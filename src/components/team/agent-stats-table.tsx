'use client';

import { useTranslations } from 'next-intl';
import { UsersRound } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/dashboard/skeleton';
import {
  PRESENCE_DOT_CLASS,
  PresenceDot,
} from '@/components/presence/presence-dot';
import { ROLE_META } from '@/components/settings/role-meta';
import type { AgentMetrics } from '@/lib/team/types';

interface AgentStatsTableProps {
  agents: AgentMetrics[];
  loading: boolean;
}

export function AgentStatsTable({ agents, loading }: AgentStatsTableProps) {
  const t = useTranslations('Team');

  if (loading) {
    return (
      <Card>
        <CardContent className="p-0">
          <div className="divide-border divide-y">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3">
                <Skeleton className="size-9 rounded-full" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (agents.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-10 text-center">
          <UsersRound className="text-muted-foreground size-6" />
          <p className="text-muted-foreground mt-2 text-sm">
            {t('noMembersTitle')}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t('noMembersDesc')}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border text-muted-foreground border-b text-left text-xs font-medium tracking-wide uppercase">
                <th className="px-4 py-3">{t('colAgent')}</th>
                <th className="px-4 py-3 text-right">{t('colAssigned')}</th>
                <th className="px-4 py-3 text-right">{t('colMessages')}</th>
                <th className="px-4 py-3 text-right">{t('colFrt')}</th>
                <th className="px-4 py-3 text-right">{t('colClosed')}</th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {agents.map((agent) => {
                const roleMeta = ROLE_META[agent.role];
                const frt =
                  agent.firstResponseMinutes === null
                    ? '—'
                    : formatMinutes(agent.firstResponseMinutes);
                return (
                  <tr key={agent.userId} className="text-foreground">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="relative shrink-0">
                          <Avatar className="size-9">
                            {agent.avatarUrl ? (
                              <AvatarImage
                                src={agent.avatarUrl}
                                alt={agent.fullName}
                              />
                            ) : null}
                            <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                              {agent.fullName.charAt(0).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <span
                            role="img"
                            aria-label={agent.presence}
                            className={`border-card absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 ${PRESENCE_DOT_CLASS[agent.presence]}`}
                          />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">
                              {agent.fullName}
                            </span>
                            <span
                              className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${roleMeta.className}`}
                            >
                              {t(`role.${agent.role}`)}
                            </span>
                          </div>
                          <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
                            <PresenceDot status={agent.presence} />
                            <span>{t(`presence.${agent.presence}`)}</span>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {agent.assignedCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {agent.messagesSent.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{frt}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {agent.closedCount.toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Show sub-minute values as seconds (rounded) so a fast-replying agent
 * doesn't read "0m" the whole week. From 1 minute up we just print "Nm".
 */
function formatMinutes(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}
