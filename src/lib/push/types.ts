// Shared types for the push subsystem.

/** DB row shape from `push_subscriptions` (service-role reads). */
export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** What the client sends to /api/push/subscribe. */
export interface ClientSubscribePayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}
