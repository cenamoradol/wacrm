// ============================================================
// GET /api/account/members/pending
//
// Lists the auth accounts that exist but never confirmed their email
// and are not yet part of this account — teammates who registered
// (e.g. through an invite link) but can't reach their mailbox.
//
// Admin+. The list comes from the Supabase auth admin API, so these
// users have a profile row and a throwaway personal account, but no
// membership in this team yet. Use POST
// /api/account/members/[userId]/activate to bring one in.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { listPendingAuthUsers, MemberError } from '@/lib/auth/members';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:memberPending:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    try {
      const pending = await listPendingAuthUsers({ accountId: ctx.accountId });
      return NextResponse.json({ pending });
    } catch (err) {
      if (err instanceof MemberError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status }
        );
      }
      console.error('[GET /api/account/members/pending] error:', err);
      return NextResponse.json(
        { error: 'Failed to load pending accounts' },
        { status: 500 }
      );
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
