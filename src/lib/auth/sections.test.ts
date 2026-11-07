import { describe, expect, it } from 'vitest';

import {
  APP_ROUTES,
  SETTINGS_TABS,
  canAccessRoute,
  canAccessSettingsTab,
  defaultLanding,
  defaultSettingsTab,
  matchRoute,
} from './sections';

describe('matchRoute', () => {
  it('matches a section by exact path', () => {
    expect(matchRoute('/inbox')).toBe('/inbox');
    expect(matchRoute('/contacts')).toBe('/contacts');
  });

  it('matches nested paths to their section', () => {
    expect(matchRoute('/automations/abc/edit')).toBe('/automations');
    expect(matchRoute('/broadcasts/new')).toBe('/broadcasts');
    expect(matchRoute('/flows/abc/runs')).toBe('/flows');
  });

  it('ignores paths that are not a dashboard section', () => {
    expect(matchRoute('/login')).toBeNull();
    expect(matchRoute('/api/contacts')).toBeNull();
    expect(matchRoute('/join/some-token')).toBeNull();
  });
});

describe('canAccessRoute', () => {
  it('opens the inbox to every member', () => {
    expect(canAccessRoute('owner', '/inbox')).toBe(true);
    expect(canAccessRoute('admin', '/inbox')).toBe(true);
    expect(canAccessRoute('agent', '/inbox')).toBe(true);
    expect(canAccessRoute('viewer', '/inbox')).toBe(true);
  });

  it('keeps the admin sections for admins and owners only', () => {
    for (const route of APP_ROUTES.filter((r) => r !== '/inbox')) {
      if (route === '/settings') continue;
      expect(canAccessRoute('owner', route)).toBe(true);
      expect(canAccessRoute('admin', route)).toBe(true);
      expect(canAccessRoute('agent', route)).toBe(false);
      expect(canAccessRoute('viewer', route)).toBe(false);
    }
  });

  it('treats an unknown role as least privilege', () => {
    expect(canAccessRoute(null, '/contacts')).toBe(false);
    expect(canAccessRoute(null, '/inbox')).toBe(true);
  });

  it('does not gate paths outside the dashboard sections', () => {
    expect(canAccessRoute('agent', '/api/contacts')).toBe(true);
  });
});

describe('canAccessSettingsTab', () => {
  it('opens the personal tabs to every member', () => {
    for (const tab of ['profile', 'security', 'appearance']) {
      expect(canAccessSettingsTab('agent', tab)).toBe(true);
      expect(canAccessSettingsTab('viewer', tab)).toBe(true);
      expect(canAccessSettingsTab('owner', tab)).toBe(true);
    }
  });

  it('keeps the workspace tabs admin-only', () => {
    for (const tab of SETTINGS_TABS.filter(
      (t) => !['profile', 'security', 'appearance'].includes(t)
    )) {
      expect(canAccessSettingsTab('admin', tab)).toBe(true);
      expect(canAccessSettingsTab('owner', tab)).toBe(true);
      expect(canAccessSettingsTab('agent', tab)).toBe(false);
      expect(canAccessSettingsTab('viewer', tab)).toBe(false);
    }
  });

  it('treats a missing tab as the admin-only overview', () => {
    expect(canAccessSettingsTab('agent', null)).toBe(false);
    expect(canAccessSettingsTab('admin', null)).toBe(true);
  });

  it('fails closed on an unknown tab', () => {
    expect(canAccessSettingsTab('agent', 'nope')).toBe(false);
    expect(canAccessSettingsTab('admin', 'nope')).toBe(true);
  });
});

describe('defaults', () => {
  it('lands admins on the dashboard and members on the inbox', () => {
    expect(defaultLanding('owner')).toBe('/dashboard');
    expect(defaultLanding('admin')).toBe('/dashboard');
    expect(defaultLanding('agent')).toBe('/inbox');
    expect(defaultLanding('viewer')).toBe('/inbox');
    expect(defaultLanding(null)).toBe('/inbox');
  });

  it('lands a member on the profile tab and an admin on the overview', () => {
    expect(defaultSettingsTab('agent')).toBe('profile');
    expect(defaultSettingsTab('viewer')).toBe('profile');
    expect(defaultSettingsTab('admin')).toBe('overview');
    expect(defaultSettingsTab('owner')).toBe('overview');
  });
});
