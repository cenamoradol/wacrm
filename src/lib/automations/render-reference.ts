// ============================================================
// Reference vocabulary renderer for the `extract_vars` step.
//
// Universal: takes any value the prior step left in vars (typically a
// `send_webhook` JSON response) and turns it into a compact, prompt-
// safe text block the LLM can scan while matching customer text.
//
// Truncation is deliberately hard at 8 KB — a reference vocabulary
// the LLM has to *match against* is no good if it never fits in the
// context window, and the catalog for a single business fits well
// under that.
// ============================================================

/** Hard cap on reference vocabulary text size. Generous for any
 *  catalog a small business actually maintains; truncates beyond. */
const MAX_REFERENCE_CHARS = 8 * 1024;

const TRUNCATION_MARKER = '\n... [truncated]';

/**
 * Render a reference value for inclusion in the LLM prompt. Pretty-
 * prints objects/arrays so the LLM can scan the structure; passes
 * strings through verbatim. Numbers/booleans become text. Anything
 * `null` / `undefined` / empty yields an empty string so the caller
 * can skip injection cleanly.
 *
 * Truncates output at 8 KB with a `[truncated]` marker so a runaway
 * webhook response can't blow the prompt budget.
 */
export function renderReference(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return truncate(raw);
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return truncate(String(raw));
  }
  // Anything else (object, array) → pretty JSON.
  try {
    return truncate(JSON.stringify(raw, null, 2));
  } catch {
    // Circular structures / BigInt etc. — best-effort string fallback.
    return truncate(String(raw));
  }
}

function truncate(s: string): string {
  if (s.length <= MAX_REFERENCE_CHARS) return s;
  return s.slice(0, MAX_REFERENCE_CHARS) + TRUNCATION_MARKER;
}

/**
 * Resolve a `reference_path` expression against a vars root, mirroring
 * the same path syntax `interpolate()` accepts (`vars.x.y[0]`). Returns
 * the raw value at that path, or `undefined` when the path doesn't
 * resolve (so the caller can decide to skip injection).
 *
 * Kept separate from `interpolate()` because we want the raw value, not
 * a stringified version — the renderer does its own pretty-printing.
 */
export function resolveReferencePath(vars: unknown, rawPath: string): unknown {
  const path = rawPath.trim();
  if (!path) return undefined;
  const stripped =
    path.startsWith('vars.') || path === 'vars'
      ? path.replace(/^vars\.?/, '')
      : path;
  if (!stripped) return undefined;
  const parts: Array<string | number> = [];
  for (const segment of stripped.split('.')) {
    const m = segment.match(/^([\w]+)((?:\[\d+\])+)$/);
    if (m) {
      parts.push(m[1]);
      for (const idx of segment.matchAll(/\[(\d+)\]/g)) {
        parts.push(Number(idx[1]));
      }
    } else {
      parts.push(segment);
    }
  }
  return resolvePath(vars, parts);
}

function resolvePath(root: unknown, parts: Array<string | number>): unknown {
  let value: unknown = root;
  for (const part of parts) {
    if (value == null) return undefined;
    if (typeof part === 'number') {
      if (!Array.isArray(value)) return undefined;
      value = value[part];
    } else {
      if (typeof value !== 'object') return undefined;
      value = (value as Record<string, unknown>)[part];
    }
  }
  return value;
}
