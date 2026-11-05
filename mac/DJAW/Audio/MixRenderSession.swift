import AVFoundation

/// The one place the mix is turned into audio. Export, the mix waveform, the transition checks and the preview
/// all render through this, so what you hear is what gets exported (same timing, same automation, same effects).
///
/// Renders from timeline time `from` on, in steps of 512 frames counted from the start of the mix (so automation is
/// evaluated at the same moments whether rendering starts at 0 or in the middle). Every track gets its own small
/// offline engine, started on the exact frame the track comes in, and the engines' outputs are added up.
/// (In one shared engine a track that came in later sat behind a time-stretch unit that had been running all along,
/// and its start drifted — late when waiting, early when fed silence, smeared when added mid-render.)
nonisolated final class MixRenderSession {
    enum SessionError: LocalizedError {
        case engine(String)
        var errorDescription: String? {
            switch self { case .engine(let m): return m }
        }
    }

    static let chunk: AVAudioFramePosition = 512
    /// A track's engine keeps running this long after the track ends (echo / reverb tails).
    static let tail = 8.0

    /// One track: its own engine with player → time-pitch → EQ → FX → echo → reverb → fader.
    nonisolated private final class Voice {
        let index: Int
        let engine = AVAudioEngine()
        let chain: Chain
        let feeder: BufferFeeder
        /// With stems: the vocals (the main feeder then plays the instrumental).
        let vocalFeeder: BufferFeeder?
        let out: AVAudioPCMBuffer
        let endFrame: AVAudioFramePosition
        let sourceRate: Double

        init?(clip c: Clip, index: Int, next: Clip?, master: Double, tempo: TempoMap, format: AVAudioFormat,
              fromElapsed e0: Double, tempoAt t: Double, endFrame: AVAudioFramePosition,
              stemFiles: (vocals: URL, instrumental: URL)? = nil, laneReverb: Bool = false) {
            self.index = index
            self.endFrame = endFrame
            guard let file = try? AVAudioFile(forReading: c.url),
                  (try? engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4096)) != nil,
                  let out = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: 4096) else { return nil }
            self.out = out
            sourceRate = file.processingFormat.sampleRate
            _ = engine.mainMixerNode
            // Stems when a drawn transition turns this track's vocals / instrumental down and they are separated.
            let stems = stemFiles
            chain = DJEQ.buildChain(engine: engine, format: file.processingFormat, clip: c, master: master,
                                    tempo: tempo.bpm(at: max(t, c.start)), stems: stems != nil, laneReverb: laneReverb)
            guard let f = BufferFeeder(clip: c, outro: c.outro(next: next), player: chain.player, fromElapsed: e0,
                                       cutOut: next?.transition == .cut, file: stems?.instrumental), !f.isEmpty else { return nil }
            var vf: BufferFeeder?
            if let stems, let vp = chain.vocalPlayer {
                vf = BufferFeeder(clip: c, outro: c.outro(next: next), player: vp, fromElapsed: e0,
                                  cutOut: next?.transition == .cut, file: stems.vocals)
            }
            guard (try? engine.start()) != nil else { return nil }
            feeder = f
            vocalFeeder = vf
            feeder.feed()
            vocalFeeder?.feed()
            chain.player.play()
            chain.vocalPlayer?.play()
        }

        func render(_ frames: AVAudioFrameCount) throws -> AVAudioPCMBuffer {
            var tries = 0
            while true {
                let status = try engine.renderOffline(frames, to: out)
                switch status {
                case .success, .insufficientDataFromInputNode:
                    return out
                case .cannotDoInCurrentContext:
                    tries += 1
                    if tries < 100 { continue }
                    throw SessionError.engine(L("レンダリングエラー", "Rendering error"))
                case .error:
                    throw SessionError.engine(L("レンダリングエラー", "Rendering error"))
                @unknown default:
                    throw SessionError.engine(L("不明なエラー", "Unknown error"))
                }
            }
        }

        func stop() { engine.stop() }

        // MARK: Exact stretch rate

        /// AVAudioUnitTimePitch does not play at exactly the rate it is set to (0.97288 plays like ~0.97266, about
        /// −0.23 ms per second off the beat). Two settings either side whose real speeds were measured
        /// (StretchCalibration) are alternated in 0.1 s blocks so that on average the track runs at exactly `r`.
        private var planRate = 0.0
        private var steadyFrames = 0.0
        private var plan: (lo: Float, hi: Float, effLo: Double, effHi: Double)?
        private var ideal = 0.0, used = 0.0
        private var held: Float = 0, heldEff = 0.0, heldLeft = 0.0
        /// Offline renders measure the unit when needed; the preview only uses what is measured already.
        var waitForCalibration = true

        func correctedRate(_ r: Double, frames: Int, outputRate: Double) -> Float {
            let n = Double(frames) * sourceRate / outputRate
            if r != planRate {
                planRate = r
                steadyFrames = 0
                plan = nil
                ideal = 0; used = 0; heldLeft = 0
            }
            steadyFrames += Double(frames)
            // Only once the rate has stayed put for a second (not during tempo ramps).
            if plan == nil, steadyFrames >= outputRate {
                plan = StretchCalibration.plan(for: r, sampleRate: sourceRate, wait: waitForCalibration)
                if plan != nil { ideal = 0; used = 0; heldLeft = 0 }
            }
            guard let p = plan else { return Float(r) }
            ideal += r * n
            if heldLeft <= 0 {
                let block = 0.1 * sourceRate
                let useHi = used + p.effLo * block < ideal + r * block
                held = useHi ? p.hi : p.lo
                heldEff = useHi ? p.effHi : p.effLo
                heldLeft = 0.1 * outputRate
            }
            heldLeft -= Double(frames)
            used += heldEff * n
            return held
        }
    }

    let sampleRate: Double
    let format: AVAudioFormat
    private var voices: [Voice] = []
    /// Tracks still to come in, by the absolute frame they start at.
    private var waiting: [(index: Int, frame: AVAudioFramePosition)] = []
    private(set) var clips: [Clip]
    private let master: Double
    private let tempo: TempoMap
    private let gridOffset: Double
    private let fixed: [Int: Automation.State]
    /// Absolute frame (from the start of the mix) of the next frame to render.
    private(set) var absoluteFrame: AVAudioFramePosition
    private let startFrame: AVAudioFramePosition
    let buffer: AVAudioPCMBuffer
    /// What the rendered audio depends on apart from levels / EQ / effects (see `update`).
    private let ownKey: Int

    /// - Parameters:
    ///   - indices: only these tracks (nil = all).
    ///   - fixed: automation states to hold instead of the timeline's (render checks of a track on its own).
    init(clips: [Clip], indices: [Int]? = nil, master: Double, tempo: TempoMap, gridOffset: Double, sampleRate sr: Double,
         from t0: Double = 0, fixed: [Int: Automation.State] = [:], waitForCalibration: Bool = true) throws {
        self.waitForCalibration = waitForCalibration
        sampleRate = sr
        guard let f = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 2),
              let b = AVAudioPCMBuffer(pcmFormat: f, frameCapacity: 4096) else {
            throw SessionError.engine(L("フォーマットを作成できません", "Could not create the audio format"))
        }
        format = f
        buffer = b
        self.clips = clips
        self.master = master
        self.tempo = tempo
        self.gridOffset = gridOffset
        self.fixed = fixed
        ownKey = Self.structureKey(clips, master: master)
        startFrame = AVAudioFramePosition((tempo.real(t0) * sr).rounded())
        absoluteFrame = startFrame
        for i in indices ?? Array(clips.indices) where i >= 0 && i < clips.count {
            let c = clips[i]
            guard c.end(master: master) > t0 else { continue }
            let frame = AVAudioFramePosition((tempo.real(c.start) * sr).rounded())
            if frame <= startFrame {
                addVoice(i, fromElapsed: max(0, t0 - c.start) * c.rate(master: master), tempoAt: t0)
            } else {
                waiting.append((i, frame))
            }
        }
        waiting.sort { $0.frame < $1.frame }
    }

    /// See Voice.waitForCalibration.
    private let waitForCalibration: Bool

    private func addVoice(_ i: Int, fromElapsed e0: Double, tempoAt t: Double) {
        let c = clips[i]
        let end = AVAudioFramePosition(((tempo.real(c.end(master: master)) + Self.tail) * sampleRate).rounded())
        let next = i + 1 < clips.count ? clips[i + 1] : nil
        let prev = i > 0 ? clips[i - 1] : nil
        let stems = Self.usesStems(c, next: next) ? StemSeparator.stems(for: c.url) : nil
        let laneReverb = (c.transition == .custom && c.lanes?.usesReverb == true)
            || (next.map { $0.transition == .custom && $0.lanes?.usesReverb == true } ?? false)
        _ = prev
        if let v = Voice(clip: c, index: i, next: next, master: master, tempo: tempo,
                         format: format, fromElapsed: e0, tempoAt: t, endFrame: end, stemFiles: stems, laneReverb: laneReverb) {
            v.waitForCalibration = waitForCalibration
            voices.append(v)
        }
    }

    func stop() {
        for v in voices { v.stop() }
        voices.removeAll()
    }

    /// Timeline (reference) time of the next frame.
    var time: Double { tempo.reference(atReal: Double(absoluteFrame) / sampleRate) }
    /// Frames rendered since `from`.
    var renderedFrames: AVAudioFramePosition { absoluteFrame - startFrame }

    /// Length of the next step: up to the next multiple of 512 frames from the start of the mix.
    /// (Shorter when a track comes in sooner, so it starts on its exact frame.)
    var nextChunk: AVAudioFrameCount {
        var n = Self.chunk - absoluteFrame % Self.chunk
        if let w = waiting.first, w.frame > absoluteFrame, w.frame - absoluteFrame < n { n = w.frame - absoluteFrame }
        return AVAudioFrameCount(n)
    }

    /// Renders the next step (`nextChunk` frames) into `buffer`.
    @discardableResult
    func renderNext() throws -> AVAudioPCMBuffer {
        // Tracks that come in now start their own engine on this very frame.
        while let w = waiting.first, w.frame <= absoluteFrame {
            waiting.removeFirst()
            addVoice(w.index, fromElapsed: 0, tempoAt: clips[w.index].start)
        }
        // Tracks long over (tails included) are let go.
        if voices.contains(where: { $0.endFrame < absoluteFrame }) {
            for v in voices where v.endFrame < absoluteFrame { v.stop() }
            voices.removeAll { $0.endFrame < absoluteFrame }
        }
        let frames = nextChunk
        let t = tempo.reference(atReal: (Double(absoluteFrame) + Double(frames) / 2) / sampleRate)
        let bpm = tempo.bpm(at: t)
        let beat = (t - gridOffset) * master / 60
        buffer.frameLength = frames
        guard let sum = buffer.floatChannelData else { return buffer }
        let chs = Int(format.channelCount), n = Int(frames)
        for c in 0..<chs { sum[c].update(repeating: 0, count: n) }
        for v in voices {
            let state = fixed[v.index] ?? Automation.state(clips: clips, index: v.index, time: t, master: master)
            v.chain.apply(state, clip: clips[v.index], tempo: bpm, beat: beat, snapTolerance: 0.02)
            v.chain.pitch.rate = v.correctedRate(DJEQ.stretchRate(clips[v.index].rate(master: bpm)), frames: n, outputRate: sampleRate)
            let out = try v.render(frames)
            if let d = out.floatChannelData {
                let m = min(n, Int(out.frameLength)), och = Int(out.format.channelCount)
                for c in 0..<chs {
                    let src = d[min(c, och - 1)]
                    for k in 0..<m { sum[c][k] += src[k] }
                }
            }
            let used = DJEQ.stretchRate(clips[v.index].rate(master: bpm))
            v.feeder.advance(frames: m(out, n), outputRate: sampleRate, rate: used)
            v.feeder.feed()
            v.vocalFeeder?.advance(frames: m(out, n), outputRate: sampleRate, rate: used)
            v.vocalFeeder?.feed()
        }
        absoluteFrame += AVAudioFramePosition(n)
        return buffer
    }

    private func m(_ b: AVAudioPCMBuffer, _ n: Int) -> Int { min(n, Int(b.frameLength)) }

    // MARK: Live changes (preview)

    /// Takes over changed levels / EQ / effects / transition curves without starting again — they are heard from
    /// the next rendered step. Returns false when the change moves audio in time (then render a new session).
    func update(clips new: [Clip], master m: Double) -> Bool {
        guard m == master, new.count == clips.count, Self.structureKey(new, master: m) == ownKey else { return false }
        clips = new
        return true
    }

    /// Whether a track's transitions in or out turn its vocals / instrumental down (then it plays from stems).
    static func usesStems(_ c: Clip, next: Clip?) -> Bool {
        (c.transition == .custom && c.lanes?.usesStemsIncoming == true)
            || (next.map { $0.transition == .custom && $0.lanes?.usesStemsOutgoing == true } ?? false)
    }

    /// Everything that decides *which* audio plays *when* (the rest is automation, read every step).
    static func structureKey(_ clips: [Clip], master: Double) -> Int {
        var h = Hasher()
        h.combine(master)
        for (i, c) in clips.enumerated() {
            // Stems in use (and ready), and reverb units needed by drawn lanes, change the engines.
            let stems = usesStems(c, next: i + 1 < clips.count ? clips[i + 1] : nil)
            h.combine(stems && StemSeparator.stems(for: c.url) != nil)
            h.combine(c.transition == .custom && c.lanes?.usesReverb == true)
        }
        for c in clips {
            h.combine(c.id); h.combine(c.url); h.combine(c.start); h.combine(c.trimStart); h.combine(c.trimEnd)
            h.combine(c.playLength); h.combine(c.edits); h.combine(c.bpm); h.combine(c.firstBeat); h.combine(c.tempo)
            h.combine(c.tempoBars); h.combine(c.tempoSync); h.combine(c.keyLock); h.combine(c.keyShift)
            h.combine(c.transition == .cut); h.combine(c.transition == .brake); h.combine(c.transition == .backspin)
            h.combine(c.spinBeats); h.combine(c.mixInBar); h.combine(c.mixOutBar); h.combine(c.transitionBars)
            h.combine(c.endBar); h.combine(c.inNudge); h.combine(c.outNudge)
            h.combine(c.fx?.contains { $0.kind == .reverb } ?? false)
        }
        return h.finalize()
    }
}
