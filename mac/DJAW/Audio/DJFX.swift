import AVFoundation
import AudioToolbox

// MARK: - DSP kernel

/// Sample-accurate DJ effects for one track: loop roll, colour filter, phaser, flanger,
/// bit crusher and trans gate. Parameters are written from the control thread
/// (plain stores — a torn read only lasts one buffer); everything else is render-thread only.
nonisolated final class FXKernel: @unchecked Sendable {
    // Written by the control thread.
    var target = FXState()
    /// Tempo the beat clock runs at (beats per minute, as heard).
    var bpm: Double = 120
    var beatTarget: Double = 0
    var resync = 0
    /// Read by the control thread to decide whether to resync.
    private(set) var beat: Double = 0
    private var seenResync = -1

    private var sr: Double = 44100
    private var channels = 2
    private var maxFrames = 0

    // Smoothed controls.
    private var sFilter: Float = 0, sPhaser: Float = 0, sFlanger: Float = 0, sCrush: Float = 0
    private var sGateDepth: Float = 0, gateGain: Float = 1, rollMix: Float = 0

    // Per-channel state.
    private var ic1 = [Float](repeating: 0, count: 2), ic2 = [Float](repeating: 0, count: 2)
    private var apz = [Float](repeating: 0, count: 8), phFB = [Float](repeating: 0, count: 2)
    private var held = [Float](repeating: 0, count: 2)
    private var flRing: UnsafeMutablePointer<Float>?
    private let flSize = 4096
    private var flWrite = 0
    private var rollRing: UnsafeMutablePointer<Float>?
    private var rollSize = 0
    private var rolling = false
    private var rollLen = 1
    private var rollPos = 0

    // Per-block scratch (allocated once).
    private var sFilt: UnsafeMutablePointer<Float>?   // filter a1, a2, a3, k, mode per sample (5 floats)
    private var sGate: UnsafeMutablePointer<Float>?
    private var sFlDelay: UnsafeMutablePointer<Float>?
    private var sPhC: UnsafeMutablePointer<Float>?
    private var sHold: UnsafeMutablePointer<Float>?   // 1 = take a new sample
    private var sRoll: UnsafeMutablePointer<Int32>?   // index into the roll ring, −1 = dry
    private var sRec: UnsafeMutablePointer<Float>?    // 1 = record the live signal at that index
    private var sRollMix: UnsafeMutablePointer<Float>?
    private var sRollDry: UnsafeMutablePointer<Float>?
    private var sCrushMix: UnsafeMutablePointer<Float>?
    private var sCrushStep: UnsafeMutablePointer<Float>?
    private var holdCounter = 0
    private var idle = true

    deinit { free() }

    private func free() {
        for p in [flRing, rollRing, sFilt, sGate, sFlDelay, sPhC, sHold, sRec, sRollMix, sRollDry, sCrushMix, sCrushStep] { p?.deallocate() }
        sRoll?.deallocate()
        flRing = nil; rollRing = nil; sFilt = nil; sGate = nil; sFlDelay = nil; sPhC = nil
        sHold = nil; sRoll = nil; sRec = nil; sRollMix = nil; sRollDry = nil; sCrushMix = nil; sCrushStep = nil
    }

    func prepare(sampleRate: Double, channels: Int, maxFrames: Int) {
        free()
        sr = sampleRate
        self.channels = min(2, max(1, channels))
        self.maxFrames = maxFrames
        func alloc(_ n: Int) -> UnsafeMutablePointer<Float> {
            let p = UnsafeMutablePointer<Float>.allocate(capacity: n)
            p.initialize(repeating: 0, count: n)
            return p
        }
        flRing = alloc(flSize * 2)
        rollSize = Int(sampleRate * 4)
        rollRing = alloc(rollSize * 2)
        sFilt = alloc(maxFrames * 5)
        sGate = alloc(maxFrames)
        sFlDelay = alloc(maxFrames)
        sPhC = alloc(maxFrames)
        sHold = alloc(maxFrames)
        sRollMix = alloc(maxFrames)
        sRollDry = alloc(maxFrames)
        sRec = alloc(maxFrames)
        sCrushMix = alloc(maxFrames)
        sCrushStep = alloc(maxFrames)
        sRoll = UnsafeMutablePointer<Int32>.allocate(capacity: maxFrames)
        sRoll!.initialize(repeating: -1, count: maxFrames)
        ic1 = [0, 0]; ic2 = [0, 0]; apz = [Float](repeating: 0, count: 8); phFB = [0, 0]; held = [0, 0]
        rolling = false
        idle = true
    }

    /// Processes `frames` samples from `input` into `output` (which may be the same memory).
    func process(input: UnsafeMutableAudioBufferListPointer, output: UnsafeMutableAudioBufferListPointer, frames n: Int) {
        guard n > 0, n <= maxFrames, let sFilt, let sGate, let sFlDelay, let sPhC, let sHold, let sRoll,
              let sRec, let sRollMix, let sRollDry, let sCrushMix, let sCrushStep, let flRing, let rollRing else {
            copyThrough(input, output, n)
            return
        }
        if resync != seenResync {
            seenResync = resync
            beat = beatTarget
        }
        let t = target
        let dBeat = max(bpm, 1) / 60 / sr
        let quietNow = t.isQuiet
        let settled = abs(sFilter) < 0.0005 && sPhaser < 0.0005 && sFlanger < 0.0005 && sCrush < 0.0005
            && sGateDepth < 0.0005 && rollMix < 0.0005 && !rolling
        if quietNow && settled {
            if !idle { for i in 0..<2 { ic1[i] = 0; ic2[i] = 0; phFB[i] = 0 }; for i in 0..<8 { apz[i] = 0 } }
            idle = true
            sFilter = 0; sPhaser = 0; sFlanger = 0; sCrush = 0; sGateDepth = 0; gateGain = 1; rollMix = 0
            beat += dBeat * Double(n)
            copyThrough(input, output, n)
            return
        }
        idle = false

        let kSmooth = Float(1 - exp(-1 / (0.012 * sr)))
        let kGate = Float(1 - exp(-1 / (0.0015 * sr)))
        let kRoll = Float(1 - exp(-1 / (0.003 * sr)))
        let nyq = Float(sr * 0.45)
        let gateDiv = Double(max(t.gateDiv, 0.03125))
        let flDiv = Double(max(t.flangerDiv, 0.5))
        let phDiv = Double(max(t.phaserDiv, 0.5))

        var a1: Float = 1, a2: Float = 0, a3: Float = 0, kq: Float = 1.4, mode: Float = 0
        var phC: Float = 0
        for i in 0..<n {
            sFilter += (t.filter - sFilter) * kSmooth
            sPhaser += (t.phaser - sPhaser) * kSmooth
            sFlanger += (t.flanger - sFlanger) * kSmooth
            sCrush += (t.crush - sCrush) * kSmooth
            sGateDepth += (t.gate - sGateDepth) * kSmooth
            beat += dBeat

            // Colour filter: coefficients every 16 samples.
            if i & 15 == 0 {
                let f = sFilter
                let a = abs(f)
                let fc: Float = f < 0 ? min(nyq, 20000 * powf(0.012, a)) : max(10, 20 * powf(120, a))
                let g = tanf(Float.pi * min(fc, nyq) / Float(sr))
                kq = 1 / (0.707 + 0.65 * a)
                a1 = 1 / (1 + g * (g + kq)); a2 = g * a1; a3 = g * a2
                mode = abs(f) < 0.0005 ? 0 : (f < 0 ? -1 : 1)
                // Phaser sweep 250 Hz…2.5 kHz.
                let ph = beat / phDiv
                let lfo = Float(0.5 - 0.5 * cos(2 * Double.pi * (ph - floor(ph))))
                let fp = 250 * powf(10, lfo)
                let tp = tanf(Float.pi * fp / Float(sr))
                phC = (tp - 1) / (tp + 1)
            }
            let o = i * 5
            sFilt[o] = a1; sFilt[o + 1] = a2; sFilt[o + 2] = a3; sFilt[o + 3] = kq; sFilt[o + 4] = mode
            sPhC[i] = phC

            // Flanger: 0.6–4 ms delay.
            let fph = beat / flDiv
            let flfo = 0.5 - 0.5 * cos(2 * Double.pi * (fph - floor(fph)))
            sFlDelay[i] = Float((0.0006 + 0.0034 * flfo) * sr)

            // Trans gate: open on the first half of each division.
            let gph = beat / gateDiv
            let open = (gph - floor(gph)) < 0.5
            let gTarget: Float = open ? 1 : 1 - sGateDepth
            gateGain += (gTarget - gateGain) * kGate
            sGate[i] = gateGain

            // Bit crusher.
            let c = sCrush
            let holdN = 1 + Int(c * c * 24)
            holdCounter += 1
            if holdCounter >= holdN { holdCounter = 0; sHold[i] = 1 } else { sHold[i] = 0 }
            sCrushMix[i] = min(1, c * 4)
            sCrushStep[i] = powf(2, -(15 - c * 11))

            // Loop roll: record a slice of the live signal, then repeat it.
            let wantRoll = t.roll > 0.5
            if wantRoll && !rolling {
                rolling = true
                rollPos = 0
                rollLen = max(64, min(rollSize - 1, Int(Double(max(t.rollDiv, 0.03125)) * 60 / max(bpm, 1) * sr)))
            } else if !wantRoll && rolling && rollMix < 0.01 {
                rolling = false
            }
            rollMix += ((wantRoll ? 1 : 0) - rollMix) * kRoll
            if rolling {
                let p = rollPos % rollLen
                sRoll[i] = Int32(p)
                sRec[i] = rollPos < rollLen ? 1 : 0
                var edge: Float = 1
                if rollPos >= rollLen {
                    let fadeN = max(1, min(96, rollLen / 4))
                    if p < fadeN { edge = Float(p) / Float(fadeN) } else if p > rollLen - fadeN { edge = Float(rollLen - p) / Float(fadeN) }
                }
                sRollMix[i] = rollMix * edge
                sRollDry[i] = 1 - rollMix
                rollPos += 1
            } else {
                sRoll[i] = -1
            }
        }

        let flMix = sFlanger, phMix = sPhaser
        let chs = min(channels, input.count, output.count)
        let startFl = flWrite
        for ch in 0..<chs {
            guard let ip = input[ch].mData?.assumingMemoryBound(to: Float.self),
                  let op = output[ch].mData?.assumingMemoryBound(to: Float.self) else { continue }
            let ring = rollRing + ch * rollSize
            let fl = flRing + ch * flSize
            var fw = startFl
            var c1 = ic1[ch], c2 = ic2[ch]
            var fb = phFB[ch]
            var h = held[ch]
            let zb = ch * 4
            for i in 0..<n {
                var x = ip[i]
                // Roll.
                let ri = Int(sRoll[i])
                if ri >= 0 {
                    if sRec[i] > 0 { ring[ri] = x }
                    x = x * sRollDry[i] + ring[ri] * sRollMix[i]
                }

                // Colour filter.
                let o = i * 5
                let md = sFilt[o + 4]
                if md != 0 {
                    let v3 = x - c2
                    let v1 = sFilt[o] * c1 + sFilt[o + 1] * v3
                    let v2 = c2 + sFilt[o + 1] * c1 + sFilt[o + 2] * v3
                    c1 = 2 * v1 - c1
                    c2 = 2 * v2 - c2
                    x = md < 0 ? v2 : x - sFilt[o + 3] * v1 - v2
                }

                // Phaser (4 all-pass stages with feedback).
                if phMix > 0.0005 {
                    let cc = sPhC[i]
                    var u = x + 0.45 * fb
                    for s in 0..<4 {
                        let y = cc * u + apz[zb + s]
                        apz[zb + s] = u - cc * y
                        u = y
                    }
                    fb = u
                    x = (x + phMix * u) / (1 + 0.5 * phMix)
                }

                // Flanger.
                if flMix > 0.0005 {
                    let d = sFlDelay[i]
                    var rp = Float(fw) - d
                    if rp < 0 { rp += Float(flSize) }
                    let i0 = Int(rp) % flSize
                    let fr = rp - Float(Int(rp))
                    let dly = fl[i0] * (1 - fr) + fl[(i0 + 1) % flSize] * fr
                    fl[fw] = x + 0.6 * flMix * dly
                    fw += 1
                    if fw >= flSize { fw = 0 }
                    x = (x + flMix * dly) / (1 + 0.45 * flMix)
                }

                // Bit crusher.
                let cm = sCrushMix[i]
                if cm > 0.0005 {
                    if sHold[i] > 0 { h = x }
                    let step = sCrushStep[i]
                    let q = (h / step).rounded() * step
                    x = x * (1 - cm) + q * cm
                }

                op[i] = x * sGate[i]
            }
            if ch == chs - 1 { flWrite = fw }
            ic1[ch] = c1; ic2[ch] = c2; phFB[ch] = fb; held[ch] = h
        }
        // Mono input feeding stereo output.
        if chs == 1 && output.count > 1, let a = output[0].mData, let b = output[1].mData, a != b {
            b.copyMemory(from: a, byteCount: n * 4)
        }
    }

    private func copyThrough(_ input: UnsafeMutableAudioBufferListPointer, _ output: UnsafeMutableAudioBufferListPointer, _ n: Int) {
        for ch in 0..<output.count {
            guard let o = output[ch].mData, let i = input[min(ch, input.count - 1)].mData, o != i else { continue }
            o.copyMemory(from: i, byteCount: n * 4)
        }
    }
}

