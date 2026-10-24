// ============================================================
// Admin-managed member accounts (server-side).
//
// Two operations, both owner/admin-only:
//
//   createMemberAccount — provision a teammate's login directly:
//     the auth user is created already confirmed (no confirmation
//     email, no invite link) and attached to the account with a
//     role.
//
//   updateMemberLogin — correct a member's email or reset their
//     password. The agent may never get access to that mailbox, so
//     the team admin is the recovery path.
//
// Auth writes need the service role: `auth.admin.*` is the only way
// to write another user's credentials, and `profiles.email` (the
// copy the roster renders) is RLS-locked to the row's own user.
//
// The membership/role checks run against the CALLER's RLS-scoped
// client, so a caller can only ever reach members of their own
// account. The role change itself stays in the supervised RPC
// (see `set_member_role`).
// ============================================================

import {
  createClient,
  type PostgrestError,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js';

import { isValidEmail, passwordError } from './credentials';
import type { AccountRole } from './roles';

/** How many auth users one admin-API page holds. */
const AUTH_USER_PAGE_SIZE = 1000;

/** How many pages to scan when looking for an auth user. */
const AUTH_USER_MAX_PAGES = 10;

/** Typed failure with the HTTP status the route should answer with. */
export class MemberError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, opts: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'MemberError';
    this.status = opts.status ?? 400;
    this.code = opts.code ?? 'member_error';
  }
}

// Lazy, shared service-role client. Mirrors src/lib/ai/admin-client.ts
// and src/lib/flows/admin-client.ts.
let _adminClient: SupabaseClient | null = null;

