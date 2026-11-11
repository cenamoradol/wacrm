// ============================================================
// Auto-archive sweep — closes conversations that went quiet after
// an agent replied.
//
// The rules (see supabase/migrations/067_auto_archive_inactivity.sql):
//   * only conversations ASSIGNED to an agent — the shared unassigned
//     pool is left alone;
//   * only when the LAST message came from an agent — if the customer
//     spoke last, the thread is waiting for an answer, not idle;
//   * after N hours of silence (N is per account, default 2);
//   * the customer is told the chat was closed — but only while their
//     last inbound message sits inside Meta's 24-hour customer-service
//     window. Past that window Meta rejects free-form text, so the
//     thread is archived silently instead.
//
// The sweep is driven by GET /api/inbox/cron (an external scheduler
// hits it every few minutes; nothing inside the container schedules
// itself — see docs/docker.md).
//
// A conversation that was archived this way comes back on its own: the
// WhatsApp webhook sets `archived = false` on the next inbound
// message.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message';

/**
 * Meta's customer-service window. Free-form text is only deliverable
 * within 24h of the customer's last inbound message; outside it Meta
 * answers with a re-engagement error and the message never lands.
 */
export const CUSTOMER_WINDOW_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Conversations swept per account per run. The cron runs every few
 * minutes, so a backlog drains over a few ticks instead of hammering
 * Meta with hundreds of sends in one go.
 */
const MAX_PER_SWEEP = 100;

/**
 * Send failures that will never fix themselves — a conversation with
 * no phone number, no WhatsApp config, or a message that doesn't
 * belong to the account can't be notified. Those are archived
 * silently instead of being retried forever.
 */
const PERMANENT_SEND_ERRORS = new Set([
  'bad_request',
  'whatsapp_not_configured',
  'not_found',
]);

export type SenderType = 'customer' | 'agent' | 'bot';

/** One row of the `conversation_message_summary` RPC. */
export interface MessageSummaryRow {
  conversation_id: string;
  last_sender_type: SenderType;
  last_at: string;
  last_customer_at: string | null;
}

/** What we need to know about a thread to decide its fate. */
export interface ThreadSummary {
  /** Timestamp of the newest message in the thread. */
  lastAt: string;
  /** Who wrote that newest message. */
  lastSender: SenderType;
  /** Timestamp of the newest message the CUSTOMER wrote. */
  lastCustomerAt: string | null;
}

export type ArchiveDecision =
  | { action: 'skip'; reason: string }
  | { action: 'archive'; notify: false }
  | { action: 'notify'; message: string };

export interface SweepSummary {
  /** Accounts with the feature switched on. */
  accounts: number;
  /** Conversations that matched the candidate query. */
  candidates: number;
  /** Conversations archived (with or without a notice). */
  archived: number;
  /** Customers actually notified. */
  notified: number;
  /** Conversations left alone because the send failed. */
  failed: number;
}

/**
 * Turn the RPC rows into the per-thread facts the decision needs.
 */
export function summarizeThreads(
  rows: MessageSummaryRow[]
): Map<string, ThreadSummary> {
  const out = new Map<string, ThreadSummary>();
  for (const row of rows) {
    out.set(row.conversation_id, {
      lastAt: row.last_at,
      lastSender: row.last_sender_type,
      lastCustomerAt: row.last_customer_at,
    });
  }
  return out;
}

/**
 * Decide what to do with one thread. Pure — no I/O — so the rules
 * are directly testable.
 */
export function decideAutoArchive(
  summary: ThreadSummary | undefined,
  options: { hours: number; message: string },
  now: Date
): ArchiveDecision {
  if (!summary) return { action: 'skip', reason: 'no_messages' };
  // The customer spoke last — the thread is waiting for an answer.
  if (summary.lastSender !== 'agent') {
    return { action: 'skip', reason: 'customer_spoke_last' };
  }

  const idleMs = now.getTime() - new Date(summary.lastAt).getTime();
  if (idleMs < options.hours * HOUR_MS) {
    return { action: 'skip', reason: 'not_idle_long_enough' };
  }

  // No customer message at all (the agent opened the thread) — there
  // is no window to answer in, so archive without a notice.
  if (!summary.lastCustomerAt) {
    return { action: 'archive', notify: false };
  }

  const sinceCustomerMs =
    now.getTime() - new Date(summary.lastCustomerAt).getTime();
  if (sinceCustomerMs > CUSTOMER_WINDOW_HOURS * HOUR_MS) {
    // Outside Meta's 24h window — a free-form notice would be
    // rejected. Archive silently.
    return { action: 'archive', notify: false };
  }

  return { action: 'notify', message: options.message };
}

interface AccountSettings {
  id: string;
  hours: number;
  message: string;
}

/**
 * Sweep one account. Returns the counters for that account.
 */
