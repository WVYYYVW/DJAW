#!/usr/bin/env python3
"""DJAW MixScore — compares DJAW's auto-mix with a reference mix (a pro DJ set, or a mix made by hand).

REFERENCE ONLY. Even two professional DJs rarely pick the same mix points for the same pair of tracks
(Kim et al., ISMIR 2020: 23.6 % identical, 40.4 % within 4 beats, 86.2 % within 16 bars), so a low score
does not mean a bad transition. Use the numbers to spot tendencies, not as a verdict.

  extract  pro mix audio + the tracks it uses  -> reference plan (JSON)
  script   reference plan -> DJAW debug script that builds the same running order and auto-mixes it
  score    reference (plan JSON / .djaw / DJAW report) vs candidate (.djaw / DJAW report) -> scores

Needs: numpy, scipy, librosa, soundfile.
"""
import argparse, json, math, os, sys, unicodedata, urllib.parse
import numpy as np

SR = 22050
HOP = 1024                     # ~21.5 frames/s for alignment and gains
HUMAN = {'exact (≤1 beat)': 23.6, '≤4 beats': 40.4, '≤16 bars': 86.2}   # pro-vs-pro agreement on cue points


# ----------------------------------------------------------------------------- helpers

def key(name):
    """File identity used to match tracks between reference and candidate."""
    n = urllib.parse.unquote(os.path.basename(name))
    n = unicodedata.normalize('NFC', os.path.splitext(n)[0]).lower().strip()
    return n


def interp_score(x, anchors):
    """Piecewise-linear score from (value, score) anchors (values ascending)."""
    xs, ys = zip(*anchors)
    return float(np.interp(x, xs, ys))


# ----------------------------------------------------------------------------- reading plans

def plan_from_djaw(path):
    """Transitions from a .djaw project (JSON, without embedded audio) or a DJAW debug report."""
    with open(path, 'rb') as f:
        raw = f.read()
    try:
        d = json.loads(raw.decode('utf-8'))
    except Exception:
        sys.exit(f'{path}: not a JSON .djaw (mixes saved with the audio inside cannot be read; save without audio).')
    clips = d.get('clips') or d.get('mix') or []
    master = float(d.get('masterBPM', 0) or 0)
    tracks, trans = [], []
    tempo = master
    for i, c in enumerate(clips):
        name = c.get('file') or c.get('url') or c.get('title')
        bpm = float(c['bpm']); fb = float(c['firstBeat'])
        bar = 240.0 / bpm
        if c.get('tempo'): tempo = float(c['tempo'])
        rate = (tempo / bpm) if (c.get('tempoSync', True) and tempo > 1) else 1.0
        tracks.append(dict(file=key(name), bpm=bpm, firstBeat=fb, rate=rate))
        if i == 0:
            continue
        a, b = clips[i - 1], c
        abpm, afb = float(a['bpm']), float(a['firstBeat'])
        L = float(b.get('transitionBars', 0) or 0)
        style = b.get('transition', 'crossfade')
        cut = style in ('cut', 'brake', 'backspin') or L < 1
        shape = b.get('shape') or {}
        swap = (shape.get('low') or {}).get('point', 0.5) if style in ('bassSwap', 'crossfade', 'filter', 'custom') else None
        a_out = afb + float(a['mixOutBar']) * 240 / abpm
        b_in = fb + float(b['mixInBar']) * bar
        trans.append(dict(a=key(a.get('file') or a.get('url')), b=tracks[-1]['file'],
                          a_out=a_out, a_end=a_out + L * 240 / abpm,
                          b_in=b_in, b_land=b_in + L * bar,
                          beats=0.0 if cut else 4 * L, style='cut' if cut else ('echo' if style == 'echoOut' else 'blend'),
                          bass_swap=None if cut else swap, rate_b=rate))
    return dict(source=os.path.basename(path), tracks=tracks, transitions=trans)


def load_plan(path):
    if path.endswith('.json'):
        with open(path) as f:
            d = json.load(f)
        if 'transitions' in d:
            for t in d.get('tracks', []):
                t['file'] = key(t['file'])
            for t in d['transitions']:
                t['a'], t['b'] = key(t['a']), key(t['b'])
            return d
    return plan_from_djaw(path)


