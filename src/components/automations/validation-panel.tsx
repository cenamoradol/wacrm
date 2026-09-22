'use client';

/**
 * Validation panel — surfaces every activation issue inline so users
 * see exactly which field to fix, instead of an opaque "N issues to fix"
 * counter. Mirrors the same `Issues` shape used in the flows builder,
 * just without the per-node severity split (autos validations are all
 * errors — there's no warning severity today).
 */

import { CircleAlert, CircleCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ValidationIssue } from '@/lib/automations/validate';

export function AutomationValidationPanel({
  issues,
}: {
  issues: ValidationIssue[];
}) {
  if (issues.length === 0) {
    return (
      <div
        role="status"
        className="bg-background flex items-center gap-2 rounded-lg border border-emerald-600/50 p-3 text-sm font-medium text-emerald-300"
      >
        <CircleCheck className="h-4 w-4 shrink-0" />
        Ready to activate.
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="bg-background rounded-lg border border-red-500/40 p-3"
    >
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-red-300">
        <CircleAlert className="h-4 w-4 shrink-0 text-red-400" />
        {issues.length === 1
          ? '1 issue to fix before activation:'
          : `${issues.length} issues to fix before activation:`}
      </div>
      <div className="flex flex-col gap-1">
        {issues.map((i, ix) => (
          <div
            key={ix}
            className="flex items-start gap-2 rounded-md px-2 py-1 text-xs text-red-300"
          >
            <CircleAlert className="mt-0.5 h-3 w-3 shrink-0 text-red-400" />
            <span className="min-w-0 flex-1">
              <code className="bg-muted text-muted-foreground mr-1 rounded px-1 py-0.5 text-[10px]">
                {i.path}
              </code>
              {i.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
