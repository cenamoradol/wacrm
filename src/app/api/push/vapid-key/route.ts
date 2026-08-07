import { NextResponse } from 'next/server';

/**
 * GET /api/push/vapid-key
 *
 * Returns the *public* VAPID key so the browser can use it as the
 * `applicationServerKey` when subscribing. The private key never
 * leaves the server. Returns `{ publicKey: null }` (with HTTP 200)
 * when push is not configured so the client can mount in
 * "disabled" mode without erroring.
 */
export async function GET() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null;
  return NextResponse.json(
    { publicKey },
    {
      headers: {
        // Cache aggressively — the public key rotates at most once
        // per VAPID regeneration (which means a deploy), and the
        // service worker is happy to re-subscribe to a new key. The
        // 5-minute cache keeps the SW happy on hard refreshes
        // without hitting Next on every page load.
        'Cache-Control': 'public, max-age=300, s-maxage=300',
      },
    }
  );
}
