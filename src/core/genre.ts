// Genre families and the genre / vocal analysis result (mac/DJAW/Audio/GenreAnalyzer.swift, model-independent part).
import { L } from './i18n';

export type MixGenre = 'house' | 'techno' | 'trance' | 'ukg' | 'bass' | 'dnb' | 'breaks' | 'hard' | 'breakcore' | 'hiphop' | 'pop' | 'chill' | 'band';
export const mixGenres: MixGenre[] = ['house', 'techno', 'trance', 'ukg', 'bass', 'dnb', 'breaks', 'hard', 'breakcore', 'hiphop', 'pop', 'chill', 'band'];

export const Genre = {
  title(g: MixGenre): string {
    switch (g) {
      case 'house': return L('ハウス／ディスコ', 'House / Disco');
      case 'techno': return L('テクノ', 'Techno');
      case 'trance': return L('トランス', 'Trance');
      case 'ukg': return L('UKガラージ／ベースライン', 'UK Garage / Bassline');
      case 'bass': return L('ダブステップ／ベースミュージック', 'Dubstep / Bass Music');
      case 'dnb': return L('ドラムンベース／ジャングル', 'Drum & Bass / Jungle');
      case 'breaks': return L('ブレイクビーツ／エレクトロ', 'Breaks / Electro');
      case 'hard': return L('ハードコア／ハードスタイル', 'Hardcore / Hardstyle');
      case 'breakcore': return L('ブレイクコア／Dariacore', 'Breakcore / Dariacore');
      case 'hiphop': return L('ヒップホップ／R&B', 'Hip-Hop / R&B');
      case 'pop': return L('ポップ／ボーカル', 'Pop / Vocal');
      case 'chill': return L('アンビエント／ダウンテンポ', 'Ambient / Downtempo');
      case 'band': return L('バンド・生演奏', 'Band / Live');
    }
  },
  short(g: MixGenre): string {
    return ({ house: 'House', techno: 'Techno', trance: 'Trance', ukg: 'UKG', bass: 'Bass', dnb: 'DnB', breaks: 'Breaks', hard: 'Hard',
      breakcore: 'Breakcore', hiphop: 'Hip-Hop', pop: 'Pop', chill: 'Chill', band: 'Band' } as Record<MixGenre, string>)[g];
  },
  mixSummary(g: MixGenre): string {
    switch (g) {
      case 'house': return L('16〜32小節のベーススワップ。アウトロにイントロを重ね、後半はハイパスで抜く', '16–32-bar bass swaps, intro over outro, high-pass on the way out');
      case 'techno': return L('32小節前後の長いブレンド。フィルターとハイパスで溶け込ませる', 'Long ~32-bar blends, melted together with filters and high-pass');
      case 'trance': return L('16〜32小節。ブレイク前のフレーズ頭で入れ替える', '16–32 bars, swapped on the phrase before the breakdown');
      case 'ukg': return L('8〜16小節。ベースを入れ替え、テンポは大きく動かさない（揺れを崩さない）', '8–16 bars with a bass swap; tempo kept steady to keep the swing');
      case 'bass': return L('8小節前後で次のドロップへ。ドロップ頭のカットインやエコーアウトも使う', '~8 bars into the next drop; drop cut-ins and echo-outs too');
      case 'dnb': return L('16小節で次のドロップに重ねる（ダブルドロップ）。リワインド（バックスピン）も使う', '16 bars landing drop on drop (double drop); rewinds (backspins) too');
      case 'breaks': return L('8〜16小節のブレンドとカットインを半々', 'A mix of 8–16-bar blends and cut-ins');
      case 'hard': return L('4〜8小節の短いつなぎ。カットイン・バックスピンでテンポごと切り替え', 'Short 4–8-bar mixes; cut-ins and backspins that switch tempo');
      case 'breakcore': return L('おいしい所だけを小節頭のカットインでつなぐ', 'Only the best bars, joined with cut-ins on the downbeat');
      case 'hiphop': return L('ブレンドは短く（〜8小節）。カットイン・エコーアウトが中心', 'Short blends (≤8 bars); mostly cut-ins and echo-outs');
      case 'pop': return L('歌がぶつからないよう 4〜8 小節。エコーアウトで切り替えることも', '4–8 bars so vocals don\'t clash; sometimes an echo-out');
      case 'chill': return L('EQ を大きく動かさない長いクロスフェード。リバーブで余韻を残す', 'Long crossfades without hard EQ moves; reverb tails');
      case 'band': return L('テンポを無理に合わせず、短いクロスフェードかエコーアウト', 'No heavy tempo matching: short crossfades or echo-outs');
    }
  },
  tempoRange(g: MixGenre): [number, number] | null {
    return ({ house: [110, 135], techno: [118, 155], trance: [124, 150], ukg: [124, 145], bass: [132, 152], dnb: [158, 182],
      breaks: [110, 145], hard: [140, 210], hiphop: [60, 115] } as Partial<Record<MixGenre, [number, number]>>)[g] ?? null;
  },
  isNeighbor(a: MixGenre, b: MixGenre): boolean {
    if (a === b) return true;
    const pairs: [MixGenre, MixGenre][] = [['house', 'techno'], ['house', 'ukg'], ['house', 'trance'], ['techno', 'trance'],
      ['ukg', 'bass'], ['ukg', 'breaks'], ['bass', 'dnb'], ['dnb', 'breaks'], ['breaks', 'house'],
      ['hard', 'trance'], ['hard', 'breakcore'], ['hiphop', 'pop'], ['pop', 'house'],
      ['chill', 'band'], ['hiphop', 'bass'], ['breakcore', 'dnb'], ['pop', 'hard']];
    return pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  },
  /** Family of one Discogs style ("Parent---Style"). */
  familyOfDiscogs(label: string): MixGenre | null {
    const parts = label.split('---');
    if (parts.length !== 2) return null;
    const [parent, style] = parts;
    const f = styleFamily.get(style);
    if (f && ['Electronic', 'Hip Hop', 'Funk / Soul', 'Latin', 'Pop'].includes(parent)) return f;
    switch (parent) {
      case 'Electronic': return 'chill';
      case 'Hip Hop': case 'Reggae': return 'hiphop';
      case 'Pop': return 'pop';
      case 'Classical': case 'Stage & Screen': return 'chill';
      case 'Non-Music': case 'Children\'s': return null;
      default: return 'band';
    }
  },
  /** Family named by a file's genre tag (null when the tag is too generic to tell). */
  familyOfTag(tag: string): MixGenre | null {
    let t = tag.toLowerCase();
    for (const w of ['electronica', 'electronic', 'edm']) t = t.split(w).join(' ');
    const has = (words: string[]) => words.some(w => t.includes(w));
    if (has(['dariacore', 'breakcore', 'mashup', 'mash-up', 'hyperpop', 'digicore', 'glitch'])) return 'breakcore';
    if (has(['hard house', 'hardcore', 'hardstyle', 'gabber', 'happy hard', 'uk hard', 'speedcore', 'frenchcore', 'hyperflip', 'jumpstyle'])) return 'hard';
    if (has(['garage', '2-step', '2step', 'ukg', 'bassline', 'grime', 'speed garage'])) return 'ukg';
    if (has(['drum & bass', 'drum and bass', 'drum n bass', 'drum\'n\'bass', 'dnb', 'd&b', 'jungle', 'neurofunk', 'liquid funk'])) return 'dnb';
    if (has(['dubstep', 'riddim', 'brostep', 'bass music', 'halftime', 'future bass'])) return 'bass';
    if (has(['techno'])) return 'techno';
    if (has(['trance', 'psy'])) return 'trance';
    if (has(['house', 'disco'])) return 'house';
    if (has(['breakbeat', 'breaks', 'big beat', 'electro'])) return 'breaks';
    if (has(['hip hop', 'hip-hop', 'hiphop', 'rap', 'r&b', 'rnb', 'trap', 'reggaeton', 'dancehall', 'reggae'])) return 'hiphop';
    if (has(['ambient', 'chill', 'downtempo', 'lo-fi', 'lofi', 'trip hop', 'new age', 'classical', 'soundtrack'])) return 'chill';
    if (has(['pop', 'anime', 'idol', 'vocaloid', 'eurobeat', 'eurodance', 'synthwave'])) return 'pop';
    if (has(['rock', 'metal', 'punk', 'jazz', 'blues', 'folk', 'country', 'acoustic', 'soul', 'funk'])) return 'band';
    return null;
  },
};

