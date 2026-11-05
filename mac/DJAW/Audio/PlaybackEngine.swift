import AVFoundation

/// Shared DJ-style 3-band EQ configuration.
nonisolated enum DJEQ {
    static func configure(_ eq: AVAudioUnitEQ) {
        let bands = eq.bands
        guard bands.count >= 3 else { return }
        bands[0].filterType = .lowShelf
        bands[0].frequency = 180
        bands[0].gain = 0
        bands[0].bypass = false

        bands[1].filterType = .parametric
        bands[1].frequency = 1000
        bands[1].bandwidth = 2.0
        bands[1].gain = 0
        bands[1].bypass = false

        bands[2].filterType = .highShelf
        bands[2].frequency = 4500
        bands[2].gain = 0
        bands[2].bypass = false
    }

    static func configureEcho(_ delay: AVAudioUnitDelay, master: Double) {
        delay.delayTime = min(2, 60 / max(master, 1) * 0.75)
        delay.feedback = 55
        delay.lowPassCutoff = 7000
        delay.wetDryMix = 0
    }

    /// The time-stretch rate actually used: never exactly 1, so the time-pitch unit always processes (and always has
    /// the same read-ahead, which offline rendering compensates — see BufferFeeder).
    static func stretchRate(_ r: Double) -> Double { abs(r - 1) < 0.00002 ? 1.00002 : r }

    /// player → time-pitch → EQ → DJ FX → send → echo → reverb → mixer → main mixer
    /// - Parameters:
    ///   - stems: the track plays from its separated stems (two players: instrumental and vocals), so the
    ///     transition can turn the vocals / the instrumental down.
    ///   - laneReverb: a drawn reverb lane needs the reverb unit.
    static func buildChain(engine: AVAudioEngine, format: AVAudioFormat, clip: Clip, master: Double, tempo: Double,
                           stems: Bool = false, laneReverb: Bool = false) -> Chain {
        let chain = Chain(clipID: clip.id, usesReverb: laneReverb || (clip.fx?.contains { $0.kind == .reverb } ?? false), stems: stems)
        configure(chain.eq)
        configureEcho(chain.delay, master: tempo)
        chain.reverb.loadFactoryPreset(.largeHall2)
        chain.reverb.wetDryMix = 0
        chain.reverb.bypass = !chain.usesReverb
        chain.pitch.rate = Float(stretchRate(clip.rate(master: tempo)))
        chain.pitch.pitch = Float(min(2400, max(-2400, clip.pitchCents(master: tempo))))
        for node in chain.nodes { engine.attach(node) }
        if let vocals = chain.vocalPlayer, let stemMix = chain.stemMix {
            engine.connect(chain.player, to: stemMix, format: format)
            engine.connect(vocals, to: stemMix, format: format)
            engine.connect(stemMix, to: chain.pitch, format: format)
        } else {
            engine.connect(chain.player, to: chain.pitch, format: format)
        }
        engine.connect(chain.pitch, to: chain.eq, format: format)
        engine.connect(chain.eq, to: chain.fx, format: format)
        engine.connect(chain.fx, to: chain.send, format: format)
        engine.connect(chain.send, to: chain.delay, format: format)
        engine.connect(chain.delay, to: chain.reverb, format: format)
        engine.connect(chain.reverb, to: chain.mixer, format: format)
        engine.connect(chain.mixer, to: engine.mainMixerNode, format: nil)
        chain.mixer.outputVolume = 0
        return chain
    }
}