# ----------------------------------------------------------------------------- extraction from audio

def features(y):
    import librosa
    ch = librosa.feature.chroma_stft(y=y, sr=SR, hop_length=HOP, n_fft=4096)
    mf = librosa.feature.mfcc(y=y, sr=SR, hop_length=HOP, n_mfcc=14)[2:]
    f = np.vstack([ch * 2, mf / 20]).astype(np.float32)
    f -= f.mean(1, keepdims=True)
    f /= f.std(1, keepdims=True) + 1e-6
    return f


def mel(y):
    """48 mel bands + a fine 30–200 Hz spectrum (bass lines are told apart by their notes)."""
    import librosa
    m = librosa.feature.melspectrogram(y=y, sr=SR, hop_length=HOP, n_fft=4096, n_mels=48, fmax=11025, power=1.0)
    S = np.abs(librosa.stft(y, n_fft=8192, hop_length=HOP))
    f = librosa.fft_frequencies(sr=SR, n_fft=8192)
    low = S[(f >= 30) & (f <= 200)]
    n = min(m.shape[1], low.shape[1])
    return np.vstack([m[:, :n], low[:, :n] * (m[:4].mean() / (low.mean() + 1e-9))]).astype(np.float32)


def best_offset(F_mix, F_trk, rate):
    """Cross-correlate the track's features, time-scaled by `rate` (track s per mix s), with the mix."""
    n = F_trk.shape[1]
    m = int(n / rate)
    if m < 32:
        return -1e9, 0
    src = np.arange(m) * rate
    T = np.stack([np.interp(src, np.arange(n), row) for row in F_trk])
    N = F_mix.shape[1] + m
    size = 1 << int(math.ceil(math.log2(N)))
    acc = np.zeros(size, np.float32)
    for k in range(T.shape[0]):
        acc += np.fft.irfft(np.fft.rfft(F_mix[k], size) * np.conj(np.fft.rfft(T[k], size)), size).astype(np.float32)
    # lag l: mix frame l ~ track frame 0 (negative lags wrap)
    lags = np.concatenate([acc[size - m + 1:], acc[:F_mix.shape[1]]])
    idx = int(np.argmax(lags))
    return float(lags[idx]) / (T.shape[0] * m), idx - (m - 1)


def align(F_mix, F_trk):
    best = (-1e9, 0, 1.0)
    for r in np.arange(0.88, 1.125, 0.005):
        s, off = best_offset(F_mix, F_trk, r)
        if s > best[0]:
            best = (s, off, r)
    for r in np.arange(best[2] - 0.004, best[2] + 0.0045, 0.001):
        s, off = best_offset(F_mix, F_trk, r)
        if s > best[0]:
            best = (s, off, r)
    return best   # score, mix frame of track frame 0, rate


def nnls_gains(target, comps):
    from scipy.optimize import nnls
    if not comps:
        return []
    A = np.stack(comps, 1)
    g, _ = nnls(A, target)
    return g


