import AVFoundation
import Accelerate
import CoreML
import CryptoKit

// MARK: - Genre families

/// Genre families the auto-mix knows how to mix differently.
nonisolated enum MixGenre: String, Codable, CaseIterable, Identifiable, Sendable {
    case house, techno, trance, ukg, bass, dnb, breaks, hard, breakcore, hiphop, pop, chill, band

    var id: String { rawValue }

    var title: String {
        switch self {
        case .house: return L("ハウス／ディスコ", "House / Disco")
        case .techno: return L("テクノ", "Techno")
        case .trance: return L("トランス", "Trance")
        case .ukg: return L("UKガラージ／ベースライン", "UK Garage / Bassline")
        case .bass: return L("ダブステップ／ベースミュージック", "Dubstep / Bass Music")
        case .dnb: return L("ドラムンベース／ジャングル", "Drum & Bass / Jungle")
        case .breaks: return L("ブレイクビーツ／エレクトロ", "Breaks / Electro")
        case .hard: return L("ハードコア／ハードスタイル", "Hardcore / Hardstyle")
        case .breakcore: return L("ブレイクコア／Dariacore", "Breakcore / Dariacore")
        case .hiphop: return L("ヒップホップ／R&B", "Hip-Hop / R&B")
        case .pop: return L("ポップ／ボーカル", "Pop / Vocal")
        case .chill: return L("アンビエント／ダウンテンポ", "Ambient / Downtempo")
        case .band: return L("バンド・生演奏", "Band / Live")
        }
    }

    var short: String {
        switch self {
        case .house: return "House"
        case .techno: return "Techno"
        case .trance: return "Trance"
        case .ukg: return "UKG"
        case .bass: return "Bass"
        case .dnb: return "DnB"
        case .breaks: return "Breaks"
        case .hard: return "Hard"
        case .breakcore: return "Breakcore"
        case .hiphop: return "Hip-Hop"
        case .pop: return "Pop"
        case .chill: return "Chill"
        case .band: return "Band"
        }
    }

    /// How tracks of this family are mixed (shown in the inspector).
    var mixSummary: String {
        switch self {
        case .house: return L("16〜32小節のベーススワップ。アウトロにイントロを重ね、後半はハイパスで抜く", "16–32-bar bass swaps, intro over outro, high-pass on the way out")
        case .techno: return L("32小節前後の長いブレンド。フィルターとハイパスで溶け込ませる", "Long ~32-bar blends, melted together with filters and high-pass")
        case .trance: return L("16〜32小節。ブレイク前のフレーズ頭で入れ替える", "16–32 bars, swapped on the phrase before the breakdown")
        case .ukg: return L("8〜16小節。ベースを入れ替え、テンポは大きく動かさない（揺れを崩さない）", "8–16 bars with a bass swap; tempo kept steady to keep the swing")
        case .bass: return L("8小節前後で次のドロップへ。ドロップ頭のカットインやエコーアウトも使う", "~8 bars into the next drop; drop cut-ins and echo-outs too")
        case .dnb: return L("16小節で次のドロップに重ねる（ダブルドロップ）。リワインド（バックスピン）も使う", "16 bars landing drop on drop (double drop); rewinds (backspins) too")
        case .breaks: return L("8〜16小節のブレンドとカットインを半々", "A mix of 8–16-bar blends and cut-ins")
        case .hard: return L("4〜8小節の短いつなぎ。カットイン・バックスピンでテンポごと切り替え", "Short 4–8-bar mixes; cut-ins and backspins that switch tempo")
        case .breakcore: return L("おいしい所だけを小節頭のカットインでつなぐ", "Only the best bars, joined with cut-ins on the downbeat")
        case .hiphop: return L("ブレンドは短く（〜8小節）。カットイン・エコーアウトが中心", "Short blends (≤8 bars); mostly cut-ins and echo-outs")
        case .pop: return L("歌がぶつからないよう 4〜8 小節。エコーアウトで切り替えることも", "4–8 bars so vocals don't clash; sometimes an echo-out")
        case .chill: return L("EQ を大きく動かさない長いクロスフェード。リバーブで余韻を残す", "Long crossfades without hard EQ moves; reverb tails")
        case .band: return L("テンポを無理に合わせず、短いクロスフェードかエコーアウト", "No heavy tempo matching: short crossfades or echo-outs")
        }
    }

    /// Tempo range tracks of this family are normally played at (nil = anything goes).
    var tempoRange: ClosedRange<Double>? {
        switch self {
        case .house: return 110...135
        case .techno: return 118...155
        case .trance: return 124...150
        case .ukg: return 124...145
        case .bass: return 132...152
        case .dnb: return 158...182
        case .breaks: return 110...145
        case .hard: return 140...210
        case .hiphop: return 60...115
        case .breakcore, .pop, .chill, .band: return nil
        }
    }

    /// Families that sit next to each other in a DJ set (a blend between them still sounds natural).
    func isNeighbor(of o: MixGenre) -> Bool {
        if o == self { return true }
        let pairs: [Set<MixGenre>] = [[.house, .techno], [.house, .ukg], [.house, .trance], [.techno, .trance],
                                      [.ukg, .bass], [.ukg, .breaks], [.bass, .dnb], [.dnb, .breaks], [.breaks, .house],
                                      [.hard, .trance], [.hard, .breakcore], [.hiphop, .pop], [.pop, .house],
                                      [.chill, .band], [.hiphop, .bass], [.breakcore, .dnb], [.pop, .hard]]
        return pairs.contains([self, o])
    }

    /// Family of one Discogs style ("Parent---Style").
    static func family(ofDiscogs label: String) -> MixGenre? {
        let parts = label.components(separatedBy: "---")
        guard parts.count == 2 else { return nil }
        let parent = parts[0], style = parts[1]
        if let f = styleFamily[style], parent == "Electronic" || parent == "Hip Hop" || parent == "Funk / Soul" || parent == "Latin" || parent == "Pop" {
            return f
        }
        switch parent {
        case "Electronic": return .chill
        case "Hip Hop", "Reggae": return .hiphop
        case "Pop": return .pop
        case "Classical", "Stage & Screen": return .chill
        case "Non-Music", "Children's": return nil
        default: return .band
        }
    }

    private static let styleFamily: [String: MixGenre] = {
        var m: [String: MixGenre] = [:]
        func put(_ f: MixGenre, _ names: [String]) { for n in names { m[n] = f } }
        put(.house, ["Acid House", "Deep House", "Disco", "Disco Polo", "Euro House", "Euro-Disco", "Garage House", "Ghetto House",
                     "Hip-House", "House", "Italo House", "Italo-Disco", "Nu-Disco", "Progressive House", "Tech House", "Tribal House",
                     "Tropical House", "Electro House", "Beatdown", "Boogie", "Latin", "Tribal"])
        put(.techno, ["Acid", "Bleep", "Deep Techno", "Dub Techno", "EBM", "Hard Techno", "Industrial", "Minimal", "Minimal Techno",
                      "New Beat", "Schranz", "Techno", "Rhythmic Noise", "Electroclash"])
        put(.trance, ["Trance", "Progressive Trance", "Psy-Trance", "Goa Trance", "Tech Trance", "Hard Trance", "Hands Up"])
        put(.ukg, ["UK Garage", "Speed Garage", "Bassline", "Grime", "UK Street Soul"])
        put(.bass, ["Dubstep", "Halftime", "Bass Music", "Juke", "Ghetto", "Miami Bass"])
        put(.dnb, ["Drum n Bass", "Jungle"])
        put(.breaks, ["Breakbeat", "Breaks", "Big Beat", "Progressive Breaks", "Broken Beat", "Electro", "Freestyle", "Jazzdance",
                      "Future Jazz", "Acid Jazz", "Leftfield"])
        put(.hard, ["Hardcore", "Happy Hardcore", "Gabber", "Hardstyle", "Jumpstyle", "Hard House", "Makina", "Donk", "Speedcore"])
        put(.breakcore, ["Breakcore", "Glitch", "Noise", "Experimental", "Chiptune", "Sound Collage", "Cut-up/DJ", "DJ Battle Tool",
                         "Turntablism", "Power Electronics"])
        put(.hiphop, ["Hip Hop", "Contemporary R&B", "Neo Soul", "New Jack Swing", "RnB/Swing", "Swingbeat", "Reggaeton", "Trap"])
        put(.pop, ["Dance-pop", "Synth-pop", "Eurodance", "Eurobeat", "Italodance", "Hi NRG", "Europop", "J-pop", "K-pop",
                   "Synthwave", "Bubblegum", "City Pop", "Vocal", "Indie Pop"])
        put(.chill, ["Ambient", "Dark Ambient", "Downtempo", "Drone", "Chillwave", "New Age", "Trip Hop", "Dub", "IDM", "Illbient",
                     "Abstract", "Modern Classical", "Berlin-School", "Dungeon Synth", "Vaporwave", "Musique Concrète", "Darkwave",
                     "Neofolk", "New Wave"])
        return m
    }()

    /// Family named by a file's genre tag (nil when the tag is too generic to tell).
    static func family(ofTag tag: String) -> MixGenre? {
        // Generic words ("Electronic", "Dance", "EDM") say nothing about how to mix.
        var t = tag.lowercased()
        for w in ["electronica", "electronic", "edm"] { t = t.replacingOccurrences(of: w, with: " ") }
        func has(_ words: [String]) -> Bool { words.contains { t.contains($0) } }
        if has(["dariacore", "breakcore", "mashup", "mash-up", "hyperpop", "digicore", "glitch"]) { return .breakcore }
        if has(["hard house", "hardcore", "hardstyle", "gabber", "happy hard", "uk hard", "speedcore", "frenchcore", "hyperflip", "jumpstyle"]) { return .hard }
        if has(["garage", "2-step", "2step", "ukg", "bassline", "grime", "speed garage"]) { return .ukg }
        if has(["drum & bass", "drum and bass", "drum n bass", "drum'n'bass", "dnb", "d&b", "jungle", "neurofunk", "liquid funk"]) { return .dnb }
        if has(["dubstep", "riddim", "brostep", "bass music", "halftime", "future bass"]) { return .bass }
        if has(["techno"]) { return .techno }
        if has(["trance", "psy"]) { return .trance }
        if has(["house", "disco"]) { return .house }
        if has(["breakbeat", "breaks", "big beat", "electro"]) { return .breaks }
        if has(["hip hop", "hip-hop", "hiphop", "rap", "r&b", "rnb", "trap", "reggaeton", "dancehall", "reggae"]) { return .hiphop }
        if has(["ambient", "chill", "downtempo", "lo-fi", "lofi", "trip hop", "new age", "classical", "soundtrack"]) { return .chill }
        if has(["pop", "anime", "idol", "vocaloid", "eurobeat", "eurodance", "synthwave"]) { return .pop }
        if has(["rock", "metal", "punk", "jazz", "blues", "folk", "country", "acoustic", "soul", "funk"]) { return .band }
        return nil
    }
}

