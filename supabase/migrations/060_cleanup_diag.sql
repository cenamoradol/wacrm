-- 060_cleanup_diag.sql — drop the diagnostic logging trigger now
-- that we've confirmed the trigger fires. The original
-- notify_webpush_dispatch trigger stays; it just couldn't reach
-- localhost from Supabase, which is what we're about to fix by
-- exposing the dev server with ngrok.

DROP TRIGGER IF EXISTS on_notification_insert_log ON notifications;
DROP FUNCTION IF EXISTS notify_webpush_dispatch_logged();
DROP TABLE IF EXISTS _trigger_log;
DROP TABLE IF EXISTS _pgnet_log;
DROP TABLE IF EXISTS _pgnet_recent;
DROP TABLE IF EXISTS _pgnet_check;
DROP TABLE IF EXISTS _pgnet_schema;