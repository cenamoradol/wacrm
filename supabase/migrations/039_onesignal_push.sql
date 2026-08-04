-- ============================================================
-- 039_onesignal_push.sql — Browser push notifications via OneSignal
--
-- When a row is inserted into `notifications` (today: only for
-- `conversation_assigned`), fire a web push through OneSignal so the
-- assigned teammate sees a native notification even with the CRM
-- tab closed.
--
-- Architecture
--   * pg_net.http_post() issues the HTTP call from inside the DB,
--     so no extra infrastructure (cron, edge function, or worker)
--     is required — the existing AFTER INSERT trigger on
--     `notifications` is the only entry point.
--   * Credentials (REST API key + app id) live in the `app_settings`
--     table. They're never read from `current_setting('app.*')`
--     because Supabase projects running on shared infrastructure
--     don't allow ALTER DATABASE on the `postgres` role — the SQL
--     editor + supabase CLI both run as roles without that grant.
--   * A failed push must NEVER block the in-app notification (which
--     already inserted the row) — the function catches and logs,
--     then returns.
--
-- Why a trigger and not a Database Webhook
--   The Supabase dashboard has a "Database Webhooks" feature that
--   POSTs to a configurable URL on insert. That works too, but adds
--   a network hop (Supabase → your server → OneSignal) and requires
--   operator setup per project. pg_net keeps it local to the DB.
--
-- Two pg_net gotchas that took a few rounds to discover. Both are
-- enforced by pg_net itself, neither surfaces in the official docs:
--   1. `body` parameter must be jsonb — passing `text` raises a
--      confusing "function does not exist" error.
--   2. Content-Type must be EXACTLY "application/json" — adding
--      `; charset=utf-8` raises "Content-Type header must be
--      application/json". OneSignal's REST API accepts the bare
--      `application/json` happily.
-- ============================================================

-- pg_net ships with Supabase but isn't auto-created. Safe to run;
-- if it's not permitted the install fails loud and fast.
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ============================================================
-- app_settings — table that stores the OneSignal credentials the
-- trigger reads. RLS-locked: anonymous + authenticated users can
-- SELECT non-secret rows (e.g. "is push configured?") but never
-- see the API key. Only the SECURITY DEFINER trigger function and
-- the operator (via the SQL editor) can write.
-- ============================================================
CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  is_secret  boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_settings_select ON app_settings;
CREATE POLICY app_settings_select ON app_settings FOR SELECT
  USING (auth.uid() IS NOT NULL AND NOT is_secret);

-- No client INSERT/UPDATE/DELETE — writers are the trigger function
-- (SECURITY DEFINER) and the operator via the SQL editor.
DROP POLICY IF EXISTS app_settings_insert ON app_settings;
DROP POLICY IF EXISTS app_settings_update ON app_settings;
DROP POLICY IF EXISTS app_settings_delete ON app_settings;

-- Read helper. SECURITY DEFINER so the trigger can read secret rows;
-- the client UI never goes through this — it uses the public
-- SELECT policy above.
CREATE OR REPLACE FUNCTION get_app_setting(p_key text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT value FROM app_settings WHERE key = p_key LIMIT 1;
$$;

ALTER FUNCTION get_app_setting(text) OWNER TO postgres;

-- Public row for the Settings → Notifications panel. The client
-- uses the existence of this row to decide whether to mount the
-- OneSignal SDK at all.
INSERT INTO app_settings (key, value, is_secret) VALUES
  ('onesignal.public_app_id', '', false)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- OneSignal dispatch
-- ============================================================
CREATE OR REPLACE FUNCTION notify_onesignal_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_app_id    text := get_app_setting('onesignal.app_id');
  v_api_key   text := get_app_setting('onesignal.api_key');
  v_site_url  text := COALESCE(get_app_setting('site_url'), 'https://crm.example.com');
  v_url       text;
  v_payload   jsonb;
BEGIN
  -- Self-hosted installs without web push configured: silently
  -- skip rather than spamming logs with every assignment.
  IF v_app_id IS NULL OR v_api_key IS NULL OR length(v_api_key) = 0 THEN
    RETURN NEW;
  END IF;

  -- Only conversation_assigned pushes today; future types can be
  -- added by extending this WHEN clause.
  IF NEW.type <> 'conversation_assigned' THEN
    RETURN NEW;
  END IF;

  -- Self-assignment (rare but possible via automation) is already
  -- skipped in the notification trigger. Defensive: if the row
  -- somehow targets the actor, don't push to themselves.
  IF NEW.actor_user_id IS NOT NULL
     AND NEW.actor_user_id::text = NEW.user_id::text THEN
    RETURN NEW;
  END IF;

  v_url := v_site_url || CASE
    WHEN NEW.conversation_id IS NOT NULL
      THEN '/inbox?c=' || NEW.conversation_id
    ELSE '/notifications'
  END;

  v_payload := jsonb_build_object(
    'app_id',                  v_app_id,
    'target_channel',          'push',
    'include_external_user_ids', jsonb_build_array(NEW.user_id::text),
    'headings',                jsonb_build_object('en', NEW.title),
    'contents',                jsonb_build_object('en', COALESCE(NEW.body, '')),
    'url',                     v_url,
    'data',                    jsonb_build_object(
                                  'notification_id', NEW.id,
                                  'conversation_id', NEW.conversation_id
                                )
  );

  -- pg_net.http_post signature (Supabase-managed pg_net):
  --   net.http_post(url text, body jsonb, params jsonb, headers jsonb,
  --                  timeout_milliseconds integer)
  -- `body` must be jsonb (NOT text). Content-Type must be EXACTLY
  -- "application/json" — no `; charset=utf-8`.
  PERFORM net.http_post(
    url     := 'https://api.onesignal.com/notifications',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Key ' || v_api_key
    ),
    body    := v_payload
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a OneSignal outage take down assignment. The
  -- in-app notification already saved; the operator just won't
  -- get a native push this once.
  RAISE WARNING 'OneSignal push failed for notification %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_onesignal_push() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_notification_insert_push ON notifications;
CREATE TRIGGER on_notification_insert_push
AFTER INSERT ON notifications
FOR EACH ROW
EXECUTE FUNCTION notify_onesignal_push();

-- ============================================================
-- Operator setup
--
-- To enable push for this project, run in the Supabase SQL editor:
--
--   INSERT INTO app_settings (key, value, is_secret) VALUES
--     ('onesignal.app_id',   '<app-id>',   false),
--     ('onesignal.api_key',  '<rest-api-key>', true),
--     ('site_url',            'https://crm.example.com', false)
--   ON CONFLICT (key) DO UPDATE SET value = excluded.value;
--
-- To rotate the key, run the same with a new value. To disable:
--
--   DELETE FROM app_settings
--   WHERE key IN ('onesignal.app_id', 'onesignal.api_key');
--
-- Verify:
--   SELECT key, length(value) AS len, is_secret
--   FROM app_settings ORDER BY key;
-- The two onesignal.* rows should have is_secret = true and the
-- `len` for the api_key should match your key length (~140 chars
-- for the v2 REST key).
-- ============================================================