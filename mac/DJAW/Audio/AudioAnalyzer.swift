import AVFoundation

nonisolated struct TrackAnalysis: Sendable, Codable {
    var title: String
    var artist: String
    var duration: Double
    var sampleRate: Double
    var bpm: Double
    var firstBeat: Double
    var waveform: Waveform
    /// Intro / drop / outro, phrase grid and key (nil if the track is too short to tell).
    var structure: TrackStructure?
    /// Other tempo readings that fit the beat almost as well (e.g. ×0.75 or ×1.5).
    var tempoOptions: [TempoOption] = []
    /// Per-hop band energies, kept so the structure can be re-analysed for another tempo reading.
    var energies: BandEnergies?
    /// Neural beats / downbeats / cue suggestions (nil if the models are unavailable).
    var neural: NeuralResult?
    /// Genre (Discogs-EffNet + the file's genre tag).
    var genre: GenreResult?
}

/// What the neural analysis tells the structure analysis.
nonisolated struct StructureHints: Sendable, Codable {
    /// Beat grid the neural beat tracker trusts (bar lines are then not re-guessed from energy).
    var gridBPM: Double?
    var gridFirstBeat: Double?
    var cues: [CueHint] = []
    /// Neural beat times (to measure, bar by bar, how well the steady grid fits the music).
    var beats: [Double] = []
}

/// An alternative reading of a track's tempo with its own beat grid.
nonisolated struct TempoOption: Sendable, Hashable, Codable {
    var bpm: Double
    var firstBeat: Double
    /// Beat-fit relative to the detected tempo (1 = as good).
    var fit: Double
}

nonisolated struct BandEnergies: Sendable {
    var low: [Float]
    var full: [Float]
    var high: [Float]
    var frameRate: Double
    var duration: Double
    var key: MusicalKey?
    var hints: StructureHints?
    /// 2 ms RMS envelopes (below ~150 Hz and full band) for placing beats on the actual attacks.
    var fineLow: [Float] = []
    var fineFull: [Float] = []
    var fineRate: Double = 500

    /// Median distance (seconds) from the beat lines to the nearest sharp attack (kick / snare) within ±45 ms,
    /// over `from`…`to` (source seconds). Add it to `firstBeat` to put the grid on the attacks. nil = too few attacks.
    func onsetOffset(bpm: Double, firstBeat: Double, from t0: Double = 0, to t1: Double? = nil, minCount: Int = 8) -> Double? {
        let n = min(fineLow.count, fineFull.count)
        guard n > 10, bpm > 1 else { return nil }
        let eps: Float = 1e-4
        var od = [Float](repeating: 0, count: n)
        for i in 2..<n {
            let dl = max(0, log(fineLow[i] + eps) - log(fineLow[i - 2] + eps))
            let df = max(0, log(fineFull[i] + eps) - log(fineFull[i - 2] + eps))
            od[i] = dl + 0.5 * df
        }
        let rate = fineRate, beat = 60 / bpm, tol = 0.045
        let end = min(t1 ?? duration, Double(n) / rate)
        var offs: [Double] = []
        var k = Int(ceil((t0 - firstBeat) / beat))
        while true {
            let t = firstBeat + Double(k) * beat
            k += 1
            if t > end { break }
            let a = Int((t - tol) * rate), b = Int((t + tol) * rate)
            guard a >= 1, b < n - 1 else { continue }
            var j = a
            for q in a..<b where od[q] > od[j] { j = q }
            guard od[j] >= 0.3 else { continue }
            let y0 = Double(od[j - 1]), y1 = Double(od[j]), y2 = Double(od[j + 1])
            let den = y0 - 2 * y1 + y2
            let frac = den < 0 ? 0.5 * (y0 - y2) / den : 0
            // The flux compares frames two apart: the attack starts about one frame before the peak.
            offs.append((Double(j) + frac - 1) / rate - t)
        }
        guard offs.count >= minCount else { return nil }
        offs.sort()
        let med = offs[offs.count / 2]
        return abs(med) < tol ? med : nil
    }

    func structure(bpm: Double, firstBeat: Double) -> TrackStructure? {
        StructureAnalyzer.analyze(eLow: low, eFull: full, eHigh: high, frameRate: frameRate,
                                  bpm: bpm, firstBeat: firstBeat, duration: duration, key: key, hints: hints)
    }

    /// Structure on a grid the neural tracker found for one stretch of the track (bar lines kept as given).
    func structure(trustedBPM bpm: Double, firstBeat: Double) -> TrackStructure? {
        var h = hints ?? StructureHints()
        h.gridBPM = bpm
        h.gridFirstBeat = firstBeat
        return StructureAnalyzer.analyze(eLow: low, eFull: full, eHigh: high, frameRate: frameRate,
                                         bpm: bpm, firstBeat: firstBeat, duration: duration, key: key, hints: h)
    }
}

