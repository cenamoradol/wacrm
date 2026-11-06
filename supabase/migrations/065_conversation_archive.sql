-- ============================================================
-- 065_conversation_archive.sql
--
-- Lets agents triage old threads out of the working inbox:
--
--   * archive — the conversation (and its full history) stays in the
--     DB, it just leaves the inbox list so the inbox isn't buried
--     under months of stale chats. A new inbound message pulls the
--     thread back automatically.
--   * delete  — the conversation row is removed; messages, reactions,
--     message actions and notifications cascade with it.
--
-- 1) `archived` flag on `conversations`.
-- 2) `deals.conversation_id` → ON DELETE SET NULL. The FK was created
--    without an ON DELETE clause (= NO ACTION), so deleting a chat
--    that a deal points at failed with an FK violation. The deal
--    belongs to the contact, not to the chat, so unlink it instead
--    of blocking the delete.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;

-- The inbox list filters on (account, archived) on every load.
CREATE INDEX IF NOT EXISTS idx_conversations_account_archived
  ON conversations (account_id, archived);

ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_conversation_id_fkey;
ALTER TABLE deals
  ADD CONSTRAINT deals_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;
