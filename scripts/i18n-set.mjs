// Changes single translations in the part files: node scripts/i18n-set.mjs '<lang>' '<English key>' '<translation>' …
// (then run i18n-merge.mjs). Parts: c<N>_cjk (zh-Hans, zh-Hant, ko), c<N>_eu1 (es, fr, de), c<N>_eu2 (it, pt, ru).
import fs from 'node:fs';
import path from 'node:path';
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'core', 'locales');
const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, '_source.json'), 'utf8')));
const group = { 'zh-Hans': 'cjk', 'zh-Hant': 'cjk', ko: 'cjk', es: 'eu1', fr: 'eu1', de: 'eu1', it: 'eu2', pt: 'eu2', ru: 'eu2' };
const CHUNK = 200, parts = Math.max(1, Math.floor(keys.length / CHUNK));
const a = process.argv.slice(2);
if (a.length % 3) throw new Error('give lang, key, translation triples');
for (let i = 0; i < a.length; i += 3) {
  const [lang, key, value] = a.slice(i, i + 3);
  const k = keys.indexOf(key);
  if (k < 0) throw new Error('no such key: ' + key);
  const n = Math.min(Math.floor(k / CHUNK), parts - 1);
  const file = path.join(dir, '_parts', `c${n}_${group[lang]}.json`);
  const part = JSON.parse(fs.readFileSync(file, 'utf8'));
  part[lang][k - n * CHUNK] = value;
  fs.writeFileSync(file, '{\n' + Object.keys(part).map(l => JSON.stringify(l) + ': ' + JSON.stringify(part[l])).join(',\n') + '\n}\n');
  console.log(`${lang} ${JSON.stringify(key)} → ${JSON.stringify(value)} (${path.basename(file)})`);
}
