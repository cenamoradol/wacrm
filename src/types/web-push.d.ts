declare module 'web-push' {
  // The web-push npm package on npm (v3.6.x) still uses the
  // function-based API, even though its TypeScript types
  // (@types/web-push) cover a v3.5 era. The v3.6 README hints at a
  // class form (`new webpush.WebPushClient(...)`) that doesn't exist
  // on disk. We type what we actually use.
  //
  //   import webpush from "web-push"
  //   webpush.setVapidDetails(subject, pub, priv)
  //   webpush.sendNotification(sub, payload, options)
  //   webpush.generateVAPIDKeys()
  //
  // The class form does not exist in this version — we drop it.

  export interface VapidKeys {
    publicKey: string;
    privateKey: string;
  }

  export interface PushSubscriptionLike {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  }

  export interface RequestOptions {
    TTL?: number;
    headers?: Record<string, string>;
    [key: string]: unknown;
  }

  export interface SendResult {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  }

  export class WebPushError extends Error {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
    endpoint: string;
  }

  export function setVapidDetails(
    subject: string,
    publicKey: string,
    privateKey: string
  ): void;

  export function generateVAPIDKeys(): VapidKeys;

  export function sendNotification(
    sub: PushSubscriptionLike,
    payload?: string | null,
    options?: RequestOptions
  ): Promise<SendResult>;

  const _default: {
    setVapidDetails: typeof setVapidDetails;
    generateVAPIDKeys: typeof generateVapidKeys;
    sendNotification: typeof sendNotification;
    WebPushError: typeof WebPushError;
  };

  export default _default;
}