/// The nodes one track plays through, and how automation drives them.
nonisolated final class Chain {
    let clipID: UUID
    let usesReverb: Bool
    let player = AVAudioPlayerNode()
    let pitch = AVAudioUnitTimePitch()
    let eq = AVAudioUnitEQ(numberOfBands: 3)
    let fx: AVAudioUnitEffect = DJFX.make()
    let send = AVAudioMixerNode()
    let delay = AVAudioUnitDelay()
    let reverb = AVAudioUnitReverb()
    let mixer = AVAudioMixerNode()
    var kernel: FXKernel? { (fx.auAudioUnit as? DJFXUnit)?.kernel }
    private var lastRate: Float = -1
    private var lastCents: Float = .nan
    private var lastDelay: Double = -1

    /// With stems: `player` plays the instrumental, this one the vocals; both meet in `stemMix`.
    let vocalPlayer: AVAudioPlayerNode?
    let stemMix: AVAudioMixerNode?

    init(clipID: UUID, usesReverb: Bool, stems: Bool = false) {
        self.clipID = clipID
        self.usesReverb = usesReverb
        vocalPlayer = stems ? AVAudioPlayerNode() : nil
        stemMix = stems ? AVAudioMixerNode() : nil
    }

    var nodes: [AVAudioNode] {
        [player, pitch, eq, fx, send, delay, reverb, mixer] + [vocalPlayer, stemMix].compactMap { $0 }
    }

    /// - Parameters:
    ///   - tempo: mix BPM now (as heard).
    ///   - beat: master beat position now (for beat-synced effects).
    ///   - snapTolerance: how far (beats) the effect clock may drift before it is re-aligned.
    func apply(_ state: Automation.State, clip: Clip, tempo: Double, beat: Double, snapTolerance: Double) {
        if let vocals = vocalPlayer {
            player.volume = max(0, state.instrumental)
            vocals.volume = max(0, state.vocal)
        }
        let bands = eq.bands
        if bands.count >= 3 {
            bands[0].gain = state.low
            bands[1].gain = state.mid
            bands[2].gain = state.high
        }
        let rate = Float(DJEQ.stretchRate(clip.rate(master: tempo)))
        if abs(rate - lastRate) > 0.000002 {
            pitch.rate = rate
            lastRate = rate
        }
        let cents = Float(min(2400, max(-2400, clip.pitchCents(master: tempo))))
        if !(abs(cents - lastCents) < 0.05) {
            pitch.pitch = cents
            lastCents = cents
        }

        // Echo: the echo-out transition wins over an echo effect region.
        let beatSec = 60 / max(tempo, 1)
        var wantDelay = beatSec * 0.75
        if state.echoWet > 0 {
            send.outputVolume = state.send
            delay.wetDryMix = state.echoWet
            delay.feedback = 55
        } else if state.fx.echo > 0 {
            send.outputVolume = 1
            delay.wetDryMix = 15 + 35 * state.fx.echo
            delay.feedback = 30 + 30 * state.fx.echo
            wantDelay = beatSec * Double(state.fx.echoDiv)
        } else {
            send.outputVolume = state.send
            delay.wetDryMix = 0
        }
        wantDelay = min(2, wantDelay)
        if abs(wantDelay - lastDelay) > lastDelay * 0.01 {
            delay.delayTime = wantDelay
            lastDelay = wantDelay
        }
        if usesReverb { reverb.wetDryMix = 55 * state.fx.reverb }

        if let k = kernel {
            k.target = state.fx
            k.bpm = clip.tempoSync ? tempo : clip.bpm
            if abs(k.beat - beat) > snapTolerance {
                k.beatTarget = beat
                k.resync &+= 1
            }
        }
        mixer.outputVolume = state.volume
    }
}

/// Frame ranges to schedule back to back for a clip (loops repeat ranges, jumps skip them),
/// starting `fromElapsed` source seconds into what the clip plays.
nonisolated enum ClipSchedule {
    static func ranges(_ segs: [PlaySegment], fromElapsed e0: Double, upTo eEnd: Double? = nil, sampleRate sr: Double,
                       fileLength: AVAudioFramePosition) -> [(start: AVAudioFramePosition, count: AVAudioFrameCount)] {
        var out: [(AVAudioFramePosition, AVAudioFrameCount)] = []
        for var seg in segs {
            if let eEnd {
                guard seg.elapsed < eEnd - 1e-6 else { break }
                seg.to = min(seg.to, seg.from + (eEnd - seg.elapsed))
            }
            let len = seg.to - seg.from
            guard seg.elapsed + len > e0 + 1e-6 else { continue }
            let skip = max(0, e0 - seg.elapsed)
            let a = AVAudioFramePosition(((seg.from + skip) * sr).rounded())
            let b = min(fileLength, AVAudioFramePosition((seg.to * sr).rounded()))
            if b > a { out.append((max(0, a), AVAudioFrameCount(b - max(0, a)))) }
        }
        return out
    }
}

