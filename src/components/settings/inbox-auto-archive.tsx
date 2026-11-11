'use client';

/**
 * Inbox auto-archive settings.
 *
 * Account-wide switch that closes conversations that went quiet after
 * an agent replied, and (while the customer is still inside Meta's
 * 24-hour window) tells them the chat was closed and they can write
 * again whenever they want.
 *
 * The work itself happens in the cron sweep — see
 * `src/lib/inbox/auto-archive.ts`. This panel only edits the three
 * `accounts` columns the sweep reads. Writes go straight to `accounts`;
 * the `accounts_update` RLS policy (migration 017) already restricts
 * that to admins+, so non-admins see disabled, read-only controls.
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Clock, Loader2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useTranslations } from 'next-intl';

export function InboxAutoArchiveSettings() {
  // Memoised so the effect below can depend on it — `createClient()`
  // is a singleton, but the reference has to be stable for the deps
  // array to be honest.
  const supabase = useMemo(() => createClient(), []);
  const { accountId, canEditSettings, profileLoading } = useAuth();
  const t = useTranslations('Settings.autoArchive');

  const [enabled, setEnabled] = useState(false);
  const [hours, setHours] = useState('2');
  const [message, setMessage] = useState('');
  /** Values as loaded from the DB — the save button only lights up
   * when something actually changed. */
  const [loaded, setLoaded] = useState({
    enabled: false,
    hours: '2',
    message: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('accounts')
        .select(
          'auto_archive_enabled, auto_archive_after_hours, auto_archive_message'
        )
        .eq('id', accountId)
        .maybeSingle();

      if (cancelled) return;
      if (error) {
        toast.error(t('loadFailed'));
        setLoading(false);
        return;
      }
      setEnabled(data?.auto_archive_enabled ?? false);
      setHours(String(data?.auto_archive_after_hours ?? 2));
      setMessage(data?.auto_archive_message ?? '');
      setLoaded({
        enabled: data?.auto_archive_enabled ?? false,
        hours: String(data?.auto_archive_after_hours ?? 2),
        message: data?.auto_archive_message ?? '',
      });
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId, supabase, t]);

  const hoursValue = Number(hours);
  const hoursValid = Number.isFinite(hoursValue) && hoursValue > 0;
  const dirty =
    enabled !== loaded.enabled ||
    hoursValue !== Number(loaded.hours) ||
    message.trim() !== loaded.message.trim();

  async function handleSave() {
    if (!accountId || saving) return;
    if (!hoursValid) {
      toast.error(t('invalidHours'));
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from('accounts')
      .update({
        auto_archive_enabled: enabled,
        auto_archive_after_hours: hoursValue,
        auto_archive_message: message.trim(),
      })
      .eq('id', accountId);
    if (error) {
      toast.error(t('saveFailed'));
    } else {
      setLoaded({ enabled, hours, message: message.trim() });
      toast.success(t('saveSuccess'));
    }
    setSaving(false);
  }

  if (profileLoading || loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground flex items-center gap-2">
            <Clock className="text-primary size-4" />
            {t('title')}
          </CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
            <div>
              <Label htmlFor="auto-archive-enabled">{t('enable')}</Label>
              <p className="text-muted-foreground text-xs">{t('enableDesc')}</p>
            </div>
            <Switch
              id="auto-archive-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={!canEditSettings}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="auto-archive-hours">{t('hours')}</Label>
            <Input
              id="auto-archive-hours"
              type="number"
              min={0.5}
              step={0.5}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              disabled={!canEditSettings}
              className="w-32"
            />
            <p className="text-muted-foreground text-xs">{t('hoursDesc')}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="auto-archive-message">{t('message')}</Label>
            <Textarea
              id="auto-archive-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={!canEditSettings}
              rows={3}
              placeholder={t('messagePlaceholder')}
            />
            <p className="text-muted-foreground text-xs">{t('messageDesc')}</p>
          </div>

          {!canEditSettings && (
            <p className="text-muted-foreground text-xs">
              {t('adminOnlyHint')}
            </p>
          )}

          <Button
            onClick={handleSave}
            disabled={!canEditSettings || saving || !dirty}
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('save')
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