// MARK: - Analysis result

nonisolated struct GenreStyle: Codable, Sendable, Hashable {
    /// Discogs style ("Electronic---UK Garage").
    var label: String
    var score: Double

    var name: String { label.components(separatedBy: "---").last ?? label }
}

nonisolated struct GenreResult: Codable, Sendable {
    var version: Int
    /// Strongest Discogs styles (model output averaged over the track).
    var styles: [GenreStyle]
    /// Share of the model's activation per family (sums to 1).
    var families: [String: Double]
    /// The file's genre tag, if any.
    var tag: String?
    /// Track averages of [voice, party, aggressive, danceable] (0…1).
    var traits: [Double]? = nil
    /// Probability of singing / rapping per ~2 s patch, and each patch's centre (source seconds).
    var voice: [Float]? = nil
    var voiceTimes: [Float]? = nil

    var party: Double? { traits.map { $0[1] } }
    var aggressive: Double? { traits.map { $0[2] } }
    var danceable: Double? { traits.map { $0[3] } }

    /// Vocal probability between two source times (max over the patches centred inside, else the nearest one).
    func vocal(from t0: Double, to t1: Double) -> Float? {
        guard let v = voice, let ts = voiceTimes, !v.isEmpty else { return nil }
        var best: Float = -1
        for (k, t) in ts.enumerated() where Double(t) >= t0 && Double(t) < t1 { best = max(best, v[k]) }
        if best >= 0 { return best }
        let mid = Float((t0 + t1) / 2)
        let k = ts.indices.min { abs(ts[$0] - mid) < abs(ts[$1] - mid) } ?? 0
        return v[k]
    }

    var tagFamily: MixGenre? { tag.flatMap(MixGenre.family(ofTag:)) }

    var ranked: [(genre: MixGenre, share: Double)] {
        families.compactMap { k, v in MixGenre(rawValue: k).map { ($0, v) } }.sorted { $0.share > $1.share }
    }

    /// The family the model is fairly sure of.
    var detected: MixGenre? {
        let r = ranked
        guard let top = r.first else { return nil }
        if top.share >= 0.28 { return top.genre }
        // Split between two neighbouring families (hardcore / breakcore, …): still clearly that corner.
        if top.share >= 0.2, r.count > 1, r[1].genre.isNeighbor(of: top.genre), top.share + r[1].share >= 0.4 { return top.genre }
        return nil
    }

    /// Tag first (when it names a family), then the model.
    var best: MixGenre? { tagFamily ?? detected }
}

