# Browser push notifications

wacrm ships with an in-app notification feed (the bell badge in the
sidebar — every team member gets a row in the `notifications` table
when a conversation is assigned to them, with realtime updates via
Supabase Realtime). For native push notifications that arrive even
when the CRM tab is closed, wacrm integrates with **OneSignal Web
Push**. Both channels are on by default once configured.

## What you'll need

- A OneSignal account (https://onesignal.com, free tier covers up to
  10k push subscribers)
- HTTPS in production (web push requires it; localhost works in dev)
- The `pg_net` extension in your Supabase project (enabled by default
  on Supabase)

## One-time setup (~5 min)

### 1. Create the OneSignal app

1. Sign up at https://onesignal.com and create a new app.
2. **Settings → Push & In-App → Web → Typical Site**.
3. **Site URL**: your canonical origin, e.g. `https://crm.example.com`.
   For local dev, use `http://localhost:3000` and tick **"Treat HTTP
   localhost as HTTPS for testing"**.
4. **Enable "Auto Resubscribe"** so users who clear browser data
   re-subscribe automatically on their next visit (no second prompt).
5. Upload a square 256×256 icon (the same one as your `src/app/icon.tsx`
   works fine; PNG or JPG).
6. In **Settings → Keys & IDs**, copy:
   - **App ID** → `NEXT_PUBLIC_ONESIGNAL_APP_ID` (browser-safe)
   - **REST API Key** → `ONESIGNAL_API_KEY` (server-only — never expose
     to the client)
7. From the OneSignal dashboard download `OneSignalSDKWorker.js`
   and drop it at `public/OneSignalSDKWorker.js` (the SDK looks for
   it at the root scope by default).

### 2. App env vars

Add to `.env`:

```
NEXT_PUBLIC_ONESIGNAL_APP_ID=<app-id>
ONESIGNAL_API_KEY=<rest-api-key>
```

Leave both blank to disable web push entirely — self-hosted installs
without OneSignal still get the in-app feed; the Settings → Notifications
panel just shows a "not configured" notice.

### 3. Supabase: install the trigger migration

The repo ships with `supabase/migrations/039_onesignal_push.sql`. Apply
it once via the Supabase SQL editor (or your normal migration runner).
It adds the `pg_net` extension (no-op if already present) and a trigger
on the existing `notifications` table that fires a OneSignal push
whenever a row of type `conversation_assigned` is inserted.

### 4. Supabase: store the credentials the trigger reads

The trigger reads its OneSignal credentials from Postgres GUC settings
(set once per cluster). Run in the SQL editor:

```sql
ALTER DATABASE postgres SET app.onesignal_app_id = '<app-id>';
ALTER DATABASE postgres SET app.onesignal_api_key  = '<rest-api-key>';
-- Optional: where the "open" link should land. Falls back to
-- https://crm.example.com if unset.
ALTER DATABASE postgres SET app.site_url = 'https://crm.example.com';
```

To rotate the key later, just `ALTER DATABASE postgres SET …` again
— the trigger reads `current_setting('app.onesignal_api_key', true)`
on every push, no migration needed.

Verify the credentials landed:

```sql
SELECT current_setting('app.onesignal_app_id', true),
       current_setting('app.onesignal_api_key', true);
```

## How it works end-to-end

```
[Teammate assigns conversation to User B]
        │
        ▼
Postgres trigger notify_conversation_assigned  (migration 027)
        │
        ├─► INSERT INTO notifications
        │     └─► realtime channel → bell badge in User B's sidebar
        │
        └─► AFTER INSERT trigger notify_onesignal_push  (migration 039)
              │
              └─► pg_net.http_post → api.onesignal.com/notifications
                                          │
                                          ▼
                                  native push on User B's devices
```

## What users see

- **In-app feed**: always on, no setup. Bell badge in sidebar shows the
  unread count; the `/notifications` page lists them with realtime
  insert/mark-read.
- **Web push**: opt-in per device. The first time a signed-in user
  visits the dashboard after `NEXT_PUBLIC_ONESIGNAL_APP_ID` is set,
  the SDK auto-init and pairs the subscription with their Supabase
  user id (`OneSignal.login(user.id)`). The browser then shows the
  native permission prompt. They can disable it from **Settings →
  Notifications** at any time; sign-out calls `OneSignal.logout()` so
  the next person to sign in on that device doesn't receive the
  previous user's pushes.
- **iOS 16.4+ Safari**: requires the user to "Add to Home Screen"
  first (Apple requirement). Once added, web push works the same as
  on desktop.

## Manual test plan

1. **Subscribe**: open the dashboard, check DevTools → Network for a
   request to `api.onesignal.com`. Then go to OneSignal → Audience →
   Subscriptions and confirm a new "Subscribed" row.
2. **Receive a push**: from a separate browser session (NOT incognito
   — incognito can't subscribe), assign a conversation to the test
   user. The push should arrive within ~1s.
3. **Closed tab**: repeat step 2 with the recipient's tab closed
   entirely. The push should still arrive.
4. **Multiple devices**: log in on a second browser/device. The push
   should land on both.
5. **iOS PWA**: install to home screen, repeat steps 2-3.
6. **Failover**: temporarily set `ONESIGNAL_API_KEY` to an invalid
   value (`ALTER DATABASE … SET app.onesignal_api_key = 'broken'`).
   Assign a conversation — the in-app notification should still
   appear; only the push is skipped. Check Supabase logs for the
   `RAISE WARNING 'OneSignal push failed …'` line.

## Operational notes

- **Rate limits**: the free OneSignal tier allows 10k push deliveries
  per day. If you grow past that, the push trigger simply no-ops
  with a warning — the in-app feed keeps working.
- **HTTPS required**: web push silently fails on HTTP origins
  (except `localhost` / `127.0.0.1`, which browsers treat as secure).
  Configure TLS on your reverse proxy before turning this on in prod.
- **Auto-Resubscribe**: leave this on in the OneSignal dashboard so
  users who clear their browser data don't have to re-grant
  permission on every visit.
- **CORS / CSP**: the SDK pulls scripts from `cdn.onesignal.com`
  and calls `api.onesignal.com`. Both are allow-listed in
  `next.config.ts` under `script-src` / `connect-src`. If you tighten
  the CSP further, keep both entries.
- **Privacy**: OneSignal stores device subscriptions tied to the
  Supabase user id (`include_external_user_ids`). Each push targets
  exactly that user's devices — no leaks across users or tenants.