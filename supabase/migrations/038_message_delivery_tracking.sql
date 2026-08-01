-- ============================================================
-- 038_message_delivery_tracking.sql
--
-- Closes the "did Meta actually deliver?" visibility gap.
--
-- Background:
--   send_image / send_text currently hardcode messages.status = 'sent'
--   right after Meta's POST /messages returns a wamid. That's a lie:
--   "sent" in this codebase really means "Meta accepted the API call",
--   NOT "Meta delivered the message to the customer's device". The
--   real status comes later via the webhook status callback (sent →
--   delivered → read, or → failed).
--
--   If the webhook isn't configured (or Meta never fires it), the
--   row stays at 'sent' forever even though the message never reached
--   WhatsApp. The operator has no way to tell from the inbox.
--
-- What this migration adds:
--   1. meta_status_updated_at: timestamp of the last status callback
--      Meta fired for this message. NULL until the first callback.
--      Lets the operator immediately see "Meta hasn't called us back
--      yet for this message" vs "Meta confirmed delivery at HH:MM".
--   2. meta_last_error: when Meta says 'failed', the error code/title
--      Meta returned (e.g. rate-limit, bad recipient). Shown in the
--      inbox so operators can debug without log-diving.
--   3. Index on (status, created_at) so we can run a cheap cron that
--      marks stale bot messages (status='sent' AND older than N
--      minutes AND no webhook callback ever landed) as 'failed'.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS meta_status_updated_at TIMESTAMPTZ;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS meta_last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_status_created
  ON messages(status, created_at DESC)
  WHERE status IN ('sent', 'sending');