def extract(mix_path, track_paths, out_path, min_score=0.35):
    import librosa
    print(f'loading {mix_path}')
    ym, _ = librosa.load(mix_path, sr=SR, mono=True)
    F_mix, M_mix = features(ym), mel(ym)
    fps = SR / HOP
    found = []
    for p in track_paths:
        y, _ = librosa.load(p, sr=SR, mono=True)
        s, off, r = align(F_mix, features(y))
        print(f'  {os.path.basename(p)[:50]:50s} match {s:.2f}  rate {r:.3f}  at {off / fps:7.1f}s')
        if s < min_score:
            continue
        found.append(dict(path=p, file=key(p), score=s, off=off, rate=r, mel=mel(y), dur=len(y) / SR))
    found.sort(key=lambda t: t['off'])
    nf = M_mix.shape[1]
    bands = dict(low=slice(48, None), mid=slice(4, 30), high=slice(30, 48))  # fine 30–200 Hz / ~170 Hz–2.5 kHz / above
    # Per mix frame: gain of every track that could be playing, per band (NNLS against the mix spectrum).
    G = {t['file']: {b: np.zeros(nf, np.float32) for b in ('all',) + tuple(bands)} for t in found}
    C = {t['file']: np.zeros(nf, np.float32) for t in found}     # low-end contribution (gain × level)
    for f in range(nf):
        active, comps = [], {b: [] for b in ('all',) + tuple(bands)}
        for t in found:
            tf = int(round((f - t['off']) * t['rate']))
            if 0 <= tf < t['mel'].shape[1]:
                active.append(t)
                col = t['mel'][:, tf]
                comps['all'].append(col[:48])
                for b, sl in bands.items():
                    comps[b].append(col[sl])
        if not active:
            continue
        for b in ('all',) + tuple(bands):
            target = M_mix[:48, f] if b == 'all' else M_mix[bands[b], f]
            tn = np.linalg.norm(target) + 1e-9
            # A track with (almost) nothing in this band can't be weighed there.
            keep = [k for k, cpt in enumerate(comps[b]) if np.linalg.norm(cpt) > 0.05 * tn]
            if not keep:
                continue
            g = nnls_gains(target, [comps[b][k] for k in keep])
            for k, v in zip(keep, g):
                G[active[k]['file']][b][f] = min(v, 3.0)
                if b == 'low':
                    C[active[k]['file']][f] = min(v, 3.0) * np.linalg.norm(comps[b][k]) / tn
    from scipy.ndimage import uniform_filter1d, median_filter
    for t in found:
        for b in G[t['file']]:
            G[t['file']][b] = uniform_filter1d(median_filter(G[t['file']][b], 9), int(fps))
    # Per-band "normal" level of each track = its gain where it plays alone (DJ mixes are rarely at unity gain).
    count = np.zeros(nf, int)
    for t in found:
        lo, hi = max(0, t['off']), min(nf, t['off'] + int(t['mel'].shape[1] / t['rate']))
        count[lo:hi] += 1
    for t in found:
        t['lv'] = {}
        for b, g in G[t['file']].items():
            solo = g[(count == 1) & (g > 0)]
            t['lv'][b] = float(np.percentile(solo, 60)) if len(solo) > fps else (float(np.percentile(g[g > 0], 75)) if (g > 0).any() else 1.0)
    if os.environ.get('MIXSCORE_DEBUG'):
        np.savez(os.environ['MIXSCORE_DEBUG'], **{f"{t['file']}|{b}": g for t in found for b, g in G[t['file']].items()},
                 **{f"{t['file']}|off": np.array([t['off'], t['rate']]) for t in found})
    def runs(mask, min_len):
        """[first, last] frame of the mask, ignoring runs shorter than min_len frames."""
        idx, out, f = np.nonzero(mask)[0], [], None
        if not len(idx):
            return None
        start = prev = idx[0]
        for i in idx[1:]:
            if i != prev + 1:
                if prev - start + 1 >= min_len: out.append((start, prev))
                start = i
            prev = i
        if prev - start + 1 >= min_len: out.append((start, prev))
        return (out[0][0], out[-1][1]) if out else None
    tracks, trans = [], []
    for t in found:
        g = G[t['file']]['all'] / (t['lv']['all'] + 1e-9)
        r = runs(g > 0.15, int(4 * fps))
        t['first'], t['last'] = r if r else (max(0, t['off']), max(0, t['off']))
        tracks.append(dict(file=t['file'], path=t['path'], rate=round(t['rate'], 4),
                           mix_start=round(t['first'] / fps, 2), mix_end=round(t['last'] / fps, 2), match=round(t['score'], 3)))
    for a, b in zip(found, found[1:]):
        f0, f1 = b['first'], a['last']
        src = lambda t, f: (f - t['off']) * t['rate'] / fps
        overlap = max(0, f1 - f0)
        cut = overlap < 1.0 * fps
        swap = None
        if not cut:
            la = uniform_filter1d(C[a['file']], int(fps))[f0:f1 + 1]
            lb = uniform_filter1d(C[b['file']], int(fps))[f0:f1 + 1]
            hold = int(2 * fps)
            k = next((i for i in range(len(la)) if (lb[i:i + hold] > la[i:i + hold]).all()), len(la) - 1)
            swap = round(k / max(1, len(la) - 1), 3)
        curves = None
        if not cut and overlap >= 4 * fps:
            # Per-band gain of each track over the overlap (relative to its solo level), 21 points 0…1.
            xs = np.linspace(f0, f1, 21).round().astype(int)
            curves = {}
            for side, t in (('a', a), ('b', b)):
                for band in ('low', 'mid', 'high', 'all'):
                    g = G[t['file']][band] / (t['lv'][band] + 1e-9)
                    curves[f'{band}_{side}'] = [round(float(min(2, g[x])), 3) for x in xs]
        trans.append(dict(curves=curves, a=a['file'], b=b['file'], a_out=round(src(a, f0), 2), a_end=round(src(a, f1), 2),
                          b_in=round(src(b, f0), 2), b_land=round(src(b, f1), 2), seconds=round(overlap / fps, 2),
                          style='cut' if cut else 'blend', bass_swap=swap, rate_b=round(b['rate'], 4)))
    plan = dict(source=os.path.basename(mix_path), tracks=tracks, transitions=trans,
                note='Extracted automatically; mix points are approximate (±1–2 s).')
    with open(out_path, 'w') as f:
        json.dump(plan, f, indent=1, ensure_ascii=False)
    print(f'{len(tracks)} tracks, {len(trans)} transitions -> {out_path}')
    return plan


