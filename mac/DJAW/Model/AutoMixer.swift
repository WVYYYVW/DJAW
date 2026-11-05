import Foundation

/// One planned transition from track A (outgoing) into track B (incoming).
/// Bars are on each track's analysis grid (`TrackStructure`).
nonisolated struct AutoMixPlan: Sendable {
    var outBar: Int
    var inBar: Int
    var length: Int
    var style: TransitionStyle
    var shape: TransitionShape?
    var score: Double
    var reasons: [String]
    /// Name of the variation (e.g. "長く重ねる") when offered as one of several choices.
    var label: String? = nil
}

/// Why the auto-mix chose a transition, kept with the clip so the inspector can explain it.
nonisolated struct AutoMixNote: Codable, Hashable, Sendable {
    var text: String
    var style: TransitionStyle
    var bars: Double
    var inBar: Double
}

/// Plans DJ-style transitions from the analysed structure of two tracks:
/// phrase-aligned mix points, an overlap that lands on the next track's drop,
/// the previous track used up to the end of its music, and no clashing low end.
nonisolated enum AutoMixer {

    /// Per-bar vocal probabilities (analysis-grid bars) of the two tracks, when known.
    struct Vocals: Sendable {
        var a: [Float]?
        var b: [Float]?
        func a(_ k: Int) -> Float { guard let v = a, k >= 0, k < v.count else { return 0 }; return v[k] }
        func b(_ k: Int) -> Float { guard let v = b, k >= 0, k < v.count else { return 0 }; return v[k] }
    }

    static func planPair(_ a: TrackStructure, _ b: TrackStructure, earliestOut aMin: Int,
                         keyClash: Bool, tempoRatio: Double, profile pf: MixProfile = .neutral,
                         vocals: Vocals = Vocals()) -> AutoMixPlan? {
        planOptions(a, b, earliestOut: aMin, keyClash: keyClash, tempoRatio: tempoRatio, profile: pf, vocals: vocals, count: 1).first
    }

    /// The best few distinct plans, best first (the checker falls back to the next one when a plan fails).
    static func planOptions(_ a: TrackStructure, _ b: TrackStructure, earliestOut aMin: Int,
                            keyClash: Bool, tempoRatio: Double, profile pf: MixProfile = .neutral,
                            vocals: Vocals = Vocals(), count: Int = 4, landing: Int? = nil) -> [AutoMixPlan] {
        let all = candidates(a, b, earliestOut: aMin, keyClash: keyClash, tempoRatio: tempoRatio, profile: pf, vocals: vocals,
                             landing: landing)
        // Best first; keep plans that differ in where / how long / how (not near-duplicates).
        var picked: [Candidate] = []
        for c in all.sorted(by: { $0.score > $1.score }) {
            if picked.contains(where: { $0.special == c.special && abs($0.m - c.m) < 4 && abs($0.i - c.i) < 4 && $0.l == c.l }) { continue }
            picked.append(c)
            if picked.count >= count { break }
        }
        return picked.map { finish($0, a, b, keyClash: keyClash, pf: pf) }
    }

    /// Distinct ways to connect the two tracks, each the best of its kind (recommended, long, short,
    /// cut on the drop, echo out, backspin / brake, a different entry, an earlier exit).
    static func planVariations(_ a: TrackStructure, _ b: TrackStructure, earliestOut aMin: Int,
                               keyClash: Bool, tempoRatio: Double, profile: MixProfile = .neutral,
                               vocals: Vocals = Vocals(), landing: Int? = nil) -> [AutoMixPlan] {
        var pf = profile
        pf.maxBars = 32   // show long blends too, even for genres that rarely use them
        let all = candidates(a, b, earliestOut: aMin, keyClash: keyClash, tempoRatio: tempoRatio, profile: pf, vocals: vocals,
                             landing: landing)
            .sorted { $0.score > $1.score }
        guard let top = all.first else { return [] }
        var out: [(String, Candidate)] = [(L("おすすめ", "Recommended"), top)]
        func add(_ label: String, _ where_: (Candidate) -> Bool) {
            guard let c = all.first(where: where_) else { return }
            if out.contains(where: { $0.1.special == c.special && $0.1.m == c.m && $0.1.i == c.i && $0.1.l == c.l }) { return }
            out.append((label, c))
        }
        add(L("長く重ねる", "Long Blend")) { $0.special == nil && $0.l >= 16 }
        add(L("短く重ねる", "Short Blend")) { $0.special == nil && $0.l <= 8 }
        add(L("ドロップでカットイン", "Cut on the Drop")) { $0.special == .cut }
        add(L("エコーで抜く", "Echo Out")) { $0.special == .echoOut }
        add(L("バックスピン／ブレーキ", "Backspin / Brake")) { $0.special == .backspin || $0.special == .brake }
        add(L("別の位置から入る", "Different Entry")) { abs($0.i - top.i) >= 8 }
        add(L("早めに抜ける", "Earlier Exit")) { $0.m <= top.m - 8 }
        return out.map { label, c in
            var plan = finish(c, a, b, keyClash: keyClash, pf: pf)
            plan.label = label
            return plan
        }
    }

    private static func candidates(_ a: TrackStructure, _ b: TrackStructure, earliestOut aMin: Int,
                                   keyClash: Bool, tempoRatio: Double, profile pf: MixProfile,
                                   vocals: Vocals, landing: Int? = nil) -> [Candidate] {
        let aEnd = a.musicEnd
        /// Where A became the main track (to judge how long it has been playing).
        let aLanding = landing ?? (aMin - 8)
        /// "Keep the energy up" pacing (hard / breakcore, learned from a user's own mix): leave A while it is still
        /// in a drop, after about `pacing` seconds, and land B on a drop — instead of playing A to its very end.
        func pacingScore(exitAt e: Int, overlapFrom m: Int, landsOnDrop: Bool, why: inout [String]) -> Double {
            guard let target = pf.pacing else { return 0 }
            var sc = 0.0
            let played = Double(e - aLanding) * a.barSeconds
            sc -= 0.06 * max(0, abs(played - target) - 16) / max(a.barSeconds, 0.5)
            if let sec = a.section(at: m), sec.kind == .drop, a.hasBass(m), landsOnDrop, e <= sec.end {
                sc += pf.dropToDrop
                why.append(L("前の曲が盛り上がっている途中で次の曲のドロップへつなぐ（1曲あたり約\(Int((target / 60).rounded()))分）",
                             "Leaves the previous track while it is still in a drop and lands on the next drop (about \(Int((target / 60).rounded())) min per track)"))
            }
            return sc
        }
        let aOut = a.lastDropEnd
        let bStart = b.musicStart
        let bDrop = b.firstDrop
        let aFloor = max(aMin, a.musicStart + 8)
        let dropStarts = Set(b.sections.filter { $0.kind == .drop }.map(\.start))

        var all: [Candidate] = []
        let probe = TransitionShape.layered(swapAt: 0.5)
        /// Bars where both tracks sing and both are clearly heard (weights the middle of the blend, where mids cross).
        func vocalClash(_ m: Int, _ i: Int, _ l: Int) -> Double {
            guard vocals.a != nil, vocals.b != nil, l > 0 else { return 0 }
            var w = 0.0
            for k in 0..<l {
                let x = (Double(k) + 0.5) / Double(l)
                let open = x > 0.3 && x < 0.8 ? 1.0 : 0.4
                if vocals.a(m + k) > 0.6 && vocals.b(i + k) > 0.6 { w += open }
            }
            return w / Double(l)
        }

        // Blends of 4–32 bars on the 4-bar grid.
        for l in [32, 16, 8, 4] {
            // Big tempo gaps can't be blended for long (both tracks would be far off their own tempo):
            // > 12 % only cut / echo / brake / backspin, 6–12 % at most 8 bars with the tempo riding over.
            if tempoRatio > pf.blendLimit { continue }
            if tempoRatio > 1.06 && l > 8 { continue }
            if l > pf.maxBars { continue }
            for m in a.gridBars(from: aFloor, to: aEnd - l, step: 4) {
                for i in b.gridBars(from: bStart - 3, to: min(b.barCount - l - 8, bDrop + 8), step: 4) {
                    var sc = 0.0
                    var why: [String] = []
                    let land = i + l
                    let e = m + l
                    // Incoming side: land on the first drop.
                    if land == bDrop {
                        sc += 2.4 * pf.dropWeight
                        why.append(L("次の曲の最初のドロップ（\(bDrop + 1)小節目）で切り替え完了", "Lands on the next track’s first drop (bar \(bDrop + 1))"))
                    } else if dropStarts.contains(land) {
                        sc += 1.2 * pf.dropWeight
                        why.append(L("次の曲のドロップ頭（\(land + 1)小節目）で切り替え完了", "Lands on a drop of the next track (bar \(land + 1))"))
                    } else if b.isPhraseStart(land) {
                        sc += 0.4
                        // Real DJ sets (Raveform, ~3,700 transitions): the outgoing track is gone while the next
                        // one is still in its intro / build-up in 57% of transitions, not only on the drop.
                        if land < bDrop && land >= bDrop - 16 { sc += 0.6 }
                    }
                    // Cue points that pro DJs would set (CUE-DETR).
                    let cueIn = b.cueStrength(at: i), cueOut = a.cueStrength(at: m), cueLand = b.cueStrength(at: land)
                    sc += 0.7 * cueIn + 0.6 * cueOut + 0.4 * cueLand
                    if cueIn > 0.5 {
                        why.append(L("次の曲はプロDJが CUE を置きやすい位置（\(i + 1)小節目・AI予測）から入る", "The next track enters where pro DJs tend to set a cue (bar \(i + 1), AI-predicted)"))
                    }
                    if i > bDrop { sc -= 0.15 * Double(i - bDrop) }
                    if i > bStart { sc -= 0.02 * Double(min(i - bStart, max(0, bDrop - bStart))) }
                    if pf.pacing == nil {
                        // Outgoing side: use the music up to its end.
                        if abs(e - aEnd) <= 1 {
                            sc += 2
                            why.append(L("前の曲は音が終わるところまで使う", "Plays the previous track to the end of its music"))
                        } else if e == aOut {
                            sc += 1.5
                            why.append(L("前の曲は最後のドロップが終わる所で抜ける", "The previous track leaves as its last drop ends"))
                        }
                        if m == aOut && aEnd - aOut >= 4 {
                            sc += 1.5
                            why.append(L("前の曲のアウトロ（\(aOut + 1)小節目〜）に重ねる", "Blends over the previous track’s outro (from bar \(aOut + 1))"))
                        }
                        if e < aOut { sc -= 0.12 * Double(aOut - e) }
                    } else {
                        sc += pacingScore(exitAt: e, overlapFrom: m, landsOnDrop: dropStarts.contains(land), why: &why)
                    }
                    sc -= 0.02 * Double(max(0, aEnd - max(e, aOut)))
                    // How busy the overlap sounds with the EQ blend that will be used.
                    sc -= 3 * clutter(a, m, b, i, l, shape: probe)
                    var sparse = 0
                    for k in 0..<l where !a.hasBass(m + k) && !b.hasBass(i + k) { sparse += 1 }
                    sc += 0.02 * Double(sparse)
                    sc += pf.lengthBonus[l] ?? 0
                    if keyClash { sc -= 0.02 * Double(l) }
                    if tempoRatio > 1.06 { sc -= 0.03 * Double(l) }
                    if a.isPhraseStart(m) { sc += 0.3 }
                    if b.isPhraseStart(i) { sc += 0.3 }
                    let vc = vocalClash(m, i, l)
                    if vc > 0 {
                        sc -= 2.5 * vc * pf.vocalWeight
                        if vc > 0.3 { why.append(L("歌が少し重なる（重なりの \(Int((vc * 100).rounded()))%）", "Vocals overlap a little (\(Int((vc * 100).rounded()))% of the blend)")) }
                    } else if vocals.a != nil && vocals.b != nil && (0..<l).contains(where: { vocals.a(m + $0) > 0.6 }) && (0..<l).contains(where: { vocals.b(i + $0) > 0.6 }) {
                        why.append(L("両方の歌が重ならない位置で重ねる", "Placed so the two vocals don't overlap"))
                    }
                    all.append(Candidate(m: m, i: i, l: l, score: sc, reasons: why, special: nil))
                }
            }
        }

        // Cut or echo out on a phrase, straight into the next track.
        let bPhraseIn = b.phraseOffset + 8 * Int((Double(bStart - b.phraseOffset) / 8).rounded(.down))
        for m in a.gridBars(from: aFloor, to: aEnd, step: 8) {
            for i in Set([bDrop, bPhraseIn]).sorted() {
                for (l, style) in [(0, TransitionStyle.cut), (2, TransitionStyle.echoOut), (0, TransitionStyle.brake), (0, TransitionStyle.backspin)] {
                    // Hard switches sound abrupt; only use them when no blend works.
                    var sc = -2.5 + pf.switchBias
                    if style == .echoOut { sc += pf.echoBias }
                    if style == .brake || style == .backspin { sc += pf.spinBias }
                    var why: [String] = []
                    if i == bDrop {
                        sc += 1.2
                        why.append(L("次の曲のドロップ頭（\(bDrop + 1)小節目）へ切り替え", "Switches straight into the next track’s drop (bar \(bDrop + 1))"))
                    }
                    let aInDrop = a.hasBass(m - 1)
                    if style == .echoOut && aInDrop {
                        sc += 0.6
                        why.append(L("前の曲は盛り上がったまま終わるのでエコーで抜く", "The previous track ends at full energy, so it is echoed out"))
                    }
                    if style == .cut && !aInDrop { sc += 0.4 }
                    sc += 0.6 * b.cueStrength(at: i) + 0.5 * a.cueStrength(at: m)
                    // Turntable stops: kept for big tempo jumps, where a blend can't stay in time.
                    if style == .brake || style == .backspin {
                        let goingDown = b.bpm < a.bpm
                        if tempoRatio > 1.08 {
                            let fits = (style == .brake) == goingDown
                            sc += fits ? 1.9 : 1.1
                            why.append(style == .brake
                                       ? L("BPM が大きく下がる（\(Int(a.bpm.rounded()))→\(Int(b.bpm.rounded()))）ので、ブレーキで止めてから次の曲へ", "Big tempo drop (\(Int(a.bpm.rounded())) → \(Int(b.bpm.rounded()))): brake to a stop, then drop the next track")
                                       : L("BPM が大きく違う（\(Int(a.bpm.rounded()))→\(Int(b.bpm.rounded()))）ので、バックスピンで切り替え", "Big tempo jump (\(Int(a.bpm.rounded())) → \(Int(b.bpm.rounded()))): backspin into the next track"))
                            if aInDrop { sc += 0.3 }
                        } else {
                            sc -= 0.8
                        }
                    } else if tempoRatio > 1.08 && style == .cut {
                        sc += 0.8
                    }
                    if pf.pacing == nil {
                        if abs(m - aEnd) <= 1 { sc += 1.5 } else if m == aOut { sc += 1.2 }
                        if m < aOut { sc -= 0.12 * Double(aOut - m) }
                    } else {
                        sc += pacingScore(exitAt: m, overlapFrom: max(0, m - 1), landsOnDrop: dropStarts.contains(i), why: &why)
                    }
                    sc -= 0.02 * Double(max(0, aEnd - max(m, aOut)))
                    // Don't cut a vocal line in half (the next one starting mid-phrase is less bad).
                    if style != .echoOut && vocals.a(m - 1) > 0.6 && vocals.a(m) > 0.6 {
                        sc -= 0.8 * pf.vocalWeight
                        why.append(L("（前の曲の歌の途中で切り替わる）", "(cuts into the previous track's vocal line)"))
                    }
                    if vocals.b(i - 1) > 0.6 && vocals.b(i) > 0.6 { sc -= 0.3 * pf.vocalWeight }
                    all.append(Candidate(m: m, i: i, l: l, score: sc, reasons: why, special: style))
                }
            }
        }

        return all
    }

    private struct Candidate { var m: Int; var i: Int; var l: Int; var score: Double; var reasons: [String]; var special: TransitionStyle? }

    private static func finish(_ c: Candidate, _ a: TrackStructure, _ b: TrackStructure, keyClash: Bool, pf: MixProfile) -> AutoMixPlan {
        let bStart = b.musicStart, bDrop = b.firstDrop
        var reasons = c.reasons
        if c.i > bStart + 3 && c.i < bDrop {
            reasons.append(L("次の曲のイントロ前半は省略（\(c.i + 1)小節目から）", "Skips the start of the next track’s intro (enters at bar \(c.i + 1))"))
        }
        if keyClash, let ka = a.key, let kb = b.key {
            reasons.append(L("キーの相性が良くない（\(ka.camelot)→\(kb.camelot)）ので重ねる長さは控えめ", "Keys clash (\(ka.camelot) → \(kb.camelot)), so the overlap is kept short"))
        }

        if let special = c.special {
            return AutoMixPlan(outBar: c.m, inBar: c.i, length: c.l, style: special, shape: nil, score: c.score, reasons: reasons)
        }

        // Pick the style from what actually sounds during the overlap.
        let l = c.l
        let aBass = (0..<l).map { a.hasBass(c.m + $0) }
        let bBass = (0..<l).map { b.hasBass(c.i + $0) }
        // Swap point: where the incoming bass really starts (on a 4-bar line), else the middle.
        var k = l / 2
        if let firstBass = (0..<l).first(where: { bBass[$0] && ($0 + 1 >= l || bBass[$0 + 1]) }), firstBass > 0 {
            k = firstBass
        }
        if l >= 8 { k = 4 * Int((Double(k) / 4).rounded()) }
        k = min(max(l >= 8 ? 4 : 1, k), max(1, l - (l >= 8 ? 4 : 1)))
        let p = Double(k) / Double(l)
        var style: TransitionStyle
        var shape: TransitionShape
        if aBass.contains(true) && bBass.contains(true) {
            style = .bassSwap
            shape = pf.shapes.apply(to: .layered(swapAt: p))
            reasons.append(L("両方に低音があるので、\(k + 1)小節目で低音を一気に入れ替え", "Both have bass, so the low end is swapped at bar \(k + 1) of the blend"))
        } else if (keyClash || pf.eq == .filter) && l >= 8 && pf.eq != .smooth {
            style = .filter
            shape = pf.shapes.apply(to: .filterOut(swapAt: p))
            reasons.append(L("前の曲をフィルターで抜いて和音のぶつかりを抑える", "Filters the previous track out to hide the key clash"))
        } else {
            style = .crossfade
            shape = pf.shapes.apply(to: .blend(swapAt: p))
            reasons.append(L("低音がぶつからないので、EQ をなだらかに入れ替えるクロスフェード", "No clashing bass: a crossfade with a gentle EQ hand-over"))
        }
        if pf.shapes.learned { reasons.append(L("EQ の動かし方は参照ミックスから学習した値", "EQ moves follow curves learned from reference mixes")) }
        reasons.append(L("次の曲は低音・中音を切った状態で静かに入り、\(k + 1)小節目までは前の曲が主役", "The next track sneaks in with its lows and mids cut; the previous track leads until bar \(k + 1)"))
        return AutoMixPlan(outBar: c.m, inBar: c.i, length: l, style: style, shape: shape, score: c.score, reasons: reasons)
    }
}