// MARK: - Analyzer

/// Genre detection with Discogs-EffNet (MTG / UPF, CC BY-NC-SA 4.0): 400 Discogs styles from 16 kHz log-mel patches,
/// averaged over the track and grouped into the families the auto-mix uses. The same pass gives voice / party /
/// aggressive / danceable probabilities (Essentia classifier heads) — a vocal timeline and an energy estimate.
/// Cached next to the beat analysis.
nonisolated enum GenreAnalyzer {
    static let version = 3
    private static let lock = NSLock()
    nonisolated(unsafe) private static var model: MLModel?
    nonisolated(unsafe) private static var labels: [String] = []
    nonisolated(unsafe) private static var melT: [Float] = []   // 257 × 96
    nonisolated(unsafe) private static var loaded = false

    static var isAvailable: Bool {
        Bundle.main.url(forResource: "GenreEffNet", withExtension: "mlmodelc") != nil
    }

    static func analyze(url: URL) async -> GenreResult? {
        let tag = await readGenreTag(url)
        var r = isAvailable ? modelResult(url: url) : nil
        AnalysisProgress.shared.finish(url, .genre, measured: false)   // no-op when it was measured already
        if r == nil, let tag { r = GenreResult(version: version, styles: [], families: [:], tag: tag) }
        r?.tag = tag
        return r
    }

    /// Model part (cached per file).
    private static func modelResult(url: URL) -> GenreResult? {
        let key = cacheKey(url)
        if let key, let cached = readCache(key) { return cached }
        lock.lock()
        defer { lock.unlock() }
        if let key, let cached = readCache(key) { return cached }
        load()
        AnalysisProgress.shared.begin(url, .genre)
        let r = autoreleasepool(invoking: { classify(url: url) })
        AnalysisProgress.shared.finish(url, .genre)
        if let key, let r { writeCache(key, r) }
        return r
    }

    private static func load() {
        guard !loaded else { return }
        loaded = true
        let config = MLModelConfiguration()
        // The Neural Engine runs this network with too little precision (activations off by up to 0.3);
        // the CPU matches the reference within 0.002 and takes well under a second per track.
        config.computeUnits = .cpuOnly
        if let u = Bundle.main.url(forResource: "GenreEffNet", withExtension: "mlmodelc") {
            model = try? MLModel(contentsOf: u, configuration: config)
        }
        if let u = Bundle.main.url(forResource: "genre_discogs400_labels", withExtension: "txt"),
           let text = try? String(contentsOf: u, encoding: .utf8) {
            labels = text.split(separator: "\n").map(String.init)
        }
        if let u = Bundle.main.url(forResource: "effnet_melfb_96x257", withExtension: "f32"),
           let d = try? Data(contentsOf: u), d.count == 96 * 257 * 4 {
            let m = d.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
            var t = [Float](repeating: 0, count: 257 * 96)
            vDSP_mtrans(m, 1, &t, 1, 257, 96)
            melT = t
        }
    }

    // MARK: Inference

    static let patchFrames = 128, bands = 96, frameSize = 512, hop = 256
    /// Back-to-back ~2 s patches (124 frames apart) cover the whole track for the vocal timeline.
    static let patchHop = 124
    /// Upper bound on patches per track (long files are sampled evenly).
    static let maxPatches = 300

    private static func classify(url: URL) -> GenreResult? {
        guard let model, labels.count == 400, melT.count == 257 * 96,
              let y = NeuralAnalyzer.loadMono(url: url, sampleRate: 16000), y.count > 16000 * 5 else { return nil }
        let frames = 1 + (y.count - frameSize) / hop
        guard frames >= patchFrames else { return nil }
        let positions = Array(stride(from: 0, through: frames - patchFrames, by: patchHop))
        let picked: [Int] = positions.count <= maxPatches ? positions
            : (0..<maxPatches).map { positions[Int((Double($0) + 0.5) * Double(positions.count) / Double(maxPatches))] }
        var sum = [Double](repeating: 0, count: 400)
        var traitSum = [Double](repeating: 0, count: 4)
        var voice: [Float] = [], times: [Float] = []
        var used = 0
        let batch = 16
        var k = 0
        while k < picked.count {
            let chunk = Array(picked[k..<min(picked.count, k + batch)])
            k += batch
            AnalysisProgress.shared.update(url, .genre, Double(k - batch) / Double(max(1, picked.count)))
            guard let input = try? MLMultiArray(shape: [NSNumber(value: chunk.count), NSNumber(value: patchFrames), NSNumber(value: bands)], dataType: .float32) else { return nil }
            let ptr = input.dataPointer.bindMemory(to: Float.self, capacity: chunk.count * patchFrames * bands)
            for (b, start) in chunk.enumerated() {
                logMel(y, firstFrame: start, count: patchFrames, into: ptr + b * patchFrames * bands)
            }
            guard let provider = try? MLDictionaryFeatureProvider(dictionary: ["melspectrogram": MLFeatureValue(multiArray: input)]),
                  let out = try? model.prediction(from: provider),
                  let act = out.featureValue(for: "activations")?.multiArrayValue else { continue }
            let tr = out.featureValue(for: "traits")?.multiArrayValue
            let a = values(act), t = tr.map(values)
            for b in 0..<chunk.count {
                for j in 0..<400 { sum[j] += Double(a[b * 400 + j]) }
                if let t, t.count >= (b + 1) * 4 {
                    for j in 0..<4 { traitSum[j] += Double(t[b * 4 + j]) }
                    voice.append(t[b * 4])
                    times.append(Float((Double(chunk[b] * hop) + Double(patchFrames * hop) / 2) / 16000))
                }
            }
            used += chunk.count
        }
        guard used > 0 else { return nil }
        let mean = sum.map { $0 / Double(used) }
        var fam: [String: Double] = [:]
        for (j, v) in mean.enumerated() {
            guard let f = MixGenre.family(ofDiscogs: labels[j]) else { continue }
            fam[f.rawValue, default: 0] += v
        }
        let total = fam.values.reduce(0, +)
        if total > 0 { for k in fam.keys { fam[k]! /= total } }
        let top = mean.indices.sorted { mean[$0] > mean[$1] }.prefix(6).map { GenreStyle(label: labels[$0], score: mean[$0]) }
        var r = GenreResult(version: version, styles: Array(top), families: fam, tag: nil)
        if !voice.isEmpty {
            r.traits = traitSum.map { $0 / Double(voice.count) }
            r.voice = voice
            r.voiceTimes = times
        }
        return r
    }

    /// Contiguous Float copy of a model output (float32 or float16).
    private static func values(_ m: MLMultiArray) -> [Float] {
        let n = m.count
        switch m.dataType {
        case .float32:
            return Array(UnsafeBufferPointer(start: m.dataPointer.bindMemory(to: Float.self, capacity: n), count: n))
        case .float16:
            let p = m.dataPointer.bindMemory(to: Float16.self, capacity: n)
            return (0..<n).map { Float(p[$0]) }
        default:
            return (0..<n).map { m[$0].floatValue }
        }
    }

    #if DEBUG
    /// Writes the first 8 patches' log-mel input and the model output (raw float32) for comparison with Python.
    static func debugDump(url: URL, to dir: URL) {
        lock.lock(); defer { lock.unlock() }
        load()
        guard let model, let y = NeuralAnalyzer.loadMono(url: url, sampleRate: 16000) else { return }
        let frames = 1 + (y.count - frameSize) / hop
        let positions = Array(stride(from: 0, through: frames - patchFrames, by: patchHop))
        let chunk = Array(positions.prefix(8))
        guard let input = try? MLMultiArray(shape: [NSNumber(value: chunk.count), 128, 96], dataType: .float32) else { return }
        let ptr = input.dataPointer.bindMemory(to: Float.self, capacity: chunk.count * 128 * 96)
        for (b, start) in chunk.enumerated() { logMel(y, firstFrame: start, count: 128, into: ptr + b * 128 * 96) }
        let mel = Array(UnsafeBufferPointer(start: ptr, count: chunk.count * 128 * 96))
        var act: [Float] = []
        if let provider = try? MLDictionaryFeatureProvider(dictionary: ["melspectrogram": MLFeatureValue(multiArray: input)]),
           let out = try? model.prediction(from: provider), let a = out.featureValue(for: "activations")?.multiArrayValue {
            act = values(a)
            if let t = out.featureValue(for: "traits")?.multiArrayValue { act += values(t) }
        }
        let info = "samples \(y.count) frames \(frames) picked \(chunk) strides \(input.strides)\n"
        try? info.write(to: dir.appendingPathComponent("genre_dump.txt"), atomically: true, encoding: .utf8)
        try? mel.withUnsafeBufferPointer { Data(buffer: $0) }.write(to: dir.appendingPathComponent("genre_mel.f32"))
        try? act.withUnsafeBufferPointer { Data(buffer: $0) }.write(to: dir.appendingPathComponent("genre_act.f32"))
        try? y.withUnsafeBufferPointer { Data(buffer: $0) }.write(to: dir.appendingPathComponent("genre_y16k.f32"))
    }
    #endif

    /// Essentia TensorflowInputMusiCNN: symmetric Hann 512, |FFT|², 96 Slaney mel bands (unit_tri), log10(1 + 10000·x).
    private static func logMel(_ y: [Float], firstFrame: Int, count: Int, into dst: UnsafeMutablePointer<Float>) {
        let n = frameSize, half = n / 2, bins = half + 1
        let log2n = vDSP_Length(9)
        guard let setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) else { return }
        defer { vDSP_destroy_fftsetup(setup) }
        let window = (0..<n).map { Float(0.5 - 0.5 * cos(2 * Double.pi * Double($0) / Double(n - 1))) }
        var frame = [Float](repeating: 0, count: n)
        var re = [Float](repeating: 0, count: half), im = [Float](repeating: 0, count: half)
        var power = [Float](repeating: 0, count: count * bins)
        y.withUnsafeBufferPointer { yp in
            for f in 0..<count {
                let s = (firstFrame + f) * hop
                guard s + n <= y.count else { break }
                vDSP_vmul(yp.baseAddress! + s, 1, window, 1, &frame, 1, vDSP_Length(n))
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
                let o = f * bins
                let dc = re[0] / 2, ny = im[0] / 2
                power[o] = dc * dc
                power[o + half] = ny * ny
                for k in 1..<half {
                    let a = re[k] / 2, b = im[k] / 2
                    power[o + k] = a * a + b * b
                }
            }
        }
        // (count × 257) · (257 × 96)
        vDSP_mmul(power, 1, melT, 1, dst, 1, vDSP_Length(count), vDSP_Length(bands), vDSP_Length(bins))
        let total = count * bands
        var scale: Float = 10000, one: Float = 1
        vDSP_vsmsa(dst, 1, &scale, &one, dst, 1, vDSP_Length(total))
        var len = Int32(total)
        vvlog10f(dst, dst, &len)
    }

    // MARK: Tags

    static func readGenreTag(_ url: URL) async -> String? {
        let asset = AVURLAsset(url: url)
        guard let formats = try? await asset.load(.availableMetadataFormats) else { return nil }
        var items: [AVMetadataItem] = (try? await asset.load(.commonMetadata)) ?? []
        for f in formats { items += (try? await asset.loadMetadata(for: f)) ?? [] }
        for item in items {
            let id = item.identifier?.rawValue.lowercased() ?? ""
            let key = (item.key as? String)?.lowercased() ?? ""
            guard id.contains("genre") || id.hasSuffix("/tcon") || id.hasSuffix("gen") || key == "genre" || key == "tcon" else { continue }
            if let s = try? await item.load(.stringValue) {
                let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
                // ID3v1-style "(17)" numbers are not useful here.
                if !t.isEmpty, !t.allSatisfy({ $0.isNumber || $0 == "(" || $0 == ")" }) { return t }
            }
        }
        return nil
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
        let text = "\(url.lastPathComponent)|\(size)|\(Int(mtime))|genre\(version)"
        return SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func readCache(_ key: String) -> GenreResult? {
        guard let dir = cacheFolder,
              let data = try? Data(contentsOf: dir.appendingPathComponent(key + ".genre.json")),
              let r = try? JSONDecoder().decode(GenreResult.self, from: data), r.version == version else { return nil }
        return r
    }

    private static func writeCache(_ key: String, _ r: GenreResult) {
        var r = r
        r.tag = nil
        guard let dir = cacheFolder, let data = try? JSONEncoder().encode(r) else { return }
        try? data.write(to: dir.appendingPathComponent(key + ".genre.json"), options: .atomic)
    }
}