extension ClipSchedule {
    /// Schedules what `clip` plays from `fromElapsed` on: its pieces, then (if any) the brake / backspin.
    @discardableResult
    /// - The first 0.4 s come from memory (no disk read at the moment the track starts) with a 3 ms fade-in.
    /// - `startAt`: player sample time of the first sample (0 = as soon as the player runs).
    /// - `cutOut`: the next track cuts in, so the last 5 ms (the cut overlap) fade out here, sample-accurately,
    ///   instead of waiting for the next automation tick (which left a short gap at cut-ins).
    nonisolated static func schedule(_ clip: Clip, outro: OutroFX?, on player: AVAudioPlayerNode, file: AVAudioFile,
                         fromElapsed e0: Double, cutOut: Bool = false, startAt: AVAudioFramePosition = 0) -> Bool {
        let sr = file.processingFormat.sampleRate
        // The first piece starts at `startAt` on the player's own clock (see PlaybackEngine.start); the rest follow on.
        var first = true
        func when() -> AVAudioTime? {
            defer { first = false }
            return first && startAt > 0 ? AVAudioTime(sampleTime: startAt, atRate: sr) : nil
        }
        let ranges = ranges(clip.playSegments(), fromElapsed: e0, upTo: outro?.elapsedStart,
                            sampleRate: sr, fileLength: file.length)
        let reader = try? AVAudioFile(forReading: clip.url)
        func read(_ start: AVAudioFramePosition, _ n: AVAudioFrameCount) -> AVAudioPCMBuffer? {
            guard let reader, n > 0,
                  let buf = AVAudioPCMBuffer(pcmFormat: reader.processingFormat, frameCapacity: n) else { return nil }
            reader.framePosition = start
            guard (try? reader.read(into: buf, frameCount: n)) != nil, buf.frameLength == n else { return nil }
            return buf
        }
        func ramp(_ buf: AVAudioPCMBuffer, from a: Int, count n: Int, up: Bool) {
            guard let d = buf.floatChannelData, n > 0 else { return }
            for ch in 0..<Int(buf.format.channelCount) {
                for k in 0..<n where a + k < Int(buf.frameLength) {
                    let g = Float(k + 1) / Float(n + 1)
                    d[ch][a + k] *= up ? g : 1 - g
                }
            }
        }
        let head = AVAudioFrameCount(0.4 * sr), fadeIn = Int(0.003 * sr), fadeOut = AVAudioFrameCount(0.005 * sr)
        for (k, r) in ranges.enumerated() {
            var start = r.start, count = r.count
            let tailFade = cutOut && outro == nil && k == ranges.count - 1
            if k == 0, let buf = read(start, min(count, head)) {
                ramp(buf, from: 0, count: fadeIn, up: true)
                if tailFade && buf.frameLength == count {
                    let n = Int(min(fadeOut, count))
                    ramp(buf, from: Int(count) - n, count: n, up: false)
                }
                player.scheduleBuffer(buf, at: when())
                start += AVAudioFramePosition(buf.frameLength)
                count -= buf.frameLength
                if count == 0 { continue }
            }
            if tailFade {
                let n = min(count, fadeOut)
                if count > n { player.scheduleSegment(file, startingFrame: start, frameCount: count - n, at: when()) }
                if let buf = read(start + AVAudioFramePosition(count - n), n) {
                    ramp(buf, from: 0, count: Int(n), up: false)
                    player.scheduleBuffer(buf, at: when())
                } else {
                    player.scheduleSegment(file, startingFrame: start + AVAudioFramePosition(count - n), frameCount: n, at: when())
                }
            } else {
                player.scheduleSegment(file, startingFrame: start, frameCount: count, at: when())
            }
        }
        var any = !ranges.isEmpty
        if let outro {
            let p0 = Clip.source(atElapsed: outro.elapsedStart, segs: clip.playSegments(), trimStart: clip.trimStart)
            if let buf = TurntableFX.buffer(url: clip.url, kind: outro.kind, at: p0, length: outro.length) {
                let skip = AVAudioFrameCount(max(0, (e0 - outro.elapsedStart) * sr))
                if skip == 0 {
                    player.scheduleBuffer(buf, at: when())
                    any = true
                } else if skip < buf.frameLength, let part = AVAudioPCMBuffer(pcmFormat: buf.format, frameCapacity: buf.frameLength - skip),
                          let src = buf.floatChannelData, let dst = part.floatChannelData {
                    part.frameLength = buf.frameLength - skip
                    for ch in 0..<Int(buf.format.channelCount) {
                        dst[ch].update(from: src[ch] + Int(skip), count: Int(part.frameLength))
                    }
                    player.scheduleBuffer(part, at: when())
                    any = true
                }
            }
        }
        return any
    }
}

