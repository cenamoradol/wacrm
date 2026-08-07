import type { AccountRole } from '@/lib/auth/roles';
import type { PresenceStatus } from '@/lib/presence';

export type Presence = PresenceStatus;

export interface AgentMetrics {
  userId: string;
  fullName: string;
  avatarUrl: string | null;
  role: AccountRole;
  presence: Presence;
  lastSeenAt: string | null;
  assignedCount: number;
  messagesSent: number;
  /** Average first-response minutes for this agent across the 14-day
   *  sampling window. Null when no samples (agent never replied). */
  firstResponseMinutes: number | null;
  closedCount: number;
}

export interface TeamMetrics {
  agents: AgentMetrics[];
  totals: {
    agents: number;
    online: number;
    avgFirstResponseMinutes: number | null;
    messagesSent: number;
    closedCount: number;
  };
}