# ----------------------------------------------------------------------------- scoring

POS = [(0, 100), (1, 95), (4, 80), (16, 60), (32, 40), (64, 15), (128, 0)]     # |Δ| in beats
LEN = [(0, 100), (1, 55), (2, 20), (3, 0)]                                     # |log2 length ratio|
TEMPO = [(0, 100), (1, 85), (2, 65), (5, 25), (10, 0)]                         # |Δ rate| in %
WEIGHTS = dict(entry=30, exit=25, length=15, style=10, bass=10, tempo=10)


def score(ref, cand, grid=None):
    grids = {t['file']: t for t in (grid or {}).get('tracks', []) if 'bpm' in t}
    for t in cand['tracks']:
        if 'bpm' in t:
            grids.setdefault(t['file'], t)
    for t in ref.get('tracks', []):
        if 'bpm' in t:
            grids.setdefault(t['file'], t)
    cmap = {(t['a'], t['b']): t for t in cand['transitions']}
    rows, missing = [], []
    for r in ref['transitions']:
        c = cmap.get((r['a'], r['b']))
        if c is None:
            missing.append(f"{r['a']} → {r['b']}")
            continue
        ga, gb = grids.get(r['a']), grids.get(r['b'])
        if not ga or not gb:
            missing.append(f"{r['a']} → {r['b']} (no beat grid)")
            continue
        beat_a, beat_b = 60 / ga['bpm'], 60 / gb['bpm']
        d_entry = abs(c['b_in'] - r['b_in']) / beat_b
        d_exit = abs(c['a_out'] - r['a_out']) / beat_a
        r_beats = r.get('beats', (r['b_land'] - r['b_in']) / beat_b)
        c_beats = c.get('beats', (c['b_land'] - c['b_in']) / beat_b)
        both_cut = r['style'] != 'blend' and c['style'] != 'blend'
        d_len = 0.0 if both_cut else abs(math.log2(max(1, c_beats) / max(1, r_beats)))
        s = dict(entry=interp_score(d_entry, POS), exit=interp_score(d_exit, POS), length=interp_score(d_len, LEN),
                 style=100.0 if (r['style'] == 'blend') == (c['style'] == 'blend') else 0.0)
        if r.get('bass_swap') is not None and c.get('bass_swap') is not None:
            s['bass'] = max(0.0, 100 * (1 - 2 * abs(r['bass_swap'] - c['bass_swap'])))
        if r.get('rate_b') and c.get('rate_b'):
            s['tempo'] = interp_score(100 * abs(r['rate_b'] - c['rate_b']), TEMPO)
        w = sum(WEIGHTS[k] for k in s)
        total = sum(WEIGHTS[k] * v for k, v in s.items()) / w
        rows.append(dict(a=r['a'], b=r['b'], total=round(total, 1), parts={k: round(v) for k, v in s.items()},
                         d_entry_beats=round(d_entry, 1), d_exit_beats=round(d_exit, 1),
                         ref=dict(style=r['style'], beats=round(r_beats, 1)), cand=dict(style=c['style'], beats=round(c_beats, 1))))
    def within(vals, lim):
        return round(100 * sum(v <= lim for v in vals) / len(vals), 1) if vals else None
    pts = [x['d_entry_beats'] for x in rows] + [x['d_exit_beats'] for x in rows]
    summary = dict(score=round(float(np.mean([x['total'] for x in rows])), 1) if rows else None,
                   transitions=len(rows), unmatched=missing,
                   agreement={'exact (≤1 beat)': within(pts, 1), '≤4 beats': within(pts, 4), '≤16 bars': within(pts, 64)},
                   human_agreement=HUMAN)
    return dict(summary=summary, transitions=rows,
                disclaimer='参考値です。プロ同士でも同じ位置を選ぶのは4拍以内で約4割なので、低い点＝悪いつなぎではありません。')


