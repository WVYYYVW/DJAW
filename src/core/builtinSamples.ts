// DJAW's own sampler sounds (assets/samples, made by scripts/make-samples.mjs — synthesised, so free to use
// anywhere: in mixes, live sets, uploads). The standard kit fills the 8 pads.
import { L } from './i18n';

export interface BuiltinSample { file: string; title: () => string; group: () => string; }

const fx = () => L('DJ エフェクト', 'DJ effects');
const sweeps = () => L('ライザー・スイープ', 'Risers & sweeps');
const drums = () => L('ドラム', 'Drums');

export const builtinSamples: BuiltinSample[] = [
  { file: 'air-horn-x3.wav', title: () => L('エアホーン（バ・バ・バーン）', 'Air Horn (ba-ba-baaa)'), group: fx },
  { file: 'air-horn.wav', title: () => L('エアホーン（長く1回）', 'Air Horn (one long)'), group: fx },
  { file: 'siren.wav', title: () => L('ダブサイレン', 'Dub Siren'), group: fx },
  { file: 'laser.wav', title: () => L('レーザー', 'Laser'), group: fx },
  { file: 'impact.wav', title: () => L('インパクト', 'Impact'), group: fx },
  { file: 'sub-drop.wav', title: () => L('サブドロップ', 'Sub Drop'), group: fx },
  { file: 'riser.wav', title: () => L('ライザー', 'Riser'), group: sweeps },
  { file: 'noise-sweep.wav', title: () => L('ノイズスイープ', 'Noise Sweep'), group: sweeps },
  { file: 'downlifter.wav', title: () => L('ダウンリフター', 'Downlifter'), group: sweeps },
  { file: 'reverse-crash.wav', title: () => L('リバースクラッシュ', 'Reverse Crash'), group: sweeps },
  { file: 'gabber-kick.wav', title: () => L('ガバキック', 'Gabber Kick'), group: drums },
  { file: 'hard-kick.wav', title: () => L('ハードキック', 'Hard Kick'), group: drums },
  { file: 'snare.wav', title: () => L('スネア', 'Snare'), group: drums },
  { file: 'clap.wav', title: () => L('クラップ', 'Clap'), group: drums },
  { file: 'open-hat.wav', title: () => L('オープンハット', 'Open Hat'), group: drums },
  { file: 'crash.wav', title: () => L('クラッシュ', 'Crash'), group: drums },
];

/** The standard kit, pad by pad (Q W E R / A S D F … as the pad keys go). */
export const standardKit = ['air-horn-x3.wav', 'siren.wav', 'riser.wav', 'impact.wav', 'gabber-kick.wav', 'snare.wav', 'crash.wav', 'laser.wav'];

export const builtinByFile = (file: string) => builtinSamples.find(b => b.file === file) ?? null;
