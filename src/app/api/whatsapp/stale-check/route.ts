import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'

/**
 * Stale-delivery detector for bot-sent messages.
 *
 * Background:
 *   send_text / send_image / send_template currently hardcode
 *   messages.status = 'sent' right after Meta's POST /messages
 *   returns a wamid. That's optimistic — Meta accepts the API call
 *   but the message can still be filtered by quality rating, sandbox
 *   restrictions, etc. The real confirmation comes later via the
 *   webhook status callback (sent → delivered → read, or → failed).
 *
 *   If the webhook isn't configured (or never fires), the row stays
 *   at 'sent' forever even though the message never reached the
 *   recipient. This endpoint is the safety net: it sweeps bot-sent
 *   messages still in 'sent' state past a configurable timeout and
 *   flips them to 'failed' with a clear error so the inbox UI can
 *   surface the problem.
 *
 * Schedule with cron-job.org / GitHub Actions:
 *   GET /api/whatsapp/stale-check
 *   Header: x-cron-secret: <AUTOMATION_CRON_SECRET>
 *
 * Idempotent — only flips rows whose meta_status_updated_at is NULL
 * (Meta never called us back) and whose created_at is older than the
 * cutoff. Runs once and returns the count.
 */
const DEFAULT_TIMEOUT_MINUTES = 10

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Optional override via ?timeout= for tests / faster debugging.
  const url = new URL(request.url)
  const timeoutRaw = Number(url.searchParams.get('timeout'))
  const timeoutMinutes =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MINUTES

  const cutoff = new Date(Date.now() - timeoutMinutes * 60_000).toISOString()

  // Find bot-sent messages that Meta never confirmed delivery for.
  // sender_type='bot' covers every automation / flow / AI reply that
  // engineSendText / engineSendImage / engineSendTemplate / dispatch
  // sent — i.e. the rows this endpoint cares about.
  // meta_status_updated_at IS NULL means Meta never called the
  // status webhook for this message at all.
  const { data: stale, error: fetchErr } = await supabaseAdmin()
    .from('messages')
    .select('id, conversation_id, message_id, created_at')
    .eq('status', 'sent')
    .eq('sender_type', 'bot')
    .is('meta_status_updated_at', null)
    .lt('created_at', cutoff)
    .limit(200)

  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  }
  if (!stale || stale.length === 0) {
    return NextResponse.json({
      scanned: 0,
      flipped: 0,
      timeout_minutes: timeoutMinutes,
    })
  }

  const ids = stale.map((r) => r.id as string)
  const { error: updateErr, count } = await supabaseAdmin()
    .from('messages')
    .update({
      status: 'failed',
      meta_last_error: `No delivery confirmation from Meta after ${timeoutMinutes} minutes — webhook status callback never fired. Check Meta webhook config or quality rating.`,
      meta_status_updated_at: new Date().toISOString(),
    })
    .in('id', ids)

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  console.warn(
    `[whatsapp-stale-check] flipped ${count ?? ids.length} bot messages from 'sent' to 'failed' (older than ${timeoutMinutes}min, no webhook callback)`,
  )

  return NextResponse.json({
    scanned: stale.length,
    flipped: count ?? ids.length,
    timeout_minutes: timeoutMinutes,
  })
}
