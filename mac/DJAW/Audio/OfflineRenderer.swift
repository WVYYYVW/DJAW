import AVFoundation
import UniformTypeIdentifiers

nonisolated enum ExportFormat: String, CaseIterable, Identifiable, Sendable {
    case wav24
    case aac256

    var id: String { rawValue }

    var title: String {
        switch self {
        case .wav24: return L("WAV（24bit）", "WAV (24-bit)")
        case .aac256: return L("M4A（AAC 256kbps）", "M4A (AAC 256 kbps)")
        }
    }

    var fileExtension: String {
        switch self {
        case .wav24: return "wav"
        case .aac256: return "m4a"
        }
    }

    var contentType: UTType {
        switch self {
        case .wav24: return .wav
        case .aac256: return .mpeg4Audio
        }
    }

    func settings(sampleRate: Double) -> [String: Any] {
        switch self {
        case .wav24:
            return [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: sampleRate,
                AVNumberOfChannelsKey: 2,
                AVLinearPCMBitDepthKey: 24,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ]
        case .aac256:
            return [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: sampleRate,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 256_000,
            ]
        }
    }
}

nonisolated final class CancelFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return cancelled
    }

    func cancel() {
        lock.lock(); defer { lock.unlock() }
        cancelled = true
    }
}

/// Renders the whole mix faster than realtime using AVAudioEngine's offline manual rendering.
nonisolated enum OfflineRenderer {
    struct Options: Sendable {
        var format: ExportFormat
        var sampleRate: Double
        var normalize: Bool
    }

    enum RenderError: LocalizedError {
        case cancelled
        case engine(String)

        var errorDescription: String? {
            switch self {
            case .cancelled: return L("書き出しを中止しました。", "Export cancelled.")
            case .engine(let message): return L("書き出しに失敗しました（\(message)）", "Export failed (\(message))")
            }
        }
    }

    static func render(clips: [Clip],
                       master: Double,
                       tempo: TempoMap,
                       gridOffset: Double,
                       to url: URL,
                       options: Options,
                       cancel: CancelFlag,
                       knownPeak: Float? = nil,
                       progress: @escaping @Sendable (Double) -> Void) throws {
        let refEnd = clips.map { $0.end(master: master) }.max() ?? 0
        let mixEnd = tempo.real(refEnd)
        guard mixEnd > 0 else { throw RenderError.engine(L("曲がありません", "No tracks")) }

        var gain: Float = 1
        if options.normalize, let peak = knownPeak {
            // The mix waveform already rendered this exact mix: same peak, same gain, no first pass needed.
            gain = normalizeGain(peak: peak)
        } else if options.normalize {
            let peak = try pass(clips: clips, master: master, tempo: tempo, gridOffset: gridOffset, mixEnd: mixEnd, sampleRate: options.sampleRate,
                                writer: nil, gain: 1, cancel: cancel) { p in progress(p * 0.5) }
            gain = normalizeGain(peak: peak)
        }

        let writer = try AVAudioFile(forWriting: url,
                                     settings: options.format.settings(sampleRate: options.sampleRate),
                                     commonFormat: .pcmFormatFloat32,
                                     interleaved: false)
        let base = options.normalize ? 0.5 : 0.0
        let span = options.normalize ? 0.5 : 1.0
        _ = try pass(clips: clips, master: master, tempo: tempo, gridOffset: gridOffset, mixEnd: mixEnd, sampleRate: options.sampleRate,
                     writer: writer, gain: gain, cancel: cancel) { p in progress(base + p * span) }
        writer.close()
        progress(1)
    }

    /// Gain that brings the loudest sample to −1 dBFS (at most +12 dB).
    static func normalizeGain(peak: Float) -> Float {
        peak > 0.0001 ? min(Float(pow(10, -1.0 / 20)) / peak, 4) : 1
    }

    /// The mix waveform exactly as an export renders it: min / max per bin of both channels (before the
    /// export's gain and clipping, which the display applies), and the peak. Same engine pass as `render`.
    struct MixPeaks: Sendable {
        var sampleRate: Double
        var binsPerSecond: Double
        var mins: [Float]
        var maxs: [Float]
        /// Loudness of each bin (RMS over the channels), drawn inside the peaks so the shape of the music shows
        /// even where a loud master fills the peaks to full scale.
        var rms: [Float]
        /// Real (heard) seconds rendered so far.
        var rendered: Double
        var peak: Float
    }

    static func renderPeaks(clips: [Clip], master: Double, tempo: TempoMap, gridOffset: Double, sampleRate: Double,
                            binsPerSecond: Double = 200, cancel: CancelFlag,
                            update: @escaping @Sendable (MixPeaks) -> Void) throws -> MixPeaks {
        let refEnd = clips.map { $0.end(master: master) }.max() ?? 0
        let mixEnd = tempo.real(refEnd)
        guard mixEnd > 0 else { throw RenderError.engine(L("曲がありません", "No tracks")) }
        let binFrames = max(1, Int((sampleRate / binsPerSecond).rounded()))
        let total = Int(((mixEnd + 0.3) * sampleRate).rounded())
        let nBins = total / binFrames + 1
        var acc = MixPeaks(sampleRate: sampleRate, binsPerSecond: sampleRate / Double(binFrames),
                           mins: [Float](repeating: 0, count: nBins), maxs: [Float](repeating: 0, count: nBins),
                           rms: [Float](repeating: 0, count: nBins), rendered: 0, peak: 0)
        var frame = 0
        var sq = [Float](repeating: 0, count: nBins)
        var lastUpdate = Date()
        let sink: (AVAudioPCMBuffer) -> Void = { buf in
            guard let d = buf.floatChannelData else { return }
            let n = Int(buf.frameLength), chs = Int(buf.format.channelCount)
            for i in 0..<n {
                let b = (frame + i) / binFrames
                guard b < nBins else { break }
                for c in 0..<chs {
                    let x = d[c][i]
                    if x < acc.mins[b] { acc.mins[b] = x }
                    if x > acc.maxs[b] { acc.maxs[b] = x }
                    sq[b] += x * x
                }
            }
            // Bins finished by this buffer get their RMS.
            let scale = 1 / Float(binFrames * max(1, chs))
            let firstOpen = (frame + n) / binFrames
            var b = frame / binFrames
            while b < min(firstOpen, nBins) { acc.rms[b] = (sq[b] * scale).squareRoot(); b += 1 }
            frame += n
            acc.rendered = Double(frame) / sampleRate
            if Date().timeIntervalSince(lastUpdate) > 0.5 {
                lastUpdate = Date()
                update(acc)
            }
        }
        acc.peak = try pass(clips: clips, master: master, tempo: tempo, gridOffset: gridOffset, mixEnd: mixEnd, sampleRate: sampleRate,
                            writer: nil, gain: 1, cancel: cancel, sink: sink) { _ in }
        acc.rendered = Double(frame) / sampleRate
        let last = frame / binFrames
        if last < nBins {
            let filled = frame - last * binFrames
            if filled > 0 { acc.rms[last] = (sq[last] / Float(filled * 2)).squareRoot() }
        }
        return acc
    }


    /// Peaks of one stretch of the mix (real seconds a…b), on the same bins as `renderPeaks` (bins counted from the
    /// start of the mix), so they can replace that stretch of an earlier render. Rendering starts `preroll` seconds
    /// early so every track that is already playing has settled exactly as in a render from the start.
    struct PeakRange: Sendable {
        var firstBin: Int
        var mins: [Float]
        var maxs: [Float]
        var rms: [Float]
    }

    static func renderPeakRange(clips: [Clip], master: Double, tempo: TempoMap, gridOffset: Double, sampleRate: Double,
                                binsPerSecond: Double, fromReal a: Double, toReal b: Double, preroll: Double = 10,
                                cancel: CancelFlag) throws -> PeakRange {
        let binFrames = max(1, Int((sampleRate / binsPerSecond).rounded()))
        let firstBin = max(0, Int((a * sampleRate) / Double(binFrames)))
        let lastBin = max(firstBin, Int(((b * sampleRate) / Double(binFrames)).rounded(.up)))
        let n = lastBin - firstBin + 1
        var out = PeakRange(firstBin: firstBin, mins: [Float](repeating: 0, count: n), maxs: [Float](repeating: 0, count: n),
                            rms: [Float](repeating: 0, count: n))
        var sq = [Float](repeating: 0, count: n)
        var count = [Int](repeating: 0, count: n)
        let startReal = max(0, Double(firstBin * binFrames) / sampleRate - preroll)
        let session = try MixRenderSession(clips: clips, master: master, tempo: tempo, gridOffset: gridOffset, sampleRate: sampleRate,
                                           from: tempo.reference(atReal: startReal))
        defer { session.stop() }
        let endFrame = AVAudioFramePosition((lastBin + 1) * binFrames)
        while session.absoluteFrame < endFrame {
            if cancel.isCancelled { throw RenderError.cancelled }
            let f0 = Int(session.absoluteFrame)
            let buf = try session.renderNext()
            guard let d = buf.floatChannelData else { continue }
            let len = Int(buf.frameLength), chs = Int(buf.format.channelCount)
            for i in 0..<len {
                let k = (f0 + i) / binFrames - firstBin
                guard k >= 0 else { continue }
                guard k < n else { break }
                for c in 0..<chs {
                    let x = d[c][i]
                    if x < out.mins[k] { out.mins[k] = x }
                    if x > out.maxs[k] { out.maxs[k] = x }
                    sq[k] += x * x
                }
                count[k] += chs
            }
        }
        for k in 0..<n where count[k] > 0 { out.rms[k] = (sq[k] / Float(count[k])).squareRoot() }
        return out
    }

    /// Renders the mix once. Returns the peak sample value (after gain).
    private static func pass(clips: [Clip],
                             master: Double,
                             tempo: TempoMap,
                             gridOffset: Double,
                             mixEnd: Double,
                             sampleRate sr: Double,
                             writer: AVAudioFile?,
                             gain: Float,
                             cancel: CancelFlag,
                             sink: ((AVAudioPCMBuffer) -> Void)? = nil,
                             progress: (Double) -> Void) throws -> Float {
        let session: MixRenderSession
        do {
            session = try MixRenderSession(clips: clips, master: master, tempo: tempo, gridOffset: gridOffset, sampleRate: sr)
        } catch {
            throw RenderError.engine(error.localizedDescription)
        }
        defer { session.stop() }

        let total = AVAudioFramePosition(((mixEnd + 0.3) * sr).rounded())
        var peak: Float = 0
        var lastReported = -1.0
        let clampOutput = writer != nil

        while session.renderedFrames < total {
            if cancel.isCancelled { throw RenderError.cancelled }
            let buffer: AVAudioPCMBuffer
            do { buffer = try session.renderNext() } catch { throw RenderError.engine(error.localizedDescription) }
            let rendered = Int(buffer.frameLength)
            if let data = buffer.floatChannelData {
                let channelCount = Int(buffer.format.channelCount)
                for c in 0..<channelCount {
                    let p = data[c]
                    for i in 0..<rendered {
                        var x = p[i] * gain
                        if clampOutput { x = min(1, max(-1, x)) }
                        p[i] = x
                        let a = abs(x)
                        if a > peak { peak = a }
                    }
                }
            }
            if let writer {
                try writer.write(from: buffer)
            }
            sink?(buffer)

            let pr = Double(session.renderedFrames) / Double(total)
            if pr - lastReported >= 0.005 {
                progress(pr)
                lastReported = pr
            }
        }
        return peak
    }
}
