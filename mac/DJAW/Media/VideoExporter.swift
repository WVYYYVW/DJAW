import Foundation
import AVFoundation
import CoreGraphics
import CoreText
import Accelerate

/// Looks for the video export (club-screen style visuals that follow the music).
nonisolated enum VisualStyle: String, CaseIterable, Identifiable, Codable, Sendable {
    case auto, pulse, tunnel, lasers, spectrum

    var id: String { rawValue }

    var title: String {
        switch self {
        case .auto: return L("オート VJ（曲の展開に合わせて切り替え）", "Auto VJ (follows the tracks’ build-ups and drops)")
        case .pulse: return L("パルス（ジャケット＋円形スペクトラム）", "Pulse (artwork + circular spectrum)")
        case .tunnel: return L("トンネル（ビートで奥へ流れる図形）", "Tunnel (shapes flying on the beat)")
        case .lasers: return L("レーザー（クラブ照明風）", "Lasers (club lighting)")
        case .spectrum: return L("スペクトラム（バー＋曲名、配信向け）", "Spectrum (bars + titles, for uploads)")
        }
    }
}

/// Renders the mix as an MP4: the exported audio plus visuals drawn frame by frame from the mix itself —
/// its spectrum and levels, the beat grid (so flashes land on the beat), the tracks' colours and artwork,
/// and a card with title / artist whenever a new track takes over.
nonisolated enum VideoExporter {
    nonisolated struct Options: Sendable {
        var width = 1920
        var height = 1080
        var fps = 30
        var style: VisualStyle = .auto
        var showTrackInfo = true
        /// Shown at the start of the video (the mix's name); empty = none.
        var mixTitle = ""
        var audio: OfflineRenderer.Options
    }

    /// What the visuals need to know about one track.
    nonisolated struct TrackVisual: @unchecked Sendable {
        var title: String
        var artist: String
        var artwork: CGImage?
        var hue: Double
        /// Real seconds in the mix: comes in / takes over / is gone.
        var start: Double
        var landing: Double
        var end: Double
        /// The track's structure on the mix's clock (intro, build-up, drop, breakdown, outro).
        var sections: [VisualSection] = []
        /// Main colours of the artwork (hues), used instead of the track colour when there are some.
        var palette: [Double] = []
    }

    // MARK: Export

    static func export(clips: [Clip], master: Double, tempo: TempoMap, gridOffset: Double, tracks: [TrackVisual],
                       to url: URL, options: Options, cancel: CancelFlag, knownPeak: Float?,
                       progress: @escaping @Sendable (Double) -> Void) throws {
        let fm = FileManager.default
        let tmp = fm.temporaryDirectory.appendingPathComponent("DJAW-video-\(UUID().uuidString).wav")
        defer { try? fm.removeItem(at: tmp) }
        // 1. The audio, exactly as the audio export writes it.
        var audioOpts = options.audio
        audioOpts.format = .wav24
        try OfflineRenderer.render(clips: clips, master: master, tempo: tempo, gridOffset: gridOffset, to: tmp, options: audioOpts,
                                   cancel: cancel, knownPeak: knownPeak) { p in progress(p * 0.35) }
        if cancel.isCancelled { throw OfflineRenderer.RenderError.cancelled }

        // 2. What the music does in every video frame.
        let features = try analyse(tmp, fps: options.fps)
        if cancel.isCancelled { throw OfflineRenderer.RenderError.cancelled }
        progress(0.4)

        // 3. Draw and encode.
        try? fm.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true
        let pixels = options.width * options.height
        let bitrate = pixels >= 1920 * 1080 ? 14_000_000 : 8_000_000
        let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: options.width,
            AVVideoHeightKey: options.height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoMaxKeyFrameIntervalKey: options.fps * 2,
            ],
        ])
        videoIn.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: videoIn, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: options.width,
            kCVPixelBufferHeightKey as String: options.height,
        ])
        let sr = options.audio.sampleRate
        let audioIn = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: sr,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 320_000,
        ])
        audioIn.expectsMediaDataInRealTime = false
        guard writer.canAdd(videoIn), writer.canAdd(audioIn) else {
            throw OfflineRenderer.RenderError.engine(L("動画を作れません", "Cannot create the video"))
        }
        writer.add(videoIn)
        writer.add(audioIn)

        let asset = AVURLAsset(url: tmp)
        let reader = try AVAssetReader(asset: asset)
        guard let track = asset.tracks(withMediaType: .audio).first else { throw OfflineRenderer.RenderError.engine(L("音声を読めません", "Cannot read the audio")) }
        let readerOut = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ])
        reader.add(readerOut)
        guard reader.startReading(), writer.startWriting() else {
            throw OfflineRenderer.RenderError.engine(writer.error?.localizedDescription ?? L("動画を書き出せません", "Cannot write the video"))
        }
        writer.startSession(atSourceTime: .zero)

        let painter = Painter(options: options, tracks: tracks, features: features, tempo: tempo, gridOffset: gridOffset, master: master)
        let total = features.frames
        var frame = 0
        var audioDone = false, videoDone = false
        var audioTime = 0.0
        var idle = 0
        while !(audioDone && videoDone) {
            if cancel.isCancelled {
                writer.cancelWriting()
                reader.cancelReading()
                throw OfflineRenderer.RenderError.cancelled
            }
            var moved = false
            if !videoDone {
                if frame >= total {
                    videoIn.markAsFinished()
                    videoDone = true
                } else if videoIn.isReadyForMoreMediaData, let pool = adaptor.pixelBufferPool {
                    var pb: CVPixelBuffer?
                    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
                    if let pb {
                        painter.draw(frame: frame, into: pb)
                        if !adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: CMTimeScale(options.fps))) {
                            throw OfflineRenderer.RenderError.engine(writer.error?.localizedDescription ?? "video")
                        }
                        frame += 1
                        moved = true
                        if frame % 30 == 0 { progress(0.4 + 0.6 * Double(frame) / Double(max(1, total))) }
                    }
                }
            }
            // Keep the audio a little ahead of the picture (the writer interleaves the two).
            if !audioDone, audioIn.isReadyForMoreMediaData, videoDone || idle > 20 || audioTime <= Double(frame) / Double(options.fps) + 1 {
                if let sb = readerOut.copyNextSampleBuffer() {
                    if !audioIn.append(sb) { throw OfflineRenderer.RenderError.engine(writer.error?.localizedDescription ?? "audio") }
                    audioTime = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb)) + CMTimeGetSeconds(CMSampleBufferGetDuration(sb))
                } else {
                    audioIn.markAsFinished()
                    audioDone = true
                }
                moved = true
            }
            if moved { idle = 0 } else { idle += 1; usleep(1000) }
        }
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        done.wait()
        if writer.status != .completed {
            throw OfflineRenderer.RenderError.engine(writer.error?.localizedDescription ?? L("動画の書き出しに失敗しました", "Video export failed"))
        }
        progress(1)
    }

    // MARK: Music features per video frame

    nonisolated struct Features: Sendable {
        var frames: Int
        var fps: Int
        /// 0…1 per frame: loudness, lows, mids, highs; `kick` = how sharply the lows just rose.
        var level: [Float]
        var low: [Float]
        var mid: [Float]
        var high: [Float]
        var kick: [Float]
        /// Log-spaced spectrum per frame (bands × frames), 0…1.
        var spectrum: [[Float]]
        static let bands = 48
    }


    static func analyse(_ url: URL, fps: Int) throws -> Features {
        let file = try AVAudioFile(forReading: url)
        let sr = file.processingFormat.sampleRate
        let n = Int(file.length)
        // Mono, read in pieces.
        var mono = [Float](repeating: 0, count: n)
        let piece: AVAudioFrameCount = 1 << 20
        guard let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: piece) else {
            throw OfflineRenderer.RenderError.engine("analyse")
        }
        var pos = 0
        while pos < n {
            try file.read(into: buf, frameCount: min(piece, AVAudioFrameCount(n - pos)))
            let len = Int(buf.frameLength)
            guard len > 0, let d = buf.floatChannelData else { break }
            let chs = Int(buf.format.channelCount)
            let scale = 1 / Float(max(1, chs))
            for i in 0..<len {
                var x: Float = 0
                for c in 0..<chs { x += d[c][i] }
                mono[pos + i] = x * scale
            }
            pos += len
        }

        let frames = Int(Double(n) / sr * Double(fps)) + 1
        let hop = sr / Double(fps)
        let fftN = 2048, log2n = vDSP_Length(11)
        guard let setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) else { throw OfflineRenderer.RenderError.engine("fft") }
        defer { vDSP_destroy_fftsetup(setup) }
        var window = [Float](repeating: 0, count: fftN)
        vDSP_hann_window(&window, vDSP_Length(fftN), Int32(vDSP_HANN_NORM))
        // Band edges (log-spaced 40 Hz – 16 kHz) in FFT bins.
        let nb = Features.bands
        let edges: [Int] = (0...nb).map { k in
            let f = 40 * pow(16_000 / 40, Double(k) / Double(nb))
            return max(1, min(fftN / 2 - 1, Int(f / sr * Double(fftN))))
        }
        var level = [Float](repeating: 0, count: frames), low = level, mid = level, high = level
        var spectrum = [[Float]](repeating: [Float](repeating: 0, count: nb), count: frames)
        var re = [Float](repeating: 0, count: fftN / 2), im = re
        var seg = [Float](repeating: 0, count: fftN)
        var mags = [Float](repeating: 0, count: fftN / 2)
        for f in 0..<frames {
            let center = Int(Double(f) * hop)
            let s0 = center - fftN / 2
            for i in 0..<fftN {
                let k = s0 + i
                seg[i] = k >= 0 && k < n ? mono[k] * window[i] : 0
            }
            re.withUnsafeMutableBufferPointer { rp in
                im.withUnsafeMutableBufferPointer { ip in
                    var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                    seg.withUnsafeBufferPointer { sp in
                        sp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: fftN / 2) {
                            vDSP_ctoz($0, 2, &split, 1, vDSP_Length(fftN / 2))
                        }
                    }
                    vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                    vDSP_zvabs(&split, 1, &mags, 1, vDSP_Length(fftN / 2))
                }
            }
            var bands = [Float](repeating: 0, count: nb)
            for b in 0..<nb {
                let a = edges[b], e = max(edges[b] + 1, edges[b + 1])
                var m: Float = 0
                for i in a..<e { m = max(m, mags[i]) }
                bands[b] = 20 * log10(max(m, 1e-6))
            }
            spectrum[f] = bands
            func band(_ lo: Double, _ hi: Double) -> Float {
                let a = max(1, Int(lo / sr * Double(fftN))), e = max(a + 1, min(fftN / 2, Int(hi / sr * Double(fftN))))
                var s: Float = 0
                for i in a..<e { s += mags[i] * mags[i] }
                return sqrt(s / Float(e - a))
            }
            low[f] = band(30, 150); mid[f] = band(300, 3000); high[f] = band(5000, 15000); level[f] = band(30, 15000)
        }
        // Scale everything to 0…1 against the loud parts of the mix.
        func normalise(_ v: inout [Float]) {
            let sorted = v.sorted()
            let ref = max(sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.97))], 1e-6)
            for i in v.indices { v[i] = min(1.2, v[i] / ref) }
        }
        normalise(&level); normalise(&low); normalise(&mid); normalise(&high)
        let all = spectrum.flatMap { $0 }.sorted()
        let top = all[min(all.count - 1, Int(Double(all.count) * 0.995))]
        let floor = top - 60
        for f in 0..<frames {
            for b in 0..<nb { spectrum[f][b] = max(0, min(1, (spectrum[f][b] - floor) / 60)) }
        }
        // Kicks: a sharp rise of the lows, held for a moment and decaying.
        var kick = [Float](repeating: 0, count: frames)
        var hold: Float = 0
        for f in 0..<frames {
            let rise = f > 0 ? max(0, low[f] - low[f - 1]) : 0
            hold = max(hold * 0.82, min(1, rise * 3.5))
            kick[f] = hold
        }
        return Features(frames: frames, fps: fps, level: level, low: low, mid: mid, high: high, kick: kick, spectrum: spectrum)
    }

    // MARK: Drawing

    typealias Painter = VisualPainter
}