const styleFamily = (() => {
  const m = new Map<string, MixGenre>();
  const put = (f: MixGenre, names: string[]) => { for (const n of names) m.set(n, f); };
  put('house', ['Acid House', 'Deep House', 'Disco', 'Disco Polo', 'Euro House', 'Euro-Disco', 'Garage House', 'Ghetto House',
    'Hip-House', 'House', 'Italo House', 'Italo-Disco', 'Nu-Disco', 'Progressive House', 'Tech House', 'Tribal House',
    'Tropical House', 'Electro House', 'Beatdown', 'Boogie', 'Latin', 'Tribal']);
  put('techno', ['Acid', 'Bleep', 'Deep Techno', 'Dub Techno', 'EBM', 'Hard Techno', 'Industrial', 'Minimal', 'Minimal Techno',
    'New Beat', 'Schranz', 'Techno', 'Rhythmic Noise', 'Electroclash']);
  put('trance', ['Trance', 'Progressive Trance', 'Psy-Trance', 'Goa Trance', 'Tech Trance', 'Hard Trance', 'Hands Up']);
  put('ukg', ['UK Garage', 'Speed Garage', 'Bassline', 'Grime', 'UK Street Soul']);
  put('bass', ['Dubstep', 'Halftime', 'Bass Music', 'Juke', 'Ghetto', 'Miami Bass']);
  put('dnb', ['Drum n Bass', 'Jungle']);
  put('breaks', ['Breakbeat', 'Breaks', 'Big Beat', 'Progressive Breaks', 'Broken Beat', 'Electro', 'Freestyle', 'Jazzdance',
    'Future Jazz', 'Acid Jazz', 'Leftfield']);
  put('hard', ['Hardcore', 'Happy Hardcore', 'Gabber', 'Hardstyle', 'Jumpstyle', 'Hard House', 'Makina', 'Donk', 'Speedcore']);
  put('breakcore', ['Breakcore', 'Glitch', 'Noise', 'Experimental', 'Chiptune', 'Sound Collage', 'Cut-up/DJ', 'DJ Battle Tool',
    'Turntablism', 'Power Electronics']);
  put('hiphop', ['Hip Hop', 'Contemporary R&B', 'Neo Soul', 'New Jack Swing', 'RnB/Swing', 'Swingbeat', 'Reggaeton', 'Trap']);
  put('pop', ['Dance-pop', 'Synth-pop', 'Eurodance', 'Eurobeat', 'Italodance', 'Hi NRG', 'Europop', 'J-pop', 'K-pop',
    'Synthwave', 'Bubblegum', 'City Pop', 'Vocal', 'Indie Pop']);
  put('chill', ['Ambient', 'Dark Ambient', 'Downtempo', 'Drone', 'Chillwave', 'New Age', 'Trip Hop', 'Dub', 'IDM', 'Illbient',
    'Abstract', 'Modern Classical', 'Berlin-School', 'Dungeon Synth', 'Vaporwave', 'Musique Concrète', 'Darkwave',
    'Neofolk', 'New Wave']);
  return m;
})();

