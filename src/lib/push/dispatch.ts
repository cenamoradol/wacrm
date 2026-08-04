import "server-only";

import webpush from "web-push";
import { createClient as createServerClient } from "@supabase/supabase-js";
import { configureWebPush } from "./vapid";
import type { PushSubscriptionRow } from "./types";

/**
 * Fan a single notification payload out to every push subscription
 * belonging to the recipient user.
 *
 * Failures are expected (subscriptions go stale, browsers expire
 * endpoints, the user revokes permission) — we DELETE the row
 * after a 404/410 so the table stays clean, and silently log
 * everything else. Push is best-effort: the in-app feed already
 * carries the same notification, this is a louder copy.
 */

export interface DispatchPayload {
  notification_id: string;
  account_id: string;
  user_id: string;
  type: string;
  title: string;
  body?: string | null;
  conversation_id?: string | null;
  created_at: string;
}

const EXPIRED_STATUS_CODES = new Set([404, 410]);

export interface DispatchResult {
  total: number;
  delivered: number;
  expired: number;
  failed: number;
  skipped: boolean;
}

export async function dispatchToUser(
  payload: DispatchPayload,
): Promise<DispatchResult> {
  const result: DispatchResult = {
    total: 0,
    delivered: 0,
    expired: 0,
    failed: 0,
    skipped: false,
  };

  if (!configureWebPush()) {
    result.skipped = true;
    return result;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  // Read the user's subscriptions. RLS would normally limit this to
  // the current user, but the dispatch endpoint runs as service role
  // and the request is for an arbitrary user id.
  const { data: subs, error } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", payload.user_id);

  if (error) {
    console.warn("[push-dispatch] failed to list subscriptions", error);
    result.failed = 1;
    return result;
  }

  const list = (subs ?? []) as PushSubscriptionRow[];
  result.total = list.length;

  if (list.length === 0) {
    return result;
  }

  // Build the W3C push payload. The service worker reads `data` for
  // the click URL and `tag` so a second push to the same
  // notification replaces the first.
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://crm.example.com";
  const target = payload.conversation_id
    ? `${siteUrl}/inbox?c=${payload.conversation_id}`
    : `${siteUrl}/notifications`;

  const pushPayload = JSON.stringify({
    notification_id: payload.notification_id,
    title: payload.title,
    body: payload.body ?? "",
    icon: "/icon",
    badge: "/icon",
    url: target,
    tag: payload.notification_id,
  });

  await Promise.all(
    list.map(async (sub) => {
      // Wrap each push in a per-subscription timeout. One stale FCM
      // endpoint (e.g. an uninstalled app) can hang the call for
      // 10+ seconds waiting for the socket to time out. We don't
      // want that to block the whole batch — the next polling cycle
      // will retry the un-marked rows.
      const PER_SUB_TIMEOUT_MS = 4_000;
      try {
        await Promise.race([
          webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            pushPayload,
            {
              TTL: 60 * 60, // 1h — long enough for the user to re-open
              headers: { Urgency: "high" },
              timeout: PER_SUB_TIMEOUT_MS,
            },
          ),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("push timeout")),
              PER_SUB_TIMEOUT_MS + 500,
            ),
          ),
        ]);
        // Bump last_seen_at to keep the row warm
        await supabase
          .from("push_subscriptions")
          .update({ last_seen_at: new Date().toISOString() })
          .eq("id", sub.id);
        result.delivered += 1;
      } catch (e: unknown) {
        const err = e as { statusCode?: number; body?: string; message?: string };
        if (err.statusCode && EXPIRED_STATUS_CODES.has(err.statusCode)) {
          // The browser revoked the subscription. Garbage-collect.
          await supabase
            .from("push_subscriptions")
            .delete()
            .eq("id", sub.id);
          result.expired += 1;
        } else {
          console.warn(
            `[push-dispatch] delivery failed for sub ${sub.id}:`,
            err.statusCode,
            err.message ?? err.body?.slice(0, 200),
          );
          result.failed += 1;
        }
      }
    }),
  );

  return result;
}