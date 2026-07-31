-- ============================================================
-- 037_minimax_provider.sql — extend AI provider allowlist
--
-- Adds 'minimax' to the CHECK constraints on `ai_configs.provider`
-- and `ai_usage_log.provider` so the new provider adapter can persist
-- and log its rows. Existing rows with 'openai' / 'anthropic' are
-- untouched; the constraint is replaced with one that accepts all three.
--
-- Idempotent — drops the named constraint first, then re-adds it.
-- The constraint name follows the auto-generated `tablename_column_check`
-- pattern that Supabase produces when CREATE TABLE specifies an inline
-- CHECK without an explicit name. Migration 033 already replaced it once
-- for the same reason (handoff_agent_id, etc.) so the name under
-- `pg_constraint` is consistent across versions.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'minimax'));

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'minimax'));
