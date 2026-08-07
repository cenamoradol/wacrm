'use client';

/**
 * NotificationsPanel — toggle for the W3C Web Push subscription.
 * "Not configured" is detected via `useWebPush().status === "disabled"`,
 * which is set by the bootstrap when /api/push/vapid-key returns
 * `{ publicKey: null }` (i.e. server is missing NEXT_PUBLIC_VAPID_PUBLIC_KEY
 * or VAPID_PRIVATE_KEY at runtime — no build-time inlining needed).
 *
 * The in-app notification feed (the bell badge in the sidebar) is
 * always on and isn't surfaced here — this panel is strictly about
 * the OS-level browser push channel.
 */

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Bell, BellOff, Loader2, Check, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useWebPush } from '@/components/notifications/webpush-bootstrap';

export function NotificationsPanel() {
  const t = useTranslations('Settings.notifications');
  const tCommon = useTranslations('Settings');
  const { status, isSubscribed, subscribe, unsubscribe, error } = useWebPush();
  const [pending, setPending] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch — status changes after the bootstrap
  // finishes on the client. The first render mirrors what the server
  // would have produced (no subscription, push disabled), then the
  // real state catches up on mount.
  useEffect(() => setMounted(true), []);

  // Source of truth for "is VAPID configured": the bootstrap hook.
  // It fetches /api/push/vapid-key in runtime, so we don't depend on
  // NEXT_PUBLIC_VAPID_PUBLIC_KEY being inlined into the client bundle
  // at build time (which was the old, fragile path — adding the var
  // in Railway after a deploy required a full rebuild to take effect).
  const configMissing = mounted && status === 'disabled';
  const reasonMessage = (() => {
    if (!mounted) return null;
    if (configMissing) return t('disabledByAdmin');
    if (status === 'insecure-origin') return t('insecureOrigin');
    if (status === 'unsupported') return error ?? t('unsupported');
    if (status === 'error') return error ?? t('unsupported');
    return null;
  })();

  const onToggle = async () => {
    if (pending) return;
    setPending(true);
    try {
      if (isSubscribed) {
        await unsubscribe();
        toast.success(t('disable'));
      } else {
        const ok = await subscribe();
        if (ok) toast.success(t('enable'));
        else toast.error(t('subscribeError'));
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-foreground text-lg font-semibold">{t('title')}</h2>
        <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
      </div>

      <section className="border-border bg-card rounded-xl border p-5">
        <StatusRow
          isSubscribed={isSubscribed}
          disabled={!mounted || configMissing || status !== 'ready'}
          label={
            isSubscribed
              ? t('enabled')
              : configMissing
                ? t('disabledByAdmin')
                : status === 'unsupported'
                  ? (error ?? t('unsupported'))
                  : status === 'insecure-origin'
                    ? t('insecureOrigin')
                    : status === 'error'
                      ? (error ?? t('unsupported'))
                      : t('ready')
          }
        />

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            onClick={onToggle}
            disabled={
              pending ||
              !mounted ||
              configMissing ||
              status === 'unsupported' ||
              status === 'insecure-origin' ||
              status === 'error' ||
              status === 'loading' ||
              status === 'disabled'
            }
            className={cn(
              'min-w-40',
              isSubscribed
                ? 'bg-muted text-foreground hover:bg-muted/80'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            )}
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isSubscribed ? (
              <BellOff className="h-4 w-4" />
            ) : (
              <Bell className="h-4 w-4" />
            )}
            {isSubscribed ? t('disable') : t('enable')}
          </Button>

          {reasonMessage && (
            <p className="text-muted-foreground text-xs">{reasonMessage}</p>
          )}
        </div>
      </section>

      <section className="border-border bg-card rounded-xl border p-5">
        <h3 className="text-foreground text-sm font-semibold">
          {t('triggerListTitle')}
        </h3>
        <ul className="mt-3 space-y-3">
          <li className="flex items-start gap-3">
            <span
              aria-hidden
              className="bg-primary/10 text-primary mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
            >
              <Bell className="h-3.5 w-3.5" />
            </span>
            <div>
              <p className="text-foreground text-sm font-medium">
                {t('triggerAssigned')}
              </p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t('triggerAssignedDesc')}
              </p>
            </div>
          </li>
        </ul>
      </section>

      <section className="border-border bg-card/50 rounded-xl border p-5">
        <h3 className="text-foreground text-sm font-semibold">
          {t('inAppTitle')}
        </h3>
        <p className="text-muted-foreground mt-1 text-xs">{t('inAppDesc')}</p>
      </section>

      <p className="text-muted-foreground text-xs">
        {tCommon('sections.notifications')} · W3C Web Push
        <ExternalLink
          aria-hidden
          className="ml-1 inline h-3 w-3 align-text-bottom"
        />
      </p>
    </div>
  );
}

function StatusRow({
  isSubscribed,
  disabled,
  label,
}: {
  isSubscribed: boolean;
  disabled: boolean;
  label: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
          isSubscribed
            ? 'bg-primary/15 text-primary'
            : 'bg-muted text-muted-foreground'
        )}
      >
        {isSubscribed ? (
          <Check className="h-4 w-4" />
        ) : (
          <BellOff className="h-4 w-4" />
        )}
      </span>
      <div className="min-w-0">
        <p
          className={cn(
            'text-sm font-medium',
            disabled ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          {label}
        </p>
      </div>
    </div>
  );
}
