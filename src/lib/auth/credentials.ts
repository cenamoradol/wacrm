// ============================================================
// Credential rules for admin-managed member accounts.
//
// An owner/admin can provision a teammate's login directly (no email
// confirmation) and later correct the email or reset the password —
// the agent may never get access to that mailbox.
//
// These helpers are the shared, pure rules both the API routes and
// the settings UI enforce. No I/O, so they're unit-testable.
// ============================================================

/** Mirrors the signup form's minimum (src/app/(auth)/signup/page.tsx). */
export const MIN_PASSWORD_LENGTH = 6;

/**
 * Loose shape check for an email address. The authoritative verdict
 * comes from Supabase Auth when the account is created / renamed —
 * this only keeps obvious junk out of the round-trip.
 */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Why a password is rejected, or null when it passes. Empty string
 * means "not being changed" for the edit flow, so it is valid there —
 * callers that require a password must check for emptiness themselves.
 */
export function passwordError(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}
