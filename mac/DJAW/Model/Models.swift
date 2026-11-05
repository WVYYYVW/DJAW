import Foundation

// MARK: - Transition

/// How the incoming clip replaces the previous one.
nonisolated enum TransitionStyle: String, Codable, CaseIterable, Identifiable, Sendable {
    case crossfade
    case bassSwap
    case filter
    case echoOut
    case cut
    /// Turntable stop: the previous track slows to a halt, the next one drops in.
    case brake
    /// The previous track is spun backwards, the next one drops in.
    case backspin
    /// Hand-drawn automation lanes (see `TransitionLanes`).
    case custom

    var id: String { rawValue }

    var title: String {
        switch self {
        case .crossfade: return L("クロスフェード", "Crossfade")
        case .bassSwap: return L("ベーススワップ", "Bass Swap")
        case .filter: return L("フィルターアウト", "Filter Out")
        case .echoOut: return L("エコーアウト", "Echo Out")
        case .cut: return L("カットイン", "Cut In")
        case .brake: return L("ブレーキ", "Brake")
        case .backspin: return L("バックスピン", "Backspin")
        case .custom: return L("カスタム", "Custom")
        }
    }

    var detail: String {
        switch self {
        case .crossfade: return L("2曲の音量をなめらかに入れ替えます。", "Smoothly swaps the volume of the two tracks.")
        case .bassSwap: return L("重ねている途中で低音だけを入れ替え、キックの重なりを防ぎます。", "Swaps only the low end halfway through so the kicks never clash.")
        case .filter: return L("前の曲の低音から削りながら抜いていきます。", "Takes the previous track out by filtering away its low end first.")
        case .echoOut: return L("前の曲をエコーの残響だけ残して止め、次の曲をカットインします。", "Stops the previous track leaving only an echo tail, and cuts the next track in.")
        case .cut: return L("出口の位置で瞬時に切り替えます（重ねません）。", "Switches instantly at the mix-out point (no overlap).")
        case .brake: return L("前の曲をターンテーブルを止めるように減速させ、出口で次の曲を落とします。BPM が大きく違う曲へのつなぎにも。", "Slows the previous track to a stop like a turntable, then drops the next one at the mix-out. Good for big tempo jumps.")
        case .backspin: return L("前の曲を手で逆回転させて止め、出口で次の曲を落とします。", "Spins the previous track backwards, then drops the next one at the mix-out.")
        case .custom: return L("フェーダーと EQ の動きを自分で描いたつなぎです。", "A transition with hand-drawn fader and EQ moves.")
        }
    }

    var symbol: String {
        switch self {
        case .crossfade: return "arrow.left.arrow.right"
        case .bassSwap: return "speaker.wave.2"
        case .filter: return "line.3.horizontal.decrease"
        case .echoOut: return "dot.radiowaves.right"
        case .cut: return "scissors"
        case .brake: return "tortoise"
        case .backspin: return "arrow.counterclockwise.circle"
        case .custom: return "slider.horizontal.3"
        }
    }

    /// Whether the length of the overlap matters for this style.
    var usesLength: Bool { !isCutLike }

    /// Switches at a single point (no overlap).
    var isCutLike: Bool { self == .cut || self == .brake || self == .backspin }

    /// Turntable effect length choices (beats) for brake / backspin.
    var spinChoices: [Double] { self == .brake ? [1, 2, 4] : self == .backspin ? [1, 2, 4] : [] }
    var defaultSpinBeats: Double { self == .brake ? 2 : 2 }

    /// Whether volume and EQ curves can be edited.
    var editableVolume: Bool { self == .crossfade || self == .bassSwap || self == .filter }

    /// Length choices offered in the inspector.
    var lengthChoices: [Double] {
        switch self {
        case .cut, .brake, .backspin: return [0]
        case .echoOut: return [1, 2, 4]
        default: return [4, 8, 16, 32]
        }
    }
}

/// One-click recipes that pick a style and length together.
nonisolated struct TransitionPreset: Identifiable, Sendable {
    let id: String
    let title: String
    let detail: String
    let symbol: String
    let style: TransitionStyle
    let bars: Double

    static var all: [TransitionPreset] { [
        TransitionPreset(id: "cut", title: L("カットイン", "Cut In"), detail: L("出口で瞬時に切替。次の曲のドロップ頭を入口にすると効果的", "Instant switch at the mix-out. Works best with the mix-in on the next track’s drop"),
                         symbol: "scissors", style: .cut, bars: 0),
        TransitionPreset(id: "echo", title: L("エコーアウト", "Echo Out"), detail: L("前の曲をエコーで残して次の曲をカットイン（2小節）", "Echo the previous track out and cut the next one in (2 bars)"),
                         symbol: "dot.radiowaves.right", style: .echoOut, bars: 2),
        TransitionPreset(id: "quick", title: L("クイックミックス", "Quick Mix"), detail: L("4小節で素早くクロスフェード", "Fast 4-bar crossfade"),
                         symbol: "hare", style: .crossfade, bars: 4),
        TransitionPreset(id: "filter", title: L("フィルターアウト", "Filter Out"), detail: L("8小節で前の曲の低音から抜いていく", "Filter the previous track out over 8 bars"),
                         symbol: "line.3.horizontal.decrease", style: .filter, bars: 8),
        TransitionPreset(id: "bass", title: L("ベーススワップ", "Bass Swap"), detail: L("16小節重ね、途中で低音を入れ替える定番のつなぎ", "The classic: 16 bars of overlap with a bass swap"),
                         symbol: "speaker.wave.2", style: .bassSwap, bars: 16),
        TransitionPreset(id: "long", title: L("ロングミックス", "Long Mix"), detail: L("32小節かけてゆっくり混ぜる", "Slow blend over 32 bars"),
                         symbol: "tortoise", style: .crossfade, bars: 32),
    ] }

    static func matching(style: TransitionStyle, bars: Double) -> TransitionPreset? {
        all.first { $0.style == style && abs($0.bars - bars) < 0.01 }
    }
}

// MARK: - Snap

/// How the tracks' loudness is evened out (ITU-R BS.1770 / LUFS, over the part of each track the mix plays).
nonisolated enum LoudnessMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case off, match, lufs14, lufs11, lufs9

    var id: String { rawValue }
    var title: String {
        switch self {
        case .off: return L("オフ", "Off")
        case .match: return L("曲どうしをそろえる", "Match the tracks")
        case .lufs14: return "−14 LUFS"
        case .lufs11: return "−11 LUFS"
        case .lufs9: return "−9 LUFS"
        }
    }
    var detail: String {
        switch self {
        case .off: return L("曲の音量はそのまま", "Tracks play at their own level")
        case .match: return L("全体の音量感は保ったまま、曲ごとの差だけをなくします", "Evens out the tracks around their average level")
        case .lufs14: return L("配信サービスの基準くらい", "About streaming-service level")
        case .lufs11: return L("やや大きめ", "A bit louder")
        case .lufs9: return L("クラブ向けの大きめの音量（書き出しの正規化で音割れを防ぎます）", "Club-loud (export normalization keeps it from clipping)")
        }
    }
    /// Fixed target, nil = the tracks' own average.
    var target: Double? {
        switch self {
        case .off, .match: return nil
        case .lufs14: return -14
        case .lufs11: return -11
        case .lufs9: return -9
        }
    }
}