async function sweepAccount(
  db: SupabaseClient,
  account: AccountSettings,
  now: Date,
  summary: SweepSummary
): Promise<void> {
  const cutoff = new Date(now.getTime() - account.hours * HOUR_MS);

  const { data: conversations, error } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', account.id)
    .eq('archived', false)
    .in('status', ['open', 'pending'])
    .not('assigned_agent_id', 'is', null)
    .not('last_message_at', 'is', null)
    .lt('last_message_at', cutoff.toISOString())
    .limit(MAX_PER_SWEEP);

  if (error) {
    console.error(
      `[auto-archive] candidate scan failed for account ${account.id}:`,
      error.message
    );
    return;
  }
  if (!conversations?.length) return;

  summary.candidates += conversations.length;
  const ids = conversations.map((c) => c.id as string);

  // One RPC for every candidate thread: who wrote the last message,
  // when, and when the customer last wrote. A lateral join per
  // conversation keeps it exact — PostgREST can't express "last
  // message per group", and pulling every message of every candidate
  // thread would hit the API's max-rows cap and silently truncate.
  const { data: summaryRows, error: msgError } = await db.rpc(
    'conversation_message_summary',
    { p_conversation_ids: ids }
  );

  if (msgError) {
    console.error('[auto-archive] message summary failed:', msgError.message);
    return;
  }

  const threads = summarizeThreads((summaryRows ?? []) as MessageSummaryRow[]);

  for (const conversationId of ids) {
    const decision = decideAutoArchive(
      threads.get(conversationId),
      { hours: account.hours, message: account.message },
      now
    );

    if (decision.action === 'skip') continue;

    if (decision.action === 'notify') {
      const sent = await notifyCustomer(
        db,
        account.id,
        conversationId,
        decision.message
      );
      if (sent === 'failed') {
        // Transient failure — leave the thread in the inbox and try
        // again on the next tick. Once the customer's last message
        // falls out of the 24h window the rule flips to "archive
        // silently", so retries are self-limiting.
        summary.failed += 1;
        continue;
      }
      // 'skipped' means there was nothing worth sending (empty text,
      // no phone number) — the thread is archived silently below.
      if (sent === 'sent') summary.notified += 1;
    }

    const { error: archiveError } = await db
      .from('conversations')
      .update({ archived: true, auto_archived_at: now.toISOString() })
      .eq('id', conversationId)
      // Guard: only archive a thread that is still live. A customer
      // who wrote back while we were sending must not be archived.
      .eq('archived', false);

    if (archiveError) {
      console.error(
        `[auto-archive] archive failed for conversation ${conversationId}:`,
        archiveError.message
      );
      summary.failed += 1;
      continue;
    }
    summary.archived += 1;
  }
}

/**
 * Send the "we closed your chat" notice. Returns 'sent', 'skipped'
 * (nothing worth sending) or 'failed' (try again later).
 */
async function notifyCustomer(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  message: string
): Promise<'sent' | 'skipped' | 'failed'> {
  if (!message.trim()) return 'skipped';

  try {
    await sendMessageToConversation(db, accountId, {
      conversationId,
      messageType: 'text',
      contentText: message,
      // The notice is not an agent reply — it must not pause an
      // active Flow run for this contact.
      skipFlowPause: true,
    });
    return 'sent';
  } catch (err) {
    const code = err instanceof SendMessageError ? err.code : 'unknown';
    if (PERMANENT_SEND_ERRORS.has(code)) {
      // Nothing to fix by retrying (no phone number, WhatsApp not
      // configured, …). Archive without the notice.
      console.warn(
        `[auto-archive] conversation ${conversationId} not notified (${code}) — archiving silently`
      );
      return 'skipped';
    }
    console.error(
      `[auto-archive] notice to conversation ${conversationId} failed:`,
      err instanceof Error ? err.message : err
    );
    return 'failed';
  }
}

/**
 * Run the sweep across every account that switched the feature on.
 *
 * `now` is injectable so the rules can be tested against fixed
 * timestamps.
 */
export async function sweepInactiveConversations(
  db: SupabaseClient,
  now: Date = new Date()
): Promise<SweepSummary> {
  const summary: SweepSummary = {
    accounts: 0,
    candidates: 0,
    archived: 0,
    notified: 0,
    failed: 0,
  };

  const { data: accounts, error } = await db
    .from('accounts')
    .select('id, auto_archive_after_hours, auto_archive_message')
    .eq('auto_archive_enabled', true);

  if (error) {
    console.error('[auto-archive] account scan failed:', error.message);
    return summary;
  }

  summary.accounts = accounts?.length ?? 0;

  for (const account of accounts ?? []) {
    await sweepAccount(
      db,
      {
        id: account.id as string,
        hours: Number(account.auto_archive_after_hours),
        message: (account.auto_archive_message as string) ?? '',
      },
      now,
      summary
    );
  }

  return summary;
}
