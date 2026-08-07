'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Clock,
  MessageSquare,
  UsersRound,
  Wifi,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { MetricCard } from '@/components/dashboard/metric-card';
import { SkeletonCard } from '@/components/dashboard/skeleton';
import { AgentStatsTable } from '@/components/team/agent-stats-table';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { createClient } from '@/lib/supabase/client';
import { loadTeamMetrics } from '@/lib/team/queries';
import type { TeamMetrics } from '@/lib/team/types';

type RangeDays = 7 | 30 | 90;

export default function TeamPage() {
  const t = useTranslations('Team.page');
  const tRange = useTranslations('Team.range');
  const { accountRole, profileLoading } = useAuth();
  const [metrics, setMetrics] = useState<TeamMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [range, setRange] = useState<RangeDays>(30);

  const loadAll = useCallback((r: RangeDays) => {
    const db = createClient();
    loadTeamMetrics(db, r)
      .then((m) => setMetrics(m))
      .catch((err) => console.error('[team] metrics failed:', err))
      .finally(() => setMetricsLoading(false));
  }, []);

  useEffect(() => {
    loadAll(range);
  }, [loadAll, range]);

  const handleRangeChange = useCallback(
    (r: RangeDays) => {
      setRange(r);
      // Sync setState in an event handler is fine — mirrors the
      // dashboard's range-change handler, which does the same.
      setMetricsLoading(true);
      loadAll(r);
    },
    [loadAll]
  );

  // Role gate. Renders an explanatory card rather than redirecting —
  // a hard redirect would hide where the page lives from curious
  // agents. The page is admin+ only because all five metrics depend
  // on per-agent attribution (email + conversation counts) that an
  // agent shouldn't see about themselves vs their peers.
  if (!profileLoading && accountRole && !canEditSettings(accountRole)) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('description')}
          </p>
        </div>
        <div className="border-border bg-card rounded-xl border p-8 text-center">
          <UsersRound className="text-muted-foreground mx-auto size-8" />
          <p className="text-foreground mt-3 text-sm font-medium">
            {t('noAccessTitle')}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t('noAccessDesc')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('description')}
          </p>
        </div>
        <RangePicker range={range} onChange={handleRangeChange} t={tRange} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metricsLoading || !metrics ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard
              title={t('cards.agents')}
              value={metrics.totals.agents.toLocaleString()}
              icon={UsersRound}
            />
            <MetricCard
              title={t('cards.online')}
              value={metrics.totals.online.toLocaleString()}
              icon={Wifi}
              subtitle={t('cards.onlineSub', {
                total: metrics.totals.agents,
              })}
            />
            <MetricCard
              title={t('cards.frt')}
              value={
                metrics.totals.avgFirstResponseMinutes === null
                  ? '—'
                  : formatMinutes(metrics.totals.avgFirstResponseMinutes)
              }
              icon={Clock}
              subtitle={t('cards.frtSub')}
            />
            <MetricCard
              title={t('cards.messages')}
              value={metrics.totals.messagesSent.toLocaleString()}
              icon={MessageSquare}
            />
          </>
        )}
      </div>

      {/* Two-row summary strip. Cards above show team-wide averages;
          the second row mirrors them with two extra KPIs that don't
          fit on the top row but matter for the "is this agent doing
          their job?" question. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {metricsLoading || !metrics ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : (
          <>
            <MetricCard
              title={t('cards.assigned')}
              value={metrics.agents
                .reduce((sum, a) => sum + a.assignedCount, 0)
                .toLocaleString()}
              icon={Activity}
              subtitle={t('cards.assignedSub')}
            />
            <MetricCard
              title={t('cards.closed')}
              value={metrics.totals.closedCount.toLocaleString()}
              icon={CheckCircle2}
              subtitle={t('cards.closedSub')}
            />
          </>
        )}
      </div>

      <AgentStatsTable
        agents={metrics?.agents ?? []}
        loading={metricsLoading}
      />

      <p className="text-muted-foreground text-xs">{t('rolesNote')}</p>
    </div>
  );
}

function RangePicker({
  range,
  onChange,
  t,
}: {
  range: RangeDays;
  onChange: (r: RangeDays) => void;
  t: ReturnType<typeof useTranslations<'Team.range'>>;
}) {
  const ranges: RangeDays[] = [7, 30, 90];
  return (
    <div className="border-border bg-card inline-flex rounded-lg border p-0.5 text-sm">
      {ranges.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          className={
            r === range
              ? 'bg-primary text-primary-foreground rounded-md px-3 py-1.5 font-medium'
              : 'text-muted-foreground hover:text-foreground rounded-md px-3 py-1.5'
          }
        >
          {t('days', { count: r })}
        </button>
      ))}
    </div>
  );
}

function formatMinutes(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}
