import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import type { ClientSubscribePayload } from '@/lib/push/types';

const Body = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userAgent: z.string().optional(),
});

/**
 * POST /api/push/subscribe
 *
 * The client (web-push SDK via the WebPushBootstrap) sends the
 * PushSubscription object it just received from the browser. We
 * upsert it into `push_subscriptions` keyed on (user_id, endpoint)
 * so a re-subscribe from the same browser just updates the keys
 * (which can change across sessions).
 *
 * The route is authed by the user's session cookie — `auth.uid()`
 * is the user the subscription is attached to. There's no way to
 * subscribe on behalf of someone else.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Read account_id from the user's profile. The push lives inside
  // an account; cross-account subscriptions aren't useful even if
  // someone tried to forge them.
  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (profileErr) {
    return NextResponse.json({ error: profileErr.message }, { status: 500 });
  }
  if (!profile?.account_id) {
    return NextResponse.json({ error: 'User has no account' }, { status: 400 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid payload', issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const body: ClientSubscribePayload = parsed.data;
  const now = new Date().toISOString();

  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      account_id: profile.account_id,
      user_id: user.id,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      user_agent: body.userAgent ?? null,
      created_at: now,
      last_seen_at: now,
    },
    { onConflict: 'user_id,endpoint' }
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
