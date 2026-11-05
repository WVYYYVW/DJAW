import Foundation

/// Step-by-step instructions for playing a finished mix live on two decks and a mixer:
/// what to load, where to set the cue, when to press play, and how to move the faders, EQs, pitch and effects
/// so that the set sounds like it does in DJAW. Also the track list (for SoundCloud descriptions and the like).
nonisolated enum PerformanceGuide {
    struct Step: Identifiable, Sendable {
        let id = UUID()
        /// Real (heard) time in the set.
        var time: Double
        /// Where the step happens on the deck(s), e.g. "A 57.1 / B 9.1".
        var position: String
        var deck: String?
        var text: String
        /// Something to get ready before this moment (shown dimmer).
        var isPrep = false
    }

    struct Track: Identifiable, Sendable {
        let id = UUID()
        var number: Int
        var deck: String
        var title: String
        var setup: [String]
        var steps: [Step]
    }

    struct Guide: Sendable {
        var overview: [String]
        var tracks: [Track]
    }

    /// Formatting (the view-layer `Fmt` lives on the main actor).
    private enum F {
        static func time(_ t: Double) -> String {
            let s = max(0, t), m = Int(s) / 60
            return String(format: "%d:%04.1f", m, s - Double(m * 60))
        }
        static func duration(_ t: Double) -> String {
            let s = Int(max(0, t).rounded())
            if s >= 3600 { return String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60) }
            return String(format: "%d:%02d", s / 60, s % 60)
        }
        static func bpm(_ b: Double) -> String {
            guard b > 0 else { return "—" }
            return abs(b - b.rounded()) < 0.005 ? String(format: "%.0f", b) : String(format: "%.2f", b)
        }
    }

    static func timeText(_ t: Double) -> String { F.time(t) }

    static func deck(_ i: Int) -> String { i % 2 == 0 ? "A" : "B" }

    // MARK: Track list

    /// "0:00 Artist - Title" per track, at the moment each track takes over from the previous one
    /// (read from the transition's curves — see Automation.switchPoint).
    static func trackList(clips: [Clip], master: Double, tempo: TempoMap, numbered: Bool = false) -> String {
        let long = (clips.map { tempo.real($0.end(master: master)) }.max() ?? 0) >= 3600
        return clips.enumerated().map { k, c in
            let t = k == 0 ? 0 : tempo.real(Automation.switchTime(clips: clips, index: k, master: master))
            return (numbered ? "\(k + 1). " : "") + stamp(t, long: long) + " " + displayName(c)
        }.joined(separator: "\n")
    }

    static func displayName(_ c: Clip) -> String {
        let title = c.title.trimmingCharacters(in: .whitespaces)
        let artist = c.artist.trimmingCharacters(in: .whitespaces)
        if artist.isEmpty || title.localizedCaseInsensitiveContains(artist) { return title }
        return "\(artist) - \(title)"
    }

    /// 0:00 / 1:02:03 (SoundCloud turns these into links).
    static func stamp(_ t: Double, long: Bool) -> String {
        let s = Int(max(0, t).rounded(.down))
        if long || s >= 3600 { return String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60) }
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    // MARK: Guide

    static func build(clips: [Clip], master: Double, tempo: TempoMap) -> Guide {
        let tracks = clips.indices.map { track($0, clips: clips, master: master, tempo: tempo) }
        let end = clips.map { tempo.real($0.end(master: master)) }.max() ?? 0
        var overview = [
            L("曲数：\(clips.count)曲　長さ：\(F.duration(end))　デッキ：2台（A・B を交互に使用）＋ミキサー",
              "\(clips.count) tracks · \(F.duration(end)) · two decks (A and B in turn) and a mixer"),
            L("位置は「デッキ 小節.拍」（例：A 57.1 = デッキAの曲の57小節目の1拍目）。小節は DJAW のグリッドの番号です。",
              "Positions are “deck bar.beat” (A 57.1 = bar 57, beat 1 of the track on deck A), numbered as on DJAW’s grid."),
            L("EQ は「12時 = 0 dB」「絞り切り = カット」。フェーダーはチャンネルフェーダー（クロスフェーダーは中央のまま）。",
              "EQ: “12 o’clock” = 0 dB, “off” = fully cut. Faders are the channel faders (leave the crossfader in the middle)."),
        ]
        if tempo.points.count > 1 || clips.contains(where: { $0.tempo != nil }) {
            overview.append(L("途中で BPM が変わります。ピッチ（テンポ）フェーダーを手順どおりに動かしてください。",
                              "The tempo changes during the set: move the pitch faders as described."))
        }
        return Guide(overview: overview, tracks: tracks)
    }

    private static func pos(_ c: Clip, _ deckName: String, at t: Double, master: Double) -> String {
        "\(deckName) \(barBeat(c.bar(atTimeline: t, master: master)))"
    }

    /// 1-based "bar.beat" for a 0-based bar position.
    static func barBeat(_ b: Double) -> String {
        let bb = (b * 4).rounded() / 4
        let bar = Int(bb.rounded(.down))
        let beat = Int(((bb - Double(bar)) * 4).rounded()) + 1
        return "\(bar + 1).\(min(4, beat))"
    }

    private static func pitch(_ c: Clip, tempo: TempoMap, at t: Double) -> Double {
        guard c.tempoSync, c.bpm > 1 else { return 0 }
        return (tempo.bpm(at: t) / c.bpm - 1) * 100
    }

    private static func pitchText(_ p: Double) -> String { String(format: "%+.2f%%", p) }

    private static func track(_ i: Int, clips: [Clip], master: Double, tempo: TempoMap) -> Track {
        let c = clips[i]
        let d = deck(i)
        var setup: [String] = []
        // Load / tempo / key.
        let bpmHere = tempo.bpm(at: c.start + 0.001)
        if c.tempoSync {
            setup.append(L("曲の BPM \(F.bpm(c.bpm)) → ピッチ \(pitchText(pitch(c, tempo: tempo, at: c.start + 0.001)))（\(F.bpm(bpmHere)) BPM で再生）",
                           "Track BPM \(F.bpm(c.bpm)) → pitch \(pitchText(pitch(c, tempo: tempo, at: c.start + 0.001))) (plays at \(F.bpm(bpmHere)) BPM)"))
        } else {
            setup.append(L("ピッチ 0%（テンポは合わせない）", "Pitch 0% (not tempo-matched)"))
        }
        setup.append(c.keepsKey ? L("マスターテンポ（キーロック）ON", "Master tempo (key lock) ON")
                                : L("マスターテンポ（キーロック）OFF", "Master tempo (key lock) OFF"))
        if let k = c.keyShift, k != 0 {
            setup.append(L("キーを \(k > 0 ? "+" : "")\(k) 半音", "Key \(k > 0 ? "+" : "")\(k) semitones"))
        }
        let segs = c.playSegments()
        let cueSource = segs.first?.from ?? c.trimStart
        setup.append(L("CUE：\(F.time(cueSource))（\(barBeat(c.bar(atSource: cueSource)))）", "CUE: \(F.time(cueSource)) (\(barBeat(c.bar(atSource: cueSource))))"))
        let trim = c.gainDB + (c.loudnessGainDB ?? 0)
        if abs(trim) >= 0.5 {
            setup.append(L("TRIM（ゲイン）\(String(format: "%+.1f", trim)) dB", "Trim (gain) \(String(format: "%+.1f", trim)) dB"))
        }
        let eqBase = [("LOW", c.eqLow), ("MID", c.eqMid), ("HIGH", c.eqHigh)].filter { abs($0.1) >= 0.5 }
        if !eqBase.isEmpty {
            setup.append(L("EQ の基本位置：", "EQ base: ") + eqBase.map { "\($0.0) \(String(format: "%+.0f", $0.1)) dB" }.joined(separator: "・"))
        }
        if let edits = c.edits, !edits.isEmpty {
            for e in edits.sorted(by: { $0.bar < $1.bar }) {
                switch e.kind {
                case .loop:
                    setup.append(L("ループ：\(barBeat(e.bar))〜 \(e.lengthLabel) を \(e.repeats + 1)回（ループ IN をホットキューに）",
                                   "Loop: from \(barBeat(e.bar)), \(e.lengthLabel), \(e.repeats + 1)× (put loop-in on a hot cue)"))
                case .jump:
                    setup.append(L("ジャンプ：\(barBeat(e.bar)) から \(barBeat(e.end)) へ（飛び先をホットキューに）",
                                   "Jump: from \(barBeat(e.bar)) to \(barBeat(e.end)) (put the target on a hot cue)"))
                }
            }
        }

        var steps: [Step] = []
        if i == 0 {
            steps.append(Step(time: tempo.real(c.start), position: pos(c, d, at: c.start, master: master), deck: d,
                              text: L("デッキ\(d) PLAY（フェーダー 100%、EQ はすべて12時）", "Deck \(d) PLAY (fader 100%, all EQs at 12 o’clock)")))
            if c.fadeInBeats > 0 {
                steps.append(Step(time: tempo.real(c.start), position: pos(c, d, at: c.start, master: master), deck: d,
                                  text: L("フェーダーを0から \(fmtBeats(c.fadeInBeats)) かけて上げる", "Bring the fader up from 0 over \(fmtBeats(c.fadeInBeats))")))
            }
        } else {
            steps += transitionSteps(i, clips: clips, master: master, tempo: tempo)
        }
        steps += fxSteps(c, deck: d, master: master, tempo: tempo)
        steps += editSteps(c, deck: d, master: master, tempo: tempo)
        if i == clips.count - 1 {
            let end = c.end(master: master)
            if c.fadeOutBeats > 0 {
                let t0 = end - c.fadeOutBeats * 60 / max(master, 1)
                steps.append(Step(time: tempo.real(t0), position: pos(c, d, at: t0, master: master), deck: d,
                                  text: L("フェーダーを \(fmtBeats(c.fadeOutBeats)) かけて0まで下げる", "Fade the fader out to 0 over \(fmtBeats(c.fadeOutBeats))")))
            }
            steps.append(Step(time: tempo.real(end), position: pos(c, d, at: end, master: master), deck: d,
                              text: L("デッキ\(d) STOP（セット終了）", "Deck \(d) STOP (end of the set)")))
        }
        steps.sort { $0.time < $1.time }
        return Track(number: i + 1, deck: d, title: displayName(c), setup: setup, steps: steps)
    }

    private static func fmtBeats(_ beats: Double) -> String {
        if beats >= 4, abs(beats / 4 - (beats / 4).rounded()) < 0.01 { return L("\(Int((beats / 4).rounded()))小節", "\(Int((beats / 4).rounded())) bars") }
        return L("\(fmt(beats))拍", "\(fmt(beats)) beats")
    }

    private static func fmt(_ v: Double) -> String {
        abs(v - v.rounded()) < 0.05 ? "\(Int(v.rounded()))" : String(format: "%.1f", v)
    }

    // MARK: Transitions

    private enum Control: CaseIterable { case volume, low, mid, high, filter, echo, reverb, vocal, instrumental
        var name: String {
            switch self {
            case .volume: return L("フェーダー", "fader")
            case .low: return "LOW"
            case .mid: return "MID"
            case .high: return "HIGH"
            case .filter: return L("フィルター", "FILTER")
            case .echo: return L("エコー", "ECHO")
            case .reverb: return L("リバーブ", "REVERB")
            case .vocal: return L("STEMS ボーカル", "STEMS vocals")
            case .instrumental: return L("STEMS 伴奏", "STEMS instrumental")
            }
        }
    }

    private static func value(_ cv: Automation.Curve, _ k: Control) -> Double {
        switch k {
        case .volume: return cv.volume
        case .low: return 1 - cv.lowKill
        case .mid: return 1 - cv.midKill
        case .high: return 1 - cv.highKill
        case .filter: return cv.filter
        case .echo: return cv.fxEcho
        case .reverb: return cv.fxReverb
        case .vocal: return cv.vocal
        case .instrumental: return cv.instrumental
        }
    }

    /// Fader in %, EQ as a knob position (1 = 12 o’clock, 0 = fully cut), filter as LPF / HPF amount.
    private static func level(_ k: Control, _ v: Double) -> String {
        switch k {
        case .volume, .echo, .reverb, .vocal, .instrumental:
            if (k == .echo || k == .reverb) && v <= 0.01 { return "OFF" }
            return "\(Int((v * 100).rounded()))%"
        case .filter:
            if abs(v) < 0.02 { return L("センター", "centre") }
            return v < 0 ? L("ローパス \(Int((-v * 100).rounded()))%", "LPF \(Int((-v * 100).rounded()))%")
                         : L("ハイパス \(Int((v * 100).rounded()))%", "HPF \(Int((v * 100).rounded()))%")
        default:
            if v >= 0.97 { return L("12時", "12 o’clock") }
            if v <= 0.03 { return L("絞り切り", "off") }
            return "\(Int((v * 100).rounded()))%"
        }
    }

    private static func transitionSteps(_ i: Int, clips: [Clip], master: Double, tempo: TempoMap) -> [Step] {
        let c = clips[i], prev = clips[i - 1]
        let dIn = deck(i), dOut = deck(i - 1)
        let start = c.start
        let len = min(prev.end(master: master), c.end(master: master)) - start
        func at(_ t: Double) -> String { "\(pos(prev, dOut, at: t, master: master)) / \(pos(c, dIn, at: t, master: master))" }
        var steps: [Step] = []
        let style = c.transition

        // Getting ready: the incoming deck's pitch and starting levels.
        let leadIn = max(0, start - 16 * 240 / max(master, 1))
        var ready = L("デッキ\(dIn) を準備：CUE に合わせ、ピッチ \(pitchText(pitch(c, tempo: tempo, at: start + 0.001)))",
                      "Get deck \(dIn) ready: at the cue, pitch \(pitchText(pitch(c, tempo: tempo, at: start + 0.001)))")
        if !style.isCutLike && style != .echoOut, len > 0.001 {
            let cv = Automation.incomingCurve(c, 0)
            ready += L("、フェーダー \(level(.volume, value(cv, .volume)))、", ", fader \(level(.volume, value(cv, .volume))), ")
                + [Control.low, .mid, .high].map { "\($0.name) \(level($0, value(cv, $0)))" }.joined(separator: "・")
        } else {
            ready += L("、フェーダー 0%（EQ は12時）", ", fader 0% (EQs at 12 o’clock)")
        }
        steps.append(Step(time: tempo.real(leadIn), position: pos(prev, dOut, at: leadIn, master: master), deck: dIn, text: ready, isPrep: true))

        switch style {
        case .cut:
            steps.append(Step(time: tempo.real(start), position: at(start), deck: dIn,
                              text: L("デッキ\(dIn) PLAY と同時にフェーダーを切り替え（\(dIn) を100%、\(dOut) を0%）", "Deck \(dIn) PLAY and swap the faders at once (\(dIn) to 100%, \(dOut) to 0%)")))
        case .echoOut:
            let beat = 60 / max(master, 1)
            let t0 = start - beat
            steps.append(Step(time: tempo.real(t0), position: pos(prev, dOut, at: t0, master: master), deck: dOut,
                              text: L("デッキ\(dOut) にエコー ON（1拍前から）", "Echo ON on deck \(dOut) (one beat early)")))
            steps.append(Step(time: tempo.real(start), position: at(start), deck: dIn,
                              text: L("デッキ\(dOut) のフェーダーを0%（エコーの残響だけ残す）＋ デッキ\(dIn) PLAY・フェーダー100%", "Deck \(dOut) fader to 0% (only the echo rings on) + deck \(dIn) PLAY, fader 100%")))
        case .brake, .backspin:
            let beats = c.spinBeats ?? style.defaultSpinBeats
            let t0 = start - beats * 60 / max(master, 1)
            steps.append(Step(time: tempo.real(t0), position: pos(prev, dOut, at: t0, master: master), deck: dOut,
                              text: style == .brake
                                  ? L("デッキ\(dOut) を STOP（ブレーキ：約\(fmt(beats))拍で止まる設定）", "Deck \(dOut) STOP (brake: stops over about \(fmt(beats)) beats)")
                                  : L("デッキ\(dOut) をバックスピン（ジョグを逆回し、約\(fmt(beats))拍）", "Backspin deck \(dOut) (spin the jog backwards, about \(fmt(beats)) beats)")))
            steps.append(Step(time: tempo.real(start), position: at(start), deck: dIn,
                              text: L("デッキ\(dIn) PLAY・フェーダー100%、デッキ\(dOut) のフェーダーを0%", "Deck \(dIn) PLAY, fader 100%; deck \(dOut) fader to 0%")))
        default:
            steps.append(Step(time: tempo.real(start), position: at(start), deck: dIn,
                              text: L("デッキ\(dIn) PLAY（\(dOut) の \(barBeat(prev.bar(atTimeline: start, master: master))) ぴったりで）", "Deck \(dIn) PLAY (exactly on \(dOut) \(barBeat(prev.bar(atTimeline: start, master: master))))")))
            if len > 0.001 {
                steps += curveSteps(c: c, prev: prev, dIn: dIn, dOut: dOut, start: start, len: len, master: master, tempo: tempo)
            }
        }

        // Tempo moving during the transition.
        if let target = c.tempo {
            let from = tempo.bpm(at: max(0, start - 0.01))
            if abs(target - from) > 0.01 {
                let bars = c.tempoBars ?? c.transitionBars
                let t1 = start + bars * 240 / max(master, 1)
                let pa0 = pitch(prev, tempo: tempo, at: max(0, start - 0.01)), pa1 = pitch(prev, tempo: tempo, at: t1)
                let pb0 = pitch(c, tempo: tempo, at: start + 0.001), pb1 = pitch(c, tempo: tempo, at: t1)
                let text = bars <= 0.01
                    ? L("BPM を \(F.bpm(from)) → \(F.bpm(target)) に一気に変更（デッキ\(dIn) ピッチ \(pitchText(pb1))）",
                        "Tempo jumps \(F.bpm(from)) → \(F.bpm(target)) (deck \(dIn) pitch \(pitchText(pb1)))")
                    : L("BPM を \(fmt(bars))小節かけて \(F.bpm(from)) → \(F.bpm(target)) へ：両方のピッチフェーダーを同時に動かす（\(dOut) \(pitchText(pa0))→\(pitchText(pa1))、\(dIn) \(pitchText(pb0))→\(pitchText(pb1))）",
                        "Tempo \(F.bpm(from)) → \(F.bpm(target)) over \(fmt(bars)) bars: move both pitch faders together (\(dOut) \(pitchText(pa0))→\(pitchText(pa1)), \(dIn) \(pitchText(pb0))→\(pitchText(pb1)))")
                steps.append(Step(time: tempo.real(start), position: at(start), deck: nil, text: text))
            }
        }

        // Where the new track takes over (the time in the track list).
        let sw = Automation.switchTime(clips: clips, index: i, master: master)
        steps.append(Step(time: tempo.real(sw), position: at(sw), deck: dIn,
                          text: L("ここでデッキ\(dIn)の曲に切り替わる（曲リストの時刻）", "Deck \(dIn) takes over here (the time in the track list)")))

        // The outgoing deck is done.
        let outEnd = prev.end(master: master)
        steps.append(Step(time: tempo.real(outEnd), position: pos(prev, dOut, at: outEnd, master: master), deck: dOut,
                          text: L("デッキ\(dOut) STOP、EQ を12時に戻して次の曲を読み込む", "Deck \(dOut) STOP, EQs back to 12 o’clock, load the next track")))
        return steps
    }

    /// The fader / EQ moves of a blend, read off the transition curves: each continuous move becomes one step.
    private static func curveSteps(c: Clip, prev: Clip, dIn: String, dOut: String, start: Double, len: Double,
                                   master: Double, tempo: TempoMap) -> [Step] {
        let barsTotal = max(0.25, len * max(master, 1) / 240)
        let n = max(64, Int(barsTotal * 16))
        struct Move { var x0: Double; var x1: Double; var v0: Double; var v1: Double }
        func moves(_ incoming: Bool, _ k: Control) -> [Move] {
            var vals: [Double] = []
            for s in 0...n {
                let x = Double(s) / Double(n)
                let cv = incoming ? Automation.incomingCurve(c, x) : Automation.outgoingCurve(c, x)
                vals.append(value(cv, k))
            }
            var out: [Move] = []
            var s = 0
            let eps = 1e-5
            let maxPause = max(1, Int(Double(n) / barsTotal / 8))
            while s < n {
                guard abs(vals[s + 1] - vals[s]) > eps else { s += 1; continue }
                let up = vals[s + 1] > vals[s]
                var e = s + 1
                // Follow the move while it keeps going the same way (pauses of up to 1/8 bar are bridged).
                var pause = 0
                var lastMoving = e
                while e < n {
                    let dv = vals[e + 1] - vals[e]
                    if abs(dv) <= eps { pause += 1; if pause > maxPause { break } }
                    else if (dv > 0) == up { pause = 0; lastMoving = e + 1 }
                    else { break }
                    e += 1
                }
                let v0 = vals[s], v1 = vals[lastMoving]
                let total = abs(v1 - v0)
                if total >= 0.05 {
                    // Where the move really happens: from 2 % to 97 % of the way (curves creep in and out).
                    let a = (s...lastMoving).first { abs(vals[$0] - v0) >= 0.02 * total } ?? s
                    let b = (s...lastMoving).first { abs(vals[$0] - v0) >= 0.97 * total } ?? lastMoving
                    out.append(Move(x0: Double(max(s, a - 1)) / Double(n), x1: Double(b) / Double(n), v0: v0, v1: v1))
                }
                s = lastMoving
            }
            return out
        }
        // Gather moves, then put the ones that start together into one step.
        var items: [(x0: Double, deck: String, text: String)] = []
        for (incoming, d) in [(true, dIn), (false, dOut)] {
            for k in Control.allCases {
                for m in moves(incoming, k) {
                    let raw = (m.x1 - m.x0) * barsTotal
                    let bars = raw < 1 ? (raw * 4).rounded() / 4 : (raw * 2).rounded() / 2
                    let how = raw <= 0.3 ? L("一気に", "at once") : L("\(fmt(bars))小節かけて", "over \(fmt(bars)) bars")
                    let text = L("\(k.name) \(level(k, m.v0))→\(level(k, m.v1))（\(how)）", "\(k.name) \(level(k, m.v0)) → \(level(k, m.v1)) (\(how))")
                    items.append((m.x0, d, text))
                }
            }
        }
        var steps: [Step] = []
        let groups = Dictionary(grouping: items) { (($0.x0 * barsTotal) * 4).rounded() / 4 }
        for (barOffset, group) in groups.sorted(by: { $0.key < $1.key }) {
            let t = start + barOffset / barsTotal * len
            let byDeck = Dictionary(grouping: group, by: { $0.deck })
            var parts: [String] = []
            for d in [dIn, dOut] {
                guard let g = byDeck[d] else { continue }
                parts.append(L("デッキ\(d)：", "Deck \(d): ") + g.map { $0.text }.joined(separator: L("、", ", ")))
            }
            steps.append(Step(time: tempo.real(t),
                              position: "\(pos(prev, dOut, at: t, master: master)) / \(pos(c, dIn, at: t, master: master))",
                              deck: nil, text: parts.joined(separator: L("　", "  "))))
        }
        return steps
    }

    // MARK: Effects and edits

    private static func fxSteps(_ c: Clip, deck d: String, master: Double, tempo: TempoMap) -> [Step] {
        guard let fx = c.fx, !fx.isEmpty else { return [] }
        let start = c.start, end = c.end(master: master)
        var steps: [Step] = []
        for f in fx.sorted(by: { $0.bar < $1.bar }) {
            let t = c.timelineTime(bar: f.bar, master: master)
            guard t < end - 0.01, c.timelineTime(bar: f.end, master: master) > start + 0.01 else { continue }
            let amount = Int((f.amount * 100).rounded())
            let shape: String
            switch f.shape {
            case .hold: shape = L("\(amount)% で一定", "steady at \(amount)%")
            case .rise: shape = L("0→\(amount)% へだんだん強く", "build 0 → \(amount)%")
            case .fall: shape = L("\(amount)%→0 へだんだん弱く", "fade \(amount)% → 0")
            case .swell: shape = L("0→\(amount)%→0 と山なりに", "swell 0 → \(amount)% → 0")
            }
            steps.append(Step(time: tempo.real(max(start, t)), position: pos(c, d, at: max(start, t), master: master), deck: d,
                              text: L("デッキ\(d)：\(f.kind.title)（\(f.kind.short)）を \(fmt(f.bars))小節、\(shape)", "Deck \(d): \(f.kind.title) (\(f.kind.short)) for \(fmt(f.bars)) bars, \(shape)")))
        }
        return steps
    }

    private static func editSteps(_ c: Clip, deck d: String, master: Double, tempo: TempoMap) -> [Step] {
        guard let edits = c.edits, !edits.isEmpty else { return [] }
        var steps: [Step] = []
        for e in edits.sorted(by: { $0.bar < $1.bar }) {
            let t = c.timelineTime(source: c.sourceTime(bar: e.bar), master: master)
            guard t >= c.start, t <= c.end(master: master) else { continue }
            let text: String
            switch e.kind {
            case .loop:
                text = L("デッキ\(d)：\(barBeat(e.bar)) から \(e.lengthLabel) ループ ON、\(e.repeats + 1)回まわしたら OFF",
                         "Deck \(d): loop \(e.lengthLabel) from \(barBeat(e.bar)), release after \(e.repeats + 1) passes")
            case .jump:
                text = L("デッキ\(d)：\(barBeat(e.bar)) でホットキューを押して \(barBeat(e.end)) へ", "Deck \(d): at \(barBeat(e.bar)) hit the hot cue for \(barBeat(e.end))")
            }
            steps.append(Step(time: tempo.real(t), position: "\(d) \(barBeat(e.bar))", deck: d, text: text))
        }
        return steps
    }

    // MARK: Text

    static func text(_ g: Guide) -> String {
        var out: [String] = [L("■ 演奏手順", "■ How to play this set"), ""]
        out += g.overview.map { "・" + $0 }
        for t in g.tracks {
            out.append("")
            out.append("\(t.number). [\(L("デッキ", "Deck")) \(t.deck)] \(t.title)")
            out += t.setup.map { "   - " + $0 }
            for s in t.steps {
                out.append("   \(F.time(s.time))  \(s.position)  \(s.isPrep ? L("（準備）", "(prep) ") : "")\(s.text)")
            }
        }
        return out.joined(separator: "\n")
    }
}