// MARK: - Running order

nonisolated extension AutoMixer {
    /// What the order planner needs to know about one track.
    struct OrderItem: Sendable {
        var bpm: Double
        /// Other tempo readings of the same track (the planner may use any of them).
        var bpmOptions: [Double] = []
        var key: MusicalKey?
        /// Bars of intro before the first drop / of outro after the last drop.
        var introBars: Int
        var outroBars: Int
        /// Genre family (tracks of the same / a neighbouring family are kept together).
        var genre: MixGenre? = nil
        /// Energy (party / aggressive / danceable feel and drop loudness), for the set's energy curve.
        var energy: Double? = nil
    }

    /// Cost of playing `b` right after `a` (lower is smoother).
    static func transitionCost(_ a: OrderItem, _ b: OrderItem) -> Double {
        var c = 0.0
        // Tempo: every track is stretched to one master tempo, so big jumps sound unnatural.
        let aOpts = [a.bpm] + a.bpmOptions, bOpts = [b.bpm] + b.bpmOptions
        var d = Double.infinity
        for x in aOpts { for y in bOpts { d = min(d, abs(log(max(1, y) / max(1, x)))) } }
        c += 25 * d
        if d > 0.08 { c += 2 }
        if b.bpm < a.bpm - 1 { c += 0.3 }   // gently prefer rising tempo
        // Key (Camelot wheel).
        if let ka = a.key, let kb = b.key, ka.confidence > 0.5, kb.confidence > 0.5 {
            if !ka.isCompatible(with: kb) {
                let x = ka.camelotNumber, y = kb.camelotNumber
                let dist = Double(min((x - y + 12) % 12, (y - x + 12) % 12))
                c += ka.minor == kb.minor ? 0.6 * dist : 0.8 + 0.4 * dist
            }
        } else {
            c += 0.3
        }
        // Genre: keep a family together, move on to neighbouring families.
        if let ga = a.genre, let gb = b.genre, ga != gb {
            c += ga.isNeighbor(of: gb) ? 0.4 : 1.2
        }
        // Easy blends: an outro into an intro.
        if a.outroBars >= 8 && b.introBars >= 8 { c -= 0.5 }
        return c
    }

    /// Order with the smallest total transition cost (exact up to 12 tracks, heuristic beyond).
    static func bestOrder(_ items: [OrderItem], arc: SetArc = .none) -> [Int] {
        let n = items.count
        // Energy rank 0…1 among the tracks that have one; cost of putting track k at position pos.
        let known = items.indices.filter { items[$0].energy != nil }.sorted { items[$0].energy! < items[$1].energy! }
        var rank = [Double?](repeating: nil, count: n)
        for (r, k) in known.enumerated() { rank[k] = known.count > 1 ? Double(r) / Double(known.count - 1) : 0.5 }
        func arcCost(_ k: Int, _ pos: Int) -> Double {
            guard n > 1, let r = rank[k], let t = arc.target(Double(pos) / Double(n - 1)) else { return 0 }
            return 3 * (r - t) * (r - t)
        }
        guard n > 2 else {
            if n == 2 {
                let ab = transitionCost(items[0], items[1]) + arcCost(0, 0) + arcCost(1, 1)
                let ba = transitionCost(items[1], items[0]) + arcCost(1, 0) + arcCost(0, 1)
                return ab <= ba ? [0, 1] : [1, 0]
            }
            return Array(0..<n)
        }
        var cost = [[Double]](repeating: [Double](repeating: 0, count: n), count: n)
        for i in 0..<n { for j in 0..<n where i != j { cost[i][j] = transitionCost(items[i], items[j]) } }
        // Small bias to start with the slowest track.
        let minBPM = items.map(\.bpm).min() ?? 0
        let startCost = items.indices.map { (arc == .none ? 0.05 * (items[$0].bpm - minBPM) : 0) + arcCost($0, 0) }

        if n <= 12 {
            // Held–Karp over open paths.
            let full = 1 << n
            var dp = [Double](repeating: .infinity, count: full * n)
            var parent = [Int](repeating: -1, count: full * n)
            for i in 0..<n { dp[(1 << i) * n + i] = startCost[i] }
            for mask in 1..<full {
                for last in 0..<n where mask & (1 << last) != 0 {
                    let cur = dp[mask * n + last]
                    if cur == .infinity { continue }
                    let pos = mask.nonzeroBitCount
                    for next in 0..<n where mask & (1 << next) == 0 {
                        let nm = mask | (1 << next)
                        let v = cur + cost[last][next] + arcCost(next, pos)
                        if v < dp[nm * n + next] {
                            dp[nm * n + next] = v
                            parent[nm * n + next] = last
                        }
                    }
                }
            }
            var last = (0..<n).min { dp[(full - 1) * n + $0] < dp[(full - 1) * n + $1] } ?? 0
            var mask = full - 1
            var path: [Int] = []
            while last >= 0 {
                path.append(last)
                let p = parent[mask * n + last]
                mask &= ~(1 << last)
                last = p
            }
            return path.reversed()
        }

        // Larger sets: best greedy path from every start, then 2-opt.
        func total(_ p: [Int]) -> Double {
            startCost[p[0]] + zip(p, p.dropFirst()).reduce(0) { $0 + cost[$1.0][$1.1] }
                + p.enumerated().dropFirst().reduce(0) { $0 + arcCost($1.element, $1.offset) }
        }
        var best: [Int] = Array(0..<n)
        var bestCost = total(best)
        for s in 0..<n {
            var path = [s]
            var used = Set([s])
            while path.count < n {
                let last = path.last!
                let pos = path.count
                let next = (0..<n).filter { !used.contains($0) }.min { cost[last][$0] + arcCost($0, pos) < cost[last][$1] + arcCost($1, pos) }!
                path.append(next)
                used.insert(next)
            }
            let c = total(path)
            if c < bestCost { best = path; bestCost = c }
        }
        var improved = true
        while improved {
            improved = false
            for i in 0..<(n - 1) {
                for j in (i + 1)..<n {
                    var cand = best
                    cand[i...j].reverse()
                    let c = total(cand)
                    if c + 1e-9 < bestCost { best = cand; bestCost = c; improved = true }
                }
            }
        }
        return best
    }
}


