// UI language (Mac: Model/Localization.swift). Every text in the code is written as L("日本語", "English"); the other
// languages are tables keyed by the English text (src/core/locales/<code>.json). An English text with values in it
// (`${n} bars`) gets its key at build time (scripts/i18n.mjs): "{0} bars", with the values passed along.
// "system" follows the OS language.
export type AppLanguage = 'system' | 'japanese' | 'english' | 'zh-Hans' | 'zh-Hant' | 'ko' | 'es' | 'fr' | 'de' | 'it' | 'pt' | 'ru';

/** The languages offered, with their own names (the language menu). */
export const languages: { id: Exclude<AppLanguage, 'system'>; name: string; tag: string }[] = [
  { id: 'japanese', name: '日本語', tag: 'ja' },
  { id: 'english', name: 'English', tag: 'en' },
  { id: 'zh-Hans', name: '简体中文', tag: 'zh-Hans' },
  { id: 'zh-Hant', name: '繁體中文', tag: 'zh-Hant' },
  { id: 'ko', name: '한국어', tag: 'ko' },
  { id: 'es', name: 'Español', tag: 'es' },
  { id: 'fr', name: 'Français', tag: 'fr' },
  { id: 'de', name: 'Deutsch', tag: 'de' },
  { id: 'it', name: 'Italiano', tag: 'it' },
  { id: 'pt', name: 'Português', tag: 'pt' },
  { id: 'ru', name: 'Русский', tag: 'ru' },
];

/** The language for an OS locale ("ja-JP", "zh-TW", "pt-BR", …). */
export function languageForLocale(locale: string): Exclude<AppLanguage, 'system'> {
  const l = locale.toLowerCase();
  if (l.startsWith('ja')) return 'japanese';
  if (l.startsWith('zh')) return /hant|tw|hk|mo/.test(l) ? 'zh-Hant' : 'zh-Hans';
  for (const x of ['ko', 'es', 'fr', 'de', 'it', 'pt', 'ru'] as const) if (l.startsWith(x)) return x;
  return 'english';
}

const tables = new Map<string, Record<string, string>>();
/** Adds a language's table (src/core/locales). */
export function registerLanguage(id: string, table: Record<string, string>) { tables.set(id, table); }

let current: Exclude<AppLanguage, 'system'> = 'japanese';

export function setLanguage(lang: AppLanguage, systemLocale = 'ja') {
  current = lang === 'system' ? languageForLocale(systemLocale) : (languages.some(x => x.id === lang) ? lang : 'english') as Exclude<AppLanguage, 'system'>;
}

/** `fn`'s text in every language (to recognise a stored text that was made in another language). */
export function inEveryLanguage(fn: () => string): string[] {
  const keep = current;
  try { return languages.map(x => { current = x.id; return fn(); }); } finally { current = keep; }
}

/**
 * A name DJAW made itself and stored (a cue "CUE 3", a take "Take 2", a new folder…), shown in the language in
 * effect: if `stored` is `make(n)` in any language (for any n), it is made again now; otherwise (the user named it)
 * it is shown as it is. `make` gets the number as text, or '' when the name has none.
 */
export function reLocalize(stored: string, make: (n: string) => string): string {
  const mark = '\u0001';
  for (const template of new Set(inEveryLanguage(() => make(mark)))) {
    const at = template.indexOf(mark);
    if (at < 0) { if (template === stored) return make(''); continue; }
    const head = template.slice(0, at), tail = template.slice(at + mark.length);
    if (stored.length > head.length + tail.length && stored.startsWith(head) && stored.endsWith(tail)) {
      const n = stored.slice(head.length, stored.length - tail.length);
      if (/^\d+$/.test(n)) return make(n);
    }
  }
  return stored;
}

/** The language in effect ('system' resolved). */
export function currentLanguage(): Exclude<AppLanguage, 'system'> { return current; }
/** BCP-47 tag of the language in effect (for <html lang>, number formats). */
export const languageTag = () => languages.find(x => x.id === current)?.tag ?? 'en';

/** Anything but Japanese (texts that exist only in Japanese and English use the English one). */
export function isEnglish() { return current !== 'japanese'; }

// Stored texts (notes kept in a mix) can carry every language: while capturing, L returns a marker holding the
// Japanese, the English, the key and the values; `localize` turns it into the language in effect when shown.
const START = '', SEP = '', END = '';
let capturing = 0;
/** Runs `fn` so that the texts it makes carry every language (see `localize`). */
export function captureLanguages<T>(fn: () => T): T {
  capturing++;
  try { return fn(); } finally { capturing--; }
}

function format(t: string, args: unknown[] | undefined) {
  return args ? t.replace(/\{(\d+)\}/g, (m, i) => (Number(i) < args.length ? String(args[Number(i)]) : m)) : t;
}

/** The text for the language in effect. `key` / `args`: added by the build for English texts with values in them. */
export function L(japanese: string, englishText: string, key?: string, args?: unknown[]): string {
  if (capturing) return START + japanese + SEP + englishText + SEP + (key ?? '') + SEP + JSON.stringify(args ?? null) + END;
  if (current === 'japanese') return japanese;
  const table = current === 'english' ? undefined : tables.get(current);
  if (!table) return englishText;
  const t = table[key ?? englishText];
  return t == null ? englishText : format(t, args);
}

/** A stored text in the language in effect (texts made with `captureLanguages`; anything else stays as it is). */
export function localize(s: string): string {
  if (!s || s.indexOf(START) < 0) return s;
  let out = '', i = 0;
  while (i < s.length) {
    const a = s.indexOf(START, i);
    if (a < 0) { out += s.slice(i); break; }
    out += s.slice(i, a);
    // The matching end (markers nest when a value is itself a marked text).
    let depth = 0, b = a;
    for (; b < s.length; b++) {
      if (s[b] === START) depth++;
      else if (s[b] === END && --depth === 0) break;
    }
    const parts = splitTop(s.slice(a + 1, b));
    if (parts.length === 4) {
      let args: unknown[] | null = null;
      try { args = JSON.parse(parts[3]); } catch { args = null; }
      const local = (x: unknown) => (typeof x === 'string' ? localize(x) : x);
      out += L(localize(parts[0]), localize(parts[1]), parts[2] || undefined, args ? args.map(local) : undefined);
    } else out += s.slice(a, b + 1);
    i = b + 1;
  }
  return out;
}

/** Splits on the separators at the top level (not inside nested markers). */
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === START) depth++;
    else if (s[i] === END) depth--;
    else if (s[i] === SEP && depth === 0) { parts.push(s.slice(from, i)); from = i + 1; }
  }
  parts.push(s.slice(from));
  return parts;
}
