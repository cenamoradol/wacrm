// wacrm push service worker
// Listens for the standard `push` event, shows a Notification, and
// navigates to the conversation on click. The companion code in
// /api/push/subscribe registers the browser with our backend; the
// Postgres trigger pg_nets our /api/push/dispatch endpoint, which
// fans out via `web-push` to every subscription for the recipient.
//
// This file is served at /sw.js from /public/sw.js. It must live at
// the root scope so the Push API can find it on every page.

self.addEventListener("install", (event) => {
  // Take over immediately so the next reload uses this version
  // without waiting for the old one to die.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Claim any uncontrolled clients (open tabs) so they pick up
  // this service worker without a manual reload.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Some senders ship a plain text payload. Fall back gracefully.
    payload = { title: "New message", body: event.data ? event.data.text() : "" };
  }

  const title = payload.title || "wacrm";
  const body = payload.body || "";
  const url = payload.url || "/notifications";
  const tag = payload.notification_id || "wacrm";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag, // collapses duplicate notifications with the same tag
      icon: "/icon",
      badge: "/icon",
      data: { url, notification_id: payload.notification_id },
      // Keep it brief — most platforms truncate after ~125 chars.
      requireInteraction: false,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/notifications";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        // If a tab is already open, focus it. Otherwise open a new one.
        for (const client of windowClients) {
          if ("focus" in client) {
            client.focus();
            if ("navigate" in client) {
              return client.navigate(targetUrl);
            }
            return;
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      }),
  );
});
