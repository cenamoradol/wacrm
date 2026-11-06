// ============================================================
// Auto-assign agent picker for the `assign_conversation` step.
//
// The step's "Round-robin" mode used to hand the conversation to
// whichever profile came back first from an unfiltered query —
// in practice always the same person. This module implements the
// rotation the mode advertises.
//
// Ranking (first difference wins):
//
//   1. online before offline — a member who is actually in the
//      dashboard can answer the customer now. Presence is a
//      *preference*, never a filter: when nobody is online the
//      rotation still has to happen.
//   2. fewer open conversations — spreads the load.
//   3. least recently active first — the rotation itself: whoever has
//      been idle longest gets the next conversation. A member with no
//      recent conversation counts as idle "since forever", so a fresh
//      team gets spread out instead of landing on one person.
//   4. user_id asc — deterministic tie-break, so two runs over the
//      same state pick the same person.
//
// No new schema: the rotation state is derived from conversations that
// already carry an assignee.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from './admin-client';
import { derivePresence, type PresenceStatus } from '@/lib/presence';
import { canSendMessages, isAccountRole } from '@/lib/auth/roles';

/**
 * How far back we look for a member's conversation activity. Older
 * conversations don't say anything useful about who is free right now,
 * and they keep the query bounded on big accounts.
 */
export const ACTIVITY_WINDOW_DAYS = 30;

export interface AutoAssignCandidate {
  user_id: string;
  full_name: string | null;
  /** Open conversations currently assigned to this member. */
  openLoad: number;
  /**
   * Epoch ms of the member's most recent assigned-conversation
   * activity. 0 when they have none inside the activity window.
   */
  lastActivityAt: number;
  /** Derived presence, using the same rules as the inbox roster. */
  presence: PresenceStatus;
}

/**
 * Who may take a conversation. Viewers are read-only (they can't
 * reply), so auto-assign never hands a thread to one — same rule the
 * rest of the app uses via `canSendMessages`.
 */
export function canReceiveConversations(role: unknown): boolean {
  return isAccountRole(role) && canSendMessages(role);
}

/**
 * Pick the member who should receive the next conversation.
 * Pure — no I/O — so the rotation rules are unit-testable.
 */
export function pickAutoAssignCandidate(
  candidates: readonly AutoAssignCandidate[]
): AutoAssignCandidate | null {
  if (candidates.length === 0) return null;
  let best = candidates[0];
  for (const c of candidates.slice(1)) {
    if (compareCandidates(c, best) < 0) best = c;
  }
  return best;
}

function compareCandidates(
  a: AutoAssignCandidate,
  b: AutoAssignCandidate
): number {
  const onlineA = a.presence === 'online' ? 0 : 1;
  const onlineB = b.presence === 'online' ? 0 : 1;
  if (onlineA !== onlineB) return onlineA - onlineB;
  if (a.openLoad !== b.openLoad) return a.openLoad - b.openLoad;
  if (a.lastActivityAt !== b.lastActivityAt)
    return a.lastActivityAt - b.lastActivityAt;
  return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
}

export interface AutoAssignOptions {
  /**
   * Restrict the rotation to these members. `undefined` = every member
   * who can reply participates. An empty array = nobody participates.
   */
  participantIds?: string[];
  /** Client to run the queries on — defaults to the service-role one. */
  db?: SupabaseClient;
}

/**
 * Narrow the pool to the members the step allows.
 *
 * `undefined` = no explicit list, so every eligible member stays in.
 * An empty array means nobody participates — the step then finds no
 * agent and reports it instead of guessing.
 */
export function filterByParticipants(
  candidates: readonly AutoAssignCandidate[],
  participantIds?: string[]
): AutoAssignCandidate[] {
  if (!participantIds) return [...candidates];
  return candidates.filter((c) => participantIds.includes(c.user_id));
}

/**
 * Build the candidate pool for an account. Members who can take a
 * conversation, with their current load and last activity.
 */
export async function loadAutoAssignCandidates(
  accountId: string,
  opts: AutoAssignOptions = {}
): Promise<AutoAssignCandidate[]> {
  const db = opts.db ?? supabaseAdmin();
  const windowStart = new Date(
    Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const [membersRes, presenceRes, convsRes] = await Promise.all([
    db
      .from('profiles')
      .select('user_id, full_name, account_role')
      .eq('account_id', accountId),
    db
      .from('member_presence')
      .select('user_id, status, last_seen_at')
      .eq('account_id', accountId),
    db
      .from('conversations')
      .select('assigned_agent_id, status, updated_at')
      .eq('account_id', accountId)
      .not('assigned_agent_id', 'is', null)
      .gte('updated_at', windowStart),
  ]);

  const now = Date.now();
  const presenceByUser = new Map<
    string,
    { status: 'online' | 'away'; last_seen_at: string }
  >();
  for (const p of (presenceRes.data ?? []) as Array<{
    user_id: string;
    status: 'online' | 'away';
    last_seen_at: string;
  }>) {
    presenceByUser.set(p.user_id, {
      status: p.status,
      last_seen_at: p.last_seen_at,
    });
  }

  const openLoad = new Map<string, number>();
  const lastActivityAt = new Map<string, number>();
  for (const c of (convsRes.data ?? []) as Array<{
    assigned_agent_id: string | null;
    status: string | null;
    updated_at: string | null;
  }>) {
    const agentId = c.assigned_agent_id;
    if (!agentId) continue;
    if (c.status === 'open') {
      openLoad.set(agentId, (openLoad.get(agentId) ?? 0) + 1);
    }
    const at = c.updated_at ? new Date(c.updated_at).getTime() : 0;
    if (Number.isFinite(at) && at > (lastActivityAt.get(agentId) ?? 0)) {
      lastActivityAt.set(agentId, at);
    }
  }

  const candidates: AutoAssignCandidate[] = [];
  for (const m of (membersRes.data ?? []) as Array<{
    user_id: string;
    full_name: string | null;
    account_role: string | null;
  }>) {
    if (!canReceiveConversations(m.account_role)) continue;
    const pres = presenceByUser.get(m.user_id);
    candidates.push({
      user_id: m.user_id,
      full_name: m.full_name,
      openLoad: openLoad.get(m.user_id) ?? 0,
      lastActivityAt: lastActivityAt.get(m.user_id) ?? 0,
      presence: derivePresence(pres?.status, pres?.last_seen_at, now),
    });
  }
  // The step's participant list narrows the pool — a member left out of
  // it never receives a conversation, even when they are the one with
  // the lightest load.
  return filterByParticipants(candidates, opts.participantIds);
}

/**
 * Convenience wrapper: load the pool and return the member who should
 * get the next conversation, or null when nobody can take one.
 */
export async function pickAutoAssignAgent(
  accountId: string,
  opts: AutoAssignOptions = {}
): Promise<AutoAssignCandidate | null> {
  const candidates = await loadAutoAssignCandidates(accountId, opts);
  return pickAutoAssignCandidate(candidates);
}