def print_report(res):
    s = res['summary']
    print('\n=== MixScore（参考値） ===')
    print(f"総合 {s['score']} / 100   （比較できたつなぎ {s['transitions']}）")
    print('位置の一致率   候補 vs 参照 | プロ同士（参考）')
    for k in HUMAN:
        print(f"  {k:16s} {s['agreement'][k]!s:>6} %   | {HUMAN[k]} %")
    for x in res['transitions']:
        print(f"\n{x['a'][:30]} → {x['b'][:30]}: {x['total']}")
        print(f"   入り Δ{x['d_entry_beats']}拍  抜け Δ{x['d_exit_beats']}拍  参照 {x['ref']['style']} {x['ref']['beats']}拍 / 候補 {x['cand']['style']} {x['cand']['beats']}拍")
        print('   ' + '  '.join(f'{k}:{v}' for k, v in x['parts'].items()))
    if s['unmatched']:
        print('\n比較できなかったつなぎ（DJAW 側で並び順が違う等）:', *s['unmatched'], sep='\n  ')
    print('\n' + res['disclaimer'])


# ----------------------------------------------------------------------------- tuning (DJAW auto-mix settings)

TUNE_PARAMS = [('len32', 0.8), ('len16', 0.6), ('len8', 0.6), ('len4', 0.6), ('switchBias', 1.2),
               ('echoBias', 0.8), ('spinBias', 0.8), ('dropWeight', 0.4), ('vocalWeight', 0.5)]


def tune_prepare(refs, workdir, mac_workdir, base=None):
    """One DJAW debug script that auto-mixes every reference running order with every candidate setting."""
    os.makedirs(workdir, exist_ok=True)
    base = base or {}
    sets = [('base', {})]
    for name, step in TUNE_PARAMS:
        for sign in (+1, -1):
            v = (1 + sign * step) if name in ('dropWeight', 'vocalWeight') else sign * step
            sets.append((f'{name}{"+" if sign > 0 else "-"}', {name: v}))
    lines = ['verify off']
    for r, ref in enumerate(refs):
        lines.append('reset')
        lines += [f"mix {t.get('mac_path') or t['path']}" for t in ref['tracks']]
        lines.append('mark')
        for k, (name, delta) in enumerate(sets):
            star = dict(base.get('params', {}).get('*', {}))
            for p, v in delta.items():
                if p in ('dropWeight', 'vocalWeight'):
                    star[p] = star.get(p, 1.0) * v
                else:
                    star[p] = star.get(p, 0.0) + v
            tuning = dict(base, version=1, params=dict(base.get('params', {}), **{'*': star}))
            with open(os.path.join(workdir, f'tune_{k:02d}.json'), 'w') as f:
                json.dump(tuning, f, indent=1)
            lines += [f'profile {mac_workdir}/tune_{k:02d}.json', 'restore', 'automix', f'report {mac_workdir}/tune_{k:02d}_ref{r}.json']
    lines += ['profile none', 'verify on']
    with open(os.path.join(workdir, 'DJAW_DEBUG_SCRIPT.txt'), 'w') as f:
        f.write('\n'.join(lines) + '\n')
    with open(os.path.join(workdir, 'tune_sets.json'), 'w') as f:
        json.dump([n for n, _ in sets], f)
    print(f'{len(sets)} settings × {len(refs)} reference mixes -> {workdir}/DJAW_DEBUG_SCRIPT.txt')


