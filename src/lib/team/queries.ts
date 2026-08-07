import type { SupabaseClient } from '@supabase/supabase-js';
import { isAccountRole } from '@/lib/auth/roles';
import { daysAgoStart } from '@/lib/dashboard/date-utils';
import type { PresenceStatus } from '@/lib/presence';
import type { AccountMember } from '@/types';
import type { AgentMetrics, TeamMetrics } from './types';

type DB = SupabaseClient;

// ------------------------------------------------------------
// All client-side aggregation. RLS scopes every query to the
// signed-in user automatically, so we never pass account_id
// explicitly. Same perf caveat as loadMetrics in
// lib/dashboard/queries.ts — if a tenant outgrows this, move
// the heavy aggregations to SQL RPCs.
// ------------------------------------------------------------

/** "Offline" = no heartbeat in the last 2 minutes. Mirrors the
 *  staleness rule documented in 024_member_presence.sql (a closed
 *  tab / logout never writes "offline", so it has to be derived). */
const OFFLINE_AFTER_MS = 2 * 60 * 1000;

export async function loadTeamMetrics(
  db: DB,
  rangeDays: number
): Promise<TeamMetrics> {
  const rangeStart = daysAgoStart(rangeDays - 1).toISOString();
  const fourteenDaysAgo = daysAgoStart(13).toISOString();

  const [membersRes, presenceRes, convsRes, msgsRes, closedRes, msgs14dRes] =
    await Promise.all([
      db
        .from('profiles')
        .select(
          'user_id, full_name, email, avatar_url, account_role, created_at'
        )
        .order('full_name'),
      db.from('member_presence').select('user_id, status, last_seen_at'),
      db
        .from('conversations')
        .select('assigned_agent_id')
        .not('assigned_agent_id', 'is', null)
        .gte('updated_at', rangeStart),
      db
        .from('messages')
        .select('sender_id')
        .eq('sender_type', 'agent')
        .gte('created_at', rangeStart),
      db
        .from('conversations')
        .select('assigned_agent_id')
        .eq('status', 'closed')
        .gte('updated_at', rangeStart),
      db
        .from('messages')
        .select('conversation_id, sender_type, sender_id, created_at')
        .in('sender_type', ['customer', 'agent'])
        .gte('created_at', fourteenDaysAgo)
        .order('conversation_id', { ascending: true })
        .order('created_at', { ascending: true }),
    ]);

  const members = (
    (membersRes.data ?? []) as Array<{
      user_id: string;
      full_name: string | null;
      email: string | null;
      avatar_url: string | null;
      account_role: string;
    }>
  ).flatMap((row): AccountMember[] => {
    if (!isAccountRole(row.account_role)) return [];
    return [
      {
        user_id: row.user_id,
        full_name: row.full_name ?? '',
        // The team page is admin/owner only, so email visibility is
        // fine for now. If this ever opens to agents, gate on
        // canManageMembers like /api/account/members does.
        email: row.email,
        avatar_url: row.avatar_url,
        role: row.account_role,
        joined_at: '',
      },
    ];
  });
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

  const assignedCounts = countBy(
    (convsRes.data ?? []) as Array<{ assigned_agent_id: string | null }>,
    (r) => r.assigned_agent_id
  );
  const messageCounts = countBy(
    (msgsRes.data ?? []) as Array<{ sender_id: string | null }>,
    (r) => r.sender_id
  );
  const closedCounts = countBy(
    (closedRes.data ?? []) as Array<{ assigned_agent_id: string | null }>,
    (r) => r.assigned_agent_id
  );

  const frtByAgent = computeFirstResponseByAgent(
    (msgs14dRes.data ?? []) as Array<{
      conversation_id: string;
      sender_type: string;
      sender_id: string | null;
      created_at: string;
    }>
  );

  const now = Date.now();
  const agents: AgentMetrics[] = members.map((m) => {
    const pres = presenceByUser.get(m.user_id);
    let presence: PresenceStatus = 'offline';
    let lastSeenAt: string | null = null;
    if (pres) {
      lastSeenAt = pres.last_seen_at;
      const stale =
        now - new Date(pres.last_seen_at).getTime() > OFFLINE_AFTER_MS;
      presence = stale ? 'offline' : pres.status;
    }
    const samples = frtByAgent.get(m.user_id) ?? [];
    const firstResponseMinutes =
      samples.length === 0
        ? null
        : samples.reduce((a, b) => a + b, 0) / samples.length;

    return {
      userId: m.user_id,
      fullName: m.full_name || m.email || 'Unknown',
      avatarUrl: m.avatar_url,
      role: m.role,
      presence,
      lastSeenAt,
      assignedCount: assignedCounts.get(m.user_id) ?? 0,
      messagesSent: messageCounts.get(m.user_id) ?? 0,
      firstResponseMinutes,
      closedCount: closedCounts.get(m.user_id) ?? 0,
    };
  });

  const totals = computeTotals(agents);
  return { agents, totals };
}

