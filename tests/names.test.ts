// Names DJAW stores by itself (src/core/defaultNames.ts) are shown in the language in effect, whichever language
// (or version) made them; names the user typed stay as they are.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/core/locales';
import { setLanguage } from '../src/core/i18n';
import { DefaultName, ShownName } from '../src/core/defaultNames';

test('default names come back in the language in effect', () => {
  setLanguage('japanese');
  const take = DefaultName.take(3), cue = DefaultName.cue(2), mine = DefaultName.myTransition(4), folder = DefaultName.folder();
  assert.equal(take, '候補 3');
  setLanguage('de');
  assert.equal(ShownName.take(take), 'Take 3');
  assert.equal(ShownName.cue(cue), 'Cue 2');
  assert.equal(ShownName.myTransition(mine), DefaultName.myTransition(4));
  assert.equal(ShownName.folder(folder), DefaultName.folder());
  assert.equal(ShownName.folder(`${folder} 2`), `${DefaultName.folder()} 2`);
  assert.equal(ShownName.take(DefaultName.previousTake()), DefaultName.previousTake());
  setLanguage('ko');
  assert.equal(ShownName.take('Take 12'), DefaultName.take(12));
  assert.notEqual(ShownName.take('Take 12'), 'Take 12');
  // Typed by the user: kept.
  assert.equal(ShownName.take('候補 A'), '候補 A');
  assert.equal(ShownName.folder('Hardcore'), 'Hardcore');
  assert.equal(ShownName.cue('drop!'), 'drop!');
  setLanguage('japanese');
});

test('built-in sampler sounds show their name in the language in effect, also under older names', () => {
  setLanguage('fr');
  const siren = ShownName.sample('siren.wav', 'Dub Siren');
  assert.notEqual(siren, 'Dub Siren');
  assert.equal(ShownName.sample('siren.wav', 'サイレン'), siren);            // 0.3.8–0.3.12
  assert.equal(ShownName.sample('siren.wav', 'ダブサイレン'), siren);
  assert.equal(ShownName.sample('air-horn-x3.wav', 'エアホーン ×3'), ShownName.sample('air-horn-x3.wav', 'Air Horn (ba-ba-baaa)'));
  assert.equal(ShownName.sample('air-horn.wav', 'Air Horn'), ShownName.sample('air-horn.wav', 'エアホーン（長く1回）'));
  assert.equal(ShownName.sample('siren.wav', 'My siren'), 'My siren');        // renamed
  assert.equal(ShownName.sample(null, 'サイレン'), 'サイレン');               // not a built-in sound
  setLanguage('japanese');
});