/// What the visuals react to in one video frame (all 0…1).
nonisolated struct FeatureFrame: Sendable {
    var level: Float
    var low: Float
    var mid: Float
    var high: Float
    var kick: Float
    var spectrum: [Float]
    static let silent = FeatureFrame(level: 0, low: 0, mid: 0, high: 0, kick: 0,
                                     spectrum: [Float](repeating: 0, count: VideoExporter.Features.bands))
}

/// Where the painter gets the music's features: the analysed export, or the live preview.
nonisolated protocol VisualFeatureSource {
    func frame(_ f: Int) -> FeatureFrame?
}

nonisolated extension VideoExporter.Features: VisualFeatureSource {
    func frame(_ f: Int) -> FeatureFrame? {
        guard frames > 0 else { return nil }
        let k = min(max(0, f), frames - 1)
        return FeatureFrame(level: level[k], low: low[k], mid: mid[k], high: high[k], kick: kick[k], spectrum: spectrum[k])
    }
}

/// The same features computed on the fly from the preview's audio (rendered a moment before it is heard),
/// levels scaled against what has been loud recently.
nonisolated final class LiveFeatures: VisualFeatureSource, @unchecked Sendable {
    let fps = 30
    private let lock = NSLock()
    private var sampleRate = 44_100.0
    private var samples: [Float] = []
    private var firstSample: Int64 = 0
    private var nextFrame = 0
    private var frames: [Int: FeatureFrame] = [:]
    private var refs: [Float] = [1e-3, 1e-3, 1e-3, 1e-3]
    private var top: Float = -20
    private var lastLow: Float = 0
    private var hold: Float = 0
    private let fftN = 2048
    private let log2n = vDSP_Length(11)
    private let setup: FFTSetup?
    private var window: [Float]

    init() {
        setup = vDSP_create_fftsetup(11, FFTRadix(kFFTRadix2))
        window = [Float](repeating: 0, count: 2048)
        vDSP_hann_window(&window, vDSP_Length(2048), Int32(vDSP_HANN_NORM))
    }

    deinit { if let setup { vDSP_destroy_fftsetup(setup) } }

    /// A new stretch of playback (after a seek): forget the old audio.
    func reset(sampleRate sr: Double, at frame: Int64) {
        lock.lock(); defer { lock.unlock() }
        sampleRate = sr
        samples = []
        firstSample = frame
        nextFrame = Int((Double(frame) / sr * Double(fps)).rounded(.up))
        frames = [:]
        hold = 0
    }

    func frame(_ f: Int) -> FeatureFrame? {
        lock.lock(); defer { lock.unlock() }
        return frames[f]
    }

    /// Rendered audio (mono), `count` samples starting at mix frame `start`.
    func feed(_ mono: [Float], at start: Int64) {
        lock.lock(); defer { lock.unlock() }
        guard let setup else { return }
        if start != firstSample + Int64(samples.count) {
            samples = []
            firstSample = start
            nextFrame = Int((Double(start) / sampleRate * Double(fps)).rounded(.up))
        }
        samples += mono
        let half = fftN / 2
        var re = [Float](repeating: 0, count: half), im = re, mags = re
        var seg = [Float](repeating: 0, count: fftN)
        let nb = VideoExporter.Features.bands
        while true {
            let center = Int64((Double(nextFrame) * sampleRate / Double(fps)).rounded())
            let s0 = Int(center - firstSample) - half
            guard s0 + fftN <= samples.count else { break }
            for i in 0..<fftN {
                let k = s0 + i
                seg[i] = k >= 0 ? samples[k] * window[i] : 0
            }
            re.withUnsafeMutableBufferPointer { rp in
                im.withUnsafeMutableBufferPointer { ip in
                    var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                    seg.withUnsafeBufferPointer { sp in
                        sp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) {
                            vDSP_ctoz($0, 2, &split, 1, vDSP_Length(half))
                        }
                    }
                    vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                    vDSP_zvabs(&split, 1, &mags, 1, vDSP_Length(half))
                }
            }
            let sr = sampleRate
            func band(_ lo: Double, _ hi: Double) -> Float {
                let a = max(1, Int(lo / sr * Double(fftN))), e = max(a + 1, min(half, Int(hi / sr * Double(fftN))))
                var s: Float = 0
                for i in a..<e { s += mags[i] * mags[i] }
                return sqrt(s / Float(e - a))
            }
            var raw = [band(30, 15000), band(30, 150), band(300, 3000), band(5000, 15000)]
            for k in 0..<4 {
                refs[k] = max(raw[k], refs[k] * 0.9993)
                raw[k] = min(1.2, raw[k] / max(refs[k], 1e-6))
            }
            var spec = [Float](repeating: 0, count: nb)
            for b in 0..<nb {
                let f0 = 40 * pow(16_000 / 40, Double(b) / Double(nb)), f1 = 40 * pow(16_000 / 40, Double(b + 1) / Double(nb))
                let a = max(1, min(half - 1, Int(f0 / sr * Double(fftN)))), e = max(a + 1, min(half, Int(f1 / sr * Double(fftN))))
                var m: Float = 0
                for i in a..<e { m = max(m, mags[i]) }
                spec[b] = 20 * log10(max(m, 1e-6))
            }
            top = max(spec.max() ?? top, top - 0.01)
            for b in 0..<nb { spec[b] = max(0, min(1, (spec[b] - (top - 60)) / 60)) }
            let rise = max(0, raw[1] - lastLow)
            lastLow = raw[1]
            hold = max(hold * 0.82, min(1, rise * 3.5))
            frames[nextFrame] = FeatureFrame(level: raw[0], low: raw[1], mid: raw[2], high: raw[3], kick: hold, spectrum: spec)
            nextFrame += 1
        }
        // Keep a few seconds of frames and only the audio still needed.
        if frames.count > fps * 20 {
            let keep = nextFrame - fps * 10
            frames = frames.filter { $0.key >= keep }
        }
        let needFrom = Int(Int64((Double(nextFrame) * sampleRate / Double(fps)).rounded()) - firstSample) - half
        if needFrom > 0 && needFrom < samples.count {
            samples.removeFirst(needFrom)
            firstSample += Int64(needFrom)
        }
    }
}
