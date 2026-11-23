// Translations for L("日本語", "English") (src/core/i18n.ts).
//
//   keyed(source)   the build's transform: an English text with values in it — L(`…`, `${n} bars`) — becomes
//                   L(`…`, `${n} bars`, "{0} bars", [n]) so the other languages can look it up by "{0} bars".
//   node scripts/i18n.mjs extract
//                   writes src/core/locales/_source.json: every key with its Japanese (for translating), and
//                   lists the keys each language's table is missing.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const isL = n => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'L' && n.arguments.length >= 2;

/** "{0} bars" for `${n} bars` (and the value expressions). */
function templateKey(t) {
  if (ts.isNoSubstitutionTemplateLiteral(t) || ts.isStringLiteral(t)) return { key: t.text, args: [] };
  let key = t.head.text;
  const args = [];
  t.templateSpans.forEach((s, i) => { key += `{${i}}` + s.literal.text; args.push(s.expression); });
  return { key, args };
}

function parse(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Adds keys and values to L calls whose English text has values; null when nothing changed. */
export function keyed(file, text) {
  if (!text.includes('L(')) return null;
  let changed = false;
  // Inner calls first: a value can itself be an L(…) (copied into the outer call's value list as written).
  for (let pass = 0; pass < 8; pass++) {
    const sf = parse(file, text);
    const edits = [];
    const visit = (n, insideOpen) => {
      let open = false;
      if (isL(n) && n.arguments.length === 2 && ts.isTemplateExpression(n.arguments[1])) open = true;
      let childOpen = false;
      ts.forEachChild(n, c => { if (visit(c, insideOpen || open)) childOpen = true; });
      if (open && !childOpen) {
        const { key, args } = templateKey(n.arguments[1]);
        edits.push({ pos: n.arguments[1].end, text: `, ${JSON.stringify(key)}, [${args.map(a => a.getText(sf)).join(', ')}]` });
      }
      return open || childOpen;
    };
    visit(sf, false);
    if (!edits.length) break;
    edits.sort((a, b) => b.pos - a.pos);
    for (const e of edits) text = text.slice(0, e.pos) + e.text + text.slice(e.pos);
    changed = true;
  }
  return changed ? text : null;
}

/** Every text in the sources: key → Japanese (with {0}… where the English has values). */
export function collect(root = 'src') {
  const out = {};
  const files = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) files.push(p); } })(root);
  for (const f of files) {
    const sf = parse(f, fs.readFileSync(f, 'utf8'));
    (function v(n) {
      if (isL(n)) {
        const en = n.arguments[1], ja = n.arguments[0];
        if (ts.isStringLiteral(en) || ts.isNoSubstitutionTemplateLiteral(en) || ts.isTemplateExpression(en)) {
          const { key, args } = templateKey(en);
          let jaText = ts.isStringLiteral(ja) || ts.isNoSubstitutionTemplateLiteral(ja) ? ja.text : ts.isTemplateExpression(ja) ? templateKey(ja).key : ja.getText(sf);
          // Number the Japanese values like the English ones where the expressions match.
          if (ts.isTemplateExpression(ja) && args.length) {
            const enArgs = args.map(a => a.getText(sf));
            const jt = templateKey(ja);
            let s = ja.head.text;
            ja.templateSpans.forEach((sp, i) => { const k = enArgs.indexOf(sp.expression.getText(sf)); s += (k >= 0 ? `{${k}}` : `{${i}?}`) + sp.literal.text; });
            jaText = s; void jt;
          }
          if (!(key in out)) out[key] = jaText;
        }
      }
      ts.forEachChild(n, v);
    })(sf);
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('i18n.mjs') && process.argv[2] === 'extract') {
  const found = collect();
  const dir = 'src/core/locales';
  fs.mkdirSync(dir, { recursive: true });
  // Keys keep their places (the translation parts are numbered by place): known keys first, in their old order
  // (also ones no longer used — dropping them would shift every key after them), then new keys at the end.
  const sourceFile = path.join(dir, '_source.json');
  const old = fs.existsSync(sourceFile) ? JSON.parse(fs.readFileSync(sourceFile, 'utf8')) : {};
  const src = { ...old };
  for (const [k, v] of Object.entries(found)) src[k] = v;
  const unused = Object.keys(old).filter(k => !(k in found)).length;
  if (unused) console.log(`${unused} texts no longer used (kept in place)`);
  fs.writeFileSync(path.join(dir, '_source.json'), JSON.stringify(src, null, 1) + '\n');
  const keys = Object.keys(src);
  console.log(`${keys.length} texts`);
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'))) {
    const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const missing = keys.filter(k => !(k in t));
    console.log(`${f}: ${keys.length - missing.length}/${keys.length}${missing.length ? `, missing ${missing.length}` : ''}`);
  }
}
