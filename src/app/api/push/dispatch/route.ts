import { NextResponse } from "next/server";
import { z } from "zod";
import { dispatchToUser, type DispatchPayload } from "@/lib/push/dispatch";

const Body = z.object({
  notification_id: z.string().uuid(),
  account_id: z.string().uuid(),
  user_id: z.string().uuid(),
  type: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional().nullable(),
  conversation_id: z.string().uuid().optional().nullable(),
  created_at: z.string().min(1),
});

/**
 * POST /api/push/dispatch
 *
 * Internal endpoint hit by the Postgres `on_notification_insert_push`
 * trigger via pg_net. Authenticates via a shared secret in the
 * `X-Push-Signature` header (HMAC-SHA256 of the body using
 * `PUSH_DISPATCH_SECRET`). We compare the incoming signature against
 * a fresh one computed on the server to reject unauthenticated
 * callers; without that, anyone who knows the URL could trigger
 * arbitrary pushes.
 *
 * Returns quickly (always 200 once the work is done) so pg_net's
 * default timeout doesn't fire even if some deliveries are slow.
 * Per-subscription failures are logged inside the helper.
 */
export async function POST(req: Request) {
  // --- 1. Verify the shared-secret signature -------------------------
  const secret = process.env.PUSH_DISPATCH_SECRET;
  const provided = req.headers.get("x-push-signature");

  if (!secret) {
    // Operator hasn't configured a secret. Refuse everything rather
    // than accept unsigned requests — better to fail closed than to
    // open a forge-able push endpoint.
    return NextResponse.json(
      { error: "Push dispatch not configured" },
      { status: 503 },
    );
  }
  if (!provided) {
    return NextResponse.json(
      { error: "Missing X-Push-Signature" },
      { status: 401 },
    );
  }

  const raw = await req.text();

  // HMAC-SHA256 (hex). Same algorithm the trigger uses (see
  // supabase/migrations/057_webpush_subscriptions.sql).
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const expected = createHmac("sha256", secret)
    .update(raw, "utf8")
    .digest("hex");

  // `timingSafeEqual` requires equal-length buffers; a wrong-length
  // signature from a forger fails the length check immediately.
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (
    expectedBuf.length !== providedBuf.length ||
    !timingSafeEqual(expectedBuf, providedBuf)
  ) {
    return NextResponse.json({ error: "Bad signature" }, { status: 401 });
  }

  // --- 2. Parse + validate the payload --------------------------------
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // --- 3. Fan out ----------------------------------------------------
  const result = await dispatchToUser(parsed.data as DispatchPayload);

  return NextResponse.json(result);
}

// Health check (the pg_net trigger can use HEAD to verify the
// endpoint is reachable; cheap, idempotent).
export async function HEAD() {
  return new NextResponse(null, {
    status: process.env.PUSH_DISPATCH_SECRET ? 200 : 503,
  });
}