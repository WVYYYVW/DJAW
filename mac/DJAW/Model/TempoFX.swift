import Foundation

// MARK: - Tempo map

/// Mix tempo over time.
///
/// The timeline is measured in *reference* seconds: seconds at the base master BPM. Every
/// synced track advances one of its beats per master beat, so the chain layout does not depend
/// on the tempo at all. The tempo map only says how long those beats really take: it warps
/// reference time into real (heard) time for playback, export and the clock displays.
nonisolated struct TempoMap: Sendable, Equatable {
    struct Point: Sendable, Equatable {
        var t: Double
        var bpm: Double
    }

    /// Base master BPM — the tempo reference seconds are measured in.
    var reference: Double
    /// Breakpoints in reference time, sorted. Tempo is linear in beats between neighbours
    /// and constant before the first / after the last point.
    private(set) var points: [Point]
    /// Real time at each point.
    private var realAt: [Double]

    init(reference: Double, points: [Point] = []) {
        let m = max(reference, 1)
        self.reference = m
        var pts = points.sorted { $0.t < $1.t }.filter { $0.t >= 0 }
        if pts.isEmpty || pts[0].t > 0 { pts.insert(Point(t: 0, bpm: pts.first?.bpm ?? m), at: 0) }
        self.points = pts
        var r: [Double] = [0]
        for k in pts.indices.dropFirst() {
            r.append(r[k - 1] + Self.span(m, pts[k - 1], pts[k], to: pts[k].t - pts[k - 1].t))
        }
        self.realAt = r
    }

    var isConstant: Bool { points.allSatisfy { abs($0.bpm - reference) < 0.0001 } }
    var hasChanges: Bool { points.contains { abs($0.bpm - points[0].bpm) > 0.0001 } }

    /// Real seconds for `u` reference seconds into the segment a → b.
    private static func span(_ m: Double, _ a: Point, _ b: Point, to u: Double) -> Double {
        let len = b.t - a.t
        let d = b.bpm - a.bpm
        if len < 1e-9 || abs(d) < 1e-9 { return u * m / a.bpm }
        let tu = a.bpm + d * u / len
        return m * len / d * log(tu / a.bpm)
    }

    private func segment(atRef t: Double) -> Int {
        var lo = 0, hi = points.count - 1
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            if points[mid].t <= t { lo = mid } else { hi = mid - 1 }
        }
        return lo
    }

    /// Mix BPM at reference time `t`.
    func bpm(at t: Double) -> Double {
        let k = segment(atRef: t)
        guard k + 1 < points.count, t >= points[k].t else { return points[k].bpm }
        let a = points[k], b = points[k + 1]
        let len = b.t - a.t
        guard len > 1e-9 else { return b.bpm }
        return a.bpm + (b.bpm - a.bpm) * min(1, (t - a.t) / len)
    }

    /// Reference → real seconds.
    func real(_ t: Double) -> Double {
        if points.count == 1 { return t * reference / points[0].bpm }
        let k = segment(atRef: t)
        if t < points[0].t { return realAt[0] + (t - points[0].t) * reference / points[0].bpm }
        if k + 1 >= points.count { return realAt[k] + (t - points[k].t) * reference / points[k].bpm }
        return realAt[k] + Self.span(reference, points[k], points[k + 1], to: t - points[k].t)
    }

    /// Real → reference seconds.
    func reference(atReal r: Double) -> Double {
        if points.count == 1 { return r * points[0].bpm / reference }
        if r < realAt[0] { return points[0].t + (r - realAt[0]) * points[0].bpm / reference }
        var k = 0
        while k + 1 < points.count && realAt[k + 1] <= r { k += 1 }
        let a = points[k]
        let dr = r - realAt[k]
        guard k + 1 < points.count else { return a.t + dr * a.bpm / reference }
        let b = points[k + 1]
        let len = b.t - a.t
        let d = b.bpm - a.bpm
        if len < 1e-9 || abs(d) < 1e-9 { return a.t + dr * a.bpm / reference }
        let tu = a.bpm * exp(d * dr / (reference * len))
        return a.t + (tu - a.bpm) * len / d
    }

    /// Builds the map from the tracks: a track with its own `tempo` changes the mix BPM
    /// from where it comes in, ramping over `tempoBars` (default: the transition length).
    static func build(clips: [Clip], master: Double) -> TempoMap {
        let m = max(master, 1)
        let barRef = 240 / m
        var pts = [Point(t: 0, bpm: m)]
        var current = m
        for (i, c) in clips.enumerated() where i > 0 {
            guard let target = c.tempo, target > 20, abs(target - current) > 0.0001 else { continue }
            let anchor = c.timelineTime(bar: c.mixInBar, master: m)
            let bars = max(0, c.tempoRampBars)
            let r0 = max(anchor, pts.last!.t)
            let r1 = r0 + bars * barRef
            if r0 > pts.last!.t + 1e-6 { pts.append(Point(t: r0, bpm: current)) }
            pts.append(Point(t: max(r1, r0 + 1e-4), bpm: target))
            current = target
        }
        return TempoMap(reference: m, points: pts)
    }
}