// MARK: - Overlap clutter

nonisolated extension AutoMixer {
    /// Average number of bands per beat (low weighted 1.5) in which both tracks are clearly
    /// audible at similar levels during the overlap — what makes a blend sound messy.
    static func clutter(_ a: TrackStructure, _ m: Int, _ b: TrackStructure, _ i: Int, _ l: Int,
                        shape: TransitionShape) -> Double {
        guard l > 0 else { return 0 }
        let steps = l * 4
        let killDB = [-40.0, -24.0, -40.0]
        let weight = [1.5, 1.0, 1.0]
        var total = 0.0
        for s in 0..<steps {
            let x = (Double(s) + 0.5) / Double(steps)
            let ci = Automation.incoming(.bassSwap, shape, x)
            let co = Automation.outgoing(.bassSwap, shape, x)
            let ba = m + s / 4, bb = i + s / 4
            guard ba >= 0, ba < a.barCount, bb >= 0, bb < b.barCount else { continue }
            let la = [Double(a.low[ba]), Double(a.full[ba]), Double(a.high[ba])]
            let lb = [Double(b.low[bb]), Double(b.full[bb]), Double(b.high[bb])]
            let ka = [co.lowKill, co.midKill, co.highKill]
            let kb = [ci.lowKill, ci.midKill, ci.highKill]
            let va = 20 * log10(max(co.volume, 1e-4)), vb = 20 * log10(max(ci.volume, 1e-4))
            for band in 0..<3 {
                let ea = la[band] + va + killDB[band] * ka[band]
                let eb = lb[band] + vb + killDB[band] * kb[band]
                if ea > -24 && eb > -24 && abs(ea - eb) < 8 { total += weight[band] }
            }
        }
        return total / Double(steps)
    }
}