/// Offline rendering (export, render checks, the mix waveform): feeds a clip's audio to its player from memory,
/// a few seconds ahead of where it plays, read synchronously from the file.
///
/// Every player starts with the render and is first given silence (`preRoll`), as many source frames as its
/// time-stretch unit will have consumed by the time the track comes in. A player started later with `play()` begins
/// on the render's output clock, but behind the time-stretch it is pulled on the *stretched* clock, which runs
/// slower or faster — so a stretched track came in late by (1 − rate) × its start time: about 1 s after half a
/// minute, 15 s after nine minutes. That is what made exports differ from the preview.
nonisolated final class BufferFeeder {
    private struct Piece { var start: AVAudioFramePosition; var count: AVAudioFrameCount }
    private let player: AVAudioPlayerNode
    private let reader: AVAudioFile
    private let sourceRate: Double
    private var pieces: [Piece]
    private var k = 0
    private var offset: AVAudioFrameCount = 0
    private var outroBuffer: AVAudioPCMBuffer?
    private let cutOut: Bool
    /// Silence still to queue before the audio (source frames).
    private var silenceLeft: Int
    /// Source frames handed to the player so far / (estimated) used by the render so far.
    private var scheduled: Double = 0
    private var consumed: Double = 0
    let isEmpty: Bool

    /// - Parameter preRoll: seconds of source audio the player's time-stretch consumes before the track comes in.
    /// - Parameter file: read this file instead of the track's own (one of its stems, same length and timing).
    init?(clip: Clip, outro: OutroFX?, player: AVAudioPlayerNode, fromElapsed e0: Double, cutOut: Bool, preRoll: Double = 0,
          compensateLead: Bool = true, file: URL? = nil) {
        guard let reader = try? AVAudioFile(forReading: file ?? clip.url) else { return nil }
        let sr = reader.processingFormat.sampleRate
        // Plus the time-stretch unit's read-ahead: it takes in that many frames before giving anything out, so
        // without them every track came out ~90 ms early in exports.
        silenceLeft = max(0, Int((preRoll * sr).rounded())) + (compensateLead ? Self.stretchLead(sampleRate: sr, format: reader.processingFormat) : 0)
        self.player = player
        self.reader = reader
        sourceRate = sr
        pieces = ClipSchedule.ranges(clip.playSegments(), fromElapsed: e0, upTo: outro?.elapsedStart,
                                     sampleRate: sr, fileLength: reader.length).map { Piece(start: $0.start, count: $0.count) }
        self.cutOut = cutOut && outro == nil
        if let outro {
            let p0 = Clip.source(atElapsed: outro.elapsedStart, segs: clip.playSegments(), trimStart: clip.trimStart)
            if let buf = TurntableFX.buffer(url: file ?? clip.url, kind: outro.kind, at: p0, length: outro.length) {
                let skip = AVAudioFrameCount(max(0, (e0 - outro.elapsedStart) * sr))
                if skip == 0 {
                    outroBuffer = buf
                } else if skip < buf.frameLength, let part = AVAudioPCMBuffer(pcmFormat: buf.format, frameCapacity: buf.frameLength - skip),
                          let src = buf.floatChannelData, let dst = part.floatChannelData {
                    part.frameLength = buf.frameLength - skip
                    for ch in 0..<Int(buf.format.channelCount) { dst[ch].update(from: src[ch] + Int(skip), count: Int(part.frameLength)) }
                    outroBuffer = part
                }
            }
        }
        isEmpty = pieces.isEmpty && outroBuffer == nil
    }

    nonisolated(unsafe) private static var leads: [Double: Int] = [:]
    private static let leadLock = NSLock()

    /// How many frames AVAudioUnitTimePitch reads ahead of what it plays (measured once per sample rate by
    /// rendering a click through it offline).
    static func stretchLead(sampleRate sr: Double, format: AVAudioFormat) -> Int {
        leadLock.lock()
        if let v = leads[sr] { leadLock.unlock(); return v }
        leadLock.unlock()
        var lead = 0
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode(), pitch = AVAudioUnitTimePitch()
        let at = Int(sr / 2)
        if let out = AVAudioFormat(standardFormatWithSampleRate: sr, channels: format.channelCount),
           (try? engine.enableManualRenderingMode(.offline, format: out, maximumFrameCount: 4096)) != nil,
           let click = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sr * 2)),
           let buf = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: 512) {
            engine.attach(player); engine.attach(pitch)
            engine.connect(player, to: pitch, format: format)
            engine.connect(pitch, to: engine.mainMixerNode, format: format)
            pitch.rate = 0.98
            click.frameLength = click.frameCapacity
            // A 1 kHz tone that starts at `at`: where it starts in the output shows the read-ahead.
            if let d = click.floatChannelData {
                for ch in 0..<Int(format.channelCount) {
                    for i in 0..<Int(click.frameLength) {
                        d[ch][i] = i < at ? 0 : 0.5 * Float(sin(2 * Double.pi * 1000 * Double(i - at) / sr))
                    }
                }
            }
            if (try? engine.start()) != nil {
                player.scheduleBuffer(click, at: nil)
                player.play()
                var out: [Float] = []
                while out.count < Int(sr * 1.5) {
                    guard let st = try? engine.renderOffline(512, to: buf), st == .success, let d = buf.floatChannelData else { break }
                    for i in 0..<Int(buf.frameLength) { out.append(abs(d[0][i])) }
                }
                engine.stop()
                // First point where the tone reaches half its level (max over 48 samples ≈ one cycle).
                var onset: Int?
                var i = 0
                while i + 48 < out.count {
                    if (out[i..<(i + 48)].max() ?? 0) > 0.25 { onset = i + 24; break }
                    i += 8
                }
                if let onset { lead = max(0, Int((Double(at) - Double(onset) * 0.98).rounded())) }
                #if DEBUG
                print("[DJAW] time-pitch read-ahead at \(sr) Hz: \(lead) frames (onset \(onset ?? -1))")
                #endif
            }
        }
        leadLock.lock(); leads[sr] = lead; leadLock.unlock()
        return lead
    }

    nonisolated(unsafe) private static var attachLatencies: [Double: Int] = [:]

    /// A time-pitch unit added while the render is already running gives out silence for this many of its input
    /// frames before the audio starts (measured once per sample rate: a tone through a unit attached mid-render).
    /// The render attaches each track that much ahead of its start, so it is heard on its exact frame.
    static func attachLatency(sampleRate sr: Double, format: AVAudioFormat) -> Int {
        leadLock.lock()
        if let v = attachLatencies[sr] { leadLock.unlock(); return v }
        leadLock.unlock()
        var latency = 0
        let engine = AVAudioEngine()
        if let out = AVAudioFormat(standardFormatWithSampleRate: sr, channels: format.channelCount),
           (try? engine.enableManualRenderingMode(.offline, format: out, maximumFrameCount: 4096)) != nil,
           let tone = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sr)),
           let buf = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: 512) {
            _ = engine.mainMixerNode
            tone.frameLength = tone.frameCapacity
            if let d = tone.floatChannelData {
                for ch in 0..<Int(format.channelCount) {
                    for i in 0..<Int(tone.frameLength) { d[ch][i] = 0.5 * Float(sin(2 * Double.pi * 1000 * Double(i) / sr)) }
                }
            }
            if (try? engine.start()) != nil {
                var pos = 0
                // Run a while with nothing attached, then attach (like a track coming in mid-mix).
                while pos < Int(sr / 2) { _ = try? engine.renderOffline(512, to: buf); pos += 512 }
                let player = AVAudioPlayerNode(), pitch = AVAudioUnitTimePitch()
                engine.attach(player); engine.attach(pitch)
                engine.connect(player, to: pitch, format: format)
                engine.connect(pitch, to: engine.mainMixerNode, format: format)
                pitch.rate = 0.98
                player.scheduleBuffer(tone, at: nil)
                player.play()
                var out: [Float] = []
                while out.count < Int(sr * 0.6) {
                    guard let st = try? engine.renderOffline(512, to: buf), st == .success, let d = buf.floatChannelData else { break }
                    for i in 0..<Int(buf.frameLength) { out.append(abs(d[0][i])) }
                }
                engine.stop()
                var i = 0
                while i + 48 < out.count {
                    if (out[i..<(i + 48)].max() ?? 0) > 0.25 { latency = Int((Double(i + 24) * 0.98).rounded()); break }
                    i += 8
                }
                #if DEBUG
                print("[DJAW] time-pitch latency when attached mid-render at \(sr) Hz: \(latency) input frames")
                #endif
            }
        }
        leadLock.lock(); attachLatencies[sr] = latency; leadLock.unlock()
        return latency
    }

    /// Seconds of source audio a track's time-stretch consumes between two real (heard) times of the mix:
    /// the integral of its stretch rate, which follows the mix tempo.
    static func preRoll(_ clip: Clip, master: Double, tempo: TempoMap, fromReal a: Double, toReal b: Double) -> Double {
        guard b > a else { return 0 }
        var sum = 0.0, t = a
        let step = 0.01
        while t < b {
            let dt = min(step, b - t)
            sum += dt * DJEQ.stretchRate(clip.rate(master: tempo.bpm(at: tempo.reference(atReal: t + dt / 2))))
            t += dt
        }
        return sum
    }

    /// The render produced `frames` output frames at `outputRate` with this track at time-stretch `rate`.
    func advance(frames: Int, outputRate: Double, rate: Double) {
        consumed += Double(frames) * max(rate, 0.01) * sourceRate / outputRate
    }

    /// Keeps at least `seconds` of source audio queued beyond what the render has used.
    func feed(ahead seconds: Double = 3) {
        let want = consumed + seconds * sourceRate
        let step = AVAudioFrameCount(sourceRate)   // 1 s per buffer
        let fadeIn = Int(0.003 * sourceRate), fadeOut = AVAudioFrameCount(0.005 * sourceRate)
        while scheduled < want, silenceLeft > 0 {
            let n = AVAudioFrameCount(min(silenceLeft, Int(step)))
            guard let buf = AVAudioPCMBuffer(pcmFormat: reader.processingFormat, frameCapacity: n) else { break }
            buf.frameLength = n
            if let d = buf.floatChannelData {
                for ch in 0..<Int(buf.format.channelCount) { d[ch].update(repeating: 0, count: Int(n)) }
            }
            player.scheduleBuffer(buf, at: nil)
            scheduled += Double(n)
            silenceLeft -= Int(n)
        }
        while scheduled < want, silenceLeft == 0, k < pieces.count {
            let p = pieces[k]
            var n = min(step, p.count - offset)
            let last = k == pieces.count - 1
            // Keep the closing fade of a cut-out inside one buffer.
            if last && cutOut && p.count - offset - n < fadeOut { n = p.count - offset }
            guard n > 0, let buf = AVAudioPCMBuffer(pcmFormat: reader.processingFormat, frameCapacity: n) else { k += 1; offset = 0; continue }
            reader.framePosition = p.start + AVAudioFramePosition(offset)
            guard (try? reader.read(into: buf, frameCount: n)) != nil, buf.frameLength > 0 else { k += 1; offset = 0; continue }
            if let d = buf.floatChannelData {
                let len = Int(buf.frameLength), chs = Int(buf.format.channelCount)
                if k == 0 && offset == 0 {
                    for ch in 0..<chs { for i in 0..<min(fadeIn, len) { d[ch][i] *= Float(i + 1) / Float(fadeIn + 1) } }
                }
                if last && cutOut && offset + buf.frameLength >= p.count {
                    let m = min(Int(fadeOut), len)
                    for ch in 0..<chs { for i in 0..<m { d[ch][len - m + i] *= 1 - Float(i + 1) / Float(m + 1) } }
                }
            }
            player.scheduleBuffer(buf, at: nil)
            scheduled += Double(buf.frameLength)
            offset += buf.frameLength
            if offset >= p.count || buf.frameLength < n { k += 1; offset = 0 }
        }
        if silenceLeft == 0, k >= pieces.count, let o = outroBuffer, scheduled < want {
            player.scheduleBuffer(o, at: nil)
            scheduled += Double(o.frameLength)
            outroBuffer = nil
        }
    }
}