extension Clip {
    /// Bars the tempo change into this track takes (0 = instant at the switch).
    nonisolated var tempoRampBars: Double {
        if let b = tempoBars { return b }
        return transition.isCutLike ? 0 : transitionBars
    }

    /// Elapsed (played) source seconds at a bar of this track, counting loops.
    nonisolated func elapsed(atBar bar: Double) -> Double {
        let s = sourceTime(bar: bar)
        return hasEdits ? Clip.elapsed(ofSource: s, in: rawSegments(), trimStart: trimStart) : s - trimStart
    }

    /// Turntable ending (brake / backspin) this track performs before `next` comes in.
    nonisolated func outro(next: Clip?) -> OutroFX? {
        guard let next, next.transition == .brake || next.transition == .backspin, bpm > 1 else { return nil }
        let beats = next.spinBeats ?? next.transition.defaultSpinBeats
        let len = beats * 60 / bpm
        let eOut = elapsed(atBar: mixOutBar)
        let start = max(0, eOut - len)
        guard eOut - start > 0.02 else { return nil }
        return OutroFX(kind: next.transition, elapsedStart: start, length: eOut - start)
    }

    /// Source bar playing at reference time `t`.
    nonisolated func bar(atTimeline t: Double, master: Double) -> Double {
        bar(atSource: sourceTime(timeline: t, master: master))
    }
}

nonisolated struct OutroFX: Sendable, Equatable {
    var kind: TransitionStyle
    /// Elapsed source seconds where the effect replaces the track's audio.
    var elapsedStart: Double
    /// Source seconds the effect lasts (it ends at the switch).
    var length: Double
}

// MARK: - Effects

nonisolated enum FXKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case lowPass, highPass, echo, reverb, flanger, phaser, gate, crush, roll

    var id: String { rawValue }

    var title: String {
        switch self {
        case .lowPass: return L("ローパス", "Low-pass")
        case .highPass: return L("ハイパス", "High-pass")
        case .echo: return L("エコー", "Echo")
        case .reverb: return L("リバーブ", "Reverb")
        case .flanger: return L("フランジャー", "Flanger")
        case .phaser: return L("フェイザー", "Phaser")
        case .gate: return L("トランス（ゲート）", "Trans (Gate)")
        case .crush: return L("ビットクラッシャー", "Bit Crusher")
        case .roll: return L("ロール", "Roll")
        }
    }

    var short: String {
        switch self {
        case .lowPass: return "LPF"
        case .highPass: return "HPF"
        case .echo: return "ECHO"
        case .reverb: return "REVERB"
        case .flanger: return "FLANGER"
        case .phaser: return "PHASER"
        case .gate: return "TRANS"
        case .crush: return "CRUSH"
        case .roll: return "ROLL"
        }
    }

    var detail: String {
        switch self {
        case .lowPass: return L("高音を削ってこもらせます。徐々に強くすると曲が遠ざかるように聞こえます。", "Cuts the highs; ramp it up and the track sounds like it walks away.")
        case .highPass: return L("低音を削って軽くします。つなぎ前のビルドアップの定番。", "Cuts the lows. The classic build-up before a drop.")
        case .echo: return L("拍に合わせたやまびこ。", "Beat-synced delay.")
        case .reverb: return L("広い空間の響きを足します。", "Adds a big-room tail.")
        case .flanger: return L("ジェット機のようなうねり。", "Jet-plane sweep.")
        case .phaser: return L("シュワシュワと回るようなうねり。", "Swirling phase sweep.")
        case .gate: return L("拍に合わせて音を細かく切ります。", "Chops the sound in time with the beat.")
        case .crush: return L("音をざらつかせてローファイにします。", "Grainy lo-fi distortion.")
        case .roll: return L("直前の音を短く繰り返します（ループロール）。", "Repeats a short slice (loop roll).")
        }
    }

    var symbol: String {
        switch self {
        case .lowPass: return "line.diagonal"
        case .highPass: return "line.diagonal.arrow"
        case .echo: return "dot.radiowaves.right"
        case .reverb: return "building.columns"
        case .flanger: return "airplane"
        case .phaser: return "tornado"
        case .gate: return "square.split.1x2"
        case .crush: return "square.grid.3x3.middle.filled"
        case .roll: return "repeat"
        }
    }

    /// Hue for the timeline region.
    var hue: Double {
        switch self {
        case .lowPass: return 0.58
        case .highPass: return 0.50
        case .echo: return 0.78
        case .reverb: return 0.70
        case .flanger: return 0.12
        case .phaser: return 0.30
        case .gate: return 0.95
        case .crush: return 0.03
        case .roll: return 0.16
        }
    }

    /// Beat divisions offered (beats). Empty = no rhythm setting.
    var divisions: [Double] {
        switch self {
        case .echo: return [0.25, 0.5, 0.75, 1]
        case .gate: return [0.125, 0.25, 0.5, 1]
        case .roll: return [0.125, 0.25, 0.5, 1]
        case .flanger, .phaser: return [4, 8, 16, 32]
        default: return []
        }
    }

    var defaultDivision: Double {
        switch self {
        case .echo: return 0.75
        case .gate: return 0.25
        case .roll: return 0.25
        case .flanger: return 16
        case .phaser: return 8
        default: return 1
        }
    }

    var defaultShape: FXShape {
        switch self {
        case .lowPass, .highPass: return .rise
        case .roll, .gate, .crush: return .hold
        default: return .swell
        }
    }

    var defaultAmount: Double {
        switch self {
        case .lowPass, .highPass: return 0.75
        case .crush: return 0.5
        case .roll: return 1
        default: return 0.6
        }
    }

    var defaultBars: Double {
        switch self {
        case .roll: return 1
        case .gate, .crush: return 2
        default: return 4
        }
    }

    static func divisionLabel(_ d: Double) -> String {
        if d >= 1 { return d == d.rounded() ? "\(Int(d))" : String(format: "%.2g", d) }
        let n = Int((1 / d).rounded())
        if abs(d - 0.75) < 0.001 { return "3/4" }
        return "1/\(n)"
    }
}