// MARK: - Mix style

/// How the auto-mix connects tracks.
nonisolated enum MixStyle: String, CaseIterable, Identifiable, Codable, Sendable {
    /// Decide from the tracks (fast-changing / tempo-switching material → quick cuts).
    case auto
    /// Long, EQ-blended DJ transitions.
    case long
    /// Dariacore / mashup style: only each track's best 8–16 bars, chained with cut-ins.
    case quick

    var id: String { rawValue }

    var title: String {
        switch self {
        case .auto: return L("自動", "Auto")
        case .long: return L("じっくりつなぐ", "Long Blends")
        case .quick: return L("カットインで畳みかける", "Quick Cuts")
        }
    }

    var detail: String {
        switch self {
        case .auto: return L("曲のジャンル・展開の速さ・テンポの揺れから自動で選び、つなぎ方もジャンルごとに変えます。", "Picked from the genres, how fast the tracks change and whether their tempo moves; each genre is mixed its own way.")
        case .long: return L("ハウス・テクノ・UKG などで、EQ を入れ替えながら長く重ねます。", "House / techno / UKG style: long overlaps with EQ hand-overs.")
        case .quick: return L("Dariacore・マッシュアップ系向け。各曲のおいしい 8〜16 小節だけを使い、小節頭のカットインでテンポごと切り替えます。", "For Dariacore / mashups: each track's best 8–16 bars, switched on the downbeat with cut-ins (tempo changes with them).")
        }
    }
}

