-- ============================================================
-- 057_webpush_subscriptions.sql — Self-hosted W3C Web Push
-- subscriptions table + dispatch trigger.
--
-- Replaces the OneSignal pipeline (039). The previous approach
-- required a third-party account + service-worker file downloaded
-- from their dashboard + manual inserts to app_settings. None of
-- that scales well and the user-facing flow was too brittle. This
-- migration implements the same W3C standard the browser already
-- supports (Push API + PushSubscription) without any third party.
--
-- Architecture
--   * Each browser that opts in gets a row in `push_subscriptions`,
--     scoped to its Supabase user id. The (account_id, user_id) pair
--     matches the notification feed's scoping so cross-tenant leaks
--     are impossible.
--   * The existing `notify_conversation_assigned` trigger on
--     `conversations` (from migration 027) still inserts a row into
--     `notifications` for the in-app feed. We add an AFTER INSERT
--     trigger on `notifications` (replacing the old OneSignal one)
--     that POSTs the notification to `/api/push/dispatch` via
--     `pg_net`. That endpoint fans the payload out to every
--     subscription for the user via `web-push`.
--   * The endpoint authenticates the request via a shared secret
--     (env `PUSH_DISPATCH_SECRET`). Without it, anyone could trigger
--     a push. Rotate by updating the env + re-running the migration
--     (or just rotating the env in the deployment).
-- ============================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The W3C PushSubscription endpoint, unique per (user, endpoint) so
  -- re-subscribes from the same browser don't accumulate duplicates.
  endpoint        text NOT NULL,
  -- The VAPID-derived shared secret + p256dh key, both base64url
  -- encoded. We store them as text for portability.
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  -- User-agent hint so the user can identify which device the
  -- subscription came from. Purely informational.
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON push_subscriptions (user_id) WHERE true;

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- A user can read/write their own subscriptions only.
DROP POLICY IF EXISTS push_subscriptions_rw ON push_subscriptions;
CREATE POLICY push_subscriptions_rw ON push_subscriptions FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- The dispatch endpoint runs as the service role (bypasses RLS) so
-- it can read all subscriptions for a user, regardless of which
-- user the request was for. The endpoint itself validates the
-- shared secret before doing any work.

-- ------------------------------------------------------------
-- Configuration — read dispatch URL + secret from app_settings
-- (same table we used for OneSignal, so we don't need a new one).
-- The trigger reads them on every call, so rotating either is a
-- one-line UPSERT away.
-- ------------------------------------------------------------
INSERT INTO app_settings (key, value, is_secret) VALUES
  ('push.dispatch_url',   '', false),
  ('push.dispatch_secret', '', true)
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------
-- Drop the old OneSignal trigger (it was on this same table)
-- and install the new web-push trigger.
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS on_notification_insert_push ON notifications;

CREATE OR REPLACE FUNCTION notify_webpush_dispatch()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
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

  -- No URLs configured: silently skip. Self-hosted installs without
  -- VAPID keys keep working — only the in-app feed is active.
  IF v_url IS NULL OR length(v_url) = 0 THEN
    RETURN NEW;
  END IF;

  -- Self-assignment defensive: don't push to yourself if the
  -- actor and recipient are the same (the original notification
  -- trigger also skips this, but the push is independent).
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
  -- verifies this to reject unauthenticated callers. We compute it
  -- with the built-in `digest()` so we don't need pgcrypto enabled
  -- for the basic case; the endpoint uses the same algorithm.
  v_sig := encode(
    hmac(
      convert_to(v_body::text, 'UTF8'),
      coalesce(v_secret, ''),
      'sha256'
    ),
    'hex'
  );

  -- pg_net.http_post signature (Supabase pg_net):
  --   net.http_post(url text, body jsonb, params jsonb, headers jsonb,
  --                  timeout_milliseconds integer)
  -- `body` must be jsonb, Content-Type must be exactly "application/json".
  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
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

-- Drop the OneSignal dispatch function (no longer used). 039's
-- function and trigger are replaced; the app_settings rows for
-- onesignal.* can be left in place — they're harmless and the
-- operator can DELETE them at their leisure.
DROP FUNCTION IF EXISTS notify_onesignal_push();

-- ------------------------------------------------------------
-- Operator setup
--
--   INSERT INTO app_settings (key, value, is_secret) VALUES
--     ('push.dispatch_url',    'https://yourdomain.com/api/push/dispatch', false),
--     ('push.dispatch_secret', '<random-32-bytes-hex>',                       true)
--   ON CONFLICT (key) DO UPDATE SET value = excluded.value;
--
-- Generate the secret with:
--   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
--
-- Verify:
--   SELECT key, length(value) AS len, is_secret FROM app_settings
--   WHERE key LIKE 'push.%' ORDER BY key;
-- `push.dispatch_url` should be non-empty, `push.dispatch_secret`
-- should be 64 chars (32 bytes hex) and is_secret=true.
-- ============================================================