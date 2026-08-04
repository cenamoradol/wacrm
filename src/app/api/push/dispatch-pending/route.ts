import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { dispatchToUser, type DispatchPayload } from "@/lib/push/dispatch";

/**
 * POST /api/push/dispatch-pending
 *
 * Polls the `notifications` table for rows belonging to the current
 * user that haven't been pushed yet (`pushed_at IS NULL`), sends a
 * push for each, and marks them `pushed_at = now()` so we don't
 * re-push on the next call.
 *
 * Called by the dashboard's WebPushBootstrap on mount and via
 * `visibilitychange` when the tab becomes visible. Cheap (single
 * indexed read + batched updates), idempotent (the partial unique
 * index on `WHERE pushed_at IS NULL` keeps the work bounded), and
 * doesn't need a public URL like the old pg_net flow did.
 *
 * Auth: standard session cookie. The current user is the only one
 * whose undispatched rows are returned — the query filters by
 * `auth.uid()`.
 */
export async function POST() {
  const serverSupabase = await createClient();

  const {
    data: { user },
  } = await serverSupabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // Read up to 50 undispatched notifications for this user, oldest
  // first. RLS limits the read to rows the user owns; no service
  // role needed.
  const { data: rows, error } = await serverSupabase
    .from("notifications")
    .select(
      "id, account_id, user_id, type, title, body, conversation_id, created_at",
    )
    .eq("user_id", user.id)
    .is("pushed_at", null)
    .order("created_at", { ascending: true })
    .limit(50);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  if (!rows || rows.length === 0) {
    return NextResponse.json({ ok: true, dispatched: 0 });
  }

  // Dispatch first, then mark `pushed_at` only on rows where the
  // push actually reached a device. This way a failed push (e.g.
  // stale FCM endpoint that times out) is retried on the next poll.
  const results: { id: string; ok: boolean; delivered: number; failed: number; expired: number; skipped: boolean }[] = [];
  const successfulIds: string[] = [];

  for (const row of rows) {
    const payload: DispatchPayload = {
      notification_id: row.id,
      account_id: row.account_id,
      user_id: row.user_id,
      type: row.type,
      title: row.title,
      body: row.body,
      conversation_id: row.conversation_id,
      created_at: row.created_at,
    };
    const result = await dispatchToUser(payload);
    const ok =
      !result.skipped &&
      (result.delivered > 0 || result.expired > 0);
    results.push({
      id: row.id,
      ok,
      delivered: result.delivered,
      failed: result.failed,
      expired: result.expired,
      skipped: result.skipped,
    });
    // Mark as pushed only if we delivered (or expired, meaning the
    // subscription is gone and we shouldn't retry). Failed rows
    // stay unpushed and get retried on the next call.
    if (ok) successfulIds.push(row.id);
  }

  if (successfulIds.length > 0) {
    // Use the service role for the update — the `notifications` RLS
    // grants the user only UPDATE on `read_at`, not arbitrary columns.
    // The trigger / webhook path sets `pushed_at` via SECURITY DEFINER
    // (bypasses RLS); we do the same here.
    const serviceSupabase = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
    await serviceSupabase
      .from("notifications")
      .update({ pushed_at: new Date().toISOString() })
      .in("id", successfulIds);
  }

  return NextResponse.json({ ok: true, dispatched: results.length, results });
}