'use client';

// ============================================================
// EditMemberDialog
//
// Corrects a member's login details: change their email, set a new
// password, or both. The agent may never get access to their
// mailbox, so the team admin is the recovery path.
//
// The new password takes effect immediately — nothing is emailed.
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil } from 'lucide-react';

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
import { useTranslations } from 'next-intl';

import { MIN_PASSWORD_LENGTH, isValidEmail } from '@/lib/auth/credentials';

export interface EditableMember {
  user_id: string;
  email: string | null;
  full_name: string;
}

interface EditMemberDialogProps {
  /** The member being edited; null closes the dialog. */
  member: EditableMember | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function EditMemberDialog({
  member,
  onOpenChange,
  onSaved,
}: EditMemberDialogProps) {
  const t = useTranslations('Settings.editMember');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Seed the form from the member whenever the dialog opens.
  useEffect(() => {
    if (!member) return;
    setEmail(member.email ?? '');
    setPassword('');
  }, [member]);

  async function handleSave() {
    if (!member) return;
    const trimmedEmail = email.trim();
    if (!isValidEmail(trimmedEmail)) {
      toast.error(t('invalidEmail'));
      return;
    }
    if (password && password.length < MIN_PASSWORD_LENGTH) {
      toast.error(t('passwordTooShort', { min: MIN_PASSWORD_LENGTH }));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/account/members/${encodeURIComponent(member.user_id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: trimmedEmail,
            // An empty password means "leave it as is".
            password: password || undefined,
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return;
      }
      toast.success(
        t('savedToast', { name: member.full_name || trimmedEmail })
      );
      setPassword('');
      onOpenChange(false);
      onSaved();
    } catch {
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={member !== null}
      onOpenChange={(next) => {
        if (!next) {
          setPassword('');
          onOpenChange(false);
        }
      }}
    >
      <DialogContent className="bg-popover border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground flex items-center gap-2">
            <Pencil className="text-primary size-4" />
            {t('dialogTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('dialogDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label
              className="text-muted-foreground"
              htmlFor="edit-member-email"
            >
              {t('emailLabel')}
            </Label>
            <Input
              id="edit-member-email"
              type="email"
              autoComplete="off"
              placeholder="agent@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label
              className="text-muted-foreground"
              htmlFor="edit-member-password"
            >
              {t('passwordLabel')}
            </Label>
            <Input
              id="edit-member-password"
              type="password"
              autoComplete="new-password"
              placeholder={t('passwordPlaceholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
            <p className="text-muted-foreground text-xs">{t('passwordHint')}</p>
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
            onClick={handleSave}
            disabled={submitting}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('saveBtn')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