nonisolated extension AutoMixer {
    /// The part of a track worth playing in a quick-cut mix.
    struct Highlight: Sendable {
        var start: Int
        var end: Int
        var score: Double
        var reasons: [String]
    }

    /// Material that suits quick cuts better than long blends: sections change every few bars,
    /// or the tempo itself moves (the steady grid only fits parts of the track).
    static func looksQuick(_ s: TrackStructure, tempoVaries: Bool) -> Bool {
        let span = max(1, s.musicEnd - s.musicStart)
        let avgSection = Double(span) / Double(max(1, s.sections.count))
        let fit = s.gridFit(from: s.musicStart, to: s.musicEnd)
        return tempoVaries || fit < 0.8 || (avgSection <= 10 && s.bpm >= 140)
    }

    /// Window lengths (bars) that last roughly 9–30 s.
    static func quickWindowBars(_ s: TrackStructure) -> [Int] {
        let ok = [8, 12, 16].filter { Double($0) * s.barSeconds >= 9 && Double($0) * s.barSeconds <= 30 }
        return ok.isEmpty ? [8] : ok
    }

    /// Best `bars`-long stretch: loud, with bass, starting on a drop / cue / phrase, and where the
    /// steady beat grid really fits (so cuts land on the beat even in tempo-switching tracks).
    /// Best highlight of any of the given lengths, starting and ending inside `within` (bars).
    static func highlight(_ s: TrackStructure, lengths: [Int], within: ClosedRange<Int>? = nil) -> Highlight? {
        var best: Highlight?
        for len in lengths {
            guard var h = highlight(s, bars: len, within: within) else { continue }
            h.score += 0.08 * Double(len - 8)   // a bit more of a good part is better than a too-short taste
            if best == nil || h.score > best!.score { best = h }
        }
        return best
    }

    static func highlight(_ s: TrackStructure, bars len: Int, within: ClosedRange<Int>? = nil) -> Highlight? {
        let lo = max(s.musicStart, within?.lowerBound ?? s.musicStart)
        let hi = min(s.musicEnd, within?.upperBound ?? s.musicEnd) - len
        guard hi >= lo else { return nil }
        var starts = Set(s.gridBars(from: lo, to: hi, step: 4))
        for c in s.cueBars where Int(c.bar) >= lo && Int(c.bar) <= hi { starts.insert(Int(c.bar)) }
        for sec in s.sections where sec.start >= lo && sec.start <= hi { starts.insert(sec.start) }
        starts.insert(lo)
        let boundaries = Set(s.sections.map(\.start) + s.sections.map(\.end))
        var best: Highlight?
        for c in starts.sorted() {
            var sc = 0.0
            var why: [String] = []
            let e = c..<(c + len)
            let energy = e.reduce(0.0) { $0 + s.energy($1) } / Double(len)
            sc += 0.25 * max(-20, energy)
            let bassFrac = Double(e.filter { s.hasBass($0) }.count) / Double(len)
            sc += 1.0 * bassFrac
            if let sec = s.section(at: c) {
                if sec.kind == .drop && sec.start == c {
                    sc += 1.2
                    why.append(L("ドロップ頭（\(c + 1)小節目）から", "From the top of a drop (bar \(c + 1))"))
                } else if sec.kind == .drop {
                    sc += 0.5
                } else if sec.kind == .intro || sec.kind == .outro {
                    sc -= 0.8
                }
            }
            let cue = s.cueStrength(at: c)
            sc += 1.5 * cue + 0.6 * s.cueStrength(at: c + len)
            if cue > 0.5 { why.append(L("AI の CUE 候補の位置で入る", "Enters on an AI cue point")) }
            if boundaries.contains(c + len) { sc += 1.0 }
            if s.isPhraseStart(c) { sc += 0.3 }
            let fit = s.gridFit(from: c, to: c + len)
            if fit < 0.7 { sc -= 4 }
            sc += 2 * (fit - 0.85)
            sc -= 0.004 * Double(c - lo)
            if best == nil || sc > best!.score {
                best = Highlight(start: c, end: c + len, score: sc, reasons: why)
            }
        }
        return best
    }

    /// How a quick-cut mix switches from `a` (leaving at its bar `out`) to `b`.
    /// Mostly hard cuts on the downbeat; spinbacks, brakes and echo-outs for variety and big tempo jumps.
    static func quickTransition(from a: TrackStructure, out: Int, to b: TrackStructure, index: Int)
        -> (style: TransitionStyle, bars: Double, roll: Bool, reasons: [String]) {
        let ratio = b.bpm / max(a.bpm, 1)
        let aFull = a.hasBass(out - 1)
        if ratio < 0.86 {
            return (.brake, 0, false, [L("BPM が大きく下がる（\(Int(a.bpm.rounded()))→\(Int(b.bpm.rounded()))）のでブレーキで止めてから切り替え", "Big tempo drop (\(Int(a.bpm.rounded())) → \(Int(b.bpm.rounded()))): brake, then switch")])
        }
        if aFull && index % 4 == 3 {
            return (.backspin, 0, false, [L("盛り上がったところでバックスピンして次の曲へ", "Spin back at full energy into the next track")])
        }
        if aFull && index % 5 == 4 {
            return (.echoOut, 1, false, [L("エコーで残響だけ残して次の曲へ", "Echo out into the next track")])
        }
        let roll = aFull && (index % 3 == 1 || ratio > 1.15)
        var why = [L("小節頭でカットイン", "Cut in on the downbeat")]
        if roll { why.append(L("切り替え直前の 2 拍をロールで刻む", "A roll over the last two beats before the cut")) }
        return (.cut, 0, roll, why)
    }
}

