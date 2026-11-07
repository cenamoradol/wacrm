// ============================================================
// Section access policy — "which screens may this role open?".
//
// Pure and dependency-free (no React, no Supabase) so the same
// module runs in the edge middleware and in client components.
// Capabilities ("what may you do") live in `@/lib/auth/roles`;
// this file only answers "where may you go".
//
// Policy
// ------
// The Inbox is the shared workspace every member works in. Every
// other section (dashboard, contacts, pipelines, broadcasts,
// automations, flows, AI agents, team) is account administration
// and stays admin+. Inside Settings a member keeps their own
// personal tabs (profile, password, appearance); the workspace
// tabs (WhatsApp, templates, quick replies, fields, deals,
// notifications, members, API keys) stay admin+.
//
// New sections MUST be added to the maps below — a path that
// matches no known route is not gated (see `matchRoute`).
// ============================================================

import { hasMinRole, type AccountRole } from './roles';

/**
 * Least-privileged role. Used when the caller's role is unknown
 * (profile not loaded yet, or a profile row with a role this
 * build doesn't know) so an unresolved role never widens access.
 */
const FALLBACK_ROLE: AccountRole = 'viewer';

/** Top-level routes of the dashboard (the sidebar's `href` values). */
export const APP_ROUTES = [
  '/dashboard',
  '/inbox',
  '/notifications',
  '/contacts',
  '/pipelines',
  '/broadcasts',
  '/automations',
  '/flows',
  '/agents',
  '/team',
  '/settings',
] as const;

export type AppRoute = (typeof APP_ROUTES)[number];

/** Minimum role that may open each route. */
const ROUTE_MIN_ROLE: Record<AppRoute, AccountRole> = {
  '/dashboard': 'admin',
  '/inbox': 'viewer',
  '/notifications': 'admin',
  '/contacts': 'admin',
  '/pipelines': 'admin',
  '/broadcasts': 'admin',
  '/automations': 'admin',
  '/flows': 'admin',
  '/agents': 'admin',
  '/team': 'admin',
  '/settings': 'viewer',
};

/** Settings tabs, in rail order. Labels and icons live in the UI. */
export const SETTINGS_TABS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'whatsapp',
  'templates',
  'quick-replies',
  'fields',
  'deals',
  'notifications',
  'members',
  'api',
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** Minimum role that may open each settings tab. */
const SETTINGS_TAB_MIN_ROLE: Record<SettingsTab, AccountRole> = {
  overview: 'admin',
  profile: 'viewer',
  security: 'viewer',
  appearance: 'viewer',
  whatsapp: 'admin',
  templates: 'admin',
  'quick-replies': 'admin',
  fields: 'admin',
  deals: 'admin',
  notifications: 'admin',
  members: 'admin',
  api: 'admin',
};

/**
 * The route a pathname belongs to — longest matching prefix, so
 * `/automations/[id]/edit` resolves to `/automations`. Returns null
 * for paths that aren't a known section (auth pages, API routes,
 * `/join/…`): those are not gated here.
 */
export function matchRoute(pathname: string): AppRoute | null {
  let match: AppRoute | null = null;
  for (const route of APP_ROUTES) {
    if (pathname !== route && !pathname.startsWith(`${route}/`)) continue;
    if (!match || route.length > match.length) match = route;
  }
  return match;
}

/** True iff `role` may open `pathname`. */
export function canAccessRoute(
  role: AccountRole | null,
  pathname: string
): boolean {
  const route = matchRoute(pathname);
  if (!route) return true; // not a gated section
  return hasMinRole(role ?? FALLBACK_ROLE, ROUTE_MIN_ROLE[route]);
}

/**
 * Minimum role for a settings tab. Unknown tabs fall back to
 * `admin` so a typo can't open a locked panel.
 */
function settingsTabMinRole(tab: string): AccountRole {
  return (
    (SETTINGS_TAB_MIN_ROLE as Record<string, AccountRole | undefined>)[tab] ??
    'admin'
  );
}

/** True iff `role` may open the settings tab `tab`. */
export function canAccessSettingsTab(
  role: AccountRole | null,
  tab: string | null
): boolean {
  // No `?tab=` means the Overview landing — an admin-only panel.
  return hasMinRole(
    role ?? FALLBACK_ROLE,
    settingsTabMinRole(tab ?? 'overview')
  );
}

/** The first settings tab a role may open. */
export function defaultSettingsTab(role: AccountRole | null): SettingsTab {
  return (
    SETTINGS_TABS.find((tab) => canAccessSettingsTab(role, tab)) ?? 'profile'
  );
}

/** Where a role lands after sign-in, or after being bounced. */
export function defaultLanding(role: AccountRole | null): string {
  return hasMinRole(role ?? FALLBACK_ROLE, 'admin') ? '/dashboard' : '/inbox';
}
