'use client';

// ============================================================
// MemberAccessDialog
//
// Two modes, one form:
//
//   add      — create a teammate's login directly: email + password
//              + role. The account is confirmed on the spot — no
//              invite link, no email confirmation — so the admin can
//              hand the credentials over directly (the agent may not
//              have access to that mailbox).
//
//   activate — take over an account that exists but never confirmed
//              its email: confirm it, set the password they sign in
//              with, and bring them into the team with a role.
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, UserPlus, UserCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslations } from 'next-intl';

import { MIN_PASSWORD_LENGTH, isValidEmail } from '@/lib/auth/credentials';

type MemberRole = 'admin' | 'agent' | 'viewer';

/** An account waiting to be confirmed by an admin. */
export interface PendingAccount {
  user_id: string;
  email: string;
}

interface MemberAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create/activation so the parent
   *  re-fetches the roster. */
  onCreated: () => void;
  /** When set, the dialog activates this pending account instead of
   *  creating a new one. */
  activate?: PendingAccount | null;
}

export function MemberAccessDialog({
  open,
  onOpenChange,
  onCreated,
  activate = null,
}: MemberAccessDialogProps) {
  const t = useTranslations('Settings.addMember');
  const tRoles = useTranslations('Settings.roles');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<MemberRole>('agent');
  const [submitting, setSubmitting] = useState(false);

  const isActivate = !!activate;

  // Seed the form when the dialog opens (or switches to the pending
  // account it was opened for).
  useEffect(() => {
    if (!open) return;
    setEmail(activate?.email ?? '');
    setPassword('');
    setFullName('');
    setRole('agent');
  }, [open, activate]);

  function reset() {
    setEmail('');
    setPassword('');
    setFullName('');
    setRole('agent');
    setSubmitting(false);
  }

  async function handleSubmit() {
    const trimmedEmail = email.trim();
    if (!isActivate && !isValidEmail(trimmedEmail)) {
      toast.error(t('invalidEmail'));
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      toast.error(t('passwordTooShort', { min: MIN_PASSWORD_LENGTH }));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        isActivate
          ? `/api/account/members/${encodeURIComponent(activate!.user_id)}/activate`
          : '/api/account/members',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            isActivate
              ? { role, password }
              : {
                  email: trimmedEmail,
                  password,
                  role,
                  fullName: fullName.trim() || undefined,
                }
          ),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('createFailed'));
        return;
      }
      toast.success(
        isActivate
          ? t('activatedToast', { email: activate!.email })
          : t('createdToast', { name: fullName.trim() || trimmedEmail })
      );
      reset();
      onOpenChange(false);
      onCreated();
    } catch {
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="bg-popover border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground flex items-center gap-2">
            {isActivate ? (
              <UserCheck className="text-primary size-4" />
            ) : (
              <UserPlus className="text-primary size-4" />
            )}
            {isActivate ? t('activateTitle') : t('dialogTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {isActivate ? t('activateDesc') : t('dialogDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label
              className="text-muted-foreground"
              htmlFor="member-access-email"
            >
              {t('emailLabel')}
            </Label>
            <Input
              id="member-access-email"
              type="email"
              autoComplete="off"
              placeholder="agent@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isActivate}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground disabled:opacity-60"
            />
          </div>

          {!isActivate && (
            <div className="space-y-2">
              <Label
                className="text-muted-foreground"
                htmlFor="member-access-name"
              >
                {t('nameLabel')}{' '}
                <span className="text-muted-foreground text-xs">
                  {t('optional')}
                </span>
              </Label>
              <Input
                id="member-access-name"
                autoComplete="off"
                placeholder={t('namePlaceholder')}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
          )}

          <div className="space-y-2">
            <Label
              className="text-muted-foreground"
              htmlFor="member-access-password"
            >
              {isActivate ? t('activatePasswordLabel') : t('passwordLabel')}
            </Label>
            <Input
              id="member-access-password"
              type="password"
              autoComplete="new-password"
              placeholder={t('passwordPlaceholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
            <p className="text-muted-foreground text-xs">
              {isActivate ? t('activatePasswordHint') : t('passwordHint')}
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('roleLabel')}</Label>
            <Select
              value={role}
              onValueChange={(v) => v && setRole(v as MemberRole)}
            >
              <SelectTrigger className="bg-muted border-border text-foreground w-full">
                <SelectValue>{tRoles(role)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">{tRoles('admin')}</SelectItem>
                <SelectItem value="agent">{tRoles('agent')}</SelectItem>
                <SelectItem value="viewer">{tRoles('viewer')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter className="bg-popover border-border">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('creating')}
              </>
            ) : isActivate ? (
              t('activateBtn')
            ) : (
              t('createBtn')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