// MARK: - Genre-specific mixing

/// How a genre is usually mixed by DJs; tilts the transition planner's choices.
nonisolated struct MixProfile: Sendable {
    enum EQ: Sendable { case swap, filter, smooth }
    /// Bonus per blend length (bars).
    var lengthBonus: [Int: Double] = [32: 0.1, 16: 0.35, 8: 0.25, 4: 0]
    var maxBars = 32
    /// Added to cuts / echo-outs / turntable stops (which otherwise only win when no blend works).
    var switchBias = 0.0
    var echoBias = 0.0
    var spinBias = 0.0
    /// Weight of landing the blend exactly on the next track's drop.
    var dropWeight = 1.0
    /// Tempo gap (ratio) above which blends are no longer planned.
    var blendLimit = 1.12
    var eq: EQ = .swap
    /// High-pass the outgoing track in the second half of long bass swaps.
    var thinOut = true
    /// Reverb tail on the outgoing track for smooth crossfades.
    var reverbTail = false
    /// How much overlapping vocals are avoided (pop / hip-hop more, techno / breakcore less).
    var vocalWeight = 1.0
    /// EQ-curve adjustments learned from reference mixes (none by default).
    var shapes = ShapeTuning()
    /// Seconds a track should play before the next one takes over (nil = use each track to the end of its music).
    var pacing: Double? = nil
    /// Bonus for leaving the previous track during a drop straight into the next track's drop (with `pacing`).
    var dropToDrop = 0.0

    static var neutral: MixProfile { MixTuning.current.apply(MixProfile(), genre: nil) }

    static func of(_ g: MixGenre) -> MixProfile {
        MixTuning.current.apply(base(g), genre: g)
    }

    private static func base(_ g: MixGenre) -> MixProfile {
        var p = MixProfile()
        p.vocalWeight = [.pop: 1.3, .hiphop: 1.2, .ukg: 1.1, .band: 1.2, .techno: 0.6, .dnb: 0.8, .bass: 0.8,
                         .hard: 0.9, .breakcore: 0.5, .chill: 0.8][g] ?? 1.0
        switch g {
        case .house:
            p.lengthBonus = [32: 0.45, 16: 0.45, 8: 0.1, 4: -0.3]; p.switchBias = -0.4; p.spinBias = -0.6; p.dropWeight = 0.8; p.blendLimit = 1.08
        case .techno:
            p.lengthBonus = [32: 0.75, 16: 0.4, 8: 0, 4: -0.4]; p.switchBias = -0.6; p.spinBias = -0.9; p.dropWeight = 0.6; p.eq = .filter; p.blendLimit = 1.08
        case .trance:
            p.lengthBonus = [32: 0.35, 16: 0.5, 8: 0.15, 4: -0.3]; p.switchBias = -0.3; p.spinBias = -0.6; p.dropWeight = 1.0; p.blendLimit = 1.08
        case .ukg:
            p.lengthBonus = [32: -0.3, 16: 0.45, 8: 0.4, 4: 0]; p.maxBars = 16; p.echoBias = 0.2; p.dropWeight = 1.1; p.blendLimit = 1.06
        case .bass:
            p.lengthBonus = [32: -0.7, 16: 0.1, 8: 0.45, 4: 0.2]; p.maxBars = 16; p.switchBias = 0.8; p.echoBias = 0.5; p.spinBias = 0.3; p.dropWeight = 1.4
        case .dnb:
            p.lengthBonus = [32: -0.2, 16: 0.5, 8: 0.35, 4: 0]; p.switchBias = 0.3; p.spinBias = 0.5; p.dropWeight = 1.5
        case .breaks:
            p.lengthBonus = [32: -0.2, 16: 0.35, 8: 0.35, 4: 0.1]; p.maxBars = 16; p.switchBias = 0.3; p.echoBias = 0.2
        case .hard:
            p.lengthBonus = [32: -0.7, 16: 0.15, 8: 0.4, 4: 0.25]; p.maxBars = 16; p.switchBias = 0.9; p.echoBias = 0.3; p.spinBias = 0.6; p.dropWeight = 1.3
            p.pacing = 150; p.dropToDrop = 0.8; p.shapes = .handSwap
        case .breakcore:
            p.lengthBonus = [32: -1, 16: -0.3, 8: 0.2, 4: 0.4]; p.maxBars = 8; p.switchBias = 1.5; p.spinBias = 0.8; p.echoBias = 0.3
            p.pacing = 150; p.dropToDrop = 0.8; p.shapes = .handSwap
        case .hiphop:
            p.lengthBonus = [32: -1, 16: -0.4, 8: 0.2, 4: 0.4]; p.maxBars = 8; p.switchBias = 1.4; p.echoBias = 0.8; p.spinBias = 0.6; p.dropWeight = 0.6; p.thinOut = false
        case .pop:
            p.lengthBonus = [32: -0.8, 16: 0, 8: 0.4, 4: 0.3]; p.maxBars = 16; p.switchBias = 0.6; p.echoBias = 0.6; p.dropWeight = 0.9; p.thinOut = false
        case .chill:
            p.lengthBonus = [32: 0.5, 16: 0.4, 8: 0, 4: -0.4]; p.switchBias = -0.8; p.spinBias = -1.5; p.echoBias = 0.2; p.dropWeight = 0.5; p.blendLimit = 1.05; p.eq = .smooth; p.thinOut = false; p.reverbTail = true
        case .band:
            p.lengthBonus = [32: -0.6, 16: 0, 8: 0.3, 4: 0.3]; p.maxBars = 16; p.switchBias = 0.5; p.echoBias = 0.7; p.spinBias = -0.6; p.dropWeight = 0.5; p.blendLimit = 1.04; p.eq = .smooth; p.thinOut = false
        }
        return p
    }

    /// Profile for a transition from genre `a` into genre `b` (nil = unknown).
    static func pair(_ a: MixGenre?, _ b: MixGenre?) -> MixProfile {
        switch (a, b) {
        case (nil, nil): return .neutral
        case (let g?, nil), (nil, let g?): return of(g)
        case (let x?, let y?):
            if x == y { return of(x) }
            let p = of(x), q = of(y)
            var r = MixProfile()
            for l in [32, 16, 8, 4] { r.lengthBonus[l] = ((p.lengthBonus[l] ?? 0) + (q.lengthBonus[l] ?? 0)) / 2 }
            r.maxBars = min(p.maxBars, q.maxBars)
            r.switchBias = (p.switchBias + q.switchBias) / 2
            r.echoBias = (p.echoBias + q.echoBias) / 2
            r.spinBias = (p.spinBias + q.spinBias) / 2
            r.dropWeight = q.dropWeight
            r.blendLimit = min(p.blendLimit, q.blendLimit)
            r.eq = p.eq == .smooth || q.eq == .smooth ? .smooth : (p.eq == .filter || q.eq == .filter ? .filter : .swap)
            r.thinOut = p.thinOut && q.thinOut
            r.reverbTail = p.reverbTail || q.reverbTail
            r.vocalWeight = max(p.vocalWeight, q.vocalWeight)
            r.shapes = q.shapes
            // The outgoing track's genre decides how long it plays.
            r.pacing = p.pacing ?? q.pacing
            r.dropToDrop = max(p.dropToDrop, q.dropToDrop)
            // Far-apart genres: a short blend or a clean switch sounds more intentional than a long overlap.
            if !x.isNeighbor(of: y) {
                r.lengthBonus[32] = (r.lengthBonus[32] ?? 0) - 0.4
                r.lengthBonus[16] = (r.lengthBonus[16] ?? 0) - 0.15
                r.switchBias += 0.7
                r.echoBias += 0.4
            }
            return r
        }
    }
}


