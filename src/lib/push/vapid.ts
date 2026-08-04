import "server-only";

import webpush from "web-push";

/**
 * VAPID + web-push configuration.
 *
 * Reads keys from env on first call, then configures web-push's
 * global VAPID material. `web-push` uses process-global VAPID state
 * for the actual signing, so we only need to call
 * `setVapidDetails` once per Node process. If either key is missing
 * the helper returns false and the caller is expected to skip
 * pushes — self-hosted installs without VAPID just keep the
 * in-app feed.
 */

let initialized = false;
let hasKeys = false;

function getEnv(name: string): string | null {
  const v = process.env[name];
  return v && v.length > 0 ? v : null;
}

/**
 * Configure web-push's global VAPID state. Idempotent — subsequent
 * calls just re-apply the same values. Returns true if VAPID is
 * configured, false if either key is missing (caller should skip
 * push delivery).
 */
export function configureWebPush(): boolean {
  if (initialized) return hasKeys;

  initialized = true;

  const publicKey = getEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY");
  const privateKey = getEnv("VAPID_PRIVATE_KEY");
  const subject =
    getEnv("VAPID_SUBJECT") ?? "mailto:support@wacrm.example.com";

  if (!publicKey || !privateKey) {
    hasKeys = false;
    return false;
  }

  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    hasKeys = true;
  } catch (e) {
    console.warn("[vapid] setVapidDetails failed:", e);
    hasKeys = false;
  }
  return hasKeys;
}

export function isWebPushConfigured(): boolean {
  return getEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY") !== null &&
    getEnv("VAPID_PRIVATE_KEY") !== null;
}