/// Step size used when dragging mix points on the timeline.
nonisolated enum SnapUnit: String, Codable, CaseIterable, Identifiable, Sendable {
    case beat
    case bar
    case phrase
    case phrase8

    var id: String { rawValue }

    var title: String {
        switch self {
        case .beat: return L("1拍", "1 beat")
        case .bar: return L("1小節", "1 bar")
        case .phrase: return L("4小節", "4 bars")
        case .phrase8: return L("8小節", "8 bars")
        }
    }

    /// Unit in bars.
    var bars: Double {
        switch self {
        case .beat: return 0.25
        case .bar: return 1
        case .phrase: return 4
        case .phrase8: return 8
        }
    }
}

// MARK: - Clip

/// One song in the mix.
///
/// The arrangement is a chain: the user edits musical positions in bars
/// (`mixInBar`, `mixOutBar`, `transitionBars`, `endBar`), and the store derives
/// `start`, `trimStart` and `trimEnd` from them so every transition lands on a bar line.
/// Bars are counted from `firstBeat` (bar 0 = "1小節目").
nonisolated struct Clip: Identifiable, Codable, Hashable, Sendable {
    var id = UUID()
    var url: URL
    var title: String
    var artist: String
    var duration: Double
    var bpm: Double
    /// Source time of the first downbeat (start of bar "1").
    var firstBeat: Double

    // Musical arrangement (edited by the user)
    /// Where this track starts playing.
    var mixInBar: Double = 0
    /// Where the transition to the next track begins.
    var mixOutBar: Double = 0
    /// Last track only: where it stops (nil = end of file).
    var endBar: Double? = nil
    /// Length of the transition from the previous track into this one.
    var transitionBars: Double = 16

    // Derived placement (timeline seconds / source seconds)
    var start: Double = 0
    var trimStart: Double = 0
    var trimEnd: Double

    var gainDB: Double = 0
    var eqLow: Double = 0
    var eqMid: Double = 0
    var eqHigh: Double = 0
    var fadeInBeats: Double = 0
    var fadeOutBeats: Double = 0
    var tempoSync: Bool = true
    /// Transition used when this clip comes in over the previous one.
    var transition: TransitionStyle = .crossfade
    var colorIndex: Int = 0
    /// User-adjusted transition curve (nil = defaults for `transition`).
    var shape: TransitionShape? = nil
    /// Hand-drawn automation used when `transition == .custom`.
    var lanes: TransitionLanes? = nil
    /// Audio path relative to the project file (to relink moved folders).
    var relativePath: String? = nil
    /// Progress: IN / OUT have been set by the user.
    var cueDone: Bool? = nil
    /// Progress: the transition into this track has been chosen by the user.
    var transitionDone: Bool? = nil
    /// Why the auto-mix chose the transition into this track.
    var autoNote: AutoMixNote? = nil
    /// Id of this track's audio inside a self-contained .djaw.
    var mediaID: String? = nil
    /// DJ edits: n-bar loops and beat jumps (in this track's bars).
    var edits: [ClipEdit]? = nil
    /// Derived by layout when there are edits: source seconds actually played (loops counted).
    var playLength: Double? = nil
    /// Key lock (master tempo): tempo changes keep the pitch. Off = vinyl (pitch follows tempo).
    var keyLock: Bool? = nil
    /// Key shift in semitones (−6…+6), like a controller's key buttons.
    var keyShift: Int? = nil
    /// Mix BPM from this track on (nil = keep the tempo of the previous track).
    var tempo: Double? = nil
    /// Bars the tempo change takes, starting where this track comes in (nil = the transition length).
    var tempoBars: Double? = nil
    /// Brake / backspin length in beats (for those transitions into this track).
    var spinBeats: Double? = nil
    /// Effect regions (filter, echo, reverb, …).
    var fx: [ClipFX]? = nil
    /// Genre chosen by the user (nil = detected).
    var genre: MixGenre? = nil
    /// Cut-ins: source seconds the mix-in / mix-out point is moved so it falls exactly on the attack
    /// (kick / snare) there instead of on the bar line, which can be 10–40 ms off. Set automatically.
    var inNudge: Double? = nil
    var outNudge: Double? = nil
    /// The transition from this track's predecessor is locked: the two stay next to each other in the
    /// running order, and auto-mix / re-planning leave this transition as it is. Holds the predecessor's id
    /// (the lock only counts while that track still comes right before this one).
    var lockedPrevID: UUID? = nil
    /// Loudness normalization: gain added on top of `gainDB` (set automatically, see LoudnessMode).
    var loudnessGainDB: Double? = nil
    /// Measured loudness (LUFS) of the part of the track the mix plays.
    var lufs: Double? = nil

    /// The lanes this transition is (or would be) drawn with.
    var effectiveLanes: TransitionLanes {
        if transition == .custom, let lanes { return lanes }
        return TransitionLanes.sampled(style: transition, shape: transitionShape)
    }
    /// Memory cues placed in the CUE editor.
    var cues: [CuePoint]? = nil
    /// When true, changing the transition length keeps the landing bar
    /// (where only this track remains) instead of the mix-in bar.
    var landingLock: Bool? = nil
    /// Saved ways of connecting the previous track into this one, to compare and pick from.
    var takes: [TransitionTake]? = nil

    /// Bar of this track at which the previous track has fully gone.
    var landingBar: Double { mixInBar + transitionBars }
    var keepsLanding: Bool { landingLock ?? false }

    var transitionShape: TransitionShape { shape ?? TransitionShape.defaults(for: transition) }
    var cueList: [CuePoint] { (cues ?? []).sorted { $0.bar < $1.bar } }

    /// Stand-in used only while a view is being torn down after its track left the mix.
    static let placeholder = Clip(url: URL(fileURLWithPath: "/dev/null"), title: "", artist: "",
                                  duration: 1, bpm: 120, firstBeat: 0, trimEnd: 1)

    /// Neutral mix points: play the whole file, no transition.
    mutating func resetToWholeTrack() {
        mixInBar = -ceil(firstBeat / barSource - 0.001)
        mixOutBar = max(mixInBar + 1, floor(lastBar))
        endBar = nil
    }

    /// Length of one bar in source seconds.
    var barSource: Double { bpm > 1 ? 240 / bpm : 2 }

    func sourceTime(bar: Double) -> Double { firstBeat + bar * barSource }
    func bar(atSource s: Double) -> Double { (s - firstBeat) / barSource }

    /// Bar of the track (0-based) as a 1-based label, e.g. "97".
    static func barLabel(_ bar: Double) -> String {
        let n = bar + 1
        if abs(n - n.rounded()) < 0.01 { return "\(Int(n.rounded()))" }
        return String(format: "%.2f", n)
    }

    func timelineTime(bar: Double, master: Double) -> Double {
        timelineTime(source: sourceTime(bar: bar), master: master)
    }

    /// Last bar that still has audio.
    var lastBar: Double { bar(atSource: duration) }

    /// Playback-rate factor (1 = original speed).
    func rate(master: Double) -> Double {
        guard tempoSync, bpm > 1, master > 1 else { return 1 }
        return master / bpm
    }

    func length(master: Double) -> Double {
        playedSource / rate(master: master)
    }

    // MARK: Loops / beat jumps

    var hasEdits: Bool { !(edits ?? []).isEmpty }
    var keepsKey: Bool { keyLock ?? true }
    var semitoneShift: Int { keyShift ?? 0 }

    /// Pitch change for the time-pitch unit, in cents (key shift, plus the tempo change in vinyl mode).
    func pitchCents(master: Double) -> Double {
        var cents = Double(semitoneShift) * 100
        if !keepsKey { cents += 1200 * log2(rate(master: master)) }
        return cents
    }

    /// Path from `trimStart` through every loop and jump to the end of the file (not cut yet).
    func rawSegments() -> [PlaySegment] {
        var events: [(trigger: Double, target: Double, count: Int)] = []
        for e in edits ?? [] where e.bars > 0.01 {
            let a = sourceTime(bar: e.bar), b = sourceTime(bar: e.bar + e.bars)
            switch e.kind {
            case .loop:
                guard e.repeats > 0, a >= -0.001, b <= duration + 0.001 else { continue }
                events.append((b, max(0, a), e.repeats))
            case .jump:
                guard a >= 0, b < duration else { continue }
                events.append((a, b, 1))
            }
        }
        var remaining = events.map { $0.count }
        var segs: [PlaySegment] = []
        var pos = trimStart
        var elapsed = 0.0
        for _ in 0..<512 {
            var best: Int?
            for (k, ev) in events.enumerated() where remaining[k] > 0 && ev.trigger > pos + 0.0005 {
                if best == nil || ev.trigger < events[best!].trigger { best = k }
            }
            guard let k = best else { break }
            segs.append(PlaySegment(from: pos, to: events[k].trigger, elapsed: elapsed))
            elapsed += events[k].trigger - pos
            remaining[k] -= 1
            pos = events[k].target
        }
        segs.append(PlaySegment(from: pos, to: max(pos, duration), elapsed: elapsed))
        return segs
    }

    /// Elapsed play time (source seconds) at source time `s`, using its LAST occurrence
    /// (so an OUT inside a loop means "on the final pass").
    static func elapsed(ofSource s: Double, in segs: [PlaySegment], trimStart: Double) -> Double {
        guard let first = segs.first else { return s - trimStart }
        if let seg = segs.last(where: { s >= $0.from - 1e-6 && s <= $0.to + 1e-6 }) {
            return seg.elapsed + (s - seg.from)
        }
        if s < first.from { return s - first.from }
        if let k = segs.lastIndex(where: { $0.from <= s }) {
            let seg = segs[k]
            if k == segs.count - 1 { return seg.elapsed + (s - seg.from) }
            return seg.elapsed + (seg.to - seg.from)   // skipped by a jump: the jump point
        }
        return s - trimStart
    }

    /// What is actually played, in order.
    func playSegments() -> [PlaySegment] {
        guard hasEdits else { return [PlaySegment(from: trimStart, to: max(trimStart, trimEnd), elapsed: 0)] }
        let raw = rawSegments()
        let limit = playLength ?? Self.elapsed(ofSource: trimEnd, in: raw, trimStart: trimStart)
        var out: [PlaySegment] = []
        for seg in raw {
            if seg.elapsed >= limit - 1e-6 { break }
            let len = seg.to - seg.from
            if seg.elapsed + len <= limit {
                out.append(seg)
            } else {
                out.append(PlaySegment(from: seg.from, to: seg.from + (limit - seg.elapsed), elapsed: seg.elapsed))
                break
            }
        }
        return out
    }

    /// Source seconds actually played (loops counted, jumps removed).
    var playedSource: Double {
        guard hasEdits else { return max(0, trimEnd - trimStart) }
        return playSegments().reduce(0) { $0 + ($1.to - $1.from) }
    }

    /// Fast timeline → source mapping for drawing (segments computed once).
    func sourceMapper(master: Double) -> (Double) -> Double {
        let r = rate(master: master)
        let st = start, ts = trimStart
        guard hasEdits else { return { t in ts + (t - st) * r } }
        let segs = playSegments()
        return { t in Self.source(atElapsed: (t - st) * r, segs: segs, trimStart: ts) }
    }

    static func source(atElapsed e: Double, segs: [PlaySegment], trimStart: Double) -> Double {
        guard e > 0, let last = segs.last else { return trimStart + e }
        for seg in segs where e < seg.elapsed + (seg.to - seg.from) {
            return seg.from + (e - seg.elapsed)
        }
        return last.to + (e - last.elapsed - (last.to - last.from))
    }

    /// The loop being played at timeline time t (nil when not looping).
    func activeLoop(at t: Double, master: Double) -> (edit: ClipEdit, pass: Int, of: Int)? {
        guard hasEdits else { return nil }
        let segs = playSegments()
        let e = (t - start) * rate(master: master)
        guard let k = segs.firstIndex(where: { e >= $0.elapsed && e < $0.elapsed + ($0.to - $0.from) }) else { return nil }
        let s = segs[k].from + (e - segs[k].elapsed)
        for edit in edits ?? [] where edit.kind == .loop {
            let a = sourceTime(bar: edit.bar), b = sourceTime(bar: edit.bar + edit.bars)
            guard s >= a - 1e-6, s < b else { continue }
            // Passes = played pieces that cover this loop.
            let passes = segs.indices.filter { segs[$0].from < b - 1e-6 && segs[$0].to > a + 1e-6 }
            guard passes.count > 1, let pass = passes.firstIndex(of: k) else { return nil }
            return (edit, pass + 1, passes.count)
        }
        return nil
    }

    func end(master: Double) -> Double {
        start + length(master: master)
    }

    func timelineTime(source s: Double, master: Double) -> Double {
        guard hasEdits else { return start + (s - trimStart) / rate(master: master) }
        return start + Self.elapsed(ofSource: s, in: playSegments(), trimStart: trimStart) / rate(master: master)
    }

    func sourceTime(timeline t: Double, master: Double) -> Double {
        guard hasEdits else { return trimStart + (t - start) * rate(master: master) }
        return Self.source(atElapsed: (t - start) * rate(master: master), segs: playSegments(), trimStart: trimStart)
    }

    /// Timeline time at which this clip's first downbeat falls (its bar phase).
    func downbeatPhase(master: Double) -> Double {
        timelineTime(source: firstBeat, master: master)
    }

    /// Duration of one of this clip's beats on the timeline.
    func timelineBeat(master: Double) -> Double {
        guard bpm > 1 else { return 60 / max(master, 1) }
        return 60 / bpm / rate(master: master)
    }
}

