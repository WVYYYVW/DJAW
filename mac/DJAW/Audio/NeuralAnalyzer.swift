import AVFoundation
import Accelerate
import CoreML
import CryptoKit

/// A cue point suggested by CUE-DETR (where pro DJs tend to put cues).
nonisolated struct CueHint: Codable, Sendable, Hashable {
    /// Source seconds.
    var time: Double
    /// 0...1 (relative to the strongest suggestion in the track).
    var score: Double
}

/// Constant-tempo beat grid fitted to the neural beat / downbeat detections.
nonisolated struct NeuralGrid: Codable, Sendable, Hashable {
    var bpm: Double
    /// First downbeat (source seconds, within the first bar).
    var firstBeat: Double
    /// 0...1: how well one steady tempo explains the detected beats (low = tempo changes inside the track).
    var coherence: Double
    /// Share of detected downbeats that agree with the chosen bar line.
    var downbeatConfidence: Double

    var tempoVaries: Bool { coherence < 0.6 }
}

nonisolated struct NeuralResult: Codable, Sendable {
    var version: Int
    var beats: [Double]
    var downbeats: [Double]
    var grid: NeuralGrid?
    var cues: [CueHint]
}

/// On-device neural analysis:
/// - Beat This! (CPJKU, MIT) — beats and downbeats.
/// - CUE-DETR (ETH DISCO, MIT) — cue points learned from professional DJs' rekordbox libraries.
/// Runs once per file and is cached in Application Support.
nonisolated enum NeuralAnalyzer {
    static let version = 2
    private static let lock = NSLock()
    nonisolated(unsafe) private static var beatModel: MLModel?
    nonisolated(unsafe) private static var cueModel: MLModel?
    nonisolated(unsafe) private static var loadedModels = false

    static var isAvailable: Bool {
        Bundle.main.url(forResource: "BeatThis", withExtension: "mlmodelc") != nil
    }

    // MARK: Entry point

    static func analyze(url: URL) -> NeuralResult? {
        let progress = AnalysisProgress.shared
        func skip() { progress.finish(url, .beats, measured: false); progress.finish(url, .cues, measured: false) }
        guard isAvailable else { skip(); return nil }
        let key = cacheKey(url)
        if let key, let cached = readCache(key) { skip(); return cached }
        lock.lock()
        defer { lock.unlock() }
        if let key, let cached = readCache(key) { skip(); return cached }
        loadModels()
        progress.begin(url, .beats)
        guard let y = loadMono(url: url, sampleRate: 22050), y.count > 22050 * 5 else { skip(); return nil }
        var beats: [Double] = [], downbeats: [Double] = []
        if let bt = autoreleasepool(invoking: { beatThis(y, progress: { progress.update(url, .beats, $0) }) }) {
            beats = bt.beats
            downbeats = bt.downbeats
        }
        progress.finish(url, .beats)
        progress.begin(url, .cues)
        var cues = autoreleasepool { cueDETR(y, progress: { progress.update(url, .cues, $0) }) } ?? []
        progress.finish(url, .cues)
        let grid = beats.count >= 16 ? estimateGrid(beats: beats, downbeats: downbeats) : nil
        // Neighbouring windows can report the same cue twice: keep the stronger one within half a bar.
        let minGap = grid.map { 120 / $0.bpm } ?? 1
        var merged: [CueHint] = []
        for c in cues.sorted(by: { $0.time < $1.time }) {
            if let last = merged.last, c.time - last.time < minGap {
                if c.score > last.score { merged[merged.count - 1] = c }
            } else {
                merged.append(c)
            }
        }
        cues = merged
        let result = NeuralResult(version: version, beats: beats, downbeats: downbeats, grid: grid, cues: cues)
        if let key { writeCache(key, result) }
        return result
    }

    private static func loadModels() {
        guard !loadedModels else { return }
        loadedModels = true
        let config = MLModelConfiguration()
        config.computeUnits = .all
        if let u = Bundle.main.url(forResource: "BeatThis", withExtension: "mlmodelc") {
            beatModel = try? MLModel(contentsOf: u, configuration: config)
        }
        if let u = Bundle.main.url(forResource: "CueDETR", withExtension: "mlmodelc") {
            cueModel = try? MLModel(contentsOf: u, configuration: config)
        }
    }

    // MARK: Cache

    private static var cacheFolder: URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let dir = base.appendingPathComponent("DJAW/Analysis", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static func cacheKey(_ url: URL) -> String? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path) else { return nil }
        let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        let mtime = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let text = "\(url.lastPathComponent)|\(size)|\(Int(mtime))|v\(version)"
        return SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func readCache(_ key: String) -> NeuralResult? {
        guard let dir = cacheFolder,
              let data = try? Data(contentsOf: dir.appendingPathComponent(key + ".json")),
              let r = try? JSONDecoder().decode(NeuralResult.self, from: data), r.version == version else { return nil }
        return r
    }

    private static func writeCache(_ key: String, _ r: NeuralResult) {
        guard let dir = cacheFolder, let data = try? JSONEncoder().encode(r) else { return }
        try? data.write(to: dir.appendingPathComponent(key + ".json"), options: .atomic)
    }

    // MARK: Audio

    /// Mono float samples at `sampleRate`.
    static func loadMono(url: URL, sampleRate sr: Double) -> [Float]? {
        guard let file = try? AVAudioFile(forReading: url) else { return nil }
        let inFormat = file.processingFormat
        guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sr, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: inFormat, to: outFormat) else { return nil }
        converter.sampleRateConverterQuality = AVAudioQuality.high.rawValue
        // Downmix like librosa / torchaudio (mean of channels) rather than AVAudioConverter's default.
        if inFormat.channelCount > 1 {
            converter.channelMap = [0]
        }
        let chunk: AVAudioFrameCount = 1 << 16
        guard let inBuf = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: chunk) else { return nil }
        let ratio = sr / inFormat.sampleRate
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: AVAudioFrameCount(Double(chunk) * ratio) + 1024) else { return nil }
        var out: [Float] = []
        out.reserveCapacity(Int(Double(file.length) * ratio) + 1024)
        var done = false
        while true {
            var status = AVAudioConverterOutputStatus.haveData
            outBuf.frameLength = 0
            status = converter.convert(to: outBuf, error: nil) { _, inputStatus in
                if done { inputStatus.pointee = .endOfStream; return nil }
                do {
                    try file.read(into: inBuf, frameCount: chunk)
                } catch {
                    done = true
                    inputStatus.pointee = .endOfStream
                    return nil
                }
                if inBuf.frameLength == 0 { done = true; inputStatus.pointee = .endOfStream; return nil }
                // Average the channels into channel 0 (the converter maps channel 0 to the mono output).
                if let d = inBuf.floatChannelData, inFormat.channelCount > 1 {
                    let n = Int(inBuf.frameLength), ch = Int(inFormat.channelCount)
                    for i in 0..<n {
                        var s: Float = 0
                        for c in 0..<ch { s += d[c][i] }
                        d[0][i] = s / Float(ch)
                    }
                }
                inputStatus.pointee = .haveData
                return inBuf
            }
            if let d = outBuf.floatChannelData, outBuf.frameLength > 0 {
                out.append(contentsOf: UnsafeBufferPointer(start: d[0], count: Int(outBuf.frameLength)))
            }
            if status == .endOfStream || status == .error { break }
            if status == .inputRanDry && done { break }
        }
        return out
    }

    /// |STFT| (or power) frames: periodic Hann window, centred (reflect or zero padding).
    /// Returns frames × (n/2+1), row-major.
    static func stft(_ y: [Float], n: Int, hop: Int, reflect: Bool, power: Bool) -> (frames: Int, bins: Int, data: [Float]) {
        let half = n / 2
        var padded = [Float](repeating: 0, count: y.count + n)
        for i in 0..<y.count { padded[half + i] = y[i] }
        if reflect && y.count > half + 1 {
            for i in 0..<half {
                padded[half - 1 - i] = y[i + 1]
                padded[half + y.count + i] = y[y.count - 2 - i]
            }
        }
        let frames = 1 + (padded.count - n) / hop
        let bins = half + 1
        var out = [Float](repeating: 0, count: frames * bins)
        let log2n = vDSP_Length(log2(Double(n)))
        guard let setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) else { return (0, bins, []) }
        defer { vDSP_destroy_fftsetup(setup) }
        let window = (0..<n).map { Float(0.5 - 0.5 * cos(2 * Double.pi * Double($0) / Double(n))) }
        var frame = [Float](repeating: 0, count: n)
        var re = [Float](repeating: 0, count: half)
        var im = [Float](repeating: 0, count: half)
        padded.withUnsafeBufferPointer { pp in
            for f in 0..<frames {
                vDSP_vmul(pp.baseAddress! + f * hop, 1, window, 1, &frame, 1, vDSP_Length(n))
                re.withUnsafeMutableBufferPointer { rp in
                    im.withUnsafeMutableBufferPointer { ip in
                        var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                        frame.withUnsafeBufferPointer { fp in
                            fp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) {
                                vDSP_ctoz($0, 2, &split, 1, vDSP_Length(half))
                            }
                        }
                        vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                    }
                }
                // vDSP's real FFT is scaled by 2; DC and Nyquist share element 0.
                let o = f * bins
                let dc = re[0] / 2, ny = im[0] / 2
                out[o] = power ? dc * dc : abs(dc)
                out[o + half] = power ? ny * ny : abs(ny)
                for k in 1..<half {
                    let a = re[k] / 2, b = im[k] / 2
                    let p = a * a + b * b
                    out[o + k] = power ? p : sqrt(p)
                }
            }
        }
        return (frames, bins, out)
    }

    private static func resource(_ name: String) -> Data? {
        guard let u = Bundle.main.url(forResource: name, withExtension: nil) else { return nil }
        return try? Data(contentsOf: u)
    }

    private static func floats(_ name: String) -> [Float]? {
        guard let d = resource(name) else { return nil }
        return d.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    }

    // MARK: Beat This!

    static func beatThis(_ y: [Float], progress: ((Double) -> Void)? = nil) -> (beats: [Double], downbeats: [Double])? {
        guard let model = beatModel, let fb = floats("beatthis_fbank_513x128.f32"), fb.count == 513 * 128 else { return nil }
        var spec = stft(y, n: 1024, hop: 441, reflect: true, power: false)
        guard spec.frames > 0 else { return nil }
        // torchaudio "frame_length" normalisation.
        var scale = Float(1 / sqrt(1024.0))
        vDSP_vsmul(spec.data, 1, &scale, &spec.data, 1, vDSP_Length(spec.data.count))
        let N = spec.frames, T = 1500, border = 6
        var starts = Array(stride(from: -border, to: N - border, by: T - 2 * border))
        if N > T - 2 * border, !starts.isEmpty { starts[starts.count - 1] = N - (T - border) }
        var beatL = [Float](repeating: -1000, count: N)
        var downL = [Float](repeating: -1000, count: N)
        guard let input = try? MLMultiArray(shape: [1, NSNumber(value: T), 513], dataType: .float32) else { return nil }
        let ptr = input.dataPointer.bindMemory(to: Float.self, capacity: T * 513)
        // "keep_first": earlier chunks win, so write the chunks back to front.
        var chunkDone = 0
        for s in starts.reversed() {
            progress?(Double(chunkDone) / Double(max(1, starts.count)))
            chunkDone += 1
            ptr.initialize(repeating: 0, count: T * 513)
            for t in 0..<T {
                let src = s + t
                guard src >= 0 && src < N else { continue }
                spec.data.withUnsafeBufferPointer { sp in
                    (ptr + t * 513).update(from: sp.baseAddress! + src * 513, count: 513)
                }
            }
            guard let out = try? model.prediction(from: MLDictionaryFeatureProvider(dictionary: ["mag": MLFeatureValue(multiArray: input)])),
                  let b = out.featureValue(for: "beat")?.multiArrayValue,
                  let d = out.featureValue(for: "downbeat")?.multiArrayValue else { return nil }
            for t in border..<(T - border) {
                let dst = s + t
                guard dst >= 0 && dst < N else { continue }
                beatL[dst] = b[t].floatValue
                downL[dst] = d[t].floatValue
            }
        }
        _ = fb   // the filterbank is inside the model; kept as a resource for reference
        let fps = 50.0
        func peaks(_ l: [Float]) -> [Double] {
            var frames: [Int] = []
            for i in 0..<l.count where l[i] > 0 {
                let lo = max(0, i - 3), hi = min(l.count - 1, i + 3)
                var m = -Float.infinity
                for j in lo...hi where l[j] > m { m = l[j] }
                if l[i] >= m { frames.append(i) }
            }
            // Merge adjacent peak frames into their mean.
            var out: [Double] = []
            var i = 0
            while i < frames.count {
                var j = i
                var sum = Double(frames[i])
                while j + 1 < frames.count && frames[j + 1] - frames[j] <= 1 { j += 1; sum += Double(frames[j]) }
                out.append(sum / Double(j - i + 1) / fps)
                i = j + 1
            }
            return out
        }
        let beats = peaks(beatL)
        var downs = peaks(downL)
        if !beats.isEmpty {
            downs = downs.map { d in beats.min { abs($0 - d) < abs($1 - d) }! }
            downs = Array(Set(downs)).sorted()
        }
        return (beats, downs)
    }

    // MARK: Grid

    private static func fold(_ p: Double, _ lo: Double, _ hi: Double) -> Double {
        var p = p
        while p < lo { p *= 2 }
        while p >= hi { p /= 2 }
        return p
    }

    /// Fits one steady tempo and bar line to the detected beats (robust to half / double-time passages).
    static func estimateGrid(beats b: [Double], downbeats db: [Double], loBPM: Double = 87.5, hiBPM: Double = 180) -> NeuralGrid? {
        let iv = zip(b.dropFirst(), b).map { $0 - $1 }.filter { $0 > 0.12 && $0 < 2 }
        guard iv.count >= 8 else { return nil }
        let lo = 60.0 / 240, hi = 60.0 / 120
        let f = iv.map { fold($0, lo, hi) }
        let binCount = 399
        var hist = [Int](repeating: 0, count: binCount)
        for x in f {
            let k = min(binCount - 1, max(0, Int((x - lo) / (hi - lo) * Double(binCount))))
            hist[k] += 1
        }
        let mode = hist.indices.max { hist[$0] < hist[$1] }!
        let p0 = lo + (Double(mode) + 0.5) * (hi - lo) / Double(binCount)
        func coherence(_ p: Double) -> (Double, Double) {
            var c = 0.0, s = 0.0
            for t in b {
                let a = 2 * Double.pi * t / p
                c += cos(a); s += sin(a)
            }
            let n = Double(b.count)
            return (sqrt(c * c + s * s) / n, atan2(s / n, c / n))
        }
        var best = (coh: 0.0, p: p0, ang: 0.0)
        for k in 0...1200 {
            let p = p0 * (0.97 + 0.06 * Double(k) / 1200)
            let (c, a) = coherence(p)
            if c > best.coh { best = (c, p, a) }
        }
        let pc = best.p
        for k in 0...200 {
            let p = pc * (0.9995 + 0.001 * Double(k) / 200)
            let (c, a) = coherence(p)
            if c > best.coh { best = (c, p, a) }
        }
        let pf = best.p
        let phf = Mathx.posMod(best.ang / (2 * Double.pi) * pf, pf)
        var period = pf
        while 60 / period > hiBPM { period *= 2 }
        while 60 / period < loBPM { period /= 2 }
        func hits(_ ph: Double, _ per: Double, _ pts: [Double], _ tol: Double) -> Int {
            pts.reduce(0) { n, t in
                let r = (t - ph) / per
                return n + (abs(r - r.rounded()) * per < tol ? 1 : 0)
            }
        }
        let m = max(1, Int((period / pf).rounded()))
        let cands = (0..<m).map { Mathx.posMod(phf + Double($0) * pf, period) }
        let ph = cands.max { hits($0, period, b, 0.04) < hits($1, period, b, 0.04) }!
        let bar = 4 * period
        let scores = (0..<4).map { hits(Mathx.posMod(ph + Double($0) * period, bar), bar, db, 0.06) }
        let j = scores.indices.max { scores[$0] < scores[$1] }!
        let total = scores.reduce(0, +)
        return NeuralGrid(bpm: 60 / period, firstBeat: Mathx.posMod(ph + Double(j) * period, bar),
                          coherence: best.coh,
                          downbeatConfidence: total > 0 ? Double(scores[j]) / Double(total) : 0)
    }

    /// A stretch of the track with its own steady tempo (Dariacore / mashups switch tempo between samples).
    struct TempoRegion: Sendable {
        var start: Double
        var end: Double
        var grid: NeuralGrid
    }

    /// Splits the detected beats into steady-tempo stretches and fits a grid to each one.
    static func tempoRegions(beats b: [Double], downbeats db: [Double], minBeats: Int = 24) -> [TempoRegion] {
        guard b.count >= minBeats else { return [] }
        let lo = 60.0 / 240, hi = 60.0 / 120
        let f = zip(b.dropFirst(), b).map { fold(max(0.12, $0 - $1), lo, hi) }
        let n = f.count
        let local: [Double] = (0..<n).map { i in
            let w = f[max(0, i - 4)...min(n - 1, i + 4)].sorted()
            return w[w.count / 2]
        }
        // Group beats while the local period stays within 2.5 % of where the stretch started.
        var groups: [Range<Int>] = []
        var s0 = 0, ref = local[0], off = 0
        for i in 1..<n {
            if abs(local[i] / ref - 1) > 0.025 { off += 1 } else { off = 0 }
            if off >= 3 {
                groups.append(s0..<(i - 2))
                s0 = i - 2; ref = local[i]; off = 0
            }
        }
        groups.append(s0..<n)
        var out: [TempoRegion] = []
        for g in groups where g.count >= minBeats {
            let pts = Array(b[g.lowerBound...g.upperBound])
            let p0 = local[g].sorted()[g.count / 2]
            // Unwrap beat indices on the fast level, then least squares t = a + P·k (two passes, dropping outliers).
            var k = [Double](repeating: 0, count: pts.count)
            for i in 1..<pts.count { k[i] = k[i - 1] + max(1, ((pts[i] - pts[i - 1]) / p0).rounded()) }
            var use = [Bool](repeating: true, count: pts.count)
            var a = pts[0], p = p0
            for _ in 0..<2 {
                let idx = pts.indices.filter { use[$0] }
                guard idx.count >= 8 else { break }
                let mk = idx.reduce(0.0) { $0 + k[$1] } / Double(idx.count)
                let mt = idx.reduce(0.0) { $0 + pts[$1] } / Double(idx.count)
                let sxy = idx.reduce(0.0) { $0 + (k[$1] - mk) * (pts[$1] - mt) }
                let sxx = idx.reduce(0.0) { $0 + (k[$1] - mk) * (k[$1] - mk) }
                guard sxx > 0 else { break }
                p = sxy / sxx; a = mt - p * mk
                for i in pts.indices { use[i] = abs(pts[i] - (a + p * k[i])) < 0.1 * p }
            }
            guard p > 0.2, p < 0.55 else { continue }
            let t0 = pts.first!, t1 = pts.last! + p
            let inDowns = db.filter { $0 >= t0 - 0.05 && $0 <= t1 }
            var period = p
            while 60 / period > 180 { period *= 2 }
            while 60 / period < 87.5 { period /= 2 }
            func hits(_ ph: Double, _ per: Double, _ x: [Double], _ tol: Double) -> Int {
                x.reduce(0) { n, t in
                    let r = (t - ph) / per
                    return n + (abs(r - r.rounded()) * per < tol ? 1 : 0)
                }
            }
            let m = max(1, Int((period / p).rounded()))
            let cands = (0..<m).map { Mathx.posMod(a + Double($0) * p, period) }
            let ph = cands.max { hits($0, period, pts, 0.04) < hits($1, period, pts, 0.04) }!
            let bar = 4 * period
            let scores = (0..<4).map { hits(Mathx.posMod(ph + Double($0) * period, bar), bar, inDowns, 0.06) }
            let j = scores.indices.max { scores[$0] < scores[$1] }!
            let tot = scores.reduce(0, +)
            let fit = Double(hits(a, p, pts, 0.035)) / Double(pts.count)
            // Express the bar line as the first downbeat of the file on this grid (may lie before 0 → wrap).
            let fb = Mathx.posMod(ph + Double(j) * period, bar)
            out.append(TempoRegion(start: t0, end: t1,
                                   grid: NeuralGrid(bpm: 60 / period, firstBeat: fb, coherence: fit,
                                                    downbeatConfidence: tot > 0 ? Double(scores[j]) / Double(tot) : 0)))
        }
        return out
    }

    /// Share of detected beats a grid lands on (compared on the faster metrical level so half / double time counts).
    static func beatHitRate(beats: [Double], bpm: Double, firstBeat: Double) -> Double {
        guard !beats.isEmpty, bpm > 1 else { return 0 }
        let p = fold(60 / bpm, 60.0 / 240, 60.0 / 120)
        let n = beats.filter { t in
            let r = (t - firstBeat) / p
            return abs(r - r.rounded()) * p < 0.035
        }.count
        return Double(n) / Double(beats.count)
    }

    // MARK: CUE-DETR

    static func cueDETR(_ y: [Float], progress: ((Double) -> Void)? = nil) -> [CueHint]? {
        guard let model = cueModel,
              let fb = floats("cuedetr_melfb_128x1025.f32"), fb.count == 128 * 1025,
              let lutData = resource("viridis_256x3.u8"), lutData.count == 768 else { return nil }
        let lut = [UInt8](lutData)
        let spec = stft(y, n: 2048, hop: 512, reflect: false, power: true)
        let F = spec.frames
        guard F > 32 else { return nil }
        // Mel power: (frames × 1025) · (1025 × 128)ᵀ → frames × 128.
        var mel = [Float](repeating: 0, count: F * 128)
        var fbT = [Float](repeating: 0, count: 1025 * 128)
        vDSP_mtrans(fb, 1, &fbT, 1, 1025, 128)
        vDSP_mmul(spec.data, 1, fbT, 1, &mel, 1, vDSP_Length(F), 128, 1025)
        // power_to_db(ref = max), top_db = 80.
        let maxM = max(1e-10, mel.max() ?? 1e-10)
        let ref = 10 * log10(maxM)
        var lo = Float.infinity, hi = -Float.infinity
        for i in 0..<mel.count {
            var v = 10 * log10(max(1e-10, mel[i])) - ref
            v = max(v, -80)
            mel[i] = v
            if v < lo { lo = v }
            if v > hi { hi = v }
        }
        let span = max(hi - lo, 1e-6)
        // Image rows: high frequencies on top (row 0 = mel band 127); viridis colours.
        var img = [UInt8](repeating: 0, count: 128 * F * 3)
        for f in 0..<F {
            for m in 0..<128 {
                let x = (mel[f * 128 + m] - lo) / span
                let k = min(255, max(0, Int(x * 256)))
                let row = 127 - m
                let o = (row * F + f) * 3
                img[o] = lut[k * 3]; img[o + 1] = lut[k * 3 + 1]; img[o + 2] = lut[k * 3 + 2]
            }
        }
        let W = 355, padding = 266
        let step = Double(W) * 0.25
        let nWin = Int(floor(Double(F + padding) / step))
        guard nWin > 0 else { return nil }
        let mean: [Float] = [0.485, 0.456, 0.406], std: [Float] = [0.229, 0.224, 0.225]
        var positions: [(pos: Int, score: Float)] = []
        positions.reserveCapacity(nWin * 100)
        let batch = 8
        var w0 = 0
        while w0 < nWin {
            let w1 = min(nWin, w0 + batch)
            var providers: [MLFeatureProvider] = []
            var borders: [Int] = []
            for i in w0..<w1 {
                let l = Int(floor(Double(i) * step)) - padding
                borders.append(l)
                guard let arr = try? MLMultiArray(shape: [1, 3, 128, NSNumber(value: W)], dataType: .float32) else { return nil }
                let p = arr.dataPointer.bindMemory(to: Float.self, capacity: 3 * 128 * W)
                for row in 0..<128 {
                    // Edge values for the linear-ramp padding.
                    let first = max(0, l), last = min(F - 1, l + W - 1)
                    for c in 0..<3 {
                        let leftEdge = Float(img[(row * F + first) * 3 + c])
                        let rightEdge = Float(img[(row * F + last) * 3 + c])
                        let leftPad = max(0, -l)
                        let inside = min(F, l + W) - max(0, l)
                        for x in 0..<W {
                            var v: Float
                            if x < leftPad {
                                v = floor(leftEdge * Float(x) / Float(leftPad))
                            } else if x < leftPad + inside {
                                v = Float(img[(row * F + (l + x)) * 3 + c])
                            } else {
                                let rightPad = W - leftPad - inside
                                let j = x - leftPad - inside + 1
                                v = floor(rightEdge * Float(rightPad - j) / Float(rightPad))
                            }
                            p[(c * 128 + row) * W + x] = (v / 255 - mean[c]) / std[c]
                        }
                    }
                }
                providers.append(try! MLDictionaryFeatureProvider(dictionary: ["pixel_values": MLFeatureValue(multiArray: arr)]))
            }
            guard let outs = try? model.predictions(fromBatch: MLArrayBatchProvider(array: providers)) else { return nil }
            progress?(Double(w1) / Double(max(1, nWin)))
            for k in 0..<outs.count {
                let o = outs.features(at: k)
                guard let s = o.featureValue(for: "score")?.multiArrayValue,
                      let bx = o.featureValue(for: "boxes")?.multiArrayValue else { continue }
                for q in 0..<100 {
                    let cx = bx[[0, NSNumber(value: q), 0] as [NSNumber]].doubleValue
                    let w = bx[[0, NSNumber(value: q), 2] as [NSNumber]].doubleValue
                    let x0 = (cx - 0.5 * w) * Double(W), x1 = (cx + 0.5 * w) * Double(W)
                    positions.append((Int(floor((x0 + x1) / 2)) + borders[k], s[[0, NSNumber(value: q)] as [NSNumber]].floatValue))
                }
            }
            w0 = w1
        }
        positions.sort { $0.pos != $1.pos ? $0.pos < $1.pos : $0.score < $1.score }
        let smin = positions.map(\.score).min() ?? 0, smax = positions.map(\.score).max() ?? 1
        let sc = positions.map { Double(($0.score - smin) / max(smax - smin, 1e-9)) }
        let peaks = findPeaks(sc, height: 0.9, distance: 16)
        return peaks.map { CueHint(time: Double(positions[$0].pos) * 512 / 22050, score: sc[$0]) }
            .filter { $0.time >= 0 }
    }

    /// scipy.signal.find_peaks(x, height:, distance:) for the parts CUE-DETR uses.
    static func findPeaks(_ x: [Double], height: Double, distance: Int) -> [Int] {
        var peaks: [Int] = []
        var i = 1
        while i < x.count - 1 {
            if x[i - 1] < x[i] {
                var ahead = i + 1
                while ahead < x.count - 1 && x[ahead] == x[i] { ahead += 1 }
                if x[ahead] < x[i] {
                    peaks.append((i + ahead - 1) / 2)
                    i = ahead
                }
            }
            i += 1
        }
        peaks = peaks.filter { x[$0] >= height }
        guard distance > 1, peaks.count > 1 else { return peaks }
        var keep = [Bool](repeating: true, count: peaks.count)
        let order = peaks.indices.sorted { x[peaks[$0]] < x[peaks[$1]] || (x[peaks[$0]] == x[peaks[$1]] && $0 < $1) }
        for idx in order.reversed() where keep[idx] {
            var k = idx - 1
            while k >= 0 && peaks[idx] - peaks[k] < distance { keep[k] = false; k -= 1 }
            k = idx + 1
            while k < peaks.count && peaks[k] - peaks[idx] < distance { keep[k] = false; k += 1 }
        }
        return peaks.indices.filter { keep[$0] }.map { peaks[$0] }
    }
}
