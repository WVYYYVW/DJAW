import Foundation

/// "Simplify transition": a transition drawn over 16 bars where the incoming track stays silent for the first
/// 8 (and the outgoing one plays untouched meanwhile) sounds exactly like an 8-bar transition. This finds the bars
/// where something actually changes and, when the user asks, rewrites the transition to just those bars —
/// same audio, shorter and easier to read and edit. Never done automatically.
extension MixStore {
    struct TransitionSimplification: Equatable {
        /// Bars cut from the start / kept.
        var dropBars: Double
        var oldBars: Double
        var newBars: Double
    }

    /// Below this a track counts as silent (−50 dB), and curves within this of their resting value count as resting.
    private static let silentLevel = 0.003
    private static let restTolerance = 0.002

    /// Whether the transition into clip `i` can be written shorter without changing how it sounds.
    func simplification(at i: Int) -> TransitionSimplification? {
        guard i > 0, i < clips.count else { return nil }
        let c = clips[i], prev = clips[i - 1]
        guard [.crossfade, .bassSwap, .filter, .custom].contains(c.transition), c.tempoSync, prev.tempoSync else { return nil }
        // The overlap as actually laid out (a track may end before the planned length).
        let overlapBars = (min(prev.end(master: masterBPM), c.end(master: masterBPM)) - c.start) / barLength
        let L = c.transitionBars
        guard L >= 2, overlapBars > L - 0.01 else { return nil }
        let unit: Double = L >= 4 ? 1 : 0.25
        let n = 960
        // Start: the outgoing track rests (full volume, no EQ) and the incoming one is silent.
        func headQuiet(_ x: Double) -> Bool {
            let o = Automation.outgoingCurve(c, x), inc = Automation.incomingCurve(c, x)
            return inc.volume <= Self.silentLevel && o.volume >= 1 - Self.restTolerance
                && o.lowKill <= Self.restTolerance && o.midKill <= Self.restTolerance && o.highKill <= Self.restTolerance && o.echo == 0
                && abs(o.filter) <= Self.restTolerance && o.fxEcho <= Self.restTolerance && o.fxReverb <= Self.restTolerance
                && o.vocal >= 1 - Self.restTolerance && o.instrumental >= 1 - Self.restTolerance
        }
        // End: the incoming track rests and the outgoing one is silent.
        func tailQuiet(_ x: Double) -> Bool {
            let o = Automation.outgoingCurve(c, x), inc = Automation.incomingCurve(c, x)
            return o.volume <= Self.silentLevel && inc.volume >= 1 - Self.restTolerance
                && inc.lowKill <= Self.restTolerance && inc.midKill <= Self.restTolerance && inc.highKill <= Self.restTolerance
                && abs(inc.filter) <= Self.restTolerance && inc.fxEcho <= Self.restTolerance && inc.fxReverb <= Self.restTolerance
                && inc.vocal >= 1 - Self.restTolerance && inc.instrumental >= 1 - Self.restTolerance
        }
        // Sampled once: how far the quiet start reaches, and from where the quiet end begins.
        var firstLoudHead = n + 1
        for k in 0...n where !headQuiet(Double(k) / Double(n)) { firstLoudHead = k; break }
        var lastLoudTail = -1
        for k in stride(from: n, through: 0, by: -1) where !tailQuiet(Double(k) / Double(n)) { lastLoudTail = k; break }
        // Whole units that are quiet throughout (every sample up to and including the unit's end).
        var s = 0.0
        while s + unit < L, Int(((s + unit) / L * Double(n)).rounded(.up)) < firstLoudHead { s += unit }
        var e = L
        while e - unit > s, Int(((e - unit) / L * Double(n)).rounded(.down)) > lastLoudTail { e -= unit }
        guard e - s >= unit, e - s < L - 0.001 else { return nil }
        return TransitionSimplification(dropBars: s, oldBars: L, newBars: e - s)
    }

    /// Transitions in the mix that can be simplified (by incoming clip id).
    var simplifiableTransitions: [(id: UUID, s: TransitionSimplification)] {
        // Worked out once per change of the mix (it samples every transition's curves).
        if let c = simplifyCache, c.revision == revision { return c.list }
        let list = clips.indices.dropFirst().compactMap { i in simplification(at: i).map { (clips[i].id, $0) } }
        simplifyCache = (revision, list)
        return list
    }