// MARK: - Audio unit

nonisolated private final class BufferHolder: @unchecked Sendable {
    var abl: UnsafeMutablePointer<AudioBufferList>?
    var capacity: AUAudioFrameCount = 0
    /// The scratch buffer's own channel memory (upstream units may swap the pointers while pulling).
    var data: [UnsafeMutableRawPointer?] = []
}

/// In-process effect unit wrapping `FXKernel`.
nonisolated final class DJFXUnit: AUAudioUnit {
    let kernel = FXKernel()
    private var inBus: AUAudioUnitBus!
    private var outBus: AUAudioUnitBus!
    private var inArray: AUAudioUnitBusArray!
    private var outArray: AUAudioUnitBusArray!
    private var scratch: AVAudioPCMBuffer?
    private let holder = BufferHolder()

    override init(componentDescription: AudioComponentDescription, options: AudioComponentInstantiationOptions = []) throws {
        try super.init(componentDescription: componentDescription, options: options)
        let fmt = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 2)!
        inBus = try AUAudioUnitBus(format: fmt)
        outBus = try AUAudioUnitBus(format: fmt)
        inArray = AUAudioUnitBusArray(audioUnit: self, busType: .input, busses: [inBus])
        outArray = AUAudioUnitBusArray(audioUnit: self, busType: .output, busses: [outBus])
        maximumFramesToRender = 4096
    }

    override var inputBusses: AUAudioUnitBusArray { inArray }
    override var outputBusses: AUAudioUnitBusArray { outArray }
    override var canProcessInPlace: Bool { true }

    override func allocateRenderResources() throws {
        try super.allocateRenderResources()
        let fmt = inBus.format
        guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: maximumFramesToRender) else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(kAudioUnitErr_FailedInitialization))
        }
        scratch = buf
        holder.abl = buf.mutableAudioBufferList
        holder.data = UnsafeMutableAudioBufferListPointer(buf.mutableAudioBufferList).map { $0.mData }
        holder.capacity = maximumFramesToRender
        kernel.prepare(sampleRate: outBus.format.sampleRate, channels: Int(outBus.format.channelCount),
                       maxFrames: Int(maximumFramesToRender))
    }

    override func deallocateRenderResources() {
        holder.abl = nil
        scratch = nil
        super.deallocateRenderResources()
    }

    override var internalRenderBlock: AUInternalRenderBlock {
        let kernel = self.kernel
        let holder = self.holder
        return { _, timestamp, frameCount, _, outputData, _, pullInputBlock in
            guard let pull = pullInputBlock, let inABL = holder.abl, frameCount <= holder.capacity else {
                return kAudioUnitErr_NoConnection
            }
            let inList = UnsafeMutableAudioBufferListPointer(inABL)
            for i in 0..<inList.count {
                if i < holder.data.count { inList[i].mData = holder.data[i] }
                inList[i].mDataByteSize = frameCount * 4
            }
            var flags = AudioUnitRenderActionFlags()
            let status = pull(&flags, timestamp, frameCount, 0, inABL)
            if status != noErr { return status }
            let outList = UnsafeMutableAudioBufferListPointer(outputData)
            for i in 0..<outList.count {
                if outList[i].mData == nil { outList[i].mData = inList[min(i, inList.count - 1)].mData }
                outList[i].mDataByteSize = frameCount * 4
            }
            kernel.process(input: inList, output: outList, frames: Int(frameCount))
            return noErr
        }
    }
}

