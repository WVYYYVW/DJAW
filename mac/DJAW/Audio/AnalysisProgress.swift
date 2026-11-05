import AVFoundation

/// Progress and remaining time of the background track analysis.
///
/// Files are analysed one after another (AnalysisQueue), each through four stages: reading (waveform,
/// energies, key), beats (Beat This!), cues (CUE-DETR) and genre / vocals (EffNet). The time each stage
/// takes per second of audio is measured as files finish and remembered between launches, so the
/// estimate is reasonable from the first file on; cached files take no time.
nonisolated final class AnalysisProgress: @unchecked Sendable {
    static let shared = AnalysisProgress()

    enum Stage: String, CaseIterable, Sendable {
        case read, beats, cues, genre

        var title: String {
            switch self {
            case .read: return L("波形・音量", "waveform")
            case .beats: return L("拍・小節", "beats")
            case .cues: return L("CUE", "cues")
            case .genre: return L("ジャンル・歌", "genre & vocals")
            }
        }
    }

    /// One file's place in the queue, for the per-track progress rings.
    struct FileStatus: Sendable, Equatable {
        /// 0…1 of this file's own work.
        var fraction: Double
        /// The stage running now (nil = waiting in the queue).
        var stage: Stage?
        /// Seconds until this file is done (its own work plus everything queued before it).
        var finishIn: Double
    }

    struct Summary: Sendable, Equatable {
        var total: Int
        var finished: Int
        /// 0…1, weighted by track length.
        var fraction: Double
        /// Seconds left (nil while there is too little to go on).
        var remaining: Double?
        /// What is being worked on now, e.g. "「chance」の拍・小節".
        var activity: String?
    }

    private struct FileState {
        var title: String
        var duration: Double
        var done: [Stage: Double] = [:]
        var started: [Stage: Date] = [:]
        var registrations = 1
    }

    private let lock = NSLock()
    private var files: [URL: FileState] = [:]
    /// Queue order (files are analysed first come, first served).
    private var order: [URL] = []
    private var finishedCount = 0
    private var costs: [Stage: Double]
    private var lastEstimate: (time: Date, value: Double)?

    /// Seconds of work per second of audio (M-series defaults; replaced by measurements).
    private static let defaultCosts: [Stage: Double] = [.read: 0.008, .beats: 0.012, .cues: 0.010, .genre: 0.008]
    private static let costsKey = "DJAW.analysisCosts"

    private init() {
        var c = Self.defaultCosts
        if let saved = UserDefaults.standard.dictionary(forKey: Self.costsKey) as? [String: Double] {
            for (k, v) in saved { if let s = Stage(rawValue: k), v > 0, v < 1 { c[s] = v } }
        }
        costs = c
    }

    // MARK: Reporting (any thread)

    private var ranks: [URL: Int] = [:]
    private var nextRank = 0

    /// The order files were added in (call before starting their analyses); the queue follows it.
    func expect(_ urls: [URL]) {
        lock.lock(); defer { lock.unlock() }
        for u in urls where ranks[u] == nil { ranks[u] = nextRank; nextRank += 1 }
    }

    func rank(_ url: URL) -> Int {
        lock.lock(); defer { lock.unlock() }
        if let r = ranks[url] { return r }
        ranks[url] = nextRank; nextRank += 1
        return ranks[url]!
    }

    /// A file was queued for analysis.
    func register(_ url: URL) {
        let duration = (try? AVAudioFile(forReading: url)).map { Double($0.length) / $0.processingFormat.sampleRate } ?? 180
        lock.lock(); defer { lock.unlock() }
        if files[url] != nil {
            files[url]!.registrations += 1
        } else {
            files[url] = FileState(title: url.deletingPathExtension().lastPathComponent, duration: max(1, duration))
            order.append(url)
        }
    }

    func begin(_ url: URL, _ stage: Stage) {
        lock.lock(); defer { lock.unlock() }
        files[url]?.started[stage] = Date()
        files[url]?.done[stage] = 0
    }

    func update(_ url: URL, _ stage: Stage, _ fraction: Double) {
        lock.lock(); defer { lock.unlock() }
        files[url]?.done[stage] = min(1, max(0, fraction))
    }

    /// A stage finished; its time is measured unless it came from the cache.
    func finish(_ url: URL, _ stage: Stage, measured: Bool = true) {
        lock.lock(); defer { lock.unlock() }
        guard var f = files[url] else { return }
        if measured, let t0 = f.started[stage], f.duration > 20 {
            let c = Date().timeIntervalSince(t0) / f.duration
            if c > 0.0005 && c < 0.5 {
                costs[stage] = 0.7 * (costs[stage] ?? c) + 0.3 * c
                UserDefaults.standard.set(Dictionary(uniqueKeysWithValues: costs.map { ($0.key.rawValue, $0.value) }), forKey: Self.costsKey)
            }
        }
        f.done[stage] = 1
        f.started[stage] = nil
        files[url] = f
    }

    /// The whole analysis of a file is over (success or not).
    func done(_ url: URL) {
        lock.lock(); defer { lock.unlock() }
        guard var f = files[url] else { return }
        f.registrations -= 1
        if f.registrations <= 0 {
            files[url] = nil
            ranks[url] = nil
            order.removeAll { $0 == url }
            finishedCount += 1
        } else {
            files[url] = f
        }
        if files.isEmpty { finishedCount = 0; lastEstimate = nil }
    }

    // MARK: Reading (main thread, a few times a second)

    /// Status of every queued / running file. The running one comes first in the estimate, then the queue order.
    func statuses() -> [URL: FileStatus] {
        lock.lock(); defer { lock.unlock() }
        var out: [URL: FileStatus] = [:]
        let running = order.filter { u in files[u].map { !$0.started.isEmpty || ($0.done[.read] ?? 0) > 0 } ?? false }
        let waiting = order.filter { !running.contains($0) }.sorted { (ranks[$0] ?? .max) < (ranks[$1] ?? .max) }
        let queue = running + waiting
        var cum = 0.0
        for url in queue {
            guard let f = files[url] else { continue }
            var own = 0.0, left = 0.0
            for s in Stage.allCases {
                let c = (costs[s] ?? 0) * f.duration
                own += c
                left += c * (1 - (f.done[s] ?? 0))
            }
            cum += left + 0.3
            let stage = Stage.allCases.first { f.started[$0] != nil }
            out[url] = FileStatus(fraction: own > 0 ? 1 - left / own : 0, stage: stage, finishIn: cum)
        }
        return out
    }

    func summary() -> Summary? {
        lock.lock(); defer { lock.unlock() }
        guard !files.isEmpty else { return nil }
        let stages = Stage.allCases
        let perFile = stages.reduce(0.0) { $0 + (costs[$1] ?? 0) }
        var totalWork = 0.0, doneWork = 0.0
        var left = 0.0
        var activity: String?
        for (_, f) in files {
            totalWork += perFile * f.duration
            for s in stages {
                let d = f.done[s] ?? 0
                let c = (costs[s] ?? 0) * f.duration
                doneWork += c * d
                left += c * (1 - d)
                if f.started[s] != nil, activity == nil {
                    activity = L("「\(f.title)」の\(s.title)", "\(s.title) of “\(f.title)”")
                }
            }
        }
        // One file at a time: what is left is simply the sum (plus a little per file for loading).
        let estimate = left + 0.3 * Double(files.count)
        // Smooth it: count down between updates instead of jumping around.
        let now = Date()
        var remaining = estimate
        if let last = lastEstimate {
            let counted = max(0, last.value - now.timeIntervalSince(last.time))
            remaining = 0.75 * counted + 0.25 * estimate
        }
        lastEstimate = (now, remaining)
        let total = files.count + finishedCount
        return Summary(total: total, finished: finishedCount,
                       fraction: totalWork > 0 ? min(1, doneWork / totalWork) : 0,
                       remaining: remaining, activity: activity)
    }

    /// "約 1分20秒" / "数秒".
    static func format(_ seconds: Double) -> String {
        let s = Int(seconds.rounded())
        if s < 5 { return L("あと少し", "a few seconds") }
        if s < 60 { return L("約 \(Int((Double(s) / 5).rounded()) * 5) 秒", "about \(Int((Double(s) / 5).rounded()) * 5) s") }
        let m = s / 60, r = (s % 60) / 10 * 10
        return r == 0 ? L("約 \(m) 分", "about \(m) min") : L("約 \(m) 分 \(r) 秒", "about \(m) min \(r) s")
    }
}