// MARK: - Tuning (from the MixScore kit)

/// EQ-curve adjustments relative to the swap point p (= the shape's inRise). Unset values keep the built-in curves.
nonisolated struct ShapeTuning: Codable, Sendable {
    var midLead: Double?
    var midRamp: Double?
    var lowRamp: Double?
    var highLead: Double?
    var highRamp: Double?
    var inRiseOffset: Double?
    var outFadeOffset: Double?
    /// Number of reference transitions the values were learned from.
    var transitions: Int?

    var learned: Bool { (transitions ?? 0) > 0 }

    /// Hand-made hardcore / breakcore blends (a user's own hyperflip mix): the next track comes up to full volume by
    /// the swap point, mids cross just before it, the lows swap in one go, then the previous track fades out.
    static let handSwap = ShapeTuning(midLead: 0.1, midRamp: 0.3, lowRamp: 0, highLead: nil, highRamp: nil,
                                      inRiseOffset: 0, outFadeOffset: 0, transitions: 4)

    func apply(to shape: TransitionShape) -> TransitionShape {
        guard learned else { return shape }
        var s = shape
        let p = shape.inRise
        func clamp(_ x: Double) -> Double { min(1, max(0, x)) }
        if let r = lowRamp { s.low.ramp = max(0, r); s.low.point = clamp(p - s.low.ramp / 2) }
        if let lead = midLead { s.mid.point = clamp(p - lead) }
        if let r = midRamp { s.mid.ramp = max(0, r) }
        if let lead = highLead {
            s.high.enabled = true
            s.high.point = clamp(p - lead)
            s.high.ramp = max(0, highRamp ?? 0.3)
        }
        if let o = inRiseOffset { s.inRise = clamp(p + o) }
        if let o = outFadeOffset { s.outFadeStart = clamp(p + o) }
        return s
    }
}