def tune_collect(refs, workdir, out):
    names = json.load(open(os.path.join(workdir, 'tune_sets.json')))
    scores = []
    for k, name in enumerate(names):
        vals = []
        for r, ref in enumerate(refs):
            p = os.path.join(workdir, f'tune_{k:02d}_ref{r}.json')
            if os.path.exists(p):
                res = score(ref, load_plan(p))
                if res['summary']['score'] is not None:
                    vals.append(res['summary']['score'])
        scores.append((float(np.mean(vals)) if vals else None, k, name))
        print(f"  {name:14s} {scores[-1][0] if scores[-1][0] is not None else '-'}")
    ok = [x for x in scores if x[0] is not None]
    if not ok:
        sys.exit('no reports found')
    base = next((x for x in ok if x[2] == 'base'), ok[0])
    # Keep every change that helped (one per parameter, the better direction), on top of the base.
    best = json.load(open(os.path.join(workdir, 'tune_00.json')))
    star = dict(best['params'].get('*', {}))
    kept = []
    for pname, _ in TUNE_PARAMS:
        cand = [x for x in ok if x[2].startswith(pname) and x[0] > base[0] + 0.5]
        if cand:
            top = max(cand)
            d = json.load(open(os.path.join(workdir, f'tune_{top[1]:02d}.json')))['params']['*']
            star[pname] = d[pname]
            kept.append(f'{top[2]} (+{top[0] - base[0]:.1f})')
    best['params']['*'] = star
    best['note'] = f"MixScore tune: base {base[0]:.1f}; kept {', '.join(kept) or 'nothing'} (reference only)"
    with open(out, 'w') as f:
        json.dump(best, f, indent=1)
    print(best['note'], '->', out)


def learn_shapes(refs, out, genres=None, existing=None):
    """EQ / fader timing of real blends, summarised as DJAW's ShapeTuning (per genre and '*')."""
    def cross(x, y, start=0):
        for i in range(start, len(x)):
            if y[i] > x[i]:
                return i / (len(x) - 1)
        return None
    def rise(y):
        y = np.asarray(y); hi = y.max() + 1e-9
        a = next((i for i in range(len(y)) if y[i] >= 0.1 * hi), 0)
        b = next((i for i in range(len(y)) if y[i] >= 0.9 * hi), len(y) - 1)
        return (b - a) / (len(y) - 1)
    rows = {}
    for ref in refs:
        for t in ref['transitions']:
            c = t.get('curves')
            if not c or t.get('bass_swap') is None:
                continue
            p = t['bass_swap']
            r = dict(lowRamp=rise(c['low_b']), midRamp=rise(c['mid_b']), highRamp=rise(c['high_b']))
            m = cross(c['mid_a'], c['mid_b']); h = cross(c['high_a'], c['high_b'])
            if m is not None: r['midLead'] = p - m
            if h is not None: r['highLead'] = p - h
            ib = next((i for i, v in enumerate(c['all_b']) if v >= 0.9 * max(c['all_b'])), None)
            ia = next((i for i, v in enumerate(c['all_a']) if v < 0.9 * max(c['all_a'][:3] or [1])), None)
            if ib is not None: r['inRiseOffset'] = ib / 20 - p
            if ia is not None: r['outFadeOffset'] = ia / 20 - p
            g = (genres or {}).get(t['b'])
            for key in ('*', g) if g else ('*',):
                rows.setdefault(key, []).append(r)
    tuning = existing or dict(version=1, params={}, shapes={})
    tuning.setdefault('shapes', {})
    for key, rs in rows.items():
        sh = {k: round(float(np.median([r[k] for r in rs if k in r])), 3) for k in
              ('lowRamp', 'midRamp', 'midLead', 'highLead', 'highRamp', 'inRiseOffset', 'outFadeOffset') if any(k in r for r in rs)}
        sh['transitions'] = len(rs)
        tuning['shapes'][key] = sh
        print(f'  {key}: {len(rs)} transitions -> {sh}')
    tuning['note'] = (tuning.get('note') or '') + ' / EQ curves learned from reference mixes'
    with open(out, 'w') as f:
        json.dump(tuning, f, indent=1)
    print('->', out)


