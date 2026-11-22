// Joins translation parts (src/core/locales/_parts/c<N>_<group>.json: { "<lang>": [texts in _source.json order,
// from N×200] }) into the tables src/core/locales/<lang>.json, checking each text keeps the {0}… of its key.
import fs from 'node:fs';
import path from 'node:path';

const dir = 'src/core/locales', parts = path.join(dir, '_parts');
const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, '_source.json'), 'utf8')));
const CHUNK = 200;
const tables = {};
let problems = 0;
const holes = s => new Set([...s.matchAll(/\{(\d+)\}/g)].map(m => m[1]));
// A translation may leave a value out (an English plural "s"), never add one.
const fits = (t, k) => [...holes(t)].every(h => holes(k).has(h));
for (const f of fs.readdirSync(parts).filter(f => /^c\d+_.+\.json$/.test(f)).sort()) {
  const n = Number(f.match(/^c(\d+)_/)[1]);
  const data = JSON.parse(fs.readFileSync(path.join(parts, f), 'utf8'));
  for (const [lang, list] of Object.entries(data)) {
    const want = Math.min(CHUNK, keys.length - n * CHUNK);
    if (list.length !== want) { console.log(`${f} ${lang}: ${list.length} texts, want ${want}`); problems++; }
    const t = (tables[lang] ??= {});
    list.forEach((s, i) => {
      const key = keys[n * CHUNK + i];
      if (key == null) return;
      if (!fits(s, key)) { console.log(`${f} ${lang} #${n * CHUNK + i}: ${JSON.stringify(key)} → ${JSON.stringify(s)}`); problems++; }
      t[key] = s;
    });
  }
}
for (const [lang, t] of Object.entries(tables)) {
  fs.writeFileSync(path.join(dir, `${lang}.json`), JSON.stringify(t, null, 1) + '\n');
  console.log(`${lang}: ${Object.keys(t).length}/${keys.length}`);
}
if (problems) { console.log(`${problems} problem(s)`); process.exit(1); }
