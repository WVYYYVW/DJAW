import AVFoundation

/// Loudness as in ITU-R BS.1770-4 / EBU R128 (LUFS): K-weighted, 400 ms blocks, absolute (−70 LUFS) and
/// relative (−10 LU) gates.
///
/// Per file, the K-weighted power of every 100 ms is measured once and kept (Application Support), so the
/// loudness of any stretch of a track — the part a mix actually plays — is computed instantly.
nonisolated enum LoudnessAnalyzer {
    static let version = 1
    /// Seconds per stored step.
    static let step = 0.1

    /// K-weighted mean-square power (summed over the channels) of every 100 ms of the file.
    static func segments(url: URL) -> [Float]? {
        let key = AnalysisCache.fingerprint(url)
        if let key, let cached = readCache(key) { return cached }
        guard let file = try? AVAudioFile(forReading: url) else { return nil }
        let fmt = file.processingFormat
        let sr = fmt.sampleRate, chs = Int(fmt.channelCount)
        guard chs > 0, let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: 1 << 16) else { return nil }
        let k = KWeighting(sampleRate: sr, channels: chs)
        let segFrames = Int((sr * step).rounded())
        var out: [Float] = []
        var acc = 0.0, inSeg = 0
        while true {
            guard (try? file.read(into: buf, frameCount: buf.frameCapacity)) != nil, buf.frameLength > 0,
                  let d = buf.floatChannelData else { break }
            let n = Int(buf.frameLength)
            var i = 0
            while i < n {
                let take = min(n - i, segFrames - inSeg)
                for c in 0..<chs { acc += k.process(channel: c, d[c] + i, count: take) }
                inSeg += take
                i += take
                if inSeg == segFrames {
                    out.append(Float(acc / Double(segFrames)))
                    acc = 0
                    inSeg = 0
                }
            }
        }
        if inSeg > segFrames / 2 { out.append(Float(acc / Double(inSeg))) }
        if let key { writeCache(key, out) }
        return out
    }

    /// Integrated loudness (LUFS) between two source times (nil = too short or silent).
    static func integrated(_ seg: [Float], from a: Double = 0, to b: Double? = nil) -> Double? {
        let i0 = max(0, Int((a / step).rounded())), i1 = min(seg.count, Int(((b ?? Double(seg.count) * step) / step).rounded()))
        guard i1 - i0 >= 4 else { return nil }
        // 400 ms blocks, 75 % overlap.
        var blocks: [Double] = []
        blocks.reserveCapacity(i1 - i0)
        for j in i0...(i1 - 4) {
            blocks.append(Double(seg[j] + seg[j + 1] + seg[j + 2] + seg[j + 3]) / 4)
        }
        func lufs(_ z: Double) -> Double { -0.691 + 10 * log10(max(z, 1e-12)) }
        let abs = blocks.filter { lufs($0) > -70 }
        guard !abs.isEmpty else { return nil }
        let rel = lufs(abs.reduce(0, +) / Double(abs.count)) - 10
        let gated = abs.filter { lufs($0) > rel }
        guard !gated.isEmpty else { return nil }
        return lufs(gated.reduce(0, +) / Double(gated.count))
    }

    // MARK: K-weighting (pre-filter high shelf + RLB high-pass, coefficients for any sample rate)

    private final class KWeighting {
        private struct Biquad { var b0, b1, b2, a1, a2: Double }
        private let shelf: Biquad, hp: Biquad
        private var z: [[Double]]   // per channel: shelf z1, z2, hp z1, z2

        init(sampleRate fs: Double, channels: Int) {
            // Stage 1: high shelf (+4 dB above ~1.7 kHz).
            do {
                let g = 3.99984385397, q = 0.7071752369554193, fc = 1681.9744509555319
                let a = pow(10, g / 40), w0 = 2 * Double.pi * fc / fs, alpha = sin(w0) / (2 * q), cw = cos(w0), sa = 2 * sqrt(a) * alpha
                let a0 = (a + 1) - (a - 1) * cw + sa
                shelf = Biquad(b0: a * ((a + 1) + (a - 1) * cw + sa) / a0, b1: -2 * a * ((a - 1) + (a + 1) * cw) / a0,
                               b2: a * ((a + 1) + (a - 1) * cw - sa) / a0, a1: 2 * ((a - 1) - (a + 1) * cw) / a0,
                               a2: ((a + 1) - (a - 1) * cw - sa) / a0)
            }
            // Stage 2: high-pass (~38 Hz).
            do {
                let q = 0.5003270373253953, fc = 38.13547087613982
                let w0 = 2 * Double.pi * fc / fs, alpha = sin(w0) / (2 * q), cw = cos(w0)
                let a0 = 1 + alpha
                hp = Biquad(b0: (1 + cw) / 2 / a0, b1: -(1 + cw) / a0, b2: (1 + cw) / 2 / a0, a1: -2 * cw / a0, a2: (1 - alpha) / a0)
            }
            z = Array(repeating: [0, 0, 0, 0], count: channels)
        }

        /// Filters `count` samples of one channel and returns the sum of squares of the result.
        func process(channel c: Int, _ x: UnsafeMutablePointer<Float>, count: Int) -> Double {
            var s1 = z[c][0], s2 = z[c][1], h1 = z[c][2], h2 = z[c][3]
            let p = shelf, q = hp
            var sum = 0.0
            for i in 0..<count {
                let v = Double(x[i])
                let y1 = p.b0 * v + s1
                s1 = p.b1 * v - p.a1 * y1 + s2
                s2 = p.b2 * v - p.a2 * y1
                let y2 = q.b0 * y1 + h1
                h1 = q.b1 * y1 - q.a1 * y2 + h2
                h2 = q.b2 * y1 - q.a2 * y2
                sum += y2 * y2
            }
            z[c] = [s1, s2, h1, h2]
            return sum
        }
    }

    // MARK: Cache

    private static func cacheURL(_ key: String) -> URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let dir = base.appendingPathComponent("DJAW/Analysis", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("\(key).loud\(version)")
    }

    private static func readCache(_ key: String) -> [Float]? {
        guard let u = cacheURL(key), let d = try? Data(contentsOf: u), d.count % 4 == 0, !d.isEmpty else { return nil }
        var out = [Float](repeating: 0, count: d.count / 4)
        _ = out.withUnsafeMutableBytes { d.copyBytes(to: $0) }
        return out
    }

    private static func writeCache(_ key: String, _ v: [Float]) {
        guard let u = cacheURL(key) else { return }
        let d = v.withUnsafeBufferPointer { Data(buffer: $0) }
        try? d.write(to: u, options: .atomic)
    }
}
