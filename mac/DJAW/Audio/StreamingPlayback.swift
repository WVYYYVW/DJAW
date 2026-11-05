import AVFoundation

/// The mix preview. It plays exactly what an export renders: a MixRenderSession renders the mix a quarter of a
/// second ahead on a background queue and the result is streamed to one player. (The earlier preview built its own
/// realtime graph, whose timing differed from the export's — tracks could come in at different moments.)
///
/// Level / EQ / effect / curve changes are taken over without restarting (heard ~0.25 s later); changes that move
/// audio in time make `applyAutomation` return true so the store starts the preview again from where it is.
final class StreamingPlayback {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let queue = DispatchQueue(label: "DJAW.preview", qos: .userInteractive)
    private let shared = Shared()
    private var connectedFormat: AVAudioFormat?
    private var anchorTimeline = 0.0
    private var anchorReal = 0.0
    private var tempo = TempoMap(reference: 120)
    private var lastClips: [Clip] = []
    private var lastMaster = 0.0
    private var sessionKey = 0
    private(set) var isRunning = false

    /// Feeds the visuals preview while playing (nil = nobody watching).
    var liveFeatures: LiveFeatures? {
        get { shared.with { $0.live } }
        set { shared.with { $0.live = newValue } }
    }

    /// How far ahead of the speakers the mix is rendered.
    static let ahead = 0.25

    /// State shared with the render queue.
    nonisolated private final class Shared: @unchecked Sendable {
        let lock = NSLock()
        var generation = 0
        var queued = 0
        var pendingClips: [Clip]?
        var capture: [Float]?
        /// The visuals preview listens here (features of the audio about to be heard).
        var live: LiveFeatures?
        func with<T>(_ f: (Shared) -> T) -> T { lock.lock(); defer { lock.unlock() }; return f(self) }
    }

    init() {
        engine.attach(player)
    }

    /// Timeline position being heard.
    var currentTime: Double {
        guard isRunning, let nt = player.lastRenderTime, let pt = player.playerTime(forNodeTime: nt), pt.sampleRate > 0 else {
            return anchorTimeline
        }
        let played = max(0, Double(pt.sampleTime) / pt.sampleRate)
        return tempo.reference(atReal: anchorReal + played)
    }

    func start(clips: [Clip], master: Double, tempo map: TempoMap, gridOffset: Double, from t: Double,
               sampleRate: Double = 44_100) throws {
        stop()
        tempo = map
        anchorTimeline = t
        anchorReal = map.real(t)
        lastClips = clips
        lastMaster = master
        sessionKey = MixRenderSession.structureKey(clips, master: master)
        let session = try MixRenderSession(clips: clips, master: master, tempo: map, gridOffset: gridOffset,
                                           sampleRate: sampleRate, from: t, waitForCalibration: false)
        if connectedFormat != session.format {
            engine.disconnectNodeOutput(player)
            engine.connect(player, to: engine.mainMixerNode, format: session.format)
            connectedFormat = session.format
        }
        #if DEBUG
        engine.mainMixerNode.outputVolume = debugMuted ? 0 : 1
        #endif
        if !engine.isRunning {
            engine.prepare()
            try engine.start()
        }
        let gen: Int = shared.with { s in
            s.generation += 1
            s.queued = 0
            s.pendingClips = nil
            #if DEBUG
            s.capture = captureArmed ? [] : nil
            #endif
            return s.generation
        }
        #if DEBUG
        captureArmed = false
        #endif
        shared.with { $0.live }?.reset(sampleRate: sampleRate, at: AVAudioFramePosition((map.real(t) * sampleRate).rounded()))
        // A little audio before the player starts, the rest on the queue.
        let prefill = Int(0.08 * sampleRate)
        while shared.with({ $0.queued }) < prefill {
            try Self.renderOne(session, to: player, shared: shared)
        }
        player.play()
        isRunning = true
        let target = Int(Self.ahead * sampleRate)
        let shared = self.shared, player = self.player
        queue.async {
            while shared.with({ $0.generation }) == gen {
                if let new = shared.with({ s -> [Clip]? in defer { s.pendingClips = nil }; return s.pendingClips }) {
                    _ = session.update(clips: new, master: master)
                }
                if shared.with({ $0.queued }) < target {
                    do { try Self.renderOne(session, to: player, shared: shared, generation: gen) } catch { break }
                } else {
                    usleep(2000)
                }
            }
            session.stop()
        }
    }

    nonisolated private static func renderOne(_ session: MixRenderSession, to player: AVAudioPlayerNode, shared: Shared,
                                  generation: Int? = nil) throws {
        let f0 = session.absoluteFrame
        let b = try session.renderNext()
        if let live = shared.with({ $0.live }), let d = b.floatChannelData {
            let n = Int(b.frameLength), chs = Int(b.format.channelCount)
            var mono = [Float](repeating: 0, count: n)
            for c in 0..<chs { for i in 0..<n { mono[i] += d[c][i] } }
            if chs > 1 { for i in 0..<n { mono[i] /= Float(chs) } }
            live.feed(mono, at: f0)
        }
        guard let copy = AVAudioPCMBuffer(pcmFormat: b.format, frameCapacity: b.frameLength),
              let src = b.floatChannelData, let dst = copy.floatChannelData else { return }
        copy.frameLength = b.frameLength
        let n = Int(b.frameLength), chs = Int(b.format.channelCount)
        for c in 0..<chs { dst[c].update(from: src[c], count: n) }
        let ok: Bool = shared.with { s in
            if let g = generation, g != s.generation { return false }
            s.queued += n
            #if DEBUG
            if s.capture != nil {
                for i in 0..<n {
                    var x: Float = 0
                    for c in 0..<chs { x += src[c][i] }
                    s.capture!.append(x / Float(chs))
                }
            }
            #endif
            return true
        }
        guard ok else { return }
        player.scheduleBuffer(copy) { shared.with { $0.queued -= n } }
    }

    func stop() {
        if isRunning { anchorTimeline = currentTime }
        shared.with { $0.generation += 1 }
        queue.sync {}            // the render loop has finished its step and left
        player.stop()
        isRunning = false
        shared.with { $0.queued = 0 }
        if engine.isRunning { engine.pause() }
    }

    /// Takes over the current mix. Returns true when the change moves audio in time: start again from `currentTime`.
    @discardableResult
    func applyAutomation(clips: [Clip], master: Double, gridOffset: Double, time t: Double) -> Bool {
        guard isRunning, clips != lastClips || master != lastMaster else { return false }
        let masterChanged = master != lastMaster
        lastClips = clips
        lastMaster = master
        if masterChanged || MixRenderSession.structureKey(clips, master: master) != sessionKey { return true }
        shared.with { $0.pendingClips = clips }
        return false
    }

    #if DEBUG
    // MARK: Debug capture: exactly the audio sent to the speakers.
    var debugMuted = false
    /// Record from the next start on.
    var captureArmed = false

    func finishCapture() -> (samples: [Float], sampleRate: Double)? {
        let s: [Float]? = shared.with { st in defer { st.capture = nil }; return st.capture }
        guard let s else { return nil }
        return (s, connectedFormat?.sampleRate ?? 44_100)
    }
    #endif
}
