import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { sweepInactiveConversations } from '@/lib/inbox/auto-archive';

/**
 * Archive conversations that went quiet after an agent replied and
 * tell the customer the chat was closed.
 *
 * The rules live in `@/lib/inbox/auto-archive`:
 *   * assigned to an agent, last message from an agent, N hours of
 *     silence (N is per account);
 *   * the customer is notified while their last inbound message is
 *     inside Meta's 24-hour window — past it the thread is archived
 *     silently, because Meta rejects free-form text out there.
 *
 * Auth: re-uses `AUTOMATION_CRON_SECRET` so operators only have one
 * secret to provision. The endpoint is independent of the automation
 * and flow crons — one failing doesn't block the others.
 *
 * Hosting: hit on a schedule (Vercel Cron / GitHub Actions / external
 * pinger) — every 5-15 minutes is plenty. Nothing inside the
 * container schedules itself (see docs/docker.md).
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  // Constant-time compare so an attacker who can hit the endpoint
  // can't recover the secret byte-by-byte from response-time deltas.
  // Length pre-check is required by timingSafeEqual (throws otherwise)
  // and leaks only the length itself, which isn't sensitive.
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const summary = await sweepInactiveConversations(supabaseAdmin());

  return NextResponse.json(summary);
}
