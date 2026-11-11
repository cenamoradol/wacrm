-- ============================================================
-- 066_agent_conversation_scope.sql
--
-- Agents work their own threads:
--
--   * owner / admin → every conversation in the account.
--   * viewer         → every conversation, read-only (the write
--                     policies keep viewers read-only).
--   * agent         → the conversations assigned to them + the
--                     shared pool of unassigned ones. Once a thread
--                     is claimed by somebody else it disappears from
--                     their inbox (replying claims it — see
--                     `src/app/api/whatsapp/send/route.ts`).
--
-- The dashboard reads conversations straight from the browser with the
-- signed-in user's session, so RLS is the only place this can be
-- enforced: the inbox list, the unread badge, deep links, the realtime
-- channel and the API routes all inherit it.
--
-- Only the SELECT policies are scoped. The write policies stay
-- account-scoped on purpose — scoping an UPDATE would break the
-- hand-off flow: an agent reassigning a thread to a teammate would
-- fail the WITH CHECK, because the new row is no longer visible to
-- the agent who just gave it away.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- VISIBILITY HELPER
--
-- SECURITY DEFINER so the policy body can read `profiles` without
-- tripping the profiles RLS (and without recursing through it).
-- Takes the conversation's account + assignee instead of the row id,
-- so it never touches `conversations` itself — no policy recursion.
-- ============================================================
CREATE OR REPLACE FUNCTION can_view_conversation(
  c_account_id UUID,
  c_assigned_agent_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH caller AS (
    SELECT p.account_role
      FROM profiles p
     WHERE p.user_id = auth.uid()
       AND p.account_id = c_account_id
  )
  SELECT
    CASE (SELECT account_role FROM caller)
      -- Owner / admin: the whole account.
      WHEN 'owner' THEN TRUE
      WHEN 'admin' THEN TRUE
      -- Viewer: read-only supervisor — every thread (the write
      -- policies keep them read-only).
      WHEN 'viewer' THEN TRUE
      -- Agent: the unassigned pool + the threads assigned to them.
      WHEN 'agent' THEN
        c_assigned_agent_id IS NULL
        OR c_assigned_agent_id = auth.uid()
      -- Not a member of this account (or a role this build doesn't
      -- know): no access.
      ELSE FALSE
    END;
$$;

ALTER FUNCTION can_view_conversation(UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_view_conversation(UUID, UUID)
  TO authenticated, service_role;

-- ============================================================
-- POLICIES
-- ============================================================

-- ---- conversations -------------------------------------------
DROP POLICY IF EXISTS conversations_select ON conversations;
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (can_view_conversation(account_id, assigned_agent_id));

-- ---- messages ------------------------------------------------
-- Reading a thread means reading its messages, so the same rule
-- applies. The EXISTS subquery also goes through the conversations
-- SELECT policy above — belt and braces.
DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
);

-- ---- message_reactions ---------------------------------------
DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
CREATE POLICY message_reactions_select ON message_reactions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
);

-- ============================================================
-- INDEX
--
-- Every agent's inbox query filters on (account, assignee).
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_conversations_account_assignee
  ON conversations (account_id, assigned_agent_id);