function adminClient(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

/** Map a SQLSTATE from the member RPCs onto an HTTP-ish error. */
function memberRpcError(err: PostgrestError): MemberError {
  if (err.code === '42501') {
    return new MemberError(err.message, { status: 403, code: 'forbidden' });
  }
  if (err.code === '22023') {
    return new MemberError(err.message, {
      status: 400,
      code: 'invalid_request',
    });
  }
  console.error('[members] unexpected RPC error:', err);
  return new MemberError('Failed to update the member', {
    status: 500,
    code: 'rpc_error',
  });
}

/**
 * Create a confirmed auth user. `email_confirm: true` is what makes
 * this "no email confirmation": the account is usable the moment it
 * exists, and Supabase sends no confirmation mail.
 */
async function createAuthUser(args: {
  email: string;
  password: string;
  fullName?: string;
}): Promise<string> {
  const { data, error } = await adminClient().auth.admin.createUser({
    email: args.email,
    password: args.password,
    email_confirm: true,
    user_metadata: args.fullName ? { full_name: args.fullName } : undefined,
  });

  if (error) {
    if (/already been registered|already exists/i.test(error.message)) {
      throw new MemberError('A user with this email address already exists', {
        status: 409,
        code: 'email_taken',
      });
    }
    throw new MemberError(error.message, { status: 400, code: 'auth_error' });
  }
  if (!data.user) {
    throw new MemberError('Could not create the account', {
      status: 500,
      code: 'auth_error',
    });
  }
  return data.user.id;
}

/**
 * One page of auth users via the admin API.
 *
 * GoTrue's admin endpoints have no email / confirmation filter, so
 * every lookup here scans pages and filters client-side. One page is
 * 1 000 users — far past any realistic wacrm install.
 */
async function listAuthUsersPage(page: number): Promise<User[]> {
  const { data, error } = await adminClient().auth.admin.listUsers({
    page,
    perPage: AUTH_USER_PAGE_SIZE,
  });
  if (error) {
    throw new MemberError(error.message, { status: 500, code: 'auth_error' });
  }
  return data.users ?? [];
}

/** Find an auth user by email (case-insensitive), or null. */
async function findAuthUserByEmail(email: string): Promise<User | null> {
  const target = email.trim().toLowerCase();
  for (let page = 1; page <= AUTH_USER_MAX_PAGES; page++) {
    const users = await listAuthUsersPage(page);
    const hit = users.find((u) => (u.email ?? '').toLowerCase() === target);
    if (hit) return hit;
    if (users.length < AUTH_USER_PAGE_SIZE) break;
  }
  return null;
}

/** An auth account that exists but never confirmed its email. */
export interface PendingAuthUser {
  user_id: string;
  email: string;
  created_at: string;
}

/**
 * Auth users who never confirmed their email and are not yet part of
 * the caller's account — the "signed up but never got the mail"
 * crowd. These are the accounts an admin can activate by hand.
 */
export async function listPendingAuthUsers(args: {
  accountId: string;
}): Promise<PendingAuthUser[]> {
  const pending: PendingAuthUser[] = [];
  for (let page = 1; page <= AUTH_USER_MAX_PAGES; page++) {
    const users = await listAuthUsersPage(page);
    for (const u of users) {
      if (u.email_confirmed_at || !u.email) continue;
      pending.push({
        user_id: u.id,
        email: u.email,
        created_at: u.created_at,
      });
    }
    if (users.length < AUTH_USER_PAGE_SIZE) break;
  }
  if (pending.length === 0) return pending;

  // Drop the ones already in this account (RLS is bypassed here on
  // purpose — we're the service role).
  const { data: profiles } = await adminClient()
    .from('profiles')
    .select('user_id, account_id')
    .in(
      'user_id',
      pending.map((p) => p.user_id)
    );
  const inAccount = new Set(
    (profiles ?? [])
      .filter((p) => p.account_id === args.accountId)
      .map((p) => p.user_id)
  );
  return pending.filter((p) => !inAccount.has(p.user_id));
}

export interface ActivateMemberArgs {
  /** Caller's RLS-scoped client — the RPC needs the caller's JWT. */
  supabase: SupabaseClient;
  accountId: string;
  userId: string;
  role: AccountRole;
  /** Password the teammate will sign in with (they can't reset it
   *  themselves without access to their mailbox). */
  password: string;
}

/**
 * Activate an account that exists but never confirmed its email:
 * confirm it, set the password, and attach it to the caller's
 * account with the given role.
 *
 * This is the recovery path for a teammate who registered through the
 * invite link but can't access their mailbox — the admin does the
 * confirming on their behalf.
 */
export async function activateMemberAccount(
  args: ActivateMemberArgs
): Promise<{ user_id: string; email: string; role: AccountRole }> {
  if (args.role === 'owner') {
    throw new MemberError("'role' must be one of admin, agent, viewer", {
      code: 'invalid_role',
    });
  }
  const pwError = passwordError(args.password);
  if (pwError) {
    throw new MemberError(pwError, { code: 'invalid_password' });
  }

  const { data: userData, error: userErr } =
    await adminClient().auth.admin.getUserById(args.userId);
  if (userErr || !userData?.user) {
    throw new MemberError('Account not found', {
      status: 404,
      code: 'not_found',
    });
  }
  const user = userData.user;
  if (!user.email) {
    throw new MemberError('That account has no email address', {
      code: 'auth_error',
    });
  }

  // Attach to the account first: if that fails, nothing has changed
  // yet. A user who is already a member is fine — the attach simply
  // has nothing left to do.
  const { error: rpcError } = await args.supabase.rpc('add_account_member', {
    p_user_id: args.userId,
    p_role: args.role,
  });
  if (rpcError && !/already a member/i.test(rpcError.message)) {
    throw memberRpcError(rpcError);
  }

  // Confirm the email + set the password they will sign in with.
  const { error } = await adminClient().auth.admin.updateUserById(args.userId, {
    email_confirm: true,
    password: args.password,
  });
  if (error) {
    throw new MemberError(error.message, { status: 400, code: 'auth_error' });
  }

  await syncProfileEmail(args.userId, user.email);

  return { user_id: args.userId, email: user.email, role: args.role };
}

/**
 * Best-effort rollback of a half-created member.
 *
 * Two traps this has to dodge:
 *   - `accounts.owner_user_id` is ON DELETE RESTRICT, so the auth
 *     row can't be deleted while the throwaway personal account
 *     still points at it. The account goes first (its cascade takes
 *     the profile row with it).
 *   - a dropped connection *after* the RPC committed must NOT delete
 *     a perfectly good member, so the attach is checked first.
 */
async function rollbackCreatedUser(
  userId: string,
  accountId: string
): Promise<void> {
  const { data: profile } = await adminClient()
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (profile?.account_id === accountId) return; // The attach landed.

  const { error: accErr } = await adminClient()
    .from('accounts')
    .delete()
    .eq('owner_user_id', userId);
  if (accErr) {
    console.error('[members] rollback: personal account', userId, accErr);
  }

  const { error } = await adminClient().auth.admin.deleteUser(userId);
  if (error) {
    console.error('[members] rollback: auth user', userId, error);
  }
}

/**
 * Write the new credentials onto the auth user. `email_confirm` is
 * forced on so a renamed mailbox doesn't need a confirmation round-
 * trip the teammate can't answer.
 */
async function updateAuthUser(
  userId: string,
  attrs: { email?: string; password?: string }
): Promise<void> {
  const { error } = await adminClient().auth.admin.updateUserById(userId, {
    ...attrs,
    ...(attrs.email ? { email_confirm: true } : {}),
  });
  if (error) {
    if (/already been registered|already exists/i.test(error.message)) {
      throw new MemberError('A user with this email address already exists', {
        status: 409,
        code: 'email_taken',
      });
    }
    throw new MemberError(error.message, { status: 400, code: 'auth_error' });
  }
}

/** Keep the roster's copy of the email in step with auth. */
async function syncProfileEmail(userId: string, email: string): Promise<void> {
  const { error } = await adminClient()
    .from('profiles')
    .update({ email })
    .eq('user_id', userId);
  if (error) {
    // The credential change already landed; the roster copy is
    // cosmetic, so don't fail the request over it.
    console.error('[members] could not sync profiles.email', userId, error);
  }
}

export interface CreateMemberAccountArgs {
  /** Caller's RLS-scoped client — the RPC needs the caller's JWT. */
  supabase: SupabaseClient;
  accountId: string;
  email: string;
  password: string;
  role: AccountRole;
  fullName?: string;
}

/**
 * Provision a member: create the confirmed auth user, then move it
 * out of the throwaway personal account the signup trigger gave it
 * into the caller's account with the requested role.
 *
 * If the email already belongs to an auth account that never
 * confirmed its email (the teammate registered through the invite
 * link but can't reach their mailbox), that account is activated
 * instead of failing — same outcome the admin asked for.
 *
 * If the attach fails the auth user is removed again, so a failed
 * call never leaves a usable login outside the team.
 */
export async function createMemberAccount(
  args: CreateMemberAccountArgs
): Promise<{ user_id: string; email: string; role: AccountRole }> {
  const email = args.email.trim().toLowerCase();
  if (!isValidEmail(email)) {
    throw new MemberError('A valid email address is required', {
      code: 'invalid_email',
    });
  }
  const pwError = passwordError(args.password);
  if (pwError) {
    throw new MemberError(pwError, { code: 'invalid_password' });
  }
  if (args.role === 'owner') {
    throw new MemberError("'role' must be one of admin, agent, viewer", {
      code: 'invalid_role',
    });
  }

  let userId: string;
  try {
    userId = await createAuthUser({
      email,
      password: args.password,
      fullName: args.fullName,
    });
  } catch (err) {
    // The address is taken. If it's a half-registered account, adopt
    // it instead of dead-ending the admin.
    if (!(err instanceof MemberError) || err.code !== 'email_taken') throw err;
    const existing = await findAuthUserByEmail(email);
    if (!existing) throw err;
    if (existing.email_confirmed_at) throw err; // A live account — not ours to take.
    return activateMemberAccount({
      supabase: args.supabase,
      accountId: args.accountId,
      userId: existing.id,
      role: args.role,
      password: args.password,
    });
  }

  const { error } = await args.supabase.rpc('add_account_member', {
    p_user_id: userId,
    p_role: args.role,
  });
  if (error) {
    await rollbackCreatedUser(userId, args.accountId);
    throw memberRpcError(error);
  }

  return { user_id: userId, email, role: args.role };
}

export interface UpdateMemberLoginArgs {
  /** Caller's RLS-scoped client — used for the membership check. */
  supabase: SupabaseClient;
  accountId: string;
  userId: string;
  email?: string;
  password?: string;
}

/**
 * Change a member's email and/or password. Both are optional, but at
 * least one must be given.
 *
 * The account owner is off-limits: their login is the root of trust
 * for the account, and letting an admin rewrite it would be a
 * takeover path. The owner manages their own credentials through
 * their profile settings / password reset.
 */
export async function updateMemberLogin(
  args: UpdateMemberLoginArgs
): Promise<void> {
  const email = args.email?.trim().toLowerCase();
  const password = args.password;

  if (!email && !password) {
    throw new MemberError('Nothing to update', { code: 'nothing_to_update' });
  }
  if (email && !isValidEmail(email)) {
    throw new MemberError('A valid email address is required', {
      code: 'invalid_email',
    });
  }
  if (password) {
    const pwError = passwordError(password);
    if (pwError) {
      throw new MemberError(pwError, { code: 'invalid_password' });
    }
  }

  // Membership check. The query is already scoped to the caller's
  // account by the `profiles_select` RLS policy, so a caller can't
  // reach a user outside their team.
  const { data: target, error } = await args.supabase
    .from('profiles')
    .select('user_id, email, account_role')
    .eq('user_id', args.userId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (error) {
    throw new MemberError('Could not load the member', { status: 500 });
  }
  if (!target) {
    throw new MemberError('Member not found', {
      status: 404,
      code: 'not_found',
    });
  }
  if (target.account_role === 'owner') {
    throw new MemberError(
      "The account owner's email and password can't be changed here",
      { status: 403, code: 'forbidden' }
    );
  }

  const emailChanged = !!email && email !== (target.email ?? '').toLowerCase();
  if (!emailChanged && !password) return; // Nothing actually changed.

  await updateAuthUser(args.userId, {
    email: emailChanged ? email : undefined,
    password: password || undefined,
  });
  if (emailChanged) {
    await syncProfileEmail(args.userId, email!);
  }
}
