-- 059_diag_trigger_fires.sql — verify the trigger actually fires on
-- every notification insert. Inserts a row in a log table at the
-- START of the function, so even if pg_net fails the log will show
-- the trigger ran.
--
-- This replaces the existing notify_webpush_dispatch trigger with
-- a wrapper that logs first, then calls the original.

CREATE TABLE IF NOT EXISTS _trigger_log (
  id bigserial PRIMARY KEY,
  fired_at timestamptz NOT NULL DEFAULT now(),
  notif_id uuid,
  app_id_len integer,
  key_len integer,
  url text
);

CREATE OR REPLACE FUNCTION notify_webpush_dispatch_logged()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
DECLARE
  v_url    text := get_app_setting('push.dispatch_url');
  v_key    text := get_app_setting('push.dispatch_secret');
BEGIN
  -- Log every invocation regardless of outcome
  INSERT INTO _trigger_log (notif_id, app_id_len, key_len, url)
  VALUES (NEW.id, length(coalesce(get_app_setting('onesignal.app_id'), '')), length(coalesce(v_key, '')), v_url);
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_webpush_dispatch_logged() OWNER TO postgres;

-- Install a "side" trigger that just logs. The original trigger is
-- preserved.
DROP TRIGGER IF EXISTS on_notification_insert_log ON notifications;
CREATE TRIGGER on_notification_insert_log
AFTER INSERT ON notifications
FOR EACH ROW
EXECUTE FUNCTION notify_webpush_dispatch_logged();

-- Reset the log
TRUNCATE _trigger_log;