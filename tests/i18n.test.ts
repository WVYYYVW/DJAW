// Languages (src/core/i18n.ts): tables keyed by the English text, values filled in, stored texts in every language.
import test from 'node:test';
import assert from 'node:assert/strict';
import { L, captureLanguages, languageForLocale, localize, registerLanguage, setLanguage } from '../src/core/i18n';

test('a table translates by the English text, with the values the build passes along', () => {
  registerLanguage('de', { Export: 'Exportieren', '{0} bars': '{0} Takte' });
  setLanguage('de');
  const n = 8;
  assert.equal(L('書き出し', 'Export'), 'Exportieren');
  assert.equal(L(`${n}小節`, `${n} bars`), '8 Takte'); // keyed at build time: L(…, "{0} bars", [n])
  assert.equal(L('未訳', 'Not translated'), 'Not translated');
  setLanguage('japanese');
  assert.equal(L(`${n}小節`, `${n} bars`), '8小節');
  setLanguage('english');
  assert.equal(L(`${n}小節`, `${n} bars`), '8 bars');
});

test('texts made while capturing read in the language in effect when shown', () => {
  registerLanguage('fr', { 'Bass swap': 'Échange de basses', 'Over {0} bars': 'Sur {0} mesures' });
  setLanguage('japanese');
  const bars = 16;
  const note = captureLanguages(() => [L('ベーススワップ', 'Bass swap'), L(`${bars}小節かけて`, `Over ${bars} bars`)].join('\n'));
  assert.equal(localize(note), 'ベーススワップ\n16小節かけて');
  setLanguage('english');
  assert.equal(localize(note), 'Bass swap\nOver 16 bars');
  setLanguage('fr');
  assert.equal(localize(note), 'Échange de basses\nSur 16 mesures');
  assert.equal(localize('plain text'), 'plain text');
  setLanguage('japanese');
});

test('the OS locale picks the language', () => {
  assert.equal(languageForLocale('ja-JP'), 'japanese');
  assert.equal(languageForLocale('zh-TW'), 'zh-Hant');
  assert.equal(languageForLocale('zh-CN'), 'zh-Hans');
  assert.equal(languageForLocale('pt-BR'), 'pt');
  assert.equal(languageForLocale('nl-NL'), 'english');
});
