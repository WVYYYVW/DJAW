import Foundation
import AVFoundation
import CoreML
import Accelerate

/// Splits a track into its vocals and everything else ("instrumental"), once, so a transition can turn either
/// down (vocal cut / a cappella). Uses Deezer's Spleeter 2-stems network (MIT License), converted to Core ML
/// (ML/VocalSplit.mlpackage): it estimates a vocal mask on a 4096-point spectrogram; the vocals are the masked
/// spectrum and the instrumental is the track minus the vocals, so both together give back the original exactly.
///
/// Stems are kept in ~/Library/Application Support/DJAW/Stems/<fingerprint>.vocals.caf / .inst.caf.
nonisolated enum StemSeparator {
    static let version = 1
    private static let n = 4096, hop = 1024, bins = 1024, block = 512

    private static var folder: URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let dir = base.appendingPathComponent("DJAW/Stems", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static var isAvailable: Bool { Bundle.main.url(forResource: "VocalSplit", withExtension: "mlmodelc") != nil }

    private static func files(_ url: URL) -> (vocals: URL, instrumental: URL)? {
        guard let key = AnalysisCache.fingerprint(url), let dir = folder else { return nil }
        return (dir.appendingPathComponent("\(key).v\(version).vocals.caf"), dir.appendingPathComponent("\(key).v\(version).inst.caf"))
    }

    /// The separated stems of a track, if they exist.
    static func stems(for url: URL) -> (vocals: URL, instrumental: URL)? {
        guard let f = files(url) else { return nil }
        let fm = FileManager.default
        return fm.fileExists(atPath: f.vocals.path) && fm.fileExists(atPath: f.instrumental.path) ? f : nil
    }

    /// Forgets a track's stems (they are made again when needed).
    static func removeStems(for url: URL) {
        guard let f = files(url) else { return }
        try? FileManager.default.removeItem(at: f.vocals)
        try? FileManager.default.removeItem(at: f.instrumental)
    }

    /// Figures from the last separation (for checking): mean vocal mask, and the vocals' / instrumental's level
    /// relative to the track (dB).
    nonisolated(unsafe) static var lastStats: [String: Double] = [:]

    private static let lock = NSLock()
    nonisolated(unsafe) private static var model: MLModel?

    private static func loadModel() throws -> MLModel {
        lock.lock(); defer { lock.unlock() }
        if let model { return model }
        guard let u = Bundle.main.url(forResource: "VocalSplit", withExtension: "mlmodelc") else {
            throw OfflineRenderer.RenderError.engine(L("ボーカル分離のモデルがありません", "The vocal separation model is missing"))
        }
        let config = MLModelConfiguration()
        config.computeUnits = .all
        let m = try MLModel(contentsOf: u, configuration: config)
        model = m
        return m
    }

    /// Separates a track (if not done yet). Returns the stem files.
    @discardableResult
    static func separate(_ url: URL, cancel: CancelFlag? = nil, progress: ((Double) -> Void)? = nil) throws -> (vocals: URL, instrumental: URL) {
        if let done = stems(for: url) { return done }
        guard let out = files(url) else { throw OfflineRenderer.RenderError.engine(L("曲を読めません", "Cannot read the track")) }
        let model = try loadModel()
        let file = try AVAudioFile(forReading: url)
        let fmt = file.processingFormat
        let frames = Int(file.length)
        guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(frames)) else {
            throw OfflineRenderer.RenderError.engine(L("曲を読めません", "Cannot read the track"))
        }
        try file.read(into: buf)
        guard let src = buf.floatChannelData else { throw OfflineRenderer.RenderError.engine("read") }
        let chs = Int(fmt.channelCount)
        // Two channels (mono is used for both), padded with one frame of silence at the start and end.
        let padded = frames + 2 * n
        var x = [[Float]](repeating: [Float](repeating: 0, count: padded), count: 2)
        for c in 0..<2 {
            let s = src[min(c, chs - 1)]
            for i in 0..<frames { x[c][n + i] = s[i] }
        }
        let nFrames = (padded - n) / hop + 1
        var vocals = [[Float]](repeating: [Float](repeating: 0, count: padded), count: 2)
        var wsum = [Float](repeating: 0, count: padded)

        var window = [Float](repeating: 0, count: n)
        for i in 0..<n { window[i] = 0.5 - 0.5 * cos(2 * .pi * Float(i) / Float(n)) }   // periodic Hann
        let log2n = vDSP_Length(12)
        guard let fft = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) else { throw OfflineRenderer.RenderError.engine("fft") }
        defer { vDSP_destroy_fftsetup(fft) }
        for k in 0..<nFrames {
            for i in 0..<n { wsum[k * hop + i] += window[i] * window[i] }
        }

        let half = n / 2
        var maskSum = 0.0, maskN = 0, maskNaN = 0
        // Spectra of one block (per channel: real / imaginary, `half` bins, packed like vDSP: imag[0] = Nyquist).
        var re = [[Float]](repeating: [Float](repeating: 0, count: block * half), count: 2)
        var im = re
        var seg = [Float](repeating: 0, count: n)
        var tr = [Float](repeating: 0, count: half), ti = tr
        let blocks = (nFrames + block - 1) / block
        for b in 0..<blocks {
            if cancel?.isCancelled == true { throw OfflineRenderer.RenderError.cancelled }
            let f0 = b * block
            let count = min(block, nFrames - f0)
            guard let input = try? MLMultiArray(shape: [1, 2, NSNumber(value: block), NSNumber(value: bins)], dataType: .float32) else {
                throw OfflineRenderer.RenderError.engine("model input")
            }
            let ip = input.dataPointer.bindMemory(to: Float.self, capacity: 2 * block * bins)
            ip.update(repeating: 0, count: 2 * block * bins)
            for c in 0..<2 {
                for t in 0..<count {
                    let start = (f0 + t) * hop
                    for i in 0..<n { seg[i] = x[c][start + i] * window[i] }
                    tr.withUnsafeMutableBufferPointer { rp in
                        ti.withUnsafeMutableBufferPointer { iq in
                            var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: iq.baseAddress!)
                            seg.withUnsafeBufferPointer { sp in
                                sp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) {
                                    vDSP_ctoz($0, 2, &split, 1, vDSP_Length(half))
                                }
                            }
                            vDSP_fft_zrip(fft, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                        }
                    }
                    // vDSP's forward transform is twice the plain DFT.
                    let o = t * half
                    for f in 0..<half { re[c][o + f] = tr[f] * 0.5; im[c][o + f] = ti[f] * 0.5 }
                    let base = (c * block + t) * bins
                    ip[base] = abs(re[c][o])                     // DC (imag[0] holds Nyquist)
                    for f in 1..<bins {
                        let r = re[c][o + f], q = im[c][o + f]
                        ip[base + f] = (r * r + q * q).squareRoot()
                    }
                }
            }
            let result = try model.prediction(from: MLDictionaryFeatureProvider(dictionary: ["magnitude": MLFeatureValue(multiArray: input)]))
            guard let mask = result.featureValue(for: "vocalMask")?.multiArrayValue else { throw OfflineRenderer.RenderError.engine("model output") }
            if mask.dataType != .float32 {
                throw OfflineRenderer.RenderError.engine("vocal mask is \(mask.dataType.rawValue), not float32")
            }
            let mp = mask.dataPointer.bindMemory(to: Float.self, capacity: 2 * block * bins)
            let strides = mask.strides.map(\.intValue)
            for t in stride(from: 0, to: count, by: 8) {
                for f in stride(from: 0, to: bins, by: 16) {
                    let m = mp[t * strides[2] + f * strides[3]]
                    if m.isNaN { maskNaN += 1 } else { maskSum += Double(m); maskN += 1 }
                }
            }
            for c in 0..<2 {
                for t in 0..<count {
                    let o = t * half
                    // Masked spectrum: bins above the model's range (≈ 11 kHz) stay with the instrumental.
                    for f in 0..<half {
                        let m: Float = f < bins ? mp[c * strides[1] + t * strides[2] + f * strides[3]] : 0
                        tr[f] = re[c][o + f] * m * 2
                        ti[f] = f == 0 ? 0 : im[c][o + f] * m * 2
                    }
                    tr.withUnsafeMutableBufferPointer { rp in
                        ti.withUnsafeMutableBufferPointer { iq in
                            var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: iq.baseAddress!)
                            vDSP_fft_zrip(fft, &split, 1, log2n, FFTDirection(FFT_INVERSE))
                            seg.withUnsafeMutableBufferPointer { sp in
                                sp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) {
                                    vDSP_ztoc(&split, 1, $0, 2, vDSP_Length(half))
                                }
                            }
                        }
                    }
                    // Inverse: 2·N times the signal (with the ×2 above undone by the 0.5 per transform).
                    let scale = 1 / Float(2 * n)
                    let start = (f0 + t) * hop
                    for i in 0..<n { vocals[c][start + i] += seg[i] * scale * window[i] }
                }
            }
            progress?(Double(b + 1) / Double(blocks))
        }
        // Overlap-add normalisation, then cut back to the track's length.
        let fmtOut = AVAudioFormat(standardFormatWithSampleRate: fmt.sampleRate, channels: 2)!
        guard let vb = AVAudioPCMBuffer(pcmFormat: fmtOut, frameCapacity: AVAudioFrameCount(frames)),
              let ib = AVAudioPCMBuffer(pcmFormat: fmtOut, frameCapacity: AVAudioFrameCount(frames)),
              let vd = vb.floatChannelData, let idd = ib.floatChannelData else { throw OfflineRenderer.RenderError.engine("buffers") }
        vb.frameLength = AVAudioFrameCount(frames)
        ib.frameLength = AVAudioFrameCount(frames)
        for c in 0..<2 {
            let s = src[min(c, chs - 1)]
            for i in 0..<frames {
                let w = wsum[n + i]
                let v = w > 1e-6 ? vocals[c][n + i] / w : 0
                vd[c][i] = v
                idd[c][i] = s[i] - v
            }
        }
        // Sanity check: the vocals must be a part of the track, not all of it (or noise).
        var eo = 0.0, ev = 0.0, ei = 0.0
        for c in 0..<2 {
            let src0 = src[min(c, chs - 1)]
            for i in stride(from: 0, to: frames, by: 4) {
                eo += Double(src0[i] * src0[i]); ev += Double(vd[c][i] * vd[c][i]); ei += Double(idd[c][i] * idd[c][i])
            }
        }
        func db(_ e: Double) -> Double { 10 * log10(max(e, 1e-20) / max(eo, 1e-20)) }
        lastStats = ["maskMean": maskN > 0 ? maskSum / Double(maskN) : -1, "maskNaN": Double(maskNaN),
                     "vocalsDB": db(ev), "instrumentalDB": db(ei)]
        if maskNaN > 0 || !ev.isFinite || db(ev) > -0.5 {
            throw OfflineRenderer.RenderError.engine(L("ボーカルの分離結果がおかしいため使いません", "The vocal separation came out wrong, so it is not used"))
        }
        // Written to temporary names first, so a half-written stem is never used.
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: fmt.sampleRate, AVNumberOfChannelsKey: 2,
                                       AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false]
        let tv = out.vocals.deletingLastPathComponent().appendingPathComponent("writing-" + out.vocals.lastPathComponent)
        let ti2 = out.instrumental.deletingLastPathComponent().appendingPathComponent("writing-" + out.instrumental.lastPathComponent)
        do {
            let fv = try AVAudioFile(forWriting: tv, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
            try fv.write(from: vb)
            let fi = try AVAudioFile(forWriting: ti2, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
            try fi.write(from: ib)
        }
        let fm = FileManager.default
        try? fm.removeItem(at: out.vocals)
        try? fm.removeItem(at: out.instrumental)
        try fm.moveItem(at: tv, to: out.vocals)
        try fm.moveItem(at: ti2, to: out.instrumental)
        return out
    }
}