/// Realtime preview. Each clip gets player → time-pitch → EQ → mixer.
/// Start times are scheduled on the host clock so clips stay beat-aligned.
final class PlaybackEngine {
    private let engine = AVAudioEngine()

    private var voices: [Chain] = []
    private(set) var isRunning = false
    private var anchorHostTime: UInt64 = 0
    private var anchorTimeline: Double = 0
    private var tempo = TempoMap(reference: 120)

    /// Current timeline (reference) position.
    var currentTime: Double {
        guard isRunning else { return anchorTimeline }
        let now = mach_absolute_time()
        guard now > anchorHostTime else { return anchorTimeline }
        let real = tempo.real(anchorTimeline) + AVAudioTime.seconds(forHostTime: now - anchorHostTime)
        return tempo.reference(atReal: real)
    }

    func start(clips: [Clip], master: Double, tempo map: TempoMap, outros: [UUID: OutroFX], from t: Double) throws {
        stop()
        tempo = map

        struct Pending {
            let chain: Chain
            let delay: Double
            let startAt: AVAudioFramePosition
            let file: AVAudioFile
            let clip: Clip
            let e0: Double
            let cutOut: Bool
        }

        var pending: [Pending] = []
        for (ci, clip) in clips.enumerated() {
            guard clip.end(master: master) > t else { continue }
            guard let file = try? AVAudioFile(forReading: clip.url) else { continue }
            let chain = DJEQ.buildChain(engine: engine, format: file.processingFormat, clip: clip, master: master,
                                        tempo: map.bpm(at: max(t, clip.start)))
            voices.append(chain)
            // Time-stretched players run on a stretched clock (behind the time-pitch unit): a track that comes in
            // later starts at the sample its clock will have reached by then, not after a plain delay — otherwise it
            // came in late by (1 − rate) × the wait.
            let wait = BufferFeeder.preRoll(clip, master: master, tempo: map, fromReal: map.real(t), toReal: max(map.real(t), map.real(clip.start)))
            pending.append(Pending(chain: chain, delay: 0, startAt: AVAudioFramePosition((wait * file.processingFormat.sampleRate).rounded()),
                                   file: file, clip: clip,
                                   e0: max(0, t - clip.start) * clip.rate(master: master),
                                   cutOut: ci + 1 < clips.count && clips[ci + 1].transition == .cut))
        }

        anchorTimeline = t
        guard !pending.isEmpty else {
            isRunning = false
            return
        }

        engine.prepare()
        try engine.start()
        #if DEBUG
        engine.mainMixerNode.outputVolume = debugMuted ? 0 : 1
        #endif

        let started = pending.filter {
            ClipSchedule.schedule($0.clip, outro: outros[$0.clip.id], on: $0.chain.player, file: $0.file, fromElapsed: $0.e0, cutOut: $0.cutOut,
                                  startAt: $0.startAt)
        }
        anchorHostTime = mach_absolute_time() + AVAudioTime.hostTime(forSeconds: 0.12)
        for p in started {
            let host = anchorHostTime + AVAudioTime.hostTime(forSeconds: p.delay)
            p.chain.player.play(at: AVAudioTime(hostTime: host))
        }
        isRunning = true
    }