/// Values the MixScore kit found to match reference mixes better (installed as
/// ~/Library/Application Support/DJAW/MixTuning.json). Absent = the built-in values.
nonisolated struct MixTuning: Codable, Sendable {
    /// Additive for lengths / biases, multiplicative for weights.
    struct Params: Codable, Sendable {
        var len32: Double?, len16: Double?, len8: Double?, len4: Double?
        var switchBias: Double?, echoBias: Double?, spinBias: Double?
        var dropWeight: Double?, vocalWeight: Double?
        var maxBars: Int?
        var pacing: Double?
        var dropToDrop: Double?
    }
    var version = 1
    var note: String?
    /// Keyed by genre (MixGenre raw value) or "*" for every genre.
    var params: [String: Params] = [:]
    var shapes: [String: ShapeTuning] = [:]

    nonisolated(unsafe) static var current = MixTuning.load(from: installedURL) ?? MixTuning()

    static var installedURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("DJAW/MixTuning.json")
    }

    static func load(from url: URL) -> MixTuning? {
        guard let d = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(MixTuning.self, from: d)
    }

    var isEmpty: Bool { params.isEmpty && shapes.isEmpty }

    func apply(_ p: MixProfile, genre: MixGenre?) -> MixProfile {
        var r = p
        for key in ["*", genre?.rawValue].compactMap({ $0 }) {
            if let t = params[key] {
                for (l, v) in [(32, t.len32), (16, t.len16), (8, t.len8), (4, t.len4)] { if let v { r.lengthBonus[l] = (r.lengthBonus[l] ?? 0) + v } }
                if let v = t.switchBias { r.switchBias += v }
                if let v = t.echoBias { r.echoBias += v }
                if let v = t.spinBias { r.spinBias += v }
                if let v = t.dropWeight { r.dropWeight *= v }
                if let v = t.vocalWeight { r.vocalWeight *= v }
                if let v = t.maxBars { r.maxBars = v }
                if let v = t.pacing { r.pacing = v > 0 ? v : nil }
                if let v = t.dropToDrop { r.dropToDrop = v }
            }
        }
        // Shapes learned for this genre; the general ones only where the genre has none of its own.
        if let sh = genre.flatMap({ shapes[$0.rawValue] }) {
            r.shapes = sh
        } else if !r.shapes.learned, let sh = shapes["*"] {
            r.shapes = sh
        }
        return r
    }
}


// MARK: - Set energy curve

/// How the energy of the set should develop over the running order.
nonisolated enum SetArc: String, CaseIterable, Identifiable, Codable, Sendable {
    /// Only what connects well (tempo, key, genre).
    case none
    /// Start calm, keep building.
    case rise
    /// Build up to a peak around 70 %, then wind down.
    case peak

    var id: String { rawValue }

    var title: String {
        switch self {
        case .none: return L("つなぎやすさ優先", "Smoothest Order")
        case .rise: return L("だんだん盛り上げる", "Keep Building")
        case .peak: return L("山を作る（最後は落ち着ける）", "Peak, Then Wind Down")
        }
    }

    /// Target energy rank (0…1) at position x (0 = first track, 1 = last).
    func target(_ x: Double) -> Double? {
        switch self {
        case .none: return nil
        case .rise: return 0.1 + 0.85 * x
        case .peak: return x < 0.7 ? 0.2 + 0.8 * x / 0.7 : 1 - 0.6 * (x - 0.7) / 0.3
        }
    }
}
