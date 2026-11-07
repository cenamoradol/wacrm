import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { isAccountRole } from '@/lib/auth/roles';
import {
  canAccessRoute,
  canAccessSettingsTab,
  defaultLanding,
  defaultSettingsTab,
  matchRoute,
} from '@/lib/auth/sections';

/**
 * True for speculative requests (link prefetch, hover prefetch). The
 * role lookup below costs a database round trip, and the sidebar
 * prefetches every visible link — so prefetches skip the check. The
 * real navigation request still runs it.
 */
function isPrefetch(request: NextRequest): boolean {
  return (
    request.headers.get('next-router-prefetch') === '1' ||
    request.headers.get('purpose') === 'prefetch' ||
    request.headers.get('sec-purpose') === 'prefetch'
  );
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie);
    });
    return response;
  };

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (
    user &&
    (request.nextUrl.pathname === '/login' ||
      request.nextUrl.pathname === '/signup' ||
      request.nextUrl.pathname === '/forgot-password')
  ) {
    const url = request.nextUrl.clone();
    const inviteToken = request.nextUrl.searchParams.get('invite');
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`;
      url.search = '';
    } else {
      url.pathname = '/dashboard';
      url.search = '';
    }
    return withRefreshedCookies(NextResponse.redirect(url));
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = [
    '/dashboard',
    '/inbox',
    '/contacts',
    '/pipelines',
    '/broadcasts',
    '/automations',
    '/settings',
  ];
  if (
    !user &&
    protectedPaths.some((path) => request.nextUrl.pathname.startsWith(path))
  ) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return withRefreshedCookies(NextResponse.redirect(url));
  }

  // API routes that need auth (not webhooks)
  if (
    !user &&
    request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
    !request.nextUrl.pathname.includes('/webhook')
  ) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );
  }

  // Role gate — the Inbox is the shared workspace; every other
  // section is admin+. The caller's own profile row carries the
  // role and is readable by its owner, so one indexed lookup tells
  // us which section this request may open. A failed lookup leaves
  // access unchanged — a broken read must not lock anyone out.
  if (user && !isPrefetch(request)) {
    const route = matchRoute(request.nextUrl.pathname);
    // `/inbox` is open to every member — skip the profile lookup on
    // the app's hottest page.
    if (route && route !== '/inbox') {
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('account_role')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!profileError && profile) {
        // A profile row with a role this build doesn't know falls
        // back to the least-privileged role rather than unlocking
        // every section.
        const role = isAccountRole(profile.account_role)
          ? profile.account_role
          : 'viewer';

        const allowed =
          route === '/settings'
            ? canAccessSettingsTab(
                role,
                request.nextUrl.searchParams.get('tab')
              )
            : canAccessRoute(role, request.nextUrl.pathname);

        if (!allowed) {
          const url = request.nextUrl.clone();
          if (route === '/settings') {
            url.pathname = '/settings';
            url.search = `?tab=${defaultSettingsTab(role)}`;
          } else {
            url.pathname = defaultLanding(role);
            url.search = '';
          }
          return withRefreshedCookies(NextResponse.redirect(url));
        }
      }
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