nonisolated enum AudioAnalyzerError: LocalizedError {
    case unreadable(String)

    var errorDescription: String? {
        switch self {
        case .unreadable(let name): return L("\(name) を読み込めませんでした。", "Could not read \(name).")
        }
    }
}

/// Reads an audio file once and produces waveform data, BPM and the first downbeat.
nonisolated enum AudioAnalyzer {
    /// Analyses one file. Files are analysed one after another (the queue keeps CPU, memory and the
    /// progress estimate predictable); a file that is already cached goes through almost instantly.
    /// - Parameter fresh: analyse again even if a stored analysis exists ("re-analyse").
    static func analyze(url: URL, fresh: Bool = false) async throws -> TrackAnalysis {
        let progress = AnalysisProgress.shared
        // Analysed before (on this Mac, or stored in the opened .djaw): no work at all.
        if !fresh, let cached = AnalysisCache.load(url) { return cached }
        progress.register(url)
        defer { progress.done(url) }
        await AnalysisQueue.shared.acquire(rank: progress.rank(url))
        do {
            if !fresh, let cached = AnalysisCache.load(url) {
                await AnalysisQueue.shared.release()
                return cached
            }
            let r = try await analyzeNow(url: url)
            AnalysisCache.store(url, r)
            await AnalysisQueue.shared.release()
            return r
        } catch {
            await AnalysisQueue.shared.release()
            throw error
        }
    }

    private static func analyzeNow(url: URL) async throws -> TrackAnalysis {
        var title = url.deletingPathExtension().lastPathComponent
        var artist = ""
        let asset = AVURLAsset(url: url)
        if let items = try? await asset.load(.commonMetadata) {
            for item in items {
                if item.commonKey == .commonKeyTitle,
                   let value = try? await item.load(.stringValue), !value.isEmpty {
                    title = value
                }
                if item.commonKey == .commonKeyArtist,
                   let value = try? await item.load(.stringValue), !value.isEmpty {
                    artist = value
                }
            }
        }
        var result = try analyzeAudio(url: url)
        result.title = title
        result.artist = artist
        result.genre = await GenreAnalyzer.analyze(url: url)
        return result
    }

    static func analyzeAudio(url: URL) throws -> TrackAnalysis {
        let file: AVAudioFile
        do {
            file = try AVAudioFile(forReading: url)
        } catch {
            throw AudioAnalyzerError.unreadable(url.lastPathComponent)
        }
        let format = file.processingFormat
        let sampleRate = format.sampleRate
        let channels = Int(format.channelCount)
        let totalFrames = file.length
        let duration = Double(totalFrames) / sampleRate
        let hop = max(64, Int((sampleRate / 100).rounded()))
        let frameRate = sampleRate / Double(hop)

        let capacity: AVAudioFrameCount = 1 << 16
        guard channels > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
            throw AudioAnalyzerError.unreadable(url.lastPathComponent)
        }

        let progress = AnalysisProgress.shared
        progress.begin(url, .read)
        var reads = 0
        let estimatedBins = Int(totalFrames) / hop + 2
        var peaks: [Float] = []
        var lows: [Float] = []
        var energyFull: [Float] = []
        var energyLow: [Float] = []
        var energyHigh: [Float] = []
        energyHigh.reserveCapacity(estimatedBins)
        peaks.reserveCapacity(estimatedBins)
        lows.reserveCapacity(estimatedBins)
        energyFull.reserveCapacity(estimatedBins)
        energyLow.reserveCapacity(estimatedBins)

        let alpha = Float(1 - exp(-2 * Double.pi * 150 / sampleRate))
        // One-pole high-pass at 3 kHz (hi-hats, vocals' air) for the structure analysis.
        let hpCoef = Float(exp(-2 * Double.pi * 3000 / sampleRate))
        var hpPrevIn: Float = 0
        var hpOut: Float = 0
        var accHighSq: Float = 0
        let chroma = ChromaAccumulator(sampleRate: sampleRate)
        var mono: [Float] = []
        let invChannels = 1 / Float(channels)
        var lowpass: Float = 0
        var accMax: Float = 0
        var accLowMax: Float = 0
        var accSq: Float = 0
        var accLowSq: Float = 0
        var count = 0
        // 2 ms envelopes for attack-accurate beat grids.
        let fineHop = max(16, Int((sampleRate / 500).rounded()))
        var fineLow: [Float] = [], fineFull: [Float] = []
        fineLow.reserveCapacity(Int(totalFrames) / fineHop + 2)
        fineFull.reserveCapacity(Int(totalFrames) / fineHop + 2)
        var fAccL: Float = 0, fAccF: Float = 0, fCount = 0

        func flush() {
            let n = Float(max(count, 1))
            peaks.append(accMax)
            lows.append(accLowMax)
            energyFull.append((accSq / n).squareRoot())
            energyLow.append((accLowSq / n).squareRoot())
            energyHigh.append((accHighSq / n).squareRoot())
            accMax = 0; accLowMax = 0; accSq = 0; accLowSq = 0; accHighSq = 0; count = 0
        }

        while file.framePosition < totalFrames {
            reads += 1
            if reads % 16 == 0 { progress.update(url, .read, Double(file.framePosition) / Double(max(1, totalFrames))) }
            do {
                try file.read(into: buffer, frameCount: capacity)
            } catch {
                break
            }
            let frames = Int(buffer.frameLength)
            if frames == 0 { break }
            guard let data = buffer.floatChannelData else { break }
            if mono.count != frames { mono = [Float](repeating: 0, count: frames) }
            for i in 0..<frames {
                var x: Float = 0
                for c in 0..<channels { x += data[c][i] }
                x *= invChannels
                lowpass += alpha * (x - lowpass)
                hpOut = hpCoef * (hpOut + x - hpPrevIn)
                hpPrevIn = x
                accHighSq += hpOut * hpOut
                mono[i] = x
                let ax = abs(x)
                let al = abs(lowpass)
                if ax > accMax { accMax = ax }
                if al > accLowMax { accLowMax = al }
                accSq += x * x
                accLowSq += lowpass * lowpass
                count += 1
                if count == hop { flush() }
                fAccL += lowpass * lowpass
                fAccF += x * x
                fCount += 1
                if fCount == fineHop {
                    fineLow.append((fAccL / Float(fineHop)).squareRoot())
                    fineFull.append((fAccF / Float(fineHop)).squareRoot())
                    fAccL = 0; fAccF = 0; fCount = 0
                }
            }
            chroma.process(mono)
        }
        if count > 0 { flush() }

        let maxPeak = max(peaks.max() ?? 1, 0.0001)
        let waveform = Waveform(binsPerSecond: frameRate, peaks: peaks, lows: lows, maxPeak: maxPeak)
        let classic = estimateTempo(energyFull: energyFull, energyLow: energyLow, frameRate: frameRate)
        var energies = BandEnergies(low: energyLow, full: energyFull, high: energyHigh,
                                    frameRate: frameRate, duration: duration, key: chroma.estimateKey())
        progress.finish(url, .read)
        let neural = NeuralAnalyzer.analyze(url: url)
        energies.fineLow = fineLow
        energies.fineFull = fineFull
        energies.fineRate = sampleRate / Double(fineHop)
        var tempo = chooseGrid(classic: classic, neural: neural)
        // Put the beat lines on the actual attacks (the trackers are only accurate to ~10–40 ms).
        if let off = energies.onsetOffset(bpm: tempo.bpm, firstBeat: tempo.firstBeat) {
            tempo.firstBeat += off
        }
        energies.hints = StructureHints(gridBPM: tempo.fromNeural ? tempo.bpm : nil,
                                        gridFirstBeat: tempo.fromNeural ? tempo.firstBeat : nil,
                                        cues: neural?.cues ?? [], beats: neural?.beats ?? [])
        let structure = energies.structure(bpm: tempo.bpm, firstBeat: tempo.firstBeat)

        return TrackAnalysis(title: url.deletingPathExtension().lastPathComponent,
                             artist: "",
                             duration: duration,
                             sampleRate: sampleRate,
                             bpm: tempo.bpm,
                             // The structure check may move the downbeat to where the sections really change.
                             firstBeat: structure?.firstBeat ?? tempo.firstBeat,
                             waveform: waveform,
                             structure: structure,
                             tempoOptions: tempo.options,
                             energies: energies,
                             neural: neural)
    }

    /// Prefers the neural beat grid when it lands on the detected beats at least as well as the
    /// energy-based estimate (it nearly always does).
    static func chooseGrid(classic: (bpm: Double, firstBeat: Double, options: [TempoOption]), neural: NeuralResult?)
        -> (bpm: Double, firstBeat: Double, options: [TempoOption], fromNeural: Bool) {
        guard let n = neural, let g = n.grid else { return (classic.bpm, classic.firstBeat, classic.options, false) }
        let oldHit = NeuralAnalyzer.beatHitRate(beats: n.beats, bpm: classic.bpm, firstBeat: classic.firstBeat)
        let newHit = NeuralAnalyzer.beatHitRate(beats: n.beats, bpm: g.bpm, firstBeat: g.firstBeat)
        guard newHit >= oldHit - 0.02 else { return (classic.bpm, classic.firstBeat, classic.options, false) }
        // The neural grid already sits in the usual DJ range (87.5–180: DnB stays at 174, dubstep at 140).
        let bpm = g.bpm
        let fb = Mathx.posMod(g.firstBeat, 240 / bpm)
        var options: [TempoOption] = []
        for f in [1.0, 2.0, 0.5] where abs(g.bpm * f - bpm) > 0.5 {
            options.append(TempoOption(bpm: g.bpm * f, firstBeat: Mathx.posMod(g.firstBeat, 240 / (g.bpm * f)), fit: f == 1 ? 1 : 0.95))
        }
        options += classic.options.filter { o in options.allSatisfy { abs($0.bpm - o.bpm) > 0.5 } && abs(o.bpm - bpm) > 0.5 }
            .map { TempoOption(bpm: $0.bpm, firstBeat: $0.firstBeat, fit: $0.fit * 0.85) }
        return (bpm, fb, options, true)
    }

    // MARK: - Tempo

    static func estimateTempo(energyFull: [Float], energyLow: [Float], frameRate fr: Double) -> (bpm: Double, firstBeat: Double, options: [TempoOption]) {
        let n = energyFull.count
        guard n > Int(fr * 8) else { return (120, 0, []) }

        // Onset strength: positive log-energy flux, low band weighted.
        var logFull = [Double](repeating: 0, count: n)
        var logLow = [Double](repeating: 0, count: n)
        for i in 0..<n {
            logFull[i] = log1p(1000 * Double(energyFull[i]))
            logLow[i] = log1p(1000 * Double(energyLow[i]))
        }
        var flux = [Double](repeating: 0, count: n)
        for i in 1..<n {
            flux[i] = max(0, logFull[i] - logFull[i - 1]) + 1.5 * max(0, logLow[i] - logLow[i - 1])
        }
        var prefix = [Double](repeating: 0, count: n + 1)
        for i in 0..<n { prefix[i + 1] = prefix[i] + flux[i] }
        let w = 8
        var onset = [Double](repeating: 0, count: n)
        for i in 0..<n {
            let a = max(0, i - w)
            let b = min(n, i + w + 1)
            let mean = (prefix[b] - prefix[a]) / Double(b - a)
            onset[i] = max(0, flux[i] - mean)
        }

        // Autocorrelation over 60...200 BPM
        let minLag = max(1, Int(floor(fr * 60 / 200)))
        let maxLag = Int(ceil(fr * 60 / 60))
        guard maxLag + 2 < n / 2 else { return (120, 0, []) }
        var acf = [Double](repeating: 0, count: maxLag + 3)
        onset.withUnsafeBufferPointer { o in
            for lag in max(1, minLag - 1)...(maxLag + 1) {
                var s = 0.0
                let limit = n - lag
                var i = 0
                while i < limit {
                    s += o[i] * o[i + lag]
                    i += 1
                }
                acf[lag] = s / Double(limit)
            }
        }
        var bestLag = minLag
        var bestScore = -1.0
        for lag in minLag...maxLag {
            let bpm = fr * 60 / Double(lag)
            let weight = exp(-0.5 * pow(log2(bpm / 120) / 0.9, 2))
            let score = acf[lag] * weight
            if score > bestScore {
                bestScore = score
                bestLag = lag
            }
        }
        var lag = Double(bestLag)
        if bestLag > 1 {
            let y0 = acf[bestLag - 1], y1 = acf[bestLag], y2 = acf[bestLag + 1]
            let d = y0 - 2 * y1 + y2
            if abs(d) > 1e-12 {
                let shift = 0.5 * (y0 - y2) / d
                if abs(shift) < 1 { lag += shift }
            }
        }
        var bpm = fr * 60 / lag
        while bpm < 78 { bpm *= 2 }
        while bpm >= 178 { bpm /= 2 }

        // Comb refinement
        func comb(_ bpm: Double, phaseStep: Double) -> (score: Double, phase: Double) {
            let period = fr * 60 / bpm
            var best = -1.0
            var bestPhase = 0.0
            onset.withUnsafeBufferPointer { o in
                var phase = 0.0
                while phase < period {
                    var s = 0.0
                    var c = 0
                    var pos = phase
                    let last = Double(n - 1)
                    while pos < last {
                        let i = Int(pos)
                        let f = pos - Double(i)
                        s += o[i] * (1 - f) + o[i + 1] * f
                        c += 1
                        pos += period
                    }
                    let mean = c > 0 ? s / Double(c) : 0
                    if mean > best {
                        best = mean
                        bestPhase = phase
                    }
                    phase += phaseStep
                }
            }
            return (best, bestPhase)
        }

        var bestBPM = bpm
        var bestComb = comb(bpm, phaseStep: 1).score
        for candidate in stride(from: bpm - 1.5, through: bpm + 1.5, by: 0.05) {
            let s = comb(candidate, phaseStep: 1).score
            if s > bestComb { bestComb = s; bestBPM = candidate }
        }
        let coarse = bestBPM
        for candidate in stride(from: coarse - 0.06, through: coarse + 0.06, by: 0.01) {
            let s = comb(candidate, phaseStep: 1).score
            if s > bestComb { bestComb = s; bestBPM = candidate }
        }
        if abs(bestBPM - bestBPM.rounded()) < 0.07 {
            bestBPM = bestBPM.rounded()
        } else {
            bestBPM = (bestBPM * 100).rounded() / 100
        }

        // Downbeat guess: the beat on which the music starts is treated as beat 1.
        let sorted = logFull.sorted()
        let reference = sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.9))]
        let startFrame = logFull.firstIndex { $0 > reference * 0.5 } ?? 0
        func firstBeat(for bpm: Double) -> Double {
            let period = fr * 60 / bpm
            let phase = comb(bpm, phaseStep: 0.25).phase
            let beatIndex = Int(((Double(startFrame) - phase) / period).rounded())
            let downIndex = ((beatIndex % 4) + 4) % 4
            return (phase + Double(downIndex) * period) / fr
        }

        // Other readings (e.g. half-time, or 3:4 in tracks with a triplet / 16th grid)
        // that fit the onsets about as well. The mix chooses between them later.
        func refined(_ center: Double) -> (bpm: Double, score: Double) {
            var best = (bpm: center, score: comb(center, phaseStep: 1).score)
            for c in stride(from: center - 0.6, through: center + 0.6, by: 0.1) {
                let sc = comb(c, phaseStep: 1).score
                if sc > best.score { best = (c, sc) }
            }
            return best
        }
        func tidy(_ b: Double) -> Double {
            abs(b - b.rounded()) < 0.07 ? b.rounded() : (b * 100).rounded() / 100
        }
        var options: [TempoOption] = []
        let base = max(bestComb, 1e-9)
        for ratio in [0.5, 2.0 / 3, 0.75, 4.0 / 3, 1.5, 2.0] {
            let center = bestBPM * ratio
            guard center >= 70, center <= 200 else { continue }
            let r = refined(center)
            let fit = r.score / base
            guard fit >= 0.85 else { continue }
            let b = tidy(r.bpm)
            options.append(TempoOption(bpm: b, firstBeat: firstBeat(for: b), fit: fit))
        }
        return (bestBPM, firstBeat(for: bestBPM), options)
    }
}


/// First-come, first-served gate: one track is analysed at a time.
/// Waiting files go in the order they were added (lowest rank first), not in whatever order their tasks woke up.
actor AnalysisQueue {
    static let shared = AnalysisQueue()
    private var busy = false
    private var waiters: [(rank: Int, cont: CheckedContinuation<Void, Never>)] = []

    func acquire(rank: Int) async {
        guard busy else { busy = true; return }
        await withCheckedContinuation { waiters.append((rank, $0)) }
    }

    func release() {
        guard let k = waiters.indices.min(by: { waiters[$0].rank < waiters[$1].rank }) else { busy = false; return }
        waiters.remove(at: k).cont.resume()
    }
}
