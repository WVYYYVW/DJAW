import AVFoundation

/// AVAudioUnitTimePitch does not play at exactly the rate it is set to (0.97288 plays like ~0.97266), which
/// made a stretched track drift off the beat by a fraction of a millisecond per second. This measures how fast
/// the unit really runs for a given setting — clicks through it offline, fitted over 20 s — and keeps the result.
nonisolated enum StretchCalibration {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var measured: [String: Double] = [:]

    /// The rate the unit really plays at when set to `rate` (source seconds per output second).
    static func effective(_ rate: Float, sampleRate sr: Double) -> Double {
        let key = "\(rate)|\(sr)"
        lock.lock()
        if let v = measured[key] { lock.unlock(); return v }
        lock.unlock()
        let v = measure(rate, sampleRate: sr) ?? Double(rate)
        lock.lock(); measured[key] = v; lock.unlock()
        return v
    }

    private static func measure(_ rate: Float, sampleRate sr: Double) -> Double? {
        guard let fmt = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 1) else { return nil }
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode(), pitch = AVAudioUnitTimePitch()
        guard (try? engine.enableManualRenderingMode(.offline, format: fmt, maximumFrameCount: 4096)) != nil else { return nil }
        engine.attach(player); engine.attach(pitch)
        engine.connect(player, to: pitch, format: fmt)
        engine.connect(pitch, to: engine.mainMixerNode, format: fmt)
        pitch.rate = rate
        // A 4 ms 2 kHz blip every half second, 22 s long.
        let length = Int(sr * 22), period = Int(sr / 2), blip = Int(sr * 0.004)
        guard let input = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(length)),
              let out = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: 4096),
              let d = input.floatChannelData?[0] else { return nil }
        input.frameLength = AVAudioFrameCount(length)
        d.update(repeating: 0, count: length)
        var starts: [Double] = []
        var k = period
        while k + blip < length {
            for i in 0..<blip { d[k + i] = 0.8 * Float(sin(2 * Double.pi * 2000 * Double(i) / sr)) }
            starts.append(Double(k))
            k += period
        }
        guard (try? engine.start()) != nil else { return nil }
        defer { engine.stop() }
        player.scheduleBuffer(input, at: nil)
        player.play()
        var env: [Float] = []
        let total = Int(Double(length) / Double(rate)) + Int(sr)
        env.reserveCapacity(total)
        while env.count < total {
            guard let st = try? engine.renderOffline(1024, to: out), st == .success, let o = out.floatChannelData?[0] else { break }
            for i in 0..<Int(out.frameLength) { env.append(abs(o[i])) }
        }
        // Onsets: first sample above a third of the blip level after a quiet stretch.
        var onsets: [Double] = []
        var i = 0, quiet = 0
        while i < env.count {
            if env[i] > 0.25 {
                if quiet > Int(sr * 0.2) { onsets.append(Double(i)) }
                quiet = 0
            } else {
                quiet += 1
            }
            i += 1
        }
        let n = min(onsets.count, starts.count)
        guard n >= 20, onsets.count == starts.count || abs(onsets.count - starts.count) <= 1 else { return nil }
        // Fit output = a + b · input; the unit plays at 1 / b.
        let xs = Array(starts.prefix(n)), ys = Array(onsets.prefix(n))
        let mx = xs.reduce(0, +) / Double(n), my = ys.reduce(0, +) / Double(n)
        var sxy = 0.0, sxx = 0.0
        for j in 0..<n { sxy += (xs[j] - mx) * (ys[j] - my); sxx += (xs[j] - mx) * (xs[j] - mx) }
        guard sxx > 0 else { return nil }
        let b = sxy / sxx
        let eff = 1 / b
        // Sanity: the measurement must be close to the setting.
        guard abs(eff / Double(rate) - 1) < 0.01 else { return nil }
        #if DEBUG
        print("[DJAW] time-pitch set to \(rate) plays at \(eff) (\(String(format: "%+.1f", (eff / Double(rate) - 1) * 1e6)) ppm)")
        #endif
        return eff
    }

    nonisolated(unsafe) private static var pending: Set<String> = []
    private static let queue = DispatchQueue(label: "DJAW.stretch-calibration", qos: .utility)

    /// Two settings around `rate` and how often to use the upper one so that, on average, the unit plays at `rate`.
    /// - Parameter wait: measure now if needed (offline renders); otherwise only what is known already, and
    ///   the measuring is started in the background (the preview must not stall).
    static func plan(for rate: Double, sampleRate sr: Double, wait: Bool = true) -> (lo: Float, hi: Float, effLo: Double, effHi: Double)? {
        let lo = Float(rate * (1 - 0.0012)), hi = Float(rate * (1 + 0.0012))
        if !wait {
            let kl = "\(lo)|\(sr)", kh = "\(hi)|\(sr)"
            lock.lock()
            let known = measured[kl] != nil && measured[kh] != nil
            let start = !known && !pending.contains(kl)
            if start { pending.insert(kl) }
            lock.unlock()
            if start {
                queue.async {
                    _ = effective(lo, sampleRate: sr)
                    _ = effective(hi, sampleRate: sr)
                    lock.lock(); pending.remove(kl); lock.unlock()
                }
            }
            guard known else { return nil }
        }
        let el = effective(lo, sampleRate: sr), eh = effective(hi, sampleRate: sr)
        guard eh > el, rate >= el, rate <= eh else { return nil }
        return (lo, hi, el, eh)
    }

    /// Measures ahead of time (in the background) what the tracks of a mix will need.
    static func prepare(rates: [(rate: Double, sampleRate: Double)]) {
        for r in rates { _ = plan(for: r.rate, sampleRate: r.sampleRate, wait: false) }
    }
}
