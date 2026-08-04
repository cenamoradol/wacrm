-- ============================================================
-- 062_restore_pg_net_trigger.sql — Restore HMAC + pg_net dispatch
-- for production. The previous migration (061_polling_push) dropped
-- the trigger from 057 because the local dev environment had no
-- public URL for pg_net to reach. In production (Railway) we have
-- a public HTTPS URL, so we restore the server-push trigger.
--
-- The `pushed_at` column from 061 stays (it's used to mark rows
-- the dispatch endpoint has processed, so we don't fight ourselves
-- if the trigger fires twice). The polling endpoint
-- (/api/push/dispatch-pending) is left in place as a belt-and-braces
-- fallback — it does nothing if no notifications are pending.
--
-- Prerequisites in app_settings:
--
--   push.dispatch_url    = https://<railway-app>.up.railway.app/api/push/dispatch
--   push.dispatch_secret = <random 32 bytes hex, matches PUSH_DISPATCH_SECRET env>
--
-- ============================================================

-- Idempotent: drop existing objects first so this migration is
-- safe to re-run.
DROP TRIGGER IF EXISTS on_notification_insert_push ON notifications;
DROP FUNCTION IF EXISTS notify_webpush_dispatch();

CREATE OR REPLACE FUNCTION notify_webpush_dispatch()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, net
AS $$
DECLARE
  v_url    text := get_app_setting('push.dispatch_url');
  v_secret text := get_app_setting('push.dispatch_secret');
  v_body   jsonb;
  v_sig    text;
BEGIN
  -- Only conversation_assigned is wired for push right now. Future
  -- types can extend this WHEN clause.
  IF NEW.type <> 'conversation_assigned' THEN
    RETURN NEW;
  END IF;

  -- No URL configured: silently skip. Self-hosted installs without
  -- a public endpoint keep working — only the in-app feed is active.
  IF v_url IS NULL OR length(v_url) = 0 THEN
    RETURN NEW;
  END IF;

  -- Self-assignment defensive: don't push to yourself if the actor
  -- and recipient are the same.
  IF NEW.actor_user_id IS NOT NULL
     AND NEW.actor_user_id::text = NEW.user_id::text THEN
    RETURN NEW;
  END IF;

  v_body := jsonb_build_object(
    'notification_id', NEW.id,
    'account_id',      NEW.account_id,
    'user_id',         NEW.user_id,
    'type',            NEW.type,
    'title',           NEW.title,
    'body',            NEW.body,
    'conversation_id', NEW.conversation_id,
    'created_at',      NEW.created_at
  );

  -- HMAC-SHA256 over the body with the shared secret. The endpoint
  -- verifies this to reject unauthenticated callers. pgcrypto lives
  -- in the `extensions` schema on Supabase (not in `public`), so the
  -- function's `search_path` must include it. Both arguments must be
  -- `bytea` for the bytea/bytea/text overload to match — passing the
  -- secret as `text` triggers `function hmac(bytea, text, unknown)
  -- does not exist` at runtime.
  v_sig := encode(
    hmac(
      convert_to(v_body::text, 'UTF8'),
      convert_to(coalesce(v_secret, ''), 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  -- pg_net.http_post signature:
  --   net.http_post(url text, body jsonb, params jsonb, headers jsonb,
  --                  timeout_milliseconds integer)
  -- `body` must be jsonb, Content-Type must be exactly "application/json".
  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type',     'application/json',
      'X-Push-Signature', v_sig
    ),
    body    := v_body
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Push dispatch is best-effort. A failed POST never blocks the
  -- in-app notification, which is already saved.
  RAISE WARNING 'Push dispatch failed for notification %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_webpush_dispatch() OWNER TO postgres;

CREATE TRIGGER on_notification_insert_push
AFTER INSERT ON notifications
FOR EACH ROW
WHEN (NEW.type = 'conversation_assigned')
EXECUTE FUNCTION notify_webpush_dispatch();

-- ============================================================
-- Operator setup (run AFTER this migration):
--
--   -- 1. Generate a strong secret (run once, keep it offline):
--   --    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
--
--   -- 2. Configure app_settings (replace <URL> and <SECRET>):
--   INSERT INTO app_settings (key, value, is_secret) VALUES
--     ('push.dispatch_url',    'https://<railway-app>.up.railway.app/api/push/dispatch', false),
--     ('push.dispatch_secret', '<SECRET>', true),
--     ('push.vapid_pub',       '<NEXT_PUBLIC_VAPID_PUBLIC_KEY>',       false),
--     ('push.vapid_priv',      '<VAPID_PRIVATE_KEY>',                  true),
--     ('push.vapid_subject',   'mailto:support@yourdomain.com',        false)
--   ON CONFLICT (key) DO UPDATE SET value = excluded.value;
--
--   -- 3. Clean up OneSignal leftovers (optional, safe):
--   DELETE FROM app_settings WHERE key IN ('onesignal.api_key', 'onesignal.app_id');
--
--   -- 4. Verify:
--   SELECT key, length(value) AS len, is_secret FROM app_settings
--   WHERE key LIKE 'push.%' OR key LIKE 'onesignal.%' ORDER BY key;
-- ============================================================
