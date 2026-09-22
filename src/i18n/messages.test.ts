import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseIcu } from '@formatjs/icu-messageformat-parser';

// Locale dictionaries are hand-maintained. English is the source of
// truth (src/i18n/request.ts falls back to en.json only when a whole
// locale file is missing — there is no per-key fallback), so a key
// that lands in en.json and not in a translation renders as a raw
// keypath for users on that locale. This guards the parity.

const MESSAGES_DIR = join(process.cwd(), 'messages');
const SOURCE_LOCALE = 'en';
const TRANSLATED_LOCALES = ['ko'];

function loadKeys(locale: string): Set<string> {
  const raw = readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8');
  const out = new Set<string>();
  const walk = (node: unknown, path: string) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) {
        walk(v, path ? `${path}.${k}` : k);
      }
      return;
    }
    out.add(path);
  };
  walk(JSON.parse(raw), '');
  return out;
}

describe('message catalogue parity', () => {
  const source = loadKeys(SOURCE_LOCALE);

  it.each(TRANSLATED_LOCALES)('%s.json covers every en.json key', (locale) => {
    const translated = loadKeys(locale);
    const missing = [...source].filter((k) => !translated.has(k)).sort();
    expect(missing, `${locale}.json is missing these keys`).toEqual([]);
  });

  it.each(TRANSLATED_LOCALES)('%s.json has no orphaned keys', (locale) => {
    const translated = loadKeys(locale);
    const orphaned = [...translated].filter((k) => !source.has(k)).sort();
    expect(orphaned, `${locale}.json has keys absent from en.json`).toEqual([]);
  });

  // Strings passed to next-intl's `t()` are parsed as ICU MessageFormat.
  // Bare `{` outside a single-quoted region is invalid (`{{` is NOT an
  // escape in this parser). Hints/examples that want to show literal
  // `{{ loop.title }}` must wrap the body in `'...'` (ICU quoted literal),
  // and `**` is rejected inside quotes too. This catches strings that
  // would surface as `INVALID_MESSAGE: MALFORMED_ARGUMENT` at render.
  // Scoped to the new list-mode keys added for `send_message` so we
  // don't trip over pre-existing strings with patterns ICU doesn't
  // accept (those are a separate, pre-existing concern).
  const LIST_MODE_KEYS = [
    'Automations.builder.config.messageTextListHint',
    'Automations.builder.config.messageListPathLabel',
    'Automations.builder.config.messageListPathPlaceholder',
    'Automations.builder.config.messageListPathHint',
    'Automations.builder.config.messageItemTemplateLabel',
    'Automations.builder.config.messageItemTemplatePlaceholder',
    'Automations.builder.config.messageItemTemplateHint',
  ];

  it.each([SOURCE_LOCALE, ...TRANSLATED_LOCALES])(
    '%s.json: send_message list-mode strings parse as ICU MessageFormat',
    (locale) => {
      const raw = readFileSync(
        join(MESSAGES_DIR, `${locale}.json`),
        'utf8'
      );
      const tree: unknown = JSON.parse(raw);
      const get = (key: string): unknown => {
        let cur: unknown = tree;
        for (const seg of key.split('.')) {
          if (cur && typeof cur === 'object') {
            cur = (cur as Record<string, unknown>)[seg];
          } else {
            return undefined;
          }
        }
        return cur;
      };
      const bad: string[] = [];
      for (const key of LIST_MODE_KEYS) {
        const value = get(key);
        if (typeof value !== 'string') {
          bad.push(`  ${key}: missing or not a string`);
          continue;
        }
        try {
          parseIcu(value);
        } catch (err) {
          const code = (err as { code?: string }).code ?? 'UNKNOWN';
          bad.push(
            `  ${key}: [${code}] ${(err as Error).message}\n    value: ${JSON.stringify(value).slice(0, 200)}`
          );
        }
      }
      expect(
        bad,
        bad.length === 0
          ? 'all list-mode strings parse OK'
          : `${locale}.json has ${bad.length} unparseable list-mode strings:\n${bad.join('\n')}`
      ).toEqual([]);
    }
  );
});
