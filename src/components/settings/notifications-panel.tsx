"use client";

/**
 * NotificationsPanel — toggle for the W3C Web Push subscription.
 * Renders a "not configured" notice when the server doesn't have
 * VAPID keys (NEXT_PUBLIC_VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY).
 *
 * The in-app notification feed (the bell badge in the sidebar) is
 * always on and isn't surfaced here — this panel is strictly about
 * the OS-level browser push channel.
 */

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Bell, BellOff, Loader2, Check, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useWebPush } from "@/components/notifications/webpush-bootstrap";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

export function NotificationsPanel() {
  const t = useTranslations("Settings.notifications");
  const tCommon = useTranslations("Settings");
  const { status, isSubscribed, subscribe, unsubscribe, error } =
    useWebPush();
  const [pending, setPending] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch — status changes after the bootstrap
  // finishes on the client. The first render mirrors what the server
  // would have produced (no subscription, push disabled), then the
  // real state catches up on mount.
  useEffect(() => setMounted(true), []);

  const configMissing = !VAPID_PUBLIC_KEY;
  const reasonMessage = (() => {
    if (!mounted) return null;
    if (configMissing) return t("disabledByAdmin");
    if (status === "insecure-origin") return t("insecureOrigin");
    if (status === "unsupported") return error ?? t("unsupported");
    if (status === "error") return error ?? t("unsupported");
    return null;
  })();

  const onToggle = async () => {
    if (pending) return;
    setPending(true);
    try {
      if (isSubscribed) {
        await unsubscribe();
        toast.success(t("disable"));
      } else {
        const ok = await subscribe();
        if (ok) toast.success(t("enable"));
        else toast.error(t("subscribeError"));
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t("title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <section className="rounded-xl border border-border bg-card p-5">
        <StatusRow
          isSubscribed={isSubscribed}
          disabled={!mounted || configMissing || status !== "ready"}
          label={
            isSubscribed
              ? t("enabled")
              : configMissing
                ? t("disabledByAdmin")
                : status === "unsupported"
                  ? error ?? t("unsupported")
                  : status === "insecure-origin"
                    ? t("insecureOrigin")
                    : status === "error"
                      ? error ?? t("unsupported")
                      : t("ready")
          }
        />

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            onClick={onToggle}
            disabled={
              pending ||
              !mounted ||
              configMissing ||
              status === "unsupported" ||
              status === "insecure-origin" ||
              status === "error" ||
              status === "loading" ||
              status === "disabled"
            }
            className={cn(
              "min-w-40",
              isSubscribed
                ? "bg-muted text-foreground hover:bg-muted/80"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isSubscribed ? (
              <BellOff className="h-4 w-4" />
            ) : (
              <Bell className="h-4 w-4" />
            )}
            {isSubscribed ? t("disable") : t("enable")}
          </Button>

          {reasonMessage && (
            <p className="text-xs text-muted-foreground">{reasonMessage}</p>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-sm font-semibold text-foreground">
          {t("triggerListTitle")}
        </h3>
        <ul className="mt-3 space-y-3">
          <li className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
            >
              <Bell className="h-3.5 w-3.5" />
            </span>
            <div>
              <p className="text-sm font-medium text-foreground">
                {t("triggerAssigned")}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("triggerAssignedDesc")}
              </p>
            </div>
          </li>
        </ul>
      </section>

      <section className="rounded-xl border border-border bg-card/50 p-5">
        <h3 className="text-sm font-semibold text-foreground">
          {t("inAppTitle")}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("inAppDesc")}</p>
      </section>

      <p className="text-xs text-muted-foreground">
        {tCommon("sections.notifications")} · W3C Web Push
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
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          isSubscribed ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
        )}
      >
        {isSubscribed ? <Check className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
      </span>
      <div className="min-w-0">
        <p
          className={cn(
            "text-sm font-medium",
            disabled ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {label}
        </p>
      </div>
    </div>
  );
}