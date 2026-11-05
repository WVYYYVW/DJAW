import Foundation

/// Computes per-clip volume and EQ at a given timeline time.
/// Shared by the realtime preview and the offline renderer so both sound identical.
nonisolated enum Automation {
    struct State: Sendable {
        /// Final linear volume (gain × envelope).
        var volume: Float
        /// Envelope only (0...1), without the clip gain. Used for drawing.
        var envelope: Double
        var low: Float
        var mid: Float
        var high: Float
        var lowKilled: Bool
        /// Input level into the echo unit (1 = normal, 0 = stop feeding).
        var send: Float
        /// Echo wet/dry mix 0...100.
        var echoWet: Float
        /// Effect regions active now.
        var fx = FXState()
        /// Stem levels (1 = as is). Only heard when the track plays from its separated stems.
        var vocal: Float = 1
        var instrumental: Float = 1
    }

    struct Curve: Sendable {
        var volume: Double
        var lowKill: Double
        var midKill: Double
        var highKill: Double = 0
        var echo: Double = 0
        // Effect / stem lanes (hand-drawn transitions only).
        /// −1 low-pass … 0 off … +1 high-pass.
        var filter: Double = 0
        var fxEcho: Double = 0
        var fxReverb: Double = 0
        var vocal: Double = 1
        var instrumental: Double = 1
    }

    private static func laneCurve(_ lanes: TransitionLanes, incoming: Bool, _ x: Double) -> Curve {
        Curve(volume: lanes.value(.volume, incoming: incoming, at: x),
              lowKill: 1 - lanes.value(.low, incoming: incoming, at: x),
              midKill: 1 - lanes.value(.mid, incoming: incoming, at: x),
              highKill: 1 - lanes.value(.high, incoming: incoming, at: x),
              filter: (lanes.value(.filter, incoming: incoming, at: x) - 0.5) * 2,
              fxEcho: lanes.value(.echo, incoming: incoming, at: x),
              fxReverb: lanes.value(.reverb, incoming: incoming, at: x),
              vocal: lanes.value(.vocal, incoming: incoming, at: x),
              instrumental: lanes.value(.instrumental, incoming: incoming, at: x))
    }

    /// Kill amount (0 = band open, 1 = band cut) for one band.
    private static func bandKill(_ band: BandSwap, _ x: Double, incoming: Bool) -> Double {
        guard band.enabled else { return 0 }
        if incoming && !band.affectsIncoming { return 0 }
        let progress: Double
        if band.ramp < 0.002 {
            progress = x < band.point ? 0 : 1
        } else {
            progress = band.curve.rise((x - band.point) / band.ramp)
        }
        // Incoming: cut until the hand-over, then opens. Outgoing: open, then cut.
        return incoming ? 1 - progress : progress
    }

    static let killDB: Double = -40

    /// Curve for the clip that comes in. x = 0...1 progress through the overlap.
    static func incoming(_ style: TransitionStyle, _ shape: TransitionShape, _ x: Double) -> Curve {
        let x = Mathx.clamp01(x)
        switch style {
        case .crossfade, .bassSwap, .filter:
            let v = shape.volumeCurve.rise(x / max(shape.inRise, 0.001))
            return Curve(volume: v,
                         lowKill: bandKill(shape.low, x, incoming: true),
                         midKill: bandKill(shape.mid, x, incoming: true),
                         highKill: bandKill(shape.high, x, incoming: true))
        case .echoOut:
            return Curve(volume: Mathx.clamp01(x / 0.02), lowKill: 0, midKill: 0)
        case .cut, .brake, .backspin:
            // Fully open from the first sample: the click-free 3 ms fade-in is baked into the scheduled audio
            // (ClipSchedule), so the switch does not wait for the next automation tick.
            return Curve(volume: 1, lowKill: 0, midKill: 0)
        case .custom:
            return Curve(volume: sin(.pi / 2 * x), lowKill: 0, midKill: 0)
        }
    }

    /// Curve for clip `c` coming in, honouring hand-drawn lanes.
    static func incomingCurve(_ c: Clip, _ x: Double) -> Curve {
        let x = Mathx.clamp01(x)
        if c.transition == .custom, let lanes = c.lanes {
            return laneCurve(lanes, incoming: true, x)
        }
        return incoming(c.transition, c.transitionShape, x)
    }

    /// Curve for the clip going out while `next` comes in, honouring hand-drawn lanes.
    static func outgoingCurve(_ next: Clip, _ x: Double) -> Curve {
        let x = Mathx.clamp01(x)
        if next.transition == .custom, let lanes = next.lanes {
            return laneCurve(lanes, incoming: false, x)
        }
        return outgoing(next.transition, next.transitionShape, x)
    }

    /// Curve for the clip that goes out. x = 0...1 progress through the overlap.
    static func outgoing(_ style: TransitionStyle, _ shape: TransitionShape, _ x: Double) -> Curve {
        let x = Mathx.clamp01(x)
        switch style {
        case .crossfade, .bassSwap, .filter:
            let span = max(1 - shape.outFadeStart, 0.001)
            let v = x <= shape.outFadeStart ? 1 : shape.volumeCurve.fall((x - shape.outFadeStart) / span)
            return Curve(volume: v,
                         lowKill: bandKill(shape.low, x, incoming: false),
                         midKill: bandKill(shape.mid, x, incoming: false),
                         highKill: bandKill(shape.high, x, incoming: false))
        case .echoOut:
            // Dry signal stops at the mix-out point, only the echo tail remains and decays.
            return Curve(volume: x <= 0 ? 1 : cos(.pi / 2 * x), lowKill: 0, midKill: 0, echo: x > 0 ? 1 : 0)
        case .cut:
            // The outgoing audio itself ends at the cut with a 5 ms fade (ClipSchedule), sample-accurately.
            return Curve(volume: 1, lowKill: 0, midKill: 0)
        case .brake, .backspin:
            return Curve(volume: 1 - Mathx.clamp01((x - 0.5) / 0.004), lowKill: 0, midKill: 0)
        case .custom:
            return Curve(volume: cos(.pi / 2 * x), lowKill: 0, midKill: 0)
        }
    }

    /// Where, in the transition into `c` (0…1 of the overlap), the new track takes over: the first moment from
    /// which it is louder than the outgoing one, judged from the transition's own curves (what you drew in the
    /// transition editor, or the preset) — fader, EQ (the low end counts most, like on a club system) and stems.
    static func switchPoint(into c: Clip) -> Double {
        switch c.transition {
        case .cut, .brake, .backspin, .echoOut: return 0
        default: break
        }
        func weight(_ cv: Curve) -> Double {
            let bands = 0.5 * (1 - cv.lowKill) + 0.3 * (1 - cv.midKill) + 0.2 * (1 - cv.highKill)
            let stems = 0.5 * cv.vocal + 0.5 * cv.instrumental
            return cv.volume * cv.volume * bands * stems
        }
        let n = 256
        var lastBehind = -1
        for k in 0...n {
            let x = Double(k) / Double(n)
            if weight(incomingCurve(c, x)) < weight(outgoingCurve(c, x)) { lastBehind = k }
        }
        return min(1, Double(lastBehind + 1) / Double(n))
    }

    /// Timeline time at which clip `i` takes over from the track before it (its start for the first track).
    static func switchTime(clips: [Clip], index i: Int, master: Double) -> Double {
        let c = clips[i]
        guard i > 0 else { return c.start }
        let prev = clips[i - 1]
        let len = min(prev.end(master: master), c.end(master: master)) - c.start
        guard len > 0.001 else { return c.start }
        return c.start + switchPoint(into: c) * len
    }

    /// `clips` must be sorted by start time.
    static func state(clips: [Clip], index i: Int, time t: Double, master: Double) -> State {
        let c = clips[i]
        let start = c.start
        let end = c.end(master: master)
        var env = 1.0
        var lowK = 0.0
        var midK = 0.0
        var highK = 0.0
        var send = 1.0
        var wet = 0.0
        // Effect / stem lanes of the transitions in and out.
        var laneFilter = 0.0, laneEcho = 0.0, laneReverb = 0.0
        var vocal = 1.0, instrumental = 1.0
        func take(_ cv: Curve) {
            if abs(cv.filter) > abs(laneFilter) { laneFilter = cv.filter }
            laneEcho = max(laneEcho, cv.fxEcho)
            laneReverb = max(laneReverb, cv.fxReverb)
            vocal *= cv.vocal
            instrumental *= cv.instrumental
        }

        if t < start || t > end { env = 0 }

        let beat = 60 / max(master, 1)
        let fadeIn = c.fadeInBeats * beat
        let fadeOut = c.fadeOutBeats * beat
        if fadeIn > 0, t < start + fadeIn {
            env *= sin(.pi / 2 * Mathx.clamp01((t - start) / fadeIn))
        }
        if fadeOut > 0, t > end - fadeOut {
            env *= sin(.pi / 2 * Mathx.clamp01((end - t) / fadeOut))
        }

        // Incoming transition (overlap with previous clip)
        if i > 0 {
            let prev = clips[i - 1]
            let len = min(prev.end(master: master), end) - start
            if len > 0.001 {
                let x = (t - start) / len
                let curve = incomingCurve(c, x)
                // Effect and stem lanes act only during the transition (as drawn in the editor); outside it the
                // track plays normally. (Fader / EQ keep their end positions, like knobs left where they were.)
                if x >= 0 && x <= 1 { take(curve) }
                env *= curve.volume
                lowK = max(lowK, curve.lowKill)
                midK = max(midK, curve.midKill)
                highK = max(highK, curve.highKill)
            }
        }

        // Outgoing transition (overlap with next clip)
        if i + 1 < clips.count {
            let next = clips[i + 1]
            let len = min(end, next.end(master: master)) - next.start
            if len > 0.001 {
                let x = (t - next.start) / len
                let curve = outgoingCurve(next, x)
                if x >= 0 && x <= 1 { take(curve) }
                env *= curve.volume
                lowK = max(lowK, curve.lowKill)
                midK = max(midK, curve.midKill)
                highK = max(highK, curve.highKill)
                if curve.echo > 0 {
                    wet = 100
                    // Keep feeding the echo for one beat after the mix-out point, then let it ring.
                    send = t - next.start < beat ? 1 : 0
                }
            }
        }

        var fx = FXState()
        if c.fx?.isEmpty == false, env > 0 {
            fx = FXState.at(c, bar: c.bar(atTimeline: t, master: master))
        }
        // Drawn effect lanes add to the effect regions (the stronger one wins).
        if abs(laneFilter) > 0.002, abs(Float(laneFilter)) > abs(fx.filter) { fx.filter = Float(laneFilter) }
        if laneEcho > 0.002, Float(laneEcho) > fx.echo { fx.echo = Float(laneEcho) }
        if laneReverb > 0.002 { fx.reverb = max(fx.reverb, Float(laneReverb)) }

        let gain = pow(10, (c.gainDB + (c.loudnessGainDB ?? 0)) / 20)
        let lowDB = c.eqLow + (killDB - c.eqLow) * lowK
        let midDB = c.eqMid + (killDB * 0.6 - c.eqMid) * midK
        let highDB = c.eqHigh + (killDB - c.eqHigh) * highK
        return State(volume: Float(gain * env),
                     envelope: env,
                     low: Float(lowDB),
                     mid: Float(midDB),
                     high: Float(highDB),
                     lowKilled: lowK > 0.5,
                     send: Float(send),
                     echoWet: Float(wet),
                     fx: fx,
                     vocal: Float(vocal),
                     instrumental: Float(instrumental))
    }
}
