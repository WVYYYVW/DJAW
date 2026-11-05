import AVFoundation
import Accelerate

/// Renders one planned transition (a few bars around it, only the two tracks involved) and listens for
/// what makes an automatic transition sound wrong: a hole in the level, a level bump, two low ends
/// piling up, or kicks that flam because the beat grids disagree.
nonisolated enum TransitionCheck {
    struct Result: Sendable {
        var problems: [String]
        var ok: Bool { problems.isEmpty }
    }

    static let sampleRate = 22050.0

    /// Checks the transition into clip `i`. nil = could not render.
    static func check(clips: [Clip], index i: Int, master: Double, tempo: TempoMap, gridOffset: Double) -> Result? {
        guard i > 0, i < clips.count else { return nil }
        let a = clips[i - 1], b = clips[i]
        let o0 = b.timelineTime(bar: b.mixInBar, master: master)
        let o1 = max(o0, a.end(master: master))
        let bar = 240 / master
        let cut = o1 - o0 < 0.25 * bar
        let t0 = max(0, o0 - 4 * bar), t1 = min(b.end(master: master), o1 + 4 * bar)
        guard t1 - t0 > 2 * bar, let y = render(clips: clips, indices: [i - 1, i], master: master, tempo: tempo, gridOffset: gridOffset,
                                                 from: t0, to: t1) else { return nil }
        let r0 = tempo.real(t0)
        func rs(_ t: Double) -> Double { tempo.real(t) - r0 }   // reference time -> seconds into the render
        // Overlap region; a cut is judged on the beats around the switch.
        let beat = 60 / master
        let ov0 = cut ? rs(o0 - beat) : rs(o0), ov1 = cut ? rs(o0 + 2 * beat) : rs(o1)
        let pre = (0.0, max(0, rs(o0) - 0.1)), post = (rs(o1) + 0.1, Double(y.count) / sampleRate)
        var problems: [String] = []
        // Each track on its own, as it sounds outside the transition (no fades / EQ moves): what the blend is measured against.
        let soloA = Automation.state(clips: clips, index: i - 1, time: max(a.start, o0 - bar), master: master)
        let soloB = Automation.state(clips: clips, index: i, time: min(b.end(master: master) - 0.01, o1 + bar), master: master)
        let ya = render(clips: clips, indices: [i - 1], master: master, tempo: tempo, gridOffset: gridOffset, from: t0, to: t1, fixed: [i - 1: soloA])
        let yb = render(clips: clips, indices: [i], master: master, tempo: tempo, gridOffset: gridOffset, from: t0, to: t1, fixed: [i: soloB])

        // Short-term level (full band and below ~150 Hz), 0.4 s windows every 46 ms.
        let hop = 1024
        let full = levels(y, hop: hop, window: 8)
        let low = levels(lowpass(y, cutoff: 150), hop: hop, window: 8)
        let fps = sampleRate / Double(hop)
        func frames(_ r: (Double, Double)) -> Range<Int> {
            let a = max(0, Int(r.0 * fps)), b = min(full.count, Int(r.1 * fps))
            return a..<max(a, b)
        }
        let ovR = frames((ov0, ov1))
        let beatFrames = max(1, Int(60 / tempo.bpm(at: o0) * fps))
        // Longest run (in frames) of `cond` inside the overlap.
        func longestRun(_ cond: (Int) -> Bool) -> Int {
            var best = 0, cur = 0
            for f in ovR { if cond(f) { cur += 1; best = max(best, cur) } else { cur = 0 } }
            return best
        }
        if !ovR.isEmpty, let ya, let yb {
            let fa = levels(ya, hop: hop, window: 8), fb = levels(yb, hop: hop, window: 8)
            let la = levels(lowpass(ya, cutoff: 150), hop: hop, window: 8), lb = levels(lowpass(yb, cutoff: 150), hop: hop, window: 8)
            func at(_ x: [Float], _ f: Int) -> Float { f < x.count ? x[f] : -120 }
            let expect = { (f: Int) -> Float in max(at(fa, f), at(fb, f)) }
            let expectLow = { (f: Int) -> Float in max(at(la, f), at(lb, f)) }
            if !cut && longestRun({ expect($0) > -50 && full[$0] < expect($0) - 9 }) >= 2 * beatFrames {
                let d = Int((ovR.map { expect($0) - full[$0] }.max() ?? 9).rounded())
                problems.append(L("つなぎの途中で音が痩せる（最大 \(d) dB 下がる）", "The level drops during the blend (up to \(d) dB)"))
            }
            if longestRun({ full[$0] > expect($0) + 4.5 }) >= beatFrames {
                let d = Int((ovR.map { full[$0] - expect($0) }.max() ?? 4.5).rounded())
                problems.append(L("重なっている間に音量が膨らむ（+\(d) dB）", "The level swells while both play (+\(d) dB)"))
            }
            if longestRun({ expectLow($0) > -50 && low[$0] > expectLow($0) + 3.5 }) >= 2 * beatFrames {
                problems.append(L("低音が重なって濁る", "The low end piles up (muddy bass)"))
            }
        }

        // Flams: a second kick 25–110 ms after the first on many beats means the grids disagree.
        if !cut {
            let flux = onsetFlux(y)
            let ffps = sampleRate / 128
            var beatTimes: [Double] = []
            var tb = gridOffset + ceil((t0 - gridOffset) / beat) * beat
            while tb < t1 { beatTimes.append(rs(tb)); tb += beat }
            func flamRate(_ r: (Double, Double)) -> Double? {
                let bs = beatTimes.filter { $0 >= r.0 + 0.15 && $0 <= r.1 - 0.15 }
                guard bs.count >= 4 else { return nil }
                var flams = 0
                for t in bs {
                    let c = Int(t * ffps), w = Int(0.12 * ffps)
                    guard c - w >= 0, c + w < flux.count else { continue }
                    let seg = Array(flux[(c - w)...(c + w)])
                    guard let p1 = seg.indices.max(by: { seg[$0] < seg[$1] }), seg[p1] > 0 else { continue }
                    let d0 = Int(0.025 * ffps), d1 = Int(0.11 * ffps)
                    let side = seg.indices.filter { abs($0 - p1) >= d0 && abs($0 - p1) <= d1 }
                    if let p2 = side.max(by: { seg[$0] < seg[$1] }), seg[p2] >= 0.5 * seg[p1],
                       // a real second peak, not the slope of the first one
                       seg[p2] > seg[max(0, min(seg.count - 1, (p1 + p2) / 2))] * 1.1 {
                        flams += 1
                    }
                }
                return Double(flams) / Double(bs.count)
            }
            if let fo = flamRate((ov0, ov1)) {
                let base = max(flamRate(pre) ?? 0, flamRate(post) ?? 0)
                if fo > 0.4 && fo - base > 0.3 {
                    problems.append(L("重なっている間、キックが二重に聞こえる（拍のずれ）", "Kicks flam during the blend (beats out of line)"))
                }
            }
        }
        return Result(problems: problems)
    }

    // MARK: Rendering

    /// Mono render of the given clips between two timeline times (reference seconds).
    static func render(clips: [Clip], indices: [Int], master: Double, tempo: TempoMap, gridOffset: Double,
                       from t0: Double, to t1: Double, fixed: [Int: Automation.State] = [:]) -> [Float]? {
        let use = indices.filter { $0 >= 0 && $0 < clips.count && clips[$0].start < t1 && clips[$0].end(master: master) > t0 }
        guard !use.isEmpty,
              let session = try? MixRenderSession(clips: clips, indices: use, master: master, tempo: tempo, gridOffset: gridOffset,
                                                  sampleRate: sampleRate, from: t0, fixed: fixed) else { return nil }
        defer { session.stop() }
        let total = Int(((tempo.real(t1) - tempo.real(t0)) * sampleRate).rounded())
        var out = [Float](); out.reserveCapacity(total + 512)
        while out.count < total {
            guard let buffer = try? session.renderNext(), let d = buffer.floatChannelData else { return nil }
            let n = Int(buffer.frameLength), ch = Int(buffer.format.channelCount)
            for s in 0..<n {
                var x: Float = 0
                for c in 0..<ch { x += d[c][s] }
                out.append(x / Float(ch))
            }
        }
        if out.count > total { out.removeLast(out.count - total) }
        return out
    }

    // MARK: Signal helpers

    /// dB level per hop, averaged over `window` hops.
    private static func levels(_ y: [Float], hop: Int, window: Int) -> [Float] {
        let n = y.count / hop
        guard n > 0 else { return [] }
        var ms = [Float](repeating: 0, count: n)
        y.withUnsafeBufferPointer { p in
            for k in 0..<n { vDSP_measqv(p.baseAddress! + k * hop, 1, &ms[k], vDSP_Length(hop)) }
        }
        var out = [Float](repeating: -120, count: n)
        for k in 0..<n {
            let lo = max(0, k - window / 2), hi = min(n, k + window / 2 + 1)
            var s: Float = 0
            for j in lo..<hi { s += ms[j] }
            out[k] = 10 * log10(max(1e-12, s / Float(hi - lo)))
        }
        return out
    }

    /// 2nd-order Butterworth low-pass.
    private static func lowpass(_ x: [Float], cutoff: Double) -> [Float] {
        let w = tan(Double.pi * cutoff / sampleRate), q = 1 / sqrt(2.0)
        let n = 1 / (1 + w / q + w * w)
        let b0 = Float(w * w * n), b1 = 2 * b0, b2 = b0
        let a1 = Float(2 * (w * w - 1) * n), a2 = Float((1 - w / q + w * w) * n)
        var y = [Float](repeating: 0, count: x.count)
        var x1: Float = 0, x2: Float = 0, y1: Float = 0, y2: Float = 0
        for i in 0..<x.count {
            let v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            x2 = x1; x1 = x[i]; y2 = y1; y1 = v
            y[i] = v
        }
        return y
    }

    /// Positive spectral flux (1024-point frames every 128 samples).
    private static func onsetFlux(_ y: [Float]) -> [Float] {
        let spec = NeuralAnalyzer.stft(y, n: 1024, hop: 128, reflect: false, power: false)
        guard spec.frames > 1 else { return [] }
        var out = [Float](repeating: 0, count: spec.frames)
        for f in 1..<spec.frames {
            var s: Float = 0
            for k in 2..<spec.bins {
                let d = log1p(spec.data[f * spec.bins + k] * 100) - log1p(spec.data[(f - 1) * spec.bins + k] * 100)
                if d > 0 { s += d }
            }
            out[f] = s
        }
        return out
    }
}