    func stop() {
        if isRunning { anchorTimeline = currentTime }
        for v in voices { v.player.stop() }
        if engine.isRunning { engine.stop() }
        for v in voices {
            for node in v.nodes { engine.detach(node) }
        }
        voices.removeAll()
        isRunning = false
    }

    #if DEBUG
    // MARK: Debug capture (compare what the preview plays with an export)

    /// Keeps the speakers silent while capturing.
    var debugMuted = false
    private var capture: CaptureBuffer?

    final class CaptureBuffer: @unchecked Sendable {
        let lock = NSLock()
        var out: [Float]
        let sampleRate: Double
        let anchorHost: UInt64

        init(seconds: Double, sampleRate: Double, anchorHost: UInt64) {
            out = [Float](repeating: 0, count: Int(seconds * sampleRate) + 1)
            self.sampleRate = sampleRate
            self.anchorHost = anchorHost
        }

        func add(_ buf: AVAudioPCMBuffer, _ when: AVAudioTime) {
            guard when.isHostTimeValid, when.hostTime >= anchorHost, let d = buf.floatChannelData else { return }
            let start = Int((AVAudioTime.seconds(forHostTime: when.hostTime - anchorHost) * sampleRate).rounded())
            let n = Int(buf.frameLength), ch = Int(buf.format.channelCount)
            lock.lock(); defer { lock.unlock() }
            for k in 0..<n where start + k < out.count {
                var x: Float = 0
                for c in 0..<ch { x += d[c][k] }
                out[start + k] += x / Float(ch)
            }
        }
    }