function countBy<T>(
  rows: T[],
  key: (r: T) => string | null
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

function computeTotals(agents: AgentMetrics[]): TeamMetrics['totals'] {
  const online = agents.filter((a) => a.presence === 'online').length;
  const messagesSent = agents.reduce((sum, a) => sum + a.messagesSent, 0);
  const closedCount = agents.reduce((sum, a) => sum + a.closedCount, 0);
  // Unweighted mean of per-agent FRT averages. Good enough for a
  // team-level summary card; the per-agent drill-down is where the
  // real signal lives. (A sample-count-weighted mean would need the
  // raw samples, which we deliberately don't keep around.)
  const frtAvgs = agents
    .map((a) => a.firstResponseMinutes)
    .filter((m): m is number => m !== null);
  const avgFirstResponseMinutes =
    frtAvgs.length === 0
      ? null
      : frtAvgs.reduce((a, b) => a + b, 0) / frtAvgs.length;
  return {
    agents: agents.length,
    online,
    avgFirstResponseMinutes,
    messagesSent,
    closedCount,
  };
}

/**
 * Pure helper exposed for tests. Walks each conversation's messages in
 * chronological order, pairs every "pending" customer message with the
 * NEXT agent reply (bot replies do not count), and groups the resulting
 * minutes by the agent's user_id.
 *
 * Rules (mirrors lib/dashboard/queries.ts loadResponseTime):
 *   - One sample per customer message — if the customer double-messages
 *     while waiting, we only count the first until it's answered.
 *   - A customer's message is only answered by an agent that follows it
 *     in the same conversation. Bot replies don't consume the pending
 *     slot.
 *   - Output: Map<agentUserId, minutes[]>.
 */
export function computeFirstResponseByAgent(
  rows: Array<{
    conversation_id: string;
    sender_type: string;
    sender_id: string | null;
    created_at: string;
  }>
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let currentConv = '';
  let pendingCustomerAt: Date | null = null;
  for (const row of rows) {
    if (row.conversation_id !== currentConv) {
      currentConv = row.conversation_id;
      pendingCustomerAt = null;
    }
    const ts = new Date(row.created_at);
    if (row.sender_type === 'customer') {
      if (!pendingCustomerAt) pendingCustomerAt = ts;
      continue;
    }
    if (row.sender_type !== 'agent' || !row.sender_id || !pendingCustomerAt) {
      continue;
    }
    const minutes = (ts.getTime() - pendingCustomerAt.getTime()) / 60_000;
    if (minutes < 0) {
      // Out-of-order row (shouldn't happen with the SQL ORDER BY, but
      // be defensive). Drop it rather than poison the average.
      continue;
    }
    const arr = out.get(row.sender_id) ?? [];
    arr.push(minutes);
    out.set(row.sender_id, arr);
    pendingCustomerAt = null;
  }
  return out;
}