// MARK: - Loops / beat jumps

/// A piece of the source that is played (loops repeat pieces, jumps skip them).
nonisolated struct PlaySegment: Sendable, Hashable {
    var from: Double
    var to: Double
    /// Source seconds played before this piece.
    var elapsed: Double
}

/// A DJ-controller style edit on one track.
nonisolated struct ClipEdit: Codable, Hashable, Sendable, Identifiable {
    enum Kind: String, Codable, Sendable { case loop, jump }
    var id = UUID()
    var kind: Kind
    /// loop: first bar of the loop. jump: bar where it jumps.
    var bar: Double
    /// loop: loop length. jump: bars skipped.
    var bars: Double
    /// loop: extra passes (1 = the section plays twice in total).
    var repeats: Int = 1

    var end: Double { bar + bars }

    /// Bars this edit adds to (+) or removes from (−) the track.
    var deltaBars: Double { kind == .loop ? bars * Double(repeats) : -bars }

    var lengthLabel: String {
        if bars >= 1 {
            let n = abs(bars - bars.rounded()) < 0.05 ? "\(Int(bars.rounded()))" : String(format: "%.1f", bars)
            return L("\(n)小節", bars == 1 ? "1 bar" : "\(n) bars")
        }
        return L("\(Int((bars * 4).rounded()))拍", "\(Int((bars * 4).rounded())) beat" + (bars * 4 > 1 ? "s" : ""))
    }

    var summary: String {
        switch kind {
        case .loop:
            return L("\(Clip.barLabel(bar))小節目から \(lengthLabel)ループ ×\(repeats + 1)",
                     "\(lengthLabel) loop from bar \(Clip.barLabel(bar)) ×\(repeats + 1)")
        case .jump:
            return L("\(Clip.barLabel(bar))小節目で \(lengthLabel)先へジャンプ",
                     "Jump ahead \(lengthLabel) at bar \(Clip.barLabel(bar))")
        }
    }
}