def make_script(ref, out, report, folder=None):
    lines = ['reset']
    for t in ref['tracks']:
        p = t.get('path') or os.path.join(folder or '', t['file'])
        lines.append(f'mix {p}')
    lines += ['automix', f'report {report}']
    with open(out, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    print(f'wrote {out}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    e = sub.add_parser('extract'); e.add_argument('--mix', required=True); e.add_argument('--tracks', nargs='+', required=True); e.add_argument('--out', required=True)
    s = sub.add_parser('script'); s.add_argument('--ref', required=True); s.add_argument('--out', required=True); s.add_argument('--report', required=True)
    s.add_argument('--path-prefix', help='replace the track folder in paths (e.g. for the Mac side)')
    c = sub.add_parser('score'); c.add_argument('--ref', required=True); c.add_argument('--cand', required=True); c.add_argument('--json')
    c.add_argument('--grid', help='.djaw / DJAW report whose beat grids are used (when neither side has them)')
    t = sub.add_parser('tune-prepare', help='write a DJAW debug script that tries setting variations on the reference mixes')
    t.add_argument('--refs', nargs='+', required=True); t.add_argument('--work', required=True)
    t.add_argument('--mac-work', help='the same folder as seen from the Mac (default: --work)')
    t.add_argument('--mac-tracks', help='folder holding the tracks on the Mac')
    t.add_argument('--base', help='an existing MixTuning.json to start from')
    t2 = sub.add_parser('tune-collect', help='score the reports and write the best MixTuning.json')
    t2.add_argument('--refs', nargs='+', required=True); t2.add_argument('--work', required=True); t2.add_argument('--out', required=True)
    l = sub.add_parser('learn-shapes', help='learn EQ / fader timing from extracted reference plans')
    l.add_argument('--refs', nargs='+', required=True); l.add_argument('--out', required=True)
    l.add_argument('--genres', help='a DJAW report: genres of the tracks (per-genre curves)')
    l.add_argument('--base', help='an existing MixTuning.json to add the curves to')
    a = ap.parse_args()
    if a.cmd in ('tune-prepare', 'tune-collect', 'learn-shapes'):
        refs = [load_plan(r) for r in a.refs]
        if a.cmd == 'tune-prepare':
            for ref in refs:
                for t in ref['tracks']:
                    if a.mac_tracks:
                        t['mac_path'] = os.path.join(a.mac_tracks, os.path.basename(t.get('path', t['file'])))
            tune_prepare(refs, a.work, a.mac_work or a.work, json.load(open(a.base)) if a.base else None)
        elif a.cmd == 'tune-collect':
            tune_collect(refs, a.work, a.out)
        else:
            genres = None
            if a.genres:
                rep_ = json.load(open(a.genres))
                genres = {key(c['file']): c.get('genreUsed') for c in rep_.get('mix', []) + rep_.get('library', []) if c.get('genreUsed')}
            learn_shapes(refs, a.out, genres, json.load(open(a.base)) if a.base else None)
        return
    if a.cmd == 'extract':
        files = []
        for t in a.tracks:
            if os.path.isdir(t):
                files += sorted(os.path.join(t, f) for f in os.listdir(t) if f.lower().endswith(('.wav', '.mp3', '.flac', '.aif', '.aiff', '.m4a')))
            else:
                files.append(t)
        files = [f for f in files if os.path.abspath(f) != os.path.abspath(a.mix)]
        extract(a.mix, files, a.out)
    elif a.cmd == 'script':
        ref = load_plan(a.ref)
        if a.path_prefix:
            for t in ref['tracks']:
                t['path'] = os.path.join(a.path_prefix, os.path.basename(t.get('path', t['file'])))
        make_script(ref, a.out, a.report)
    else:
        res = score(load_plan(a.ref), load_plan(a.cand), load_plan(a.grid) if a.grid else None)
        print_report(res)
        if a.json:
            with open(a.json, 'w') as f:
                json.dump(res, f, indent=1, ensure_ascii=False)


if __name__ == '__main__':
    main()
