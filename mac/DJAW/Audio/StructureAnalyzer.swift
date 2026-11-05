import Foundation
import Accelerate

// MARK: - Results

nonisolated enum SectionKind: String, Sendable, Hashable, Codable {
    case intro, drop, breakdown, outro

    var title: String {
        switch self {
        case .intro: return L("イントロ", "Intro")
        case .drop: return L("ドロップ", "Drop")
        case .breakdown: return L("ブレイク", "Break")
        case .outro: return L("アウトロ", "Outro")
        }
    }
}

/// A run of bars with a similar texture. Bars are counted on the analysis grid (see `TrackStructure`).
nonisolated struct TrackSection: Sendable, Hashable, Codable {
    var start: Int
    /// Exclusive.
    var end: Int
    var kind: SectionKind
    /// Fraction of bars with a strong low end.
    var bass: Double
    /// Mean loudness relative to the track's loud parts (dB).
    var energy: Double
}

nonisolated struct MusicalKey: Sendable, Hashable, Codable {
    /// 0 = C … 11 = B
    var pitchClass: Int
    var minor: Bool
    /// Correlation with the key profile (0…1).
    var confidence: Double

    private static let names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    private static let camelotMajor = [0: 8, 7: 9, 2: 10, 9: 11, 4: 12, 11: 1, 6: 2, 1: 3, 8: 4, 3: 5, 10: 6, 5: 7]
    private static let camelotMinor = [9: 8, 4: 9, 11: 10, 6: 11, 1: 12, 8: 1, 3: 2, 10: 3, 5: 4, 0: 5, 7: 6, 2: 7]

    var name: String { Self.names[pitchClass] + (minor ? "m" : "") }
    var camelotNumber: Int { (minor ? Self.camelotMinor : Self.camelotMajor)[pitchClass] ?? 1 }
    var camelot: String { "\(camelotNumber)\(minor ? "A" : "B")" }

    /// The key after shifting by `semitones`.
    func shifted(by semitones: Int) -> MusicalKey {
        MusicalKey(pitchClass: Mathx.posModInt(pitchClass + semitones, 12), minor: minor, confidence: confidence)
    }

    /// Harmonic-mixing rule of thumb: same key, ±1 on the Camelot wheel, or the relative major/minor.
    func isCompatible(with other: MusicalKey) -> Bool {
        let a = camelotNumber, b = other.camelotNumber
        let d = min((a - b + 12) % 12, (b - a + 12) % 12)
        if minor == other.minor { return d <= 1 }
        return d == 0
    }
}

/// Musical structure of one track, found from its waveform.
///
/// Bars are counted from `firstBeat` on the analysis grid: bar 0 starts at `firstBeat`.
/// Use `time(ofBar:)` to convert to source seconds (and from there to a clip's own bars),
/// so the result stays valid even if the user later nudges the clip's grid.
/// A suggested cue point on a track's bar grid.
nonisolated struct CueBar: Sendable, Hashable, Codable {
    var bar: Double
    var score: Double
}

