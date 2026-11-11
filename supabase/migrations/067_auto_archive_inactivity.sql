-- ============================================================
-- 067_auto_archive_inactivity.sql
--
-- Auto-archive conversations that go quiet after an agent replied.
--
-- The rules (as agreed with the account owner):
--   * only conversations ASSIGNED to an agent — the shared unassigned
--     pool is left alone;
--   * only when the LAST message came from an agent — if the customer
--     spoke last, the thread is waiting for an answer, not idle;
--   * after N hours of silence (N is per account, default 2);
--   * the customer is notified that the chat was closed... but only
--     while their last inbound message is inside Meta's 24-hour
--     customer-service window. Past that window Meta rejects free-form
--     text, so the thread is archived silently instead.
--
-- `conversations.archived` (migration 065) already does the archiving
-- half; a new inbound message resets it to false, so a customer who
-- writes again gets the thread back — see the WhatsApp webhook.
--
-- `auto_archived_at` records when the sweep archived the thread, so
-- an auto-archived thread is distinguishable from a hand-archived
-- one later on.
--
-- RLS: no new policies needed. `accounts` is already gated
-- (members read, admins+ write) and `conversations` is account-scoped
-- for both reads and writes.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS auto_archive_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Hours of silence before the thread is archived. Fractional values
-- are fine (0.5 = 30 minutes) — the sweep compares against a
-- timestamp, not an integer count of hours.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS auto_archive_after_hours NUMERIC NOT NULL DEFAULT 2;

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_auto_archive_after_hours_positive;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_auto_archive_after_hours_positive
  CHECK (auto_archive_after_hours > 0);

-- The text the customer receives. Editable per account — it is
-- customer-facing copy, so it does not belong in the translation
-- catalogue.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS auto_archive_message TEXT NOT NULL DEFAULT 'Hi! This chat was closed because of inactivity. Feel free to write us again at any time - we will be happy to help.';

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS auto_archived_at TIMESTAMPTZ;

-- The sweep's hot path: "unarchived conversations of this account,
-- oldest first". Partial on `archived = FALSE` keeps the index small
-- — archived rows are never candidates.
CREATE INDEX IF NOT EXISTS idx_conversations_auto_archive
  ON conversations (account_id, last_message_at)
  WHERE archived = FALSE;

-- "The newest message of this thread". The sweep asks for it per
-- conversation and the inbox loads threads in created_at order, so the
-- pair is worth its own index.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at DESC);

-- ============================================================
-- MESSAGE SUMMARY HELPER
--
-- "For each of these conversations: who wrote the last message, when
-- was it, and when did the customer last write?"
--
-- The sweep needs the last message of each thread, which PostgREST
-- can't express (no per-group limit). Pulling every message of every
-- candidate thread instead hits the API's max-rows cap: the response
-- is silently truncated, the truncated conversations look like "no
-- messages" on every later run, and the sweep never gets to them.
-- A lateral join per conversation keeps the read exact AND bounded —
-- one indexed row per conversation.
--
-- Invoker-rights on purpose: RLS still applies to whoever calls it
-- (an agent only ever sees their own threads). The cron runs under
-- the service role, which bypasses RLS.
-- ============================================================
CREATE OR REPLACE FUNCTION conversation_message_summary(
  p_conversation_ids UUID[]
)
RETURNS TABLE (
  conversation_id UUID,
  last_sender_type TEXT,
  last_at TIMESTAMPTZ,
  last_customer_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    ids.id,
    last_msg.sender_type,
    last_msg.created_at,
    (
      SELECT max(m.created_at)
        FROM messages m
       WHERE m.conversation_id = ids.id
         AND m.sender_type = 'customer'
    )
  FROM unnest(p_conversation_ids) AS ids(id)
  CROSS JOIN LATERAL (
    SELECT m.sender_type, m.created_at
      FROM messages m
     WHERE m.conversation_id = ids.id
     ORDER BY m.created_at DESC
     LIMIT 1
  ) AS last_msg;
$$;

ALTER FUNCTION conversation_message_summary(UUID[]) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.conversation_message_summary(UUID[]) TO authenticated, service_role;
