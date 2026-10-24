// ============================================================
// POST /api/account/members/[userId]/activate
//
// Admin+ activates an account that exists but never confirmed its
// email: confirms it, sets the password the teammate will sign in
// with, and attaches it to this account with the given role.
//
// This is the recovery path for a teammate who registered through an
// invite link but never got (or never read) the confirmation mail —
// they can't reset their own password without mailbox access.
//
// The account owner is off-limits: their login is the root of trust
// for the account. See `src/lib/auth/members.ts`.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isAccountRole } from '@/lib/auth/roles';
import { activateMemberAccount, MemberError } from '@/lib/auth/members';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:memberActivate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const body = (await request.json().catch(() => null)) as {
      role?: unknown;
      password?: unknown;
    } | null;

    const role = body?.role;
    if (!isAccountRole(role) || role === 'owner') {
      return NextResponse.json(
        { error: "'role' must be one of admin, agent, viewer" },
        { status: 400 }
      );
    }
    const password = typeof body?.password === 'string' ? body.password : '';

    try {
      const member = await activateMemberAccount({
        supabase: ctx.supabase,
        accountId: ctx.accountId,
        userId,
        role,
        password,
      });
      return NextResponse.json({ ok: true, member });
    } catch (err) {
      if (err instanceof MemberError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status }
        );
      }
      console.error('[POST /api/account/members/activate] error:', err);
      return NextResponse.json(
        { error: 'Failed to activate the account' },
        { status: 500 }
      );
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