nonisolated struct TrackStructure: Sendable, Codable {
    var bpm: Double
    /// Corrected first downbeat (source seconds).
    var firstBeat: Double
    var barSeconds: Double
    var barCount: Int
    /// Phrases (8 bars) start at bars ≡ phraseOffset (mod 8).
    var phraseOffset: Int
    /// Per-bar levels relative to the track's loud parts (dB): low (<150 Hz), full, high (>3 kHz).
    var low: [Float]
    var full: [Float]
    var high: [Float]
    var bass: [Bool]
    /// First bar with music.
    var musicStart: Int
    /// Bar after the last one with music.
    var musicEnd: Int
    /// Start of the first drop (main section with bass); `musicStart` if none.
    var firstDrop: Int
    /// End of the last drop, i.e. where the outro starts; `musicEnd` if none.
    var lastDropEnd: Int
    var sections: [TrackSection]
    var key: MusicalKey?
    /// Beats the downbeat was moved by the structure check (0 = unchanged).
    var downbeatShift: Int
    /// Cue points suggested by CUE-DETR, on this grid (bar, 0...1 strength).
    var cueBars: [CueBar] = []
    /// Per bar: share of the detected beats that sit on this grid (−1 = no beats detected).
    /// Low values mean the tempo drifts or switches there (common in Dariacore / mashups).
    var gridFit: [Float] = []

    /// Mean grid fit over bars a..<b (bars without detected beats count as fitting).
    func gridFit(from a: Int, to b: Int) -> Double {
        guard !gridFit.isEmpty, b > a else { return 1 }
        var s = 0.0, n = 0.0
        let lo = max(0, a), hi = min(gridFit.count, b)
        guard hi > lo else { return 1 }
        for i in lo..<hi {
            s += gridFit[i] < 0 ? 1 : Double(gridFit[i]); n += 1
        }
        return n > 0 ? s / n : 1
    }

    /// Strength (0...1) of a suggested cue within `tolerance` bars of `b` (0 if none).
    func cueStrength(at b: Int, tolerance: Double = 0.5) -> Double {
        cueBars.filter { abs($0.bar - Double(b)) <= tolerance }.map(\.score).max() ?? 0
    }

    func time(ofBar b: Double) -> Double { firstBeat + b * barSeconds }
    func bar(atTime t: Double) -> Double { (t - firstBeat) / barSeconds }
    func hasBass(_ b: Int) -> Bool { b >= 0 && b < bass.count ? bass[b] : false }
    func energy(_ b: Int) -> Double { b >= 0 && b < full.count ? Double(full[b]) : -60 }
    func isPhraseStart(_ b: Int, unit: Int = 8) -> Bool { Mathx.posModInt(b - phraseOffset, unit) == 0 }
    func section(at b: Int) -> TrackSection? { sections.first { b >= $0.start && b < $0.end } }

    /// Phrase-grid bars from `lo` to `hi` (inclusive) every `step` bars.
    func gridBars(from lo: Int, to hi: Int, step: Int) -> [Int] {
        guard hi >= lo else { return [] }
        var k = Int((Double(lo - phraseOffset) / Double(step)).rounded(.up))
        var out: [Int] = []
        while phraseOffset + k * step <= hi {
            out.append(phraseOffset + k * step)
            k += 1
        }
        return out
    }

    var summary: String {
        let parts = sections.map { "\($0.kind.title) \($0.start + 1)–\($0.end)" }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Key detection (chroma accumulator)

/// Streams mono samples, low-passes and decimates them to ~11 kHz, and accumulates a
/// 12-bin pitch-class profile from peak-picked FFT frames.
nonisolated final class ChromaAccumulator {
    private static let n = 8192
    private static let hop = 4096
    private let decimation: Int
    private let setup: FFTSetup
    private let window: [Float]
    private let bins: [(index: Int, pc: Int, weight: Double)]
    private var ring: [Float]
    private var filled = 0
    private var sinceLast = 0
    private var phase = 0
    private var chroma = [Double](repeating: 0, count: 12)
    // Two cascaded biquad low-passes (anti-aliasing before decimation), run by Accelerate per chunk.
    private var lowpass: vDSP.Biquad<Float>
    private var real: [Float]
    private var imag: [Float]
    private var mags: [Float]
    private var frame: [Float]

    init(sampleRate: Double) {
        let n = Self.n
        let decimation = max(1, Int((sampleRate / 11025).rounded()))
        let fs = sampleRate / Double(decimation)
        var win = [Float](repeating: 0, count: n)
        vDSP_hann_window(&win, vDSP_Length(n), Int32(vDSP_HANN_NORM))
        var bins: [(index: Int, pc: Int, weight: Double)] = []
        for k in 1..<(n / 2) {
            let f = Double(k) * fs / Double(n)
            guard f >= 80, f <= 2000 else { continue }
            let midi = 12 * log2(f / 440) + 69
            let r = midi.rounded()
            let d = midi - r
            bins.append((k, Mathx.posModInt(Int(r), 12), pow(cos(Double.pi * d), 2)))
        }
        let fc = min(4000, fs * 0.42)
        let w0 = 2 * Double.pi * fc / sampleRate
        let alpha = sin(w0) / (2 * 0.70710678)
        let cw = cos(w0)
        let a0 = 1 + alpha

        self.decimation = decimation
        self.setup = vDSP_create_fftsetup(13, FFTRadix(kFFTRadix2))!
        self.window = win
        self.bins = bins
        self.ring = [Float](repeating: 0, count: n)
        self.real = [Float](repeating: 0, count: n / 2)
        self.imag = [Float](repeating: 0, count: n / 2)
        self.mags = [Float](repeating: 0, count: n / 2)
        self.frame = [Float](repeating: 0, count: n)
        let section = [(1 - cw) / 2 / a0, (1 - cw) / a0, (1 - cw) / 2 / a0, -2 * cw / a0, (1 - alpha) / a0]
        self.lowpass = vDSP.Biquad(coefficients: section + section, channelCount: 1, sectionCount: 2, ofType: Float.self)!
    }

    deinit { vDSP_destroy_fftsetup(setup) }

    /// Feeds a chunk of mono samples at the file's sample rate.
    func process(_ chunk: [Float]) {
        guard !chunk.isEmpty else { return }
        let filtered = lowpass.apply(input: chunk)
        var i = (decimation - phase) % decimation
        while i < filtered.count {
            ring[filled % Self.n] = filtered[i]
            filled += 1
            sinceLast += 1
            if filled >= Self.n && sinceLast >= Self.hop {
                sinceLast = 0
                analyzeFrame()
            }
            i += decimation
        }
        phase = (phase + filtered.count) % decimation
    }

    private func analyzeFrame() {
        let n = Self.n
        let log2n: vDSP_Length = 13
        let start = filled % n
        for i in 0..<n { frame[i] = ring[(start + i) % n] * window[i] }
        real.withUnsafeMutableBufferPointer { rp in
            imag.withUnsafeMutableBufferPointer { ip in
                var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                frame.withUnsafeBufferPointer { fp in
                    fp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: n / 2) { cp in
                        vDSP_ctoz(cp, 2, &split, 1, vDSP_Length(n / 2))
                    }
                }
                vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                vDSP_zvmags(&split, 1, &mags, 1, vDSP_Length(n / 2))
            }
        }
        // mags = |X|² ; peaks on magnitude are the same as peaks on power.
        var vec = [Double](repeating: 0, count: 12)
        for b in bins {
            let k = b.index
            guard k > 0, k < n / 2 - 1 else { continue }
            let m = mags[k]
            if m > mags[k - 1] && m >= mags[k + 1] {
                vec[b.pc] += Double(m) * b.weight
            }
        }
        let norm = sqrt(vec.reduce(0) { $0 + $1 * $1 })
        if norm > 0 { for i in 0..<12 { chroma[i] += vec[i] / norm } }
    }

    /// Krumhansl–Schmuckler key estimate.
    func estimateKey() -> MusicalKey? {
        let total = chroma.reduce(0, +)
        guard total > 0 else { return nil }
        let major: [Double] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
        let minorP: [Double] = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
        func corr(_ a: [Double], _ b: [Double]) -> Double {
            let ma = a.reduce(0, +) / 12, mb = b.reduce(0, +) / 12
            var s = 0.0, sa = 0.0, sb = 0.0
            for i in 0..<12 {
                s += (a[i] - ma) * (b[i] - mb)
                sa += (a[i] - ma) * (a[i] - ma)
                sb += (b[i] - mb) * (b[i] - mb)
            }
            return sa > 0 && sb > 0 ? s / sqrt(sa * sb) : 0
        }
        var best: MusicalKey?
        for t in 0..<12 {
            for (profile, isMinor) in [(major, false), (minorP, true)] {
                let rotated = (0..<12).map { profile[Mathx.posModInt($0 - t, 12)] }
                let r = corr(chroma, rotated)
                if best == nil || r > best!.confidence {
                    best = MusicalKey(pitchClass: t, minor: isMinor, confidence: r)
                }
            }
        }
        return best
    }
}

// MARK: - Structure analysis

nonisolated enum StructureAnalyzer {
    private static let weights: (Double, Double, Double) = (1.5, 1.0, 0.7)

    private struct Bands {
        var low: Double, full: Double, high: Double
        static func - (a: Bands, b: Bands) -> Bands { Bands(low: a.low - b.low, full: a.full - b.full, high: a.high - b.high) }
        var weightedAbs: Double { abs(low) * weights.0 + abs(full) * weights.1 + abs(high) * weights.2 }
    }

    private static func mean(_ v: ArraySlice<Bands>) -> Bands {
        guard !v.isEmpty else { return Bands(low: 0, full: 0, high: 0) }
        var s = Bands(low: 0, full: 0, high: 0)
        for b in v { s.low += b.low; s.full += b.full; s.high += b.high }
        let n = Double(v.count)
        return Bands(low: s.low / n, full: s.full / n, high: s.high / n)
    }

    private static func gridFitPerBar(_ beats: [Double], firstBeat fb: Double, beat: Double, bars nb: Int) -> [Float] {
        guard !beats.isEmpty else { return [] }
        var p = beat
        while p > 60.0 / 120 { p /= 2 }
        while p < 60.0 / 240 { p *= 2 }
        var hit = [Int](repeating: 0, count: nb), tot = [Int](repeating: 0, count: nb)
        let barLen = 4 * beat
        for t in beats {
            let b = Int(floor((t - fb) / barLen))
            guard b >= 0 && b < nb else { continue }
            tot[b] += 1
            let r = (t - fb) / p
            if abs(r - r.rounded()) * p < 0.035 { hit[b] += 1 }
        }
        return (0..<nb).map { tot[$0] == 0 ? -1 : Float(hit[$0]) / Float(tot[$0]) }
    }

    private static func percentile(_ values: [Double], _ q: Double) -> Double {
        guard !values.isEmpty else { return 0 }
        let s = values.sorted()
        let pos = q * Double(s.count - 1)
        let i = Int(pos.rounded(.down))
        let f = pos - Double(i)
        return i + 1 < s.count ? s[i] * (1 - f) + s[i + 1] * f : s[i]
    }

    /// - Parameters: per-hop RMS energies at `frameRate` frames per second.
    static func analyze(eLow: [Float], eFull: [Float], eHigh: [Float], frameRate fr: Double,
                        bpm: Double, firstBeat: Double, duration: Double, key: MusicalKey?,
                        hints: StructureHints? = nil) -> TrackStructure? {
        let count = min(eLow.count, eFull.count, eHigh.count)
        guard bpm > 1, count > 0, duration > 20 else { return nil }
        let beat = 60 / bpm
        let barLen = 4 * beat

        func bandDB(_ t0: Double, _ t1: Double) -> Bands {
            let i0 = max(0, Int(t0 * fr))
            let i1 = min(count, max(i0 + 1, Int(t1 * fr)))
            guard i1 > i0 else { return Bands(low: -120, full: -120, high: -120) }
            var l = 0.0, f = 0.0, h = 0.0
            for i in i0..<i1 {
                l += Double(eLow[i]) * Double(eLow[i])
                f += Double(eFull[i]) * Double(eFull[i])
                h += Double(eHigh[i]) * Double(eHigh[i])
            }
            let n = Double(i1 - i0)
            return Bands(low: 10 * log10(l / n + 1e-12), full: 10 * log10(f / n + 1e-12), high: 10 * log10(h / n + 1e-12))
        }

        // 1) Downbeat check: big changes in the music happen on downbeats.
        var fb = firstBeat
        var shift = 0
        let j0 = -Int((fb / beat).rounded(.down))
        let nbt = Int((duration - fb) / beat)
        // The neural tracker found the bar lines itself: don't second-guess them from energy.
        var trusted = false
        if let gb = hints?.gridBPM, let gf = hints?.gridFirstBeat, abs(gb / bpm - 1) < 0.003 {
            let d = Mathx.posMod(gf - firstBeat, barLen)
            trusted = min(d, barLen - d) < 0.03
        }
        if nbt - j0 > 64 && !trusted {
            let beats = (j0..<nbt).map { bandDB(fb + Double($0) * beat, fb + Double($0 + 1) * beat) }
            let n = beats.count
            var nov = [Double](repeating: 0, count: n)
            for j in 8..<(n - 8) {
                let a = mean(beats[max(0, j - 16)..<j])
                let b = mean(beats[j..<min(n, j + 16)])
                nov[j] = (b - a).weightedAbs
            }
            var votes = [Double](repeating: 0, count: 4)
            for j in 0..<n where nov[j] >= 3 {
                let lo = max(0, j - 8), hi = min(n - 1, j + 8)
                if nov[j] >= nov[lo...hi].max()! {
                    votes[Mathx.posModInt(j + j0, 4)] += nov[j]
                }
            }
            let total = votes.reduce(0, +)
            if let bq = votes.indices.max(by: { votes[$0] < votes[$1] }), bq != 0,
               votes[bq] > 1.5 * votes[0], votes[bq] >= 0.3 * total {
                shift = bq
                fb += Double(bq) * beat
                while fb - barLen >= 0 { fb -= barLen }
            }
        }

        // 2) Per-bar levels relative to the loud parts.
        let nb = Int(((duration - fb) / barLen + 0.5).rounded(.down))
        guard nb >= 8 else { return nil }
        var bars = (0..<nb).map { bandDB(fb + Double($0) * barLen, fb + Double($0 + 1) * barLen) }
        let maxFull = bars.map(\.full).max() ?? 0
        let musical = bars.filter { $0.full > maxFull - 40 }
        let ref = Bands(low: percentile(musical.map(\.low), 0.95),
                        full: percentile(musical.map(\.full), 0.95),
                        high: percentile(musical.map(\.high), 0.95))
        bars = bars.map { $0 - ref }

        // Sustained low end per bar: the quieter quarter of the low band's 10 ms levels. A sub bass keeps it
        // high all bar long, while kicks on their own (UKG / dubstep / DnB intros and outros) let it fall
        // between hits — so "has bass" means a bassline, not just a kick drum.
        var floor = [Double](repeating: -120, count: nb)
        for b in 0..<nb {
            let i0 = max(0, Int((fb + Double(b) * barLen) * fr))
            let i1 = min(count, Int((fb + Double(b + 1) * barLen) * fr))
            guard i1 > i0 + 4 else { continue }
            let q = eLow[i0..<i1].sorted()
            floor[b] = 20 * log10(Double(q[q.count / 4]) + 1e-9)
        }
        let floorRef = percentile(Array(floor[0..<nb]).filter { $0 > -100 }, 0.95)
        floor = floor.map { $0 - floorRef }

        // 3) Where the music is.
        let musicStart = bars.firstIndex { $0.full > -25 } ?? 0
        let musicEnd = (bars.lastIndex { $0.full > -20 } ?? (nb - 1)) + 1

        // 4) Phrase offset: section changes and fills line up with the 8-bar grid.
        var raw = [Double](repeating: 0, count: nb)
        if musicStart + 2 < musicEnd - 1 {
            for i in (musicStart + 2)..<(musicEnd - 1) {
                let a = mean(bars[max(musicStart, i - 4)..<i])
                let b = mean(bars[i..<min(musicEnd, i + 4)])
                raw[i] = min(24, (b - a).weightedAbs)
            }
        }
        var novelty = [Double](repeating: 0, count: nb)
        for i in 0..<nb where raw[i] > 0 {
            if raw[i] >= raw[max(0, i - 2)...min(nb - 1, i + 2)].max()! { novelty[i] = raw[i] }
        }
        if max(1, musicStart + 1) < musicEnd - 1 {
            for i in max(1, musicStart + 1)..<(musicEnd - 1) {
                let neighbour = i >= 2 ? bars[i - 2].low : bars[i].low
                let dip = min(neighbour, bars[i].low) - bars[i - 1].low
                if dip > 5 { novelty[i] += min(12, 0.5 * dip) }
            }
        }
        var scores = (0..<8).map { p in stride(from: p, to: nb, by: 8).reduce(0.0) { $0 + novelty[$1] } }
        // Cue suggestions sit on phrase starts far more often than not: let them vote too.
        var cueBars: [CueBar] = []
        for c in hints?.cues ?? [] {
            let b = (c.time - fb) / barLen
            let r = b.rounded()
            guard abs(b - r) < 0.2, r >= 0, Int(r) < nb else { continue }
            cueBars.append(CueBar(bar: r, score: c.score))
            scores[Mathx.posModInt(Int(r), 8)] += 6 * c.score
        }
        scores[0] *= 1.05
        let phase = scores.indices.max { scores[$0] < scores[$1] } ?? 0

        // 5) Sections.
        let bassOn: [Bool] = (0..<nb).map { i in
            let v = i == 0 ? bars[0].low : 0.5 * (bars[i].low + bars[i - 1].low)
            return v > -6 && floor[i] > -9
        }
        var bounds = [musicStart]
        if musicStart + 1 < musicEnd {
            let cueSet = Set(cueBars.map { Int($0.bar) })
            for i in (musicStart + 1)..<musicEnd where raw[i] >= 4.5 || (cueSet.contains(i) && raw[i] >= 2.5) {
                guard raw[i] >= raw[max(0, i - 2)...min(nb - 1, i + 2)].max()! else { continue }
                let lo = max(musicStart + 1, i - 2), hi = min(musicEnd, i + 3)
                guard lo < hi else { continue }
                var j = lo
                var best = -1.0
                for k in lo..<hi {
                    let step = (bars[k] - bars[k - 1]).weightedAbs
                    if step > best { best = step; j = k }
                }
                let snapped = phase + 4 * Int((Double(j - phase) / 4 + 0.5).rounded(.down))
                if abs(snapped - j) <= 1 { j = snapped }
                // A pro-style cue point nearby marks the real start (e.g. the drop after a 2-bar silent build-up).
                if let c = cueBars.filter({ abs(Int($0.bar) - j) <= 2 }).max(by: { $0.score < $1.score }) { j = Int(c.bar) }
                if j - bounds.last! >= 4 && j < musicEnd { bounds.append(j) }
            }
        }
        bounds.append(musicEnd)
        var sections: [TrackSection] = []
        for (a, b) in zip(bounds, bounds.dropFirst()) where b > a {
            let bassFrac = Double((a..<b).filter { bassOn[$0] }.count) / Double(b - a)
            let energy = (a..<b).reduce(0.0) { $0 + bars[$1].full } / Double(b - a)
            let isDrop = bassFrac >= 0.6 && energy >= -4.5
            sections.append(TrackSection(start: a, end: b, kind: isDrop ? .drop : .breakdown, bass: bassFrac, energy: energy))
        }
        // A drop starts where the bass does: move its start past silent build-up bars (up to 4).
        for i in sections.indices.dropFirst() where sections[i].kind == .drop {
            let s0 = sections[i].start
            if let k = (s0..<max(s0, min(s0 + 4, sections[i].end - 1))).first(where: { floor[$0] > -9 }), k > s0 {
                sections[i].start = k
                sections[i - 1].end = k
            }
        }
        let drops = sections.filter { $0.kind == .drop }
        let firstDrop = drops.first?.start ?? musicStart
        let lastDropEnd = drops.last?.end ?? musicEnd
        for i in sections.indices where sections[i].kind != .drop {
            if sections[i].end <= firstDrop { sections[i].kind = .intro }
            else if sections[i].start >= lastDropEnd { sections[i].kind = .outro }
        }
        // Merge neighbours of the same kind for a cleaner picture.
        var merged: [TrackSection] = []
        for s in sections {
            if var last = merged.last, last.kind == s.kind {
                let la = Double(last.end - last.start), lb = Double(s.end - s.start)
                last.bass = (last.bass * la + s.bass * lb) / (la + lb)
                last.energy = (last.energy * la + s.energy * lb) / (la + lb)
                last.end = s.end
                merged[merged.count - 1] = last
            } else {
                merged.append(s)
            }
        }

        return TrackStructure(bpm: bpm, firstBeat: fb, barSeconds: barLen, barCount: nb, phraseOffset: phase,
                              low: bars.map { Float($0.low) }, full: bars.map { Float($0.full) }, high: bars.map { Float($0.high) },
                              bass: bassOn, musicStart: musicStart, musicEnd: musicEnd,
                              firstDrop: firstDrop, lastDropEnd: lastDropEnd, sections: merged,
                              key: key, downbeatShift: shift, cueBars: cueBars,
                              gridFit: gridFitPerBar(hints?.beats ?? [], firstBeat: fb, beat: beat, bars: nb))
    }
}