nonisolated enum FXShape: String, Codable, CaseIterable, Identifiable, Sendable {
    case hold, rise, fall, swell

    var id: String { rawValue }

    var title: String {
        switch self {
        case .hold: return L("一定", "Steady")
        case .rise: return L("だんだん強く", "Build")
        case .fall: return L("だんだん弱く", "Fade")
        case .swell: return L("山なり", "Swell")
        }
    }

    var symbol: String {
        switch self {
        case .hold: return "rectangle"
        case .rise: return "arrow.up.right"
        case .fall: return "arrow.down.right"
        case .swell: return "chevron.up"
        }
    }

    /// 0...1 strength at progress x (0...1).
    func level(_ x: Double) -> Double {
        switch self {
        case .hold: return 1
        case .rise: return x * x * (3 - 2 * x) * 0.85 + x * 0.15
        case .fall: return 1 - (x * x * (3 - 2 * x) * 0.85 + x * 0.15)
        case .swell: return sin(.pi * x)
        }
    }
}

/// An effect region on a track, in that track's bars.
nonisolated struct ClipFX: Codable, Hashable, Identifiable, Sendable {
    var id = UUID()
    var kind: FXKind
    var bar: Double
    var bars: Double
    /// Peak strength 0...1.
    var amount: Double
    /// Rhythm in beats (echo time, gate / roll length, sweep period).
    var division: Double
    var shape: FXShape
    /// Placed by the auto-mix (replaced when it plans again).
    var auto: Bool? = nil

    var end: Double { bar + bars }

    init(kind: FXKind, bar: Double, bars: Double? = nil, amount: Double? = nil, shape: FXShape? = nil, auto: Bool? = nil) {
        self.kind = kind
        self.bar = bar
        self.bars = bars ?? kind.defaultBars
        self.amount = amount ?? kind.defaultAmount
        self.division = kind.defaultDivision
        self.shape = shape ?? kind.defaultShape
        self.auto = auto
    }

    /// Strength at a source bar (0 outside the region). Steady regions get short ramps so nothing clicks.
    func level(atBar b: Double) -> Double {
        guard bars > 0, b >= bar, b < end else { return 0 }
        let x = (b - bar) / bars
        var v = shape.level(x)
        if shape == .hold && kind != .roll && kind != .gate {
            let edge = min(0.03, 0.5)
            v *= min(1, x / edge, (1 - x) / edge)
        }
        return max(0, min(1, v)) * amount
    }
}

/// Effect amounts for one track at one instant (0 = off).
nonisolated struct FXState: Sendable, Equatable {
    /// −1 (low-pass) … +1 (high-pass).
    var filter: Float = 0
    var echo: Float = 0
    var echoDiv: Float = 0.75
    var reverb: Float = 0
    var flanger: Float = 0
    var flangerDiv: Float = 16
    var phaser: Float = 0
    var phaserDiv: Float = 8
    var gate: Float = 0
    var gateDiv: Float = 0.25
    var crush: Float = 0
    var roll: Float = 0
    var rollDiv: Float = 0.25

    var isQuiet: Bool { filter == 0 && echo == 0 && reverb == 0 && flanger == 0 && phaser == 0 && gate == 0 && crush == 0 && roll == 0 }

    static func at(_ c: Clip, bar: Double) -> FXState {
        var s = FXState()
        for fx in c.fx ?? [] {
            let v = Float(fx.level(atBar: bar))
            guard v > 0 else { continue }
            let d = Float(fx.division)
            switch fx.kind {
            case .lowPass: if -v < s.filter { s.filter = -v }
            case .highPass: if v > s.filter { s.filter = v }
            case .echo: if v > s.echo { s.echo = v; s.echoDiv = d }
            case .reverb: s.reverb = max(s.reverb, v)
            case .flanger: if v > s.flanger { s.flanger = v; s.flangerDiv = d }
            case .phaser: if v > s.phaser { s.phaser = v; s.phaserDiv = d }
            case .gate: if v > s.gate { s.gate = v; s.gateDiv = d }
            case .crush: s.crush = max(s.crush, v)
            case .roll: if v > s.roll { s.roll = v; s.rollDiv = d }
            }
        }
        return s
    }
}
