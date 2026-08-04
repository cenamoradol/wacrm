// One-off script: dispatch all undispatched notifications.
// Mirrors /api/push/dispatch-pending — kept here for dev when
// the browser polling falls behind. Safe to delete once the prod
// cron job replaces it.

const { createClient } = require("@supabase/supabase-js");
const webpush = require("web-push");
const fs = require("fs");

const env = fs.readFileSync(".env", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const pub = env.match(/NEXT_PUBLIC_VAPID_PUBLIC_KEY=(.+)/)[1].trim();
const priv = env.match(/VAPID_PRIVATE_KEY=(.+)/)[1].trim();
const subject = env.match(/VAPID_SUBJECT=(.+)/)[1]?.trim() || "mailto:support@wacrm.example.com";

webpush.setVapidDetails(subject, pub, priv);

const sb = createClient(url, key, { auth: { persistSession: false } });

(async () => {
  const { data: rows, error } = await sb
    .from("notifications")
    .select(
      "id, account_id, user_id, type, title, body, conversation_id, created_at",
    )
    .is("pushed_at", null)
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) {
    console.error("fetch error:", error);
    return;
  }
  console.log("Undispatched rows:", rows?.length || 0);

  for (const row of rows || []) {
    const { data: subs } = await sb
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("user_id", row.user_id);
    if (!subs || subs.length === 0) {
      console.log(`  no subs for user ${row.user_id}, skipping ${row.id}`);
      continue;
    }
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          JSON.stringify({
            notification_id: row.id,
            title: row.title,
            body: row.body ?? "",
            url: row.conversation_id
              ? `https://crm.example.com/inbox?c=${row.conversation_id}`
              : "https://crm.example.com/notifications",
            tag: row.id,
          }),
          { TTL: 60 * 60, timeout: 4000, headers: { Urgency: "high" } },
        );
        await sb
          .from("notifications")
          .update({ pushed_at: new Date().toISOString() })
          .eq("id", row.id);
        console.log(`  pushed ${row.id}`);
      } catch (e) {
        console.log(`  failed ${row.id}: ${e.message}`);
      }
    }
  }
})();