export const GENRE_VERSION = 3;

export interface GenreStyle { label: string; score: number }

export interface GenreResult {
  version: number;
  /** Strongest Discogs styles (model output averaged over the track). */
  styles: GenreStyle[];
  /** Share of the model's activation per family (sums to 1). */
  families: Record<string, number>;
  /** The file's genre tag, if any. */
  tag?: string | null;
  /** Track averages of [voice, party, aggressive, danceable] (0…1). */
  traits?: number[] | null;
  /** Probability of singing / rapping per ~2 s patch, and each patch's centre (source seconds). */
  voice?: number[] | null;
  voiceTimes?: number[] | null;
}

export const Genres = {
  styleName: (s: GenreStyle) => s.label.split('---').pop() ?? s.label,
  party: (r: GenreResult) => r.traits?.[1] ?? null,
  aggressive: (r: GenreResult) => r.traits?.[2] ?? null,
  danceable: (r: GenreResult) => r.traits?.[3] ?? null,
  /** Vocal probability between two source times (max over the patches centred inside, else the nearest one). */
  vocal(r: GenreResult, t0: number, t1: number): number | null {
    const v = r.voice, ts = r.voiceTimes;
    if (!v || !ts || !v.length) return null;
    let best = -1;
    for (let k = 0; k < ts.length; k++) if (ts[k] >= t0 && ts[k] < t1) best = Math.max(best, v[k]);
    if (best >= 0) return best;
    const mid = (t0 + t1) / 2;
    let k = 0;
    for (let j = 1; j < ts.length; j++) if (Math.abs(ts[j] - mid) < Math.abs(ts[k] - mid)) k = j;
    return v[k];
  },
  tagFamily: (r: GenreResult) => (r.tag ? Genre.familyOfTag(r.tag) : null),
  ranked(r: GenreResult): { genre: MixGenre; share: number }[] {
    return Object.entries(r.families).filter(([k]) => (mixGenres as string[]).includes(k))
      .map(([k, v]) => ({ genre: k as MixGenre, share: v })).sort((a, b) => b.share - a.share);
  },
  /** The family the model is fairly sure of. */
  detected(r: GenreResult): MixGenre | null {
    const rk = Genres.ranked(r);
    const top = rk[0];
    if (!top) return null;
    if (top.share >= 0.28) return top.genre;
    if (top.share >= 0.2 && rk.length > 1 && Genre.isNeighbor(rk[1].genre, top.genre) && top.share + rk[1].share >= 0.4) return top.genre;
    return null;
  },
  /** Tag first (when it names a family), then the model. */
  best: (r: GenreResult) => Genres.tagFamily(r) ?? Genres.detected(r),
};