    /// Records every track's output (after its fader) for `seconds`, aligned to the playback start.
    func startCapture(seconds: Double) {
        guard isRunning, let first = voices.first else { return }
        let sr = first.mixer.outputFormat(forBus: 0).sampleRate
        let cap = CaptureBuffer(seconds: seconds + 0.5, sampleRate: sr, anchorHost: anchorHostTime)
        capture = cap
        for v in voices {
            v.mixer.installTap(onBus: 0, bufferSize: 512, format: nil) { b, w in cap.add(b, w) }
        }
    }

    func finishCapture() -> (samples: [Float], sampleRate: Double)? {
        guard let cap = capture else { return nil }
        for v in voices { v.mixer.removeTap(onBus: 0) }
        capture = nil
        cap.lock.lock(); defer { cap.lock.unlock() }
        return (cap.out, cap.sampleRate)
    }
    #endif

    func applyAutomation(clips: [Clip], master: Double, gridOffset: Double, time t: Double) {
        guard !voices.isEmpty else { return }
        var indexByID: [UUID: Int] = [:]
        for (i, c) in clips.enumerated() { indexByID[c.id] = i }
        let bpm = tempo.bpm(at: t)
        let beat = (t - gridOffset) * master / 60
        for v in voices {
            guard let i = indexByID[v.clipID] else {
                v.mixer.outputVolume = 0
                continue
            }
            // A track about to start gets its levels set ahead of time (it is silent until its scheduled start),
            // so a cut-in is heard from its first sample instead of from the next timer tick.
            let start = clips[i].start
            let te = t < start && start - t < 0.25 ? start + 0.0005 : t
            let state = Automation.state(clips: clips, index: i, time: te, master: master)
            v.apply(state, clip: clips[i], tempo: bpm, beat: beat, snapTolerance: 0.12)
        }
    }
}
