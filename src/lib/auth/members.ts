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
} from '@supabase/supabase-js';

import { isValidEmail, passwordError } from './credentials';
import type { AccountRole } from './roles';

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

  const userId = await createAuthUser({
    email,
    password: args.password,
    fullName: args.fullName,
  });

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
