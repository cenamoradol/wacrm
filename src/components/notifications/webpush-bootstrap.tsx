"use client";

/**
 * WebPushBootstrap — self-hosted browser push using the standard
 * W3C Push API + the `web-push` server lib. No third-party service
 * (no OneSignal, no Firebase) — VAPID keys are generated locally
 * and stored in env.
 *
 * Flow
 *   1. On mount, fetch /api/push/vapid-key to get the public key.
 *   2. Wait for service worker registration at /sw.js. Register it
 *      lazily on first use so dev (where the file may not exist) is
 *      not blocked.
 *   3. When the signed-in user changes, subscribe() / unsubscribe()
 *      against the Push API and POST the subscription to
 *      /api/push/subscribe. Logging out via use-auth() triggers
 *      `unsubscribe()` automatically.
 *   4. Exposes a `useWebPush()` hook with the same shape as the
 *      old OneSignal hook (status / error / isSubscribed / subscribe
 *      / unsubscribe) so the Settings → Notifications panel keeps
 *      working unchanged.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/hooks/use-auth";

const SW_URL = "/sw.js";

type Status =
  | "disabled" // VAPID not configured
  | "unsupported" // browser doesn't support Push
  | "insecure-origin" // page is not on https / localhost
  | "loading" // checking SW + permission
  | "ready" // SDK usable
  | "error";

interface WebPushContextValue {
  status: Status;
  error: string | null;
  isSubscribed: boolean;
  subscribe: () => Promise<boolean>;
  unsubscribe: () => Promise<void>;
}

const WebPushContext = createContext<WebPushContextValue | null>(null);

/**
 * Apply a base64url-encoded string to a Uint8Array. The W3C Push
 * API requires the applicationServerKey as a BufferSource, but the
 * `urlBase64ToUint8Array` helper that every tutorial uses is
 * copy-pasted — keeping it here means no import gymnastics.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function WebPushBootstrap({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);
  // Track the latest user id we've synced a subscription for, so a
  // re-render with the same user doesn't double-POST.
  const pairedUserIdRef = useRef<string | null>(null);
  const [swReady, setSwReady] = useState<ServiceWorkerRegistration | null>(null);

  // 1. Feature detect & fetch the public VAPID key once.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Hard requirements: HTTPS or localhost (secure context).
      if (typeof window === "undefined") return;
      const { protocol, hostname } = window.location;
      const secure =
        protocol === "https:" ||
        hostname === "localhost" ||
        hostname === "127.0.0.1";
      if (!secure) {
        if (!cancelled) {
          setStatus("insecure-origin");
          setError("Web push requires HTTPS");
        }
        return;
      }
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        if (!cancelled) {
          setStatus("unsupported");
          setError("This browser doesn't support push notifications");
        }
        return;
      }

      try {
        const res = await fetch("/api/push/vapid-key");
        const data: { publicKey: string | null } = await res.json();
        if (!data.publicKey) {
          if (!cancelled) {
            setStatus("disabled");
            setError("Push not configured on the server");
          }
          return;
        }
        // Cache the key on the global so subscribe() can use it
        // without re-fetching.
        (window as unknown as { __VAPID_PUBLIC_KEY?: string }).__VAPID_PUBLIC_KEY =
          data.publicKey;
        if (!cancelled) setStatus("ready");
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setError(e instanceof Error ? e.message : "Failed to load VAPID key");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // 2. Register the service worker once the user is about to opt in
  // (we don't register on mount — no point burning a registration
  // if the user never enables push). The registration is cached and
  // reused across subscribe() calls.
  const ensureServiceWorker = useCallback(async (): Promise<ServiceWorkerRegistration | null> => {
    if (swReady) return swReady;
    try {
      const reg = await navigator.serviceWorker.register(SW_URL, {
        scope: "/",
      });
      setSwReady(reg);
      return reg;
    } catch (e) {
      console.warn("[webpush] service worker register failed", e);
      return null;
    }
  }, [swReady]);

  // 3. Pair the subscription with the signed-in user. We always
  // (re-)subscribe on sign-in so a fresh login in a new browser
  // registers a device, and (re-)unsubscribe on sign-out so the next
  // user on the same device doesn't inherit the push.
  useEffect(() => {
    if (status !== "ready") return;
    if (loading) return;

    const target = user?.id ?? null;
    if (target === pairedUserIdRef.current) return;

    let cancelled = false;
    (async () => {
      try {
        if (target) {
          // Re-subscribe on sign-in. The browser may return the
          // existing subscription (no-op) or a new one (replaces
          // the server row via the upsert).
          const reg = await ensureServiceWorker();
          if (!reg) return;
          const pubKey = (window as unknown as { __VAPID_PUBLIC_KEY?: string })
            .__VAPID_PUBLIC_KEY;
          if (!pubKey) return;

          const perm = await Notification.requestPermission();
          if (perm !== "granted") {
            pairedUserIdRef.current = target;
            setIsSubscribed(false);
            return;
          }

          let sub = await reg.pushManager.getSubscription();
          if (!sub) {
            sub = await reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(
                pubKey,
              ) as BufferSource,
            });
          }

          await fetch("/api/push/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              endpoint: sub.endpoint,
              keys: {
                p256dh: sub.getKey("p256dh")
                  ? btoa(String.fromCharCode(...new Uint8Array(sub.getKey("p256dh")!)))
                      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
                  : "",
                auth: sub.getKey("auth")
                  ? btoa(String.fromCharCode(...new Uint8Array(sub.getKey("auth")!)))
                      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
                  : "",
              },
              userAgent: navigator.userAgent,
            }),
          });
          pairedUserIdRef.current = target;
          setIsSubscribed(true);
        } else {
          // Sign-out: tell the browser to unsubscribe, then drop the
          // server row. If pushManager isn't reachable we just leave
          // the server row — it'll expire naturally.
          const reg = swReady ?? (await navigator.serviceWorker.getRegistration(SW_URL).catch(() => null));
          const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
          if (sub) {
            await fetch("/api/push/subscribe", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: "", auth: "" } }),
            }).catch(() => undefined);
            await sub.unsubscribe().catch(() => undefined);
          }
          pairedUserIdRef.current = null;
          setIsSubscribed(false);
        }
      } catch (e) {
        if (!cancelled) {
          console.warn("[webpush] sync failed", e);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [status, loading, user?.id, swReady, ensureServiceWorker]);

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (status !== "ready" || !user) return false;
    try {
      const reg = await ensureServiceWorker();
      if (!reg) return false;
      const pubKey = (window as unknown as { __VAPID_PUBLIC_KEY?: string })
        .__VAPID_PUBLIC_KEY;
      if (!pubKey) return false;

      const perm = await Notification.requestPermission();
      if (perm !== "granted") return false;

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(pubKey) as BufferSource,
        });
      }
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.getKey("p256dh")
              ? btoa(String.fromCharCode(...new Uint8Array(sub.getKey("p256dh")!)))
                  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
              : "",
            auth: sub.getKey("auth")
              ? btoa(String.fromCharCode(...new Uint8Array(sub.getKey("auth")!)))
                  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
              : "",
          },
          userAgent: navigator.userAgent,
        }),
      });
      if (!res.ok) return false;
      pairedUserIdRef.current = user.id;
      setIsSubscribed(true);
      return true;
    } catch (e) {
      console.warn("[webpush] subscribe failed", e);
      return false;
    }
  }, [status, user, ensureServiceWorker]);

  // Pull-based push dispatch: every time the user has the app open
  // and the tab is visible, ping the server to flush any
  // undispatched notifications for us. The server endpoint is the
  // single source of truth for which notifications have been
  // delivered (it sets `pushed_at`), so duplicate calls are safe.
  //
  // We do this in addition to realtime (the in-app feed) because
  // the OS-level push notification is a louder copy that should fire
  // even if the realtime message arrived while the user's attention
  // was elsewhere.
  const flushPending = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch("/api/push/dispatch-pending", { method: "POST" });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.dispatched > 0) {
          // Optional: surface a toast / log. Quiet for now.
        }
      }
    } catch (e) {
      // best-effort; do nothing
    }
  }, [user]);

  // Flush on sign-in, on tab focus, and on a low-frequency interval.
  // Frequency tuned so a user with the app open gets push within ~20s
  // of an assignment without hammering the server.
  useEffect(() => {
    if (!user || status !== "ready") return;

    // Initial flush on mount
    flushPending();
    // When the tab regains focus (user comes back to it)
    const onVisibility = () => {
      if (document.visibilityState === "visible") flushPending();
    };
    document.addEventListener("visibilitychange", onVisibility);
    // Window-focus fallback (some browsers don't fire visibilitychange
    // when the tab is already visible but the user just clicks in).
    const onFocus = () => flushPending();
    window.addEventListener("focus", onFocus);

    // Periodic flush every 20s
    const interval = setInterval(flushPending, 20_000);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      clearInterval(interval);
    };
  }, [user, status, flushPending]);

  const unsubscribe = useCallback(async (): Promise<void> => {
    try {
      const reg =
        swReady ?? (await navigator.serviceWorker.getRegistration(SW_URL).catch(() => null));
      if (reg) {
        const sub = await reg.pushManager.getSubscription().catch(() => null);
        if (sub) {
          await sub.unsubscribe().catch(() => undefined);
        }
      }
      setIsSubscribed(false);
      pairedUserIdRef.current = null;
    } catch {
      // best-effort
    }
  }, [swReady]);

  const value = useMemo<WebPushContextValue>(
    () => ({ status, error, isSubscribed, subscribe, unsubscribe }),
    [status, error, isSubscribed, subscribe, unsubscribe],
  );

  return <WebPushContext.Provider value={value}>{children}</WebPushContext.Provider>;
}

export function useWebPush(): WebPushContextValue {
  const ctx = useContext(WebPushContext);
  if (!ctx) {
    return {
      status: "unsupported",
      error: "WebPushBootstrap not mounted",
      isSubscribed: false,
      subscribe: async () => false,
      unsubscribe: async () => undefined,
    };
  }
  return ctx;
}