    /// Rewrites the transition into `id` to the bars where it changes (undoable). Returns false if there is nothing to do.
    @discardableResult
    func simplifyTransition(into id: UUID, undoable: Bool = true) -> Bool {
        guard let i = index(of: id), let sim = simplification(at: i) else { return false }
        if undoable { pushUndo() } else { isDirty = true }
        let c = clips[i]
        let u0 = sim.dropBars / sim.oldBars, u1 = (sim.dropBars + sim.newBars) / sim.oldBars
        clips[i].lanes = Self.cutLanes(Self.denseLanes(c), from: u0, to: u1)
        clips[i].transition = .custom
        if c.tempo != nil {
            // A tempo change rides over the transition: keep it ending where it ended.
            clips[i].tempoBars = max(0, c.tempoRampBars - sim.dropBars)
        }
        clips[i - 1].mixOutBar += sim.dropBars
        clips[i].mixInBar += sim.dropBars
        clips[i].transitionBars = sim.newBars
        finishTimingEdit()
        return true
    }

    /// Simplifies every transition that can be (one undo step). Returns how many.
    @discardableResult
    func simplifyAllTransitions() -> Int {
        let ids = simplifiableTransitions.map(\.id)
        guard !ids.isEmpty else { return 0 }
        pushUndo()
        var n = 0
        for id in ids where simplifyTransition(into: id, undoable: false) { n += 1 }
        return n
    }

    // MARK: Curves

    /// The bend for a segment from x0 to x1 that best follows the part of segment a → b between them.
    private static func fitBend(_ a: AutoPoint, _ b: AutoPoint, from x0: Double, to x1: Double) -> Double {
        let y0 = TransitionLanes.value([a, b], at: x0), y1 = TransitionLanes.value([a, b], at: x1)
        guard abs(y1 - y0) > 1e-6, x1 > x0 else { return 0 }
        let samples = (1...31).map { k -> (Double, Double) in
            let s = Double(k) / 32
            return (s, TransitionLanes.value([a, b], at: x0 + (x1 - x0) * s))
        }
        var best = (err: Double.infinity, bend: 0.0)
        var bend = -1.0
        while bend <= 1.0001 {
            let p = AutoPoint(x: 0, y: y0, bend: bend), q = AutoPoint(x: 1, y: y1)
            var e = 0.0
            for (s, y) in samples { let d = p.segmentValue(to: q, t: s) - y; e += d * d }
            if e < best.err { best = (e, bend) }
            bend += 0.005
        }
        return best.bend
    }

    /// The transition's curves as editable lanes (presets converted the way the transition editor converts them).
    private static func denseLanes(_ c: Clip) -> TransitionLanes {
        if c.transition == .custom, let lanes = c.lanes { return lanes }
        return c.effectiveLanes
    }

    /// The part u0…u1 of every lane, stretched to 0…1. Segments that are cut in two are followed finely
    /// (their shape is not a single bend any more); whole segments keep their points and bends.
    private static func cutLanes(_ lanes: TransitionLanes, from u0: Double, to u1: Double) -> TransitionLanes {
        func cut(_ pts: [AutoPoint]) -> [AutoPoint] {
            guard !pts.isEmpty, u1 > u0 else { return pts }
            let span = u1 - u0
            func local(_ x: Double) -> Double { min(1, max(0, (x - u0) / span)) }
            var out: [AutoPoint] = []
            func add(_ x: Double, _ y: Double, bend: Double = 0) {
                if let last = out.last, abs(last.x - local(x)) < 1e-6 {
                    if bend != 0 { out[out.count - 1].bend = bend }
                    return
                }
                out.append(AutoPoint(x: local(x), y: y, bend: bend))
            }
            // Segments of the curve, including the flat ends before the first / after the last point.
            var segs: [(a: AutoPoint, b: AutoPoint)] = []
            if pts[0].x > 0 { segs.append((AutoPoint(x: 0, y: pts[0].y), AutoPoint(x: pts[0].x, y: pts[0].y))) }
            for k in 0..<(pts.count - 1) { segs.append((pts[k], pts[k + 1])) }
            if let l = pts.last, l.x < 1 { segs.append((AutoPoint(x: l.x, y: l.y), AutoPoint(x: 1, y: l.y))) }
            for (a, b) in segs where b.x > u0 && a.x < u1 {
                if a.x >= u0 && b.x <= u1 {
                    add(a.x, a.y, bend: a.bend)
                    add(b.x, b.y)
                } else {
                    // Cut: the remaining part becomes one segment between the same kind of points, with the bend
                    // that follows the original curve most closely (so the editor shows no extra points).
                    let x0 = max(a.x, u0), x1 = min(b.x, u1)
                    let y0 = TransitionLanes.value([a, b], at: x0), y1 = TransitionLanes.value([a, b], at: x1)
                    add(x0, y0, bend: Self.fitBend(a, b, from: x0, to: x1))
                    add(x1, y1)
                }
            }
            return out.isEmpty ? [AutoPoint(x: 0, y: TransitionLanes.value(pts, at: u0)), AutoPoint(x: 1, y: TransitionLanes.value(pts, at: u1))] : out
        }
        var l = lanes
        for k in LaneKind.allCases {
            for inc in [true, false] { l.setPoints(k, incoming: inc, cut(lanes.points(k, incoming: inc))) }
        }
        return l
    }
}
