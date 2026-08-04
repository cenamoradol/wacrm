-- ============================================================
-- 061_polling_push.sql — switch from pg_net push to pull-based
-- dispatch. Why:
--
--   The previous design used pg_net.http_post from the trigger to
--   call /api/push/dispatch on a public URL. In production that's
--   fine; in dev it requires a tunnel (ngrok / cloudflared /
--   localtunnel) just to reach the local server. This migration
--   moves the dispatch to a pull model: the trigger just inserts
--   the notification as before, and the Next.js app polls for
--   undispatched rows.
--
--   Trade-off: push only fires while the user has the app open (or
--   until they re-open it within the dispatch window). That's fine
--   for an MVP and matches the existing in-app feed's UX exactly
--   (the bell badge in the sidebar is the live signal; the OS
--   notification is the loud copy of the same row).
--
--   When the user has a deployed prod environment, you can switch
--   back to pg_net by reverting 061 and re-running 057 with
--   `push.dispatch_url` set to the public domain.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS pushed_at timestamptz;

-- Drop the pg_net-based push dispatch trigger; the in-app
-- notification still gets inserted by the original trigger from
-- migration 027.
DROP TRIGGER IF EXISTS on_notification_insert_push ON notifications;
DROP FUNCTION IF EXISTS notify_webpush_dispatch();

-- Index for the poller's "find me undelivered rows for this user"
-- query. Partial index because most rows will be pushed_at != null.
CREATE INDEX IF NOT EXISTS notifications_pushed_at_null_idx
  ON notifications (user_id, created_at)
  WHERE pushed_at IS NULL;