// MARK: - Cues

nonisolated struct CuePoint: Identifiable, Codable, Hashable, Sendable {
    var id = UUID()
    /// Bar position in the track (0 = "1小節目"), quarter bars = beats.
    var bar: Double
    var label: String
}

// MARK: - Transition curves

nonisolated enum CurveShape: String, Codable, CaseIterable, Identifiable, Sendable {
    case linear
    case smooth
    case equalPower
    case fast
    case slow

    var id: String { rawValue }

    var title: String {
        switch self {
        case .linear: return L("直線", "Linear")
        case .smooth: return L("なめらか（S字）", "Smooth (S-curve)")
        case .equalPower: return L("等パワー", "Equal power")
        case .fast: return L("速く立ち上がる", "Fast start")
        case .slow: return L("ゆっくり立ち上がる", "Slow start")
        }
    }

    /// Rising curve 0→1 for x in 0...1.
    func rise(_ x: Double) -> Double {
        let x = min(1, max(0, x))
        switch self {
        case .linear: return x
        case .smooth: return (1 - cos(.pi * x)) / 2
        case .equalPower: return sin(.pi / 2 * x)
        case .fast: return 1 - (1 - x) * (1 - x)
        case .slow: return x * x
        }
    }

    /// Falling curve 1→0, the mirror image of `rise`.
    func fall(_ x: Double) -> Double { rise(1 - x) }
}

nonisolated enum EQBand: String, Codable, CaseIterable, Identifiable, Sendable {
    case low, mid, high
    var id: String { rawValue }
    var title: String {
        switch self {
        case .low: return "LOW"
        case .mid: return "MID"
        case .high: return "HIGH"
        }
    }
}

/// How one EQ band is handed over between the two tracks during a transition.
nonisolated struct BandSwap: Codable, Hashable, Sendable {
    var enabled: Bool
    /// Where the hand-over starts (0...1 of the overlap).
    var point: Double
    /// How long the hand-over takes (0 = instant).
    var ramp: Double
    var curve: CurveShape
    /// false = only the outgoing track's band is cut (filter-style).
    var affectsIncoming: Bool = true

    static let off = BandSwap(enabled: false, point: 0.5, ramp: 0.25, curve: .smooth)
}

/// Fine control over a transition, all positions as 0...1 of the overlap.
nonisolated struct TransitionShape: Codable, Hashable, Sendable {
    /// Incoming track reaches full volume here.
    var inRise: Double
    /// Outgoing track starts to fade here.
    var outFadeStart: Double
    var volumeCurve: CurveShape
    var low: BandSwap
    var mid: BandSwap
    var high: BandSwap

    func band(_ b: EQBand) -> BandSwap {
        switch b {
        case .low: return low
        case .mid: return mid
        case .high: return high
        }
    }

    mutating func setBand(_ b: EQBand, _ value: BandSwap) {
        switch b {
        case .low: low = value
        case .mid: mid = value
        case .high: high = value
        }
    }

    /// DJ-style EQ blend: the incoming track creeps in with its lows and mids cut
    /// (only hats / highs at first), the mids cross over around the swap point,
    /// the lows swap at `p`, and then the outgoing track drops away quickly.
    /// Neither track is ever at full level with all bands open at the same time.
    static func layered(swapAt p: Double) -> TransitionShape {
        let p = min(0.85, max(0.15, p))
        return TransitionShape(inRise: p, outFadeStart: p, volumeCurve: .slow,
                               low: BandSwap(enabled: true, point: p, ramp: 0, curve: .linear),
                               mid: BandSwap(enabled: true, point: max(0, p - 0.15), ramp: 0.3, curve: .smooth),
                               high: .off)
    }

    /// Like `layered`, but the lows and mids move gradually and the outgoing highs are filtered away at the end.
    static func filterOut(swapAt p: Double) -> TransitionShape {
        let p = min(0.85, max(0.15, p))
        return TransitionShape(inRise: p, outFadeStart: p, volumeCurve: .slow,
                               low: BandSwap(enabled: true, point: max(0, p - 0.3), ramp: 0.4, curve: .smooth),
                               mid: BandSwap(enabled: true, point: max(0, p - 0.15), ramp: 0.35, curve: .smooth),
                               high: BandSwap(enabled: true, point: p, ramp: 1 - p, curve: .smooth, affectsIncoming: false))
    }

    /// Smooth volume blend with gentle low / mid crossovers (no hard swap).
    static func blend(swapAt p: Double) -> TransitionShape {
        let p = min(0.85, max(0.15, p))
        return TransitionShape(inRise: p, outFadeStart: p, volumeCurve: .slow,
                               low: BandSwap(enabled: true, point: max(0, p - 0.1), ramp: 0.2, curve: .smooth),
                               mid: BandSwap(enabled: true, point: max(0, p - 0.2), ramp: 0.4, curve: .smooth),
                               high: .off)
    }

    static func defaults(for style: TransitionStyle) -> TransitionShape {
        switch style {
        case .crossfade:
            return TransitionShape(inRise: 1, outFadeStart: 0, volumeCurve: .equalPower,
                                   low: .off, mid: .off, high: .off)
        case .bassSwap:
            return .layered(swapAt: 0.5)
        case .filter:
            return .filterOut(swapAt: 0.5)
        case .echoOut:
            return TransitionShape(inRise: 0.02, outFadeStart: 0, volumeCurve: .equalPower, low: .off, mid: .off, high: .off)
        case .cut, .brake, .backspin:
            return TransitionShape(inRise: 0.004, outFadeStart: 0.5, volumeCurve: .linear, low: .off, mid: .off, high: .off)
        case .custom:
            return TransitionShape(inRise: 1, outFadeStart: 0, volumeCurve: .equalPower, low: .off, mid: .off, high: .off)
        }
    }
}

// MARK: - Hand-drawn automation

nonisolated struct AutoPoint: Codable, Hashable, Sendable, Identifiable {
    var id = UUID()
    /// 0...1 progress through the transition.
    var x: Double
    /// 0...1 level (volume, or how open an EQ band is: 1 = open, 0 = kill).
    var y: Double
    /// Curvature of the segment from this point to the next (−1...1, 0 = straight).
    /// Positive = the curve moves early (bulges toward the end value), negative = moves late.
    var bend: Double = 0

    init(id: UUID = UUID(), x: Double, y: Double, bend: Double = 0) {
        self.id = id
        self.x = x
        self.y = y
        self.bend = bend
    }

    enum CodingKeys: String, CodingKey { case id, x, y, bend }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        x = try c.decode(Double.self, forKey: .x)
        y = try c.decode(Double.self, forKey: .y)
        bend = try c.decodeIfPresent(Double.self, forKey: .bend) ?? 0
    }

    /// Exponent used for the segment shape: t^e (bend 1 → 0.2, bend −1 → 5).
    var exponent: Double { pow(5, -min(1, max(-1, bend))) }

    /// Value of the segment from `self` to `next` at local position t (0...1).
    func segmentValue(to next: AutoPoint, t: Double) -> Double {
        let t = min(1, max(0, t))
        return y + (next.y - y) * pow(t, exponent)
    }

    /// The bend that makes the segment pass through `mid` at its halfway point.
    static func bend(from a: AutoPoint, to b: AutoPoint, passingMid mid: Double) -> Double {
        let span = b.y - a.y
        guard abs(span) > 0.02 else { return 0 }
        let ratio = min(0.97, max(0.03, (mid - a.y) / span))
        let e = log(ratio) / log(0.5)
        return min(1, max(-1, -log(e) / log(5)))
    }
}

nonisolated enum LaneKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case volume, high, mid, low
    /// DJ-mixer style filter knob: middle = off, down = low-pass, up = high-pass.
    case filter
    case echo, reverb
    /// Stems: the track's vocals and everything else (separated once per track, see StemSeparator).
    case vocal, instrumental
    var id: String { rawValue }
    var title: String {
        switch self {
        case .volume: return L("フェーダー", "Fader")
        case .high: return "HIGH"
        case .mid: return "MID"
        case .low: return "LOW"
        case .filter: return L("フィルター", "Filter")
        case .echo: return L("エコー", "Echo")
        case .reverb: return L("リバーブ", "Reverb")
        case .vocal: return L("ボーカル", "Vocals")
        case .instrumental: return L("伴奏", "Instrumental")
        }
    }
    /// What the top / bottom of the lane mean.
    var legend: String {
        switch self {
        case .volume: return L("上＝100%\n下＝0%", "Top 100%\nBottom 0%")
        case .high, .mid, .low: return L("上＝開く\n下＝KILL", "Top open\nBottom kill")
        case .filter: return L("上＝ハイパス\n中＝なし\n下＝ローパス", "Top high-pass\nMiddle off\nBottom low-pass")
        case .echo, .reverb: return L("上＝強い\n下＝なし", "Top full\nBottom off")
        case .vocal: return L("上＝そのまま\n下＝ボーカルを消す", "Top as is\nBottom vocals cut")
        case .instrumental: return L("上＝そのまま\n下＝伴奏を消す\n（アカペラ）", "Top as is\nBottom cut\n(a cappella)")
        }
    }
    /// The lane's value when nothing is drawn (no effect).
    var neutral: Double {
        switch self {
        case .filter: return 0.5
        case .echo, .reverb: return 0
        default: return 1
        }
    }
    var isEffect: Bool { self == .filter || self == .echo || self == .reverb }
    var isStem: Bool { self == .vocal || self == .instrumental }
    static let mixer: [LaneKind] = [.volume, .high, .mid, .low]
    static let effects: [LaneKind] = [.filter, .echo, .reverb]
    static let stems: [LaneKind] = [.vocal, .instrumental]
}

nonisolated struct TransitionLanes: Codable, Hashable, Sendable {
    var outVolume: [AutoPoint]
    var outHigh: [AutoPoint]
    var outMid: [AutoPoint]
    var outLow: [AutoPoint]
    var inVolume: [AutoPoint]
    var inHigh: [AutoPoint]
    var inMid: [AutoPoint]
    var inLow: [AutoPoint]
    // Effect and stem lanes (nil = not drawn: no effect).
    var outFilter: [AutoPoint]? = nil
    var inFilter: [AutoPoint]? = nil
    var outEcho: [AutoPoint]? = nil
    var inEcho: [AutoPoint]? = nil
    var outReverb: [AutoPoint]? = nil
    var inReverb: [AutoPoint]? = nil
    var outVocal: [AutoPoint]? = nil
    var inVocal: [AutoPoint]? = nil
    var outInstrumental: [AutoPoint]? = nil
    var inInstrumental: [AutoPoint]? = nil

    static func flat(_ kind: LaneKind) -> [AutoPoint] {
        [AutoPoint(x: 0, y: kind.neutral), AutoPoint(x: 1, y: kind.neutral)]
    }

    func points(_ kind: LaneKind, incoming: Bool) -> [AutoPoint] {
        switch (kind, incoming) {
        case (.volume, false): return outVolume
        case (.high, false): return outHigh
        case (.mid, false): return outMid
        case (.low, false): return outLow
        case (.volume, true): return inVolume
        case (.high, true): return inHigh
        case (.mid, true): return inMid
        case (.low, true): return inLow
        case (.filter, false): return outFilter ?? Self.flat(kind)
        case (.filter, true): return inFilter ?? Self.flat(kind)
        case (.echo, false): return outEcho ?? Self.flat(kind)
        case (.echo, true): return inEcho ?? Self.flat(kind)
        case (.reverb, false): return outReverb ?? Self.flat(kind)
        case (.reverb, true): return inReverb ?? Self.flat(kind)
        case (.vocal, false): return outVocal ?? Self.flat(kind)
        case (.vocal, true): return inVocal ?? Self.flat(kind)
        case (.instrumental, false): return outInstrumental ?? Self.flat(kind)
        case (.instrumental, true): return inInstrumental ?? Self.flat(kind)
        }
    }

    /// Whether a lane does anything (differs from its neutral value somewhere).
    func isActive(_ kind: LaneKind, incoming: Bool) -> Bool {
        points(kind, incoming: incoming).contains { abs($0.y - kind.neutral) > 0.002 }
    }

    mutating func setPoints(_ kind: LaneKind, incoming: Bool, _ pts: [AutoPoint]) {
        let sorted = pts.sorted { $0.x < $1.x }
        // A lane back at its neutral value is stored as "not drawn".
        let flat = !kind.isEffect && !kind.isStem ? false : !sorted.contains { abs($0.y - kind.neutral) > 0.002 }
        let opt: [AutoPoint]? = flat ? nil : sorted
        switch (kind, incoming) {
        case (.volume, false): outVolume = sorted
        case (.high, false): outHigh = sorted
        case (.mid, false): outMid = sorted
        case (.low, false): outLow = sorted
        case (.volume, true): inVolume = sorted
        case (.high, true): inHigh = sorted
        case (.mid, true): inMid = sorted
        case (.low, true): inLow = sorted
        case (.filter, false): outFilter = opt
        case (.filter, true): inFilter = opt
        case (.echo, false): outEcho = opt
        case (.echo, true): inEcho = opt
        case (.reverb, false): outReverb = opt
        case (.reverb, true): inReverb = opt
        case (.vocal, false): outVocal = opt
        case (.vocal, true): inVocal = opt
        case (.instrumental, false): outInstrumental = opt
        case (.instrumental, true): inInstrumental = opt
        }
    }

    /// Interpolation through the points, each segment shaped by its bend.
    static func value(_ pts: [AutoPoint], at x: Double) -> Double {
        guard let first = pts.first, let last = pts.last else { return 1 }
        if x <= first.x { return first.y }
        if x >= last.x { return last.y }
        for k in 1..<pts.count where x <= pts[k].x {
            let a = pts[k - 1], b = pts[k]
            let span = b.x - a.x
            if span < 1e-9 { return b.y }
            return a.segmentValue(to: b, t: (x - a.x) / span)
        }
        return last.y
    }

    func value(_ kind: LaneKind, incoming: Bool, at x: Double) -> Double {
        Self.value(points(kind, incoming: incoming), at: x)
    }

    /// Converts a preset style into editable points (sampled, then simplified).
    static func sampled(style: TransitionStyle, shape: TransitionShape) -> TransitionLanes {
        var xs = stride(from: 0.0, through: 1.0, by: 1.0 / 96).map { $0 }
        var critical = [shape.inRise, shape.outFadeStart]
        for b in [shape.low, shape.mid, shape.high] where b.enabled {
            critical += [b.point, b.point + b.ramp]
        }
        for c in critical {
            xs += [c - 0.0005, c, c + 0.0005]
        }
        xs = Array(Set(xs.map { min(1, max(0, $0)) })).sorted()
        func lane(_ kind: LaneKind, incoming: Bool) -> [AutoPoint] {
            let pts = xs.map { x -> AutoPoint in
                let c = incoming ? Automation.incoming(style, shape, x) : Automation.outgoing(style, shape, x)
                let y: Double
                switch kind {
                case .volume: y = c.volume
                case .high: y = 1 - c.highKill
                case .mid: y = 1 - c.midKill
                case .low: y = 1 - c.lowKill
                default: y = kind.neutral
                }
                return AutoPoint(x: x, y: min(1, max(0, y)))
            }
            return fitCurve(pts)
        }
        return TransitionLanes(outVolume: lane(.volume, incoming: false), outHigh: lane(.high, incoming: false),
                               outMid: lane(.mid, incoming: false), outLow: lane(.low, incoming: false),
                               inVolume: lane(.volume, incoming: true), inHigh: lane(.high, incoming: true),
                               inMid: lane(.mid, incoming: true), inLow: lane(.low, incoming: true))
    }

    /// Reduces a densely sampled curve to a few points with bends, so it is easy to edit.
    static func fitCurve(_ samples: [AutoPoint]) -> [AutoPoint] {
        var pts = simplify(samples, epsilon: 0.07)
        // Fit each segment's bend to the real curve's midpoint.
        for k in 0..<(pts.count - 1) {
            let a = pts[k], b = pts[k + 1]
            let midX = (a.x + b.x) / 2
            let real = value(samples, at: midX)
            pts[k].bend = AutoPoint.bend(from: a, to: b, passingMid: real)
        }
        return pts
    }

    /// Ramer–Douglas–Peucker simplification (keeps the first and last point).
    static func simplify(_ pts: [AutoPoint], epsilon: Double) -> [AutoPoint] {
        guard pts.count > 2 else { return pts }
        var keep = [Bool](repeating: false, count: pts.count)
        keep[0] = true
        keep[pts.count - 1] = true
        var stack = [(0, pts.count - 1)]
        while let (a, b) = stack.popLast() {
            guard b > a + 1 else { continue }
            var maxD = 0.0
            var idx = a
            for k in (a + 1)..<b {
                let y = pts[a].y + (pts[b].y - pts[a].y) * (pts[k].x - pts[a].x) / max(1e-9, pts[b].x - pts[a].x)
                let d = abs(pts[k].y - y)
                if d > maxD { maxD = d; idx = k }
            }
            if maxD > epsilon {
                keep[idx] = true
                stack.append((a, idx))
                stack.append((idx, b))
            }
        }
        return pts.enumerated().filter { keep[$0.offset] }.map(\.element)
    }

    /// Ready-made pairs of curves for one lane.
    enum Template: String, CaseIterable, Identifiable {
        case linear, equalPower, instantMiddle, secondHalf, open
        var id: String { rawValue }
        var title: String {
            switch self {
            case .linear: return L("直線で入れ替え", "Linear swap")
            case .equalPower: return L("等パワーで入れ替え", "Equal-power swap")
            case .instantMiddle: return L("中間で瞬時に入れ替え", "Instant swap in the middle")
            case .secondHalf: return L("後半で入れ替え", "Swap in the second half")
            case .open: return L("両方とも開いたまま", "Both stay open")
            }
        }
    }

    mutating func apply(_ template: Template, to kind: LaneKind) {
        let incoming: [AutoPoint]
        switch template {
        case .linear:
            incoming = [AutoPoint(x: 0, y: 0), AutoPoint(x: 1, y: 1)]
        case .equalPower:
            incoming = [AutoPoint(x: 0, y: 0, bend: 0.45), AutoPoint(x: 1, y: 1)]
        case .instantMiddle:
            incoming = [AutoPoint(x: 0, y: 0), AutoPoint(x: 0.5, y: 0), AutoPoint(x: 0.5005, y: 1), AutoPoint(x: 1, y: 1)]
        case .secondHalf:
            incoming = [AutoPoint(x: 0, y: 0), AutoPoint(x: 0.5, y: 0), AutoPoint(x: 1, y: 1)]
        case .open:
            setPoints(kind, incoming: true, [AutoPoint(x: 0, y: 1), AutoPoint(x: 1, y: 1)])
            setPoints(kind, incoming: false, [AutoPoint(x: 0, y: 1), AutoPoint(x: 1, y: 1)])
            return
        }
        setPoints(kind, incoming: true, incoming)
        let outgoing: [AutoPoint]
        if template == .equalPower {
            outgoing = [AutoPoint(x: 0, y: 1, bend: -0.45), AutoPoint(x: 1, y: 0)]
        } else {
            outgoing = incoming.map { AutoPoint(x: $0.x, y: 1 - $0.y, bend: $0.bend) }
        }
        setPoints(kind, incoming: false, outgoing)
    }

    /// Outgoing = mirror image (1 − y) of incoming for one lane.
    mutating func mirrorToOutgoing(_ kind: LaneKind) {
        let pts = points(kind, incoming: true).map { AutoPoint(x: $0.x, y: 1 - $0.y, bend: $0.bend) }
        setPoints(kind, incoming: false, pts)
    }
}

nonisolated extension TransitionLanes {
    /// Ready-made moves for the effect and stem lanes.
    struct EffectPreset: Identifiable, Sendable {
        let id: String
        let title: String
        let incoming: [AutoPoint]?
        let outgoing: [AutoPoint]?
    }

    static func effectPresets(_ kind: LaneKind) -> [EffectPreset] {
        func p(_ v: [(Double, Double)], bend: Double = 0) -> [AutoPoint] {
            v.enumerated().map { k, xy in AutoPoint(x: xy.0, y: xy.1, bend: k == v.count - 2 ? bend : 0) }
        }
        switch kind {
        case .filter:
            return [
                EffectPreset(id: "outHP", title: L("前の曲をハイパスで抜く（後半）", "High-pass the previous track out (second half)"),
                             incoming: nil, outgoing: p([(0, 0.5), (0.5, 0.5), (1, 1)], bend: 0.3)),
                EffectPreset(id: "inLP", title: L("この曲をローパスから開く（前半）", "Open this track from a low-pass (first half)"),
                             incoming: p([(0, 0), (0.5, 0.5), (1, 0.5)]), outgoing: nil),
                EffectPreset(id: "both", title: L("両方（入る側ローパス・出る側ハイパス）", "Both (in from low-pass, out to high-pass)"),
                             incoming: p([(0, 0), (0.5, 0.5), (1, 0.5)]), outgoing: p([(0, 0.5), (0.5, 0.5), (1, 1)], bend: 0.3)),
            ]
        case .echo:
            return [
                EffectPreset(id: "outEnd", title: L("最後の1/4で前の曲にエコー", "Echo the previous track in the last quarter"),
                             incoming: nil, outgoing: p([(0, 0), (0.75, 0), (1, 0.8)])),
                EffectPreset(id: "outHalf", title: L("後半ずっと前の曲にエコー", "Echo the previous track through the second half"),
                             incoming: nil, outgoing: p([(0, 0), (0.5, 0), (0.6, 0.6), (1, 0.6)])),
            ]
        case .reverb:
            return [
                EffectPreset(id: "outTail", title: L("前の曲をリバーブで遠ざける", "Wash the previous track out with reverb"),
                             incoming: nil, outgoing: p([(0, 0), (0.6, 0), (1, 0.8)], bend: -0.3)),
                EffectPreset(id: "inFromVerb", title: L("この曲をリバーブの中から出す", "Bring this track in out of a reverb"),
                             incoming: p([(0, 0.7), (0.5, 0)]), outgoing: nil),
            ]
        case .vocal:
            return [
                EffectPreset(id: "outCut", title: L("前の曲のボーカルを途中で消す", "Cut the previous track’s vocals halfway"),
                             incoming: nil, outgoing: p([(0, 1), (0.4, 1), (0.5, 0), (1, 0)])),
                EffectPreset(id: "inLater", title: L("この曲は伴奏だけで入り、最後にボーカルを入れる", "This track comes in without vocals; vocals at the end"),
                             incoming: p([(0, 0), (0.74, 0), (0.75, 1), (1, 1)]), outgoing: nil),
                EffectPreset(id: "swap", title: L("ボーカルを入れ替える（真ん中）", "Swap the vocals in the middle"),
                             incoming: p([(0, 0), (0.49, 0), (0.5, 1), (1, 1)]), outgoing: p([(0, 1), (0.49, 1), (0.5, 0), (1, 0)])),
            ]
        case .instrumental:
            return [
                EffectPreset(id: "inAcapella", title: L("この曲のボーカルだけ（アカペラ）を先に重ねる", "Lay this track’s a cappella over first"),
                             incoming: p([(0, 0), (0.74, 0), (0.75, 1), (1, 1)]), outgoing: nil),
                EffectPreset(id: "outAcapella", title: L("前の曲はボーカルだけ残して抜ける", "Leave the previous track’s a cappella at the end"),
                             incoming: nil, outgoing: p([(0, 1), (0.5, 1), (0.6, 0), (1, 0)])),
            ]
        default:
            return []
        }
    }

    mutating func apply(_ preset: EffectPreset, to kind: LaneKind) {
        setPoints(kind, incoming: true, preset.incoming ?? Self.flat(kind))
        setPoints(kind, incoming: false, preset.outgoing ?? Self.flat(kind))
    }

    mutating func clear(_ kind: LaneKind) {
        setPoints(kind, incoming: true, Self.flat(kind))
        setPoints(kind, incoming: false, Self.flat(kind))
    }

    /// The transition uses the stems (vocals / instrumental) of the outgoing or incoming track.
    var usesStemsOutgoing: Bool { isActive(.vocal, incoming: false) || isActive(.instrumental, incoming: false) }
    var usesStemsIncoming: Bool { isActive(.vocal, incoming: true) || isActive(.instrumental, incoming: true) }
    var usesReverb: Bool { isActive(.reverb, incoming: true) || isActive(.reverb, incoming: false) }
}

/// A user-made transition saved app-wide ("My Transitions").
nonisolated struct CustomTransition: Codable, Identifiable, Hashable, Sendable {
    var id = UUID()
    var name: String
    var bars: Double
    var lanes: TransitionLanes
}

// MARK: - Waveform

nonisolated struct Waveform: Sendable {
    var binsPerSecond: Double
    var peaks: [Float]
    var lows: [Float]
    var maxPeak: Float

    /// Source time of the last bin that is louder than `fraction` of the peak.
    func lastSoundTime(fraction: Float = 0.04) -> Double? {
        let threshold = maxPeak * fraction
        guard let i = peaks.lastIndex(where: { $0 > threshold }) else { return nil }
        return Double(i + 1) / binsPerSecond
    }
}

// MARK: - Grid

nonisolated struct Grid: Sendable {
    var bpm: Double
    var offset: Double

    var beat: Double { 60 / max(bpm, 1) }
    var bar: Double { beat * 4 }

    func snap(_ t: Double, unitBeats: Double) -> Double {
        let u = beat * unitBeats
        return offset + ((t - offset) / u).rounded() * u
    }

    /// 1-based bar and beat at timeline time t.
    func position(_ t: Double) -> (bar: Int, beat: Int) {
        let rel = (t - offset) / beat
        let b = Int(floor(rel + 1e-6))
        let bar = Int(floor(Double(b) / 4)) + 1
        let beatInBar = ((b % 4) + 4) % 4 + 1
        return (bar, beatInBar)
    }
}

nonisolated enum Mathx {
    static func posModInt(_ a: Int, _ m: Int) -> Int {
        guard m > 0 else { return 0 }
        return ((a % m) + m) % m
    }

    static func posMod(_ a: Double, _ m: Double) -> Double {
        guard m > 0 else { return 0 }
        let r = a.truncatingRemainder(dividingBy: m)
        return r < 0 ? r + m : r
    }

    static func clamp01(_ x: Double) -> Double { min(1, max(0, x)) }
}

// MARK: - Project file

/// Work state restored when a mix is reopened.
nonisolated struct ProjectUIState: Codable, Sendable {
    var playhead: Double
    var pixelsPerSecond: Double
    var scrollTime: Double
    var selectedClipID: UUID?
    var showDecks: Bool
    var showMixer: Bool? = nil
    var showInspector: Bool
}

/// The DJAW Mix document (.djaw). JSON with a format marker so it can be recognised and migrated.
nonisolated struct ProjectFile: Codable, Sendable {
    static let formatID = "DJAW-Mix"
    static let currentVersion = 2

    var format: String?
    var version: Int
    var savedAt: Date?
    var appVersion: String?
    /// Where the document lives (used when restoring an autosave).
    var originalPath: String?
    var notes: String?
    var ui: ProjectUIState?
    /// My Transitions used in this mix, so the file is self-contained.
    var customTransitions: [CustomTransition]?
    var masterBPM: Double
    var gridOffset: Double
    var defaultTransitionBars: Int
    var defaultTransitionStyle: TransitionStyle?
    var library: [Clip]?
    var snap: SnapUnit
    var clips: [Clip]
    /// Stable id of this mix (names the folder embedded audio is unpacked to).
    var projectID: String? = nil
    /// Audio files stored inside the .djaw package.
    var media: [ProjectContainer.Media]? = nil
    /// Track analyses (waveform, grid, structure, neural beats / cues, genre), keyed by audio fingerprint,
    /// so opening the mix does not analyse the tracks again (see AnalysisCache).
    var analyses: [String: Data]? = nil
    /// Loudness normalization of this mix (LoudnessMode raw value).
    var loudnessMode: String? = nil
    /// Track profiles (title, artist, artwork, …) keyed by audio fingerprint, so they travel with the mix.
    var profiles: [String: TrackProfile]? = nil
}

/// How much of each track the auto-mix plays.
nonisolated enum TrackUse: String, CaseIterable, Identifiable, Codable, Sendable {
    /// By genre: hardcore / breakcore keep the energy up (≈ 2½ min per track), the rest play to the end.
    case auto
    /// Each track up to the end of its music (or of its last drop).
    case full
    /// Leave each track while it is still in a drop, after about 2½ minutes, straight into the next drop.
    case energetic

    var id: String { rawValue }

    var title: String {
        switch self {
        case .auto: return L("ジャンルに合わせる", "By Genre")
        case .full: return L("曲を最後まで使う", "Play Tracks Out")
        case .energetic: return L("盛り上がったまま次へ", "Keep the Energy Up")
        }
    }

    var detail: String {
        switch self {
        case .auto: return L("ハードコア／ブレイクコアは盛り上がったまま次の曲へ、それ以外は曲を最後まで使います。", "Hardcore / breakcore keep the energy up; other genres play each track out.")
        case .full: return L("前の曲は最後のドロップやアウトロまで使ってから次へ。", "Each track plays through its last drop or outro before the next one.")
        case .energetic: return L("前の曲がドロップの途中（1曲あたり約2分半）で、次の曲のドロップへつなぎます。", "Leaves each track mid-drop (about 2½ minutes per track) straight into the next drop.")
        }
    }
}

/// One saved way of connecting a track to the track before it, so several can be kept, compared and chosen from.
nonisolated struct TransitionTake: Codable, Hashable, Sendable, Identifiable {
    var id = UUID()
    var name: String
    var created = Date()
    /// The outgoing track the take was made with (takes only apply while it is still the previous track).
    var prevID: UUID
    var snapshot: Snapshot

    /// Everything that makes up the transition, on both tracks.
    struct Snapshot: Codable, Hashable, Sendable {
        // Outgoing track
        var prevMixOutBar: Double
        var prevOutNudge: Double?
        var prevFadeOutBeats: Double
        /// Effects the auto-mix placed on the outgoing track for this transition.
        var prevAutoFX: [ClipFX]
        // Incoming track
        var mixInBar: Double
        var transitionBars: Double
        var transition: TransitionStyle
        var shape: TransitionShape?
        var lanes: TransitionLanes?
        var tempo: Double?
        var tempoBars: Double?
        var spinBeats: Double?
        var inNudge: Double?
        var fadeInBeats: Double
        var landingLock: Bool?
        var autoNote: AutoMixNote?

        init(prev: Clip, clip: Clip) {
            prevMixOutBar = prev.mixOutBar
            prevOutNudge = prev.outNudge
            prevFadeOutBeats = prev.fadeOutBeats
            prevAutoFX = (prev.fx ?? []).filter { $0.auto == true }
            mixInBar = clip.mixInBar
            transitionBars = clip.transitionBars
            transition = clip.transition
            shape = clip.shape
            lanes = clip.transition == .custom ? clip.lanes : nil
            tempo = clip.tempo
            tempoBars = clip.tempoBars
            spinBeats = clip.spinBeats
            inNudge = clip.inNudge
            fadeInBeats = clip.fadeInBeats
            landingLock = clip.landingLock
            autoNote = clip.autoNote
        }

        /// Same transition (ignoring the explanation text).
        func sounds(like o: Snapshot) -> Bool {
            var a = self, b = o
            a.autoNote = nil; b.autoNote = nil
            return a == b
        }

        func apply(prev: inout Clip, clip: inout Clip) {
            prev.mixOutBar = prevMixOutBar
            prev.outNudge = prevOutNudge
            prev.fadeOutBeats = prevFadeOutBeats
            var fx = (prev.fx ?? []).filter { $0.auto != true }
            fx += prevAutoFX
            prev.fx = fx.isEmpty ? nil : fx
            clip.mixInBar = mixInBar
            clip.transitionBars = transitionBars
            clip.transition = transition
            clip.shape = shape
            clip.lanes = lanes
            clip.tempo = tempo
            clip.tempoBars = tempoBars
            clip.spinBeats = spinBeats
            clip.inNudge = inNudge
            clip.fadeInBeats = fadeInBeats
            clip.landingLock = landingLock
            clip.autoNote = autoNote
        }
    }

    /// A short description: style, length, where the two tracks meet.
    var summary: String {
        let s = snapshot
        let how = s.transition.isCutLike || s.transitionBars < 0.01
            ? s.transition.title
            : L("\(s.transition.title) \(Self.bars(s.transitionBars))小節", "\(s.transition.title), \(Self.bars(s.transitionBars)) bars")
        return L("\(how)・前の曲 \(Self.bars(s.prevMixOutBar + 1))小節目まで・この曲は \(Self.bars(s.mixInBar + 1))小節目から",
                 "\(how) · previous until bar \(Self.bars(s.prevMixOutBar + 1)) · in at bar \(Self.bars(s.mixInBar + 1))")
    }

    private static func bars(_ v: Double) -> String {
        abs(v - v.rounded()) < 0.01 ? "\(Int(v.rounded()))" : String(format: "%.2f", v)
    }
}

/// The track colours (hues), shared by the views and the code that keeps neighbouring tracks apart.
nonisolated enum ClipPalette {
    static let hues: [Double] = [0.53, 0.92, 0.08, 0.75, 0.36, 0.60, 0.14, 0.99, 0.45, 0.84]

    static func hue(_ index: Int) -> Double { hues[((index % hues.count) + hues.count) % hues.count] }

    /// Distance between two colours on the colour wheel (0 = same hue, 0.5 = opposite).
    static func distance(_ a: Int, _ b: Int) -> Double {
        let d = abs(hue(a) - hue(b)).truncatingRemainder(dividingBy: 1)
        return min(d, 1 - d)
    }

    /// Below this, two tracks next to each other are hard to tell apart.
    static let minNeighbourDistance = 0.15
}