nonisolated enum DJFX {
    static let description = AudioComponentDescription(componentType: kAudioUnitType_Effect,
                                                       componentSubType: 0x646A_6678,       // 'djfx'
                                                       componentManufacturer: 0x444A_4157,  // 'DJAW'
                                                       componentFlags: 0, componentFlagsMask: 0)
    private static let registered: Bool = {
        AUAudioUnit.registerSubclass(DJFXUnit.self, as: description, name: "DJAW: DJ FX", version: 1)
        return true
    }()

    static func make() -> AVAudioUnitEffect {
        _ = registered
        return AVAudioUnitEffect(audioComponentDescription: description)
    }
}

// MARK: - Brake / backspin

/// Renders the turntable stop or backspin that replaces the end of the outgoing track.
nonisolated enum TurntableFX {
    nonisolated(unsafe) private static let cache = NSCache<NSString, AVAudioPCMBuffer>()

    /// `p0`: source seconds where the effect starts. `length`: source seconds it lasts.
    static func buffer(url: URL, kind: TransitionStyle, at p0: Double, length: Double) -> AVAudioPCMBuffer? {
        let key = "\(url.path)|\(kind.rawValue)|\(Int(p0 * 1000))|\(Int(length * 1000))" as NSString
        if let b = cache.object(forKey: key) { return b }
        guard let b = render(url: url, kind: kind, at: p0, length: length) else { return nil }
        cache.setObject(b, forKey: key)
        return b
    }

    private static func render(url: URL, kind: TransitionStyle, at p0: Double, length D: Double) -> AVAudioPCMBuffer? {
        guard D > 0.01, let file = try? AVAudioFile(forReading: url) else { return nil }
        let fmt = file.processingFormat
        let sr = fmt.sampleRate
        let R = 3.2
        let backDist = kind == .backspin ? R * D / 2.4 + 0.15 : 0
        let fwdDist = kind == .backspin ? 0.2 : D * 0.5 + 0.1
        let w0 = max(0, AVAudioFramePosition(((p0 - backDist) * sr).rounded()))
        let w1 = min(file.length, AVAudioFramePosition(((p0 + fwdDist) * sr).rounded()))
        guard w1 - w0 > 8, let src = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(w1 - w0)) else { return nil }
        file.framePosition = w0
        do { try file.read(into: src, frameCount: AVAudioFrameCount(w1 - w0)) } catch { return nil }
        let outFrames = AVAudioFrameCount(D * sr)
        guard let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: outFrames),
              let si = src.floatChannelData, let so = out.floatChannelData else { return nil }
        out.frameLength = outFrames
        let n = Int(src.frameLength)
        let start = Double(AVAudioFramePosition((p0 * sr).rounded()) - w0)
        let ramp = min(0.07, 0.15 * D)

        for ch in 0..<Int(fmt.channelCount) {
            let s = si[ch], o = so[ch]
            var pos = start
            var lp: Float = 0
            for i in 0..<Int(outFrames) {
                let tau = Double(i) / sr
                let u = tau / D
                var r: Double
                var g: Double
                if kind == .backspin {
                    if tau < ramp {
                        r = 1 - (1 + R) * tau / ramp
                    } else {
                        let v = (tau - ramp) / max(D - ramp, 0.001)
                        r = -R * pow(max(0, 1 - v), 1.8)
                    }
                    g = u > 0.6 ? pow((1 - u) / 0.4, 1.5) : 1
                } else {
                    r = pow(max(0, 1 - u), 1.6)
                    g = u > 0.9 ? (1 - u) / 0.1 : 1
                }
                // Cubic (Hermite) read.
                let ip = Int(floor(pos))
                let f = Float(pos - floor(pos))
                func at(_ k: Int) -> Float { s[min(max(k, 0), n - 1)] }
                let xm1 = at(ip - 1), x0 = at(ip), x1 = at(ip + 1), x2 = at(ip + 2)
                let c1 = 0.5 * (x1 - xm1)
                let c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2
                let c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1)
                let y = ((c3 * f + c2) * f + c1) * f + x0
                // Fast spinning aliases: soften it in proportion to the speed.
                let a = Float(min(1, 1.2 / max(abs(r), 1)))
                lp += (y - lp) * a
                o[i] = lp * Float(g)
                pos += r
            }
        }
        return out
    }
}
