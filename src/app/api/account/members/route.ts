// ============================================================
// GET /api/account/members
//
// Lists every member of the caller's account. Any member can call
// it (the Members tab is shown to admins+, but agents/viewers see
// a read-only roster too).
//
// Field visibility
//   Sensitive fields (email) are returned only when the caller is
//   admin+. Agents and viewers see name + avatar + role + joined
//   date only. This mirrors the design decision from the planning
//   phase: "agent/viewer sees names only".
//
// POST /api/account/members
//
// Admin+ provisions a member's login directly: the auth user is
// created already confirmed (no confirmation email, no invite link)
// and attached to the account with the given role. See
// `src/lib/auth/members.ts`.
// ============================================================

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { canManageMembers, isAccountRole } from '@/lib/auth/roles';
import { createMemberAccount, MemberError } from '@/lib/auth/members';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import type { AccountMember } from '@/types';

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  account_role: string;
  created_at: string;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // RLS on profiles allows reading any row whose account matches
    // the caller's, so this query is naturally account-scoped.
    const { data, error } = await ctx.supabase
      .from('profiles')
      .select('user_id, full_name, email, avatar_url, account_role, created_at')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[GET /api/account/members] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load members' },
        { status: 500 }
      );
    }

    const canSeeEmails = canManageMembers(ctx.role);

    const members: AccountMember[] = (data as ProfileRow[]).flatMap((row) => {
      // Defensive: the DB enum should never let an unknown role
      // through, but if a migration ever broadens the enum without
      // updating TS, skip the row rather than crash the page.
      if (!isAccountRole(row.account_role)) return [];
      return [
        {
          user_id: row.user_id,
          full_name: row.full_name ?? '',
          email: canSeeEmails ? row.email : null,
          avatar_url: row.avatar_url,
          role: row.account_role,
          joined_at: row.created_at,
        },
      ];
    });

    return NextResponse.json({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/account/members  (admin+)
 *
 * Create a member's login directly — no invite link, no email
 * confirmation. The teammate gets the credentials the admin types
 * here and can sign in immediately.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:memberCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      email?: unknown;
      password?: unknown;
      role?: unknown;
      fullName?: unknown;
    } | null;

    const role = body?.role;
    if (!isAccountRole(role) || role === 'owner') {
      return NextResponse.json(
        { error: "'role' must be one of admin, agent, viewer" },
        { status: 400 }
      );
    }

    const email = typeof body?.email === 'string' ? body.email : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const fullName =
      typeof body?.fullName === 'string' ? body.fullName.trim() : '';

    try {
      const member = await createMemberAccount({
        supabase: ctx.supabase,
        accountId: ctx.accountId,
        email,
        password,
        role,
        fullName,
      });
      return NextResponse.json({ ok: true, member }, { status: 201 });
    } catch (err) {
      if (err instanceof MemberError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status }
        );
      }
      console.error('[POST /api/account/members] error:', err);
      return NextResponse.json(
        { error: 'Failed to add the member' },
        { status: 500 }
      );
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
