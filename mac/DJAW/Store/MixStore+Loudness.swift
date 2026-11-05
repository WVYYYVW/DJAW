import Foundation

/// Loudness normalization: every track gets a correction gain so the part of it the mix plays has the same
/// loudness (LUFS) — the tracks' average, or a fixed target. It is an ordinary gain in the automation, so the
/// preview, the export and the mix waveform all include it.
extension MixStore {
    /// Largest correction either way (dB).
    static let loudnessLimit = 12.0

    /// Measures what is missing (in the background) and sets every track's correction gain.
    func applyLoudness() {
        guard loudnessMode != .off else {
            for i in clips.indices where clips[i].loudnessGainDB != nil || clips[i].lufs != nil {
                clips[i].loudnessGainDB = nil
                clips[i].lufs = nil
            }
            return
        }
        for url in Set(clips.map(\.url)) where loudnessSegments[url] == nil && !loudnessInFlight.contains(url) && !missingFiles.contains(url) {
            loudnessInFlight.insert(url)
            Task.detached(priority: .utility) { [weak self] in
                let seg = LoudnessAnalyzer.segments(url: url)
                await MainActor.run {
                    guard let self else { return }
                    self.loudnessInFlight.remove(url)
                    if let seg { self.loudnessSegments[url] = seg }
                    self.applyLoudness()
                }
            }
        }
        // Loudness of the part each track plays (its first played source second to its last).
        var measured: [Int: Double] = [:]
        for i in clips.indices {
            guard let seg = loudnessSegments[clips[i].url],
                  let l = LoudnessAnalyzer.integrated(seg, from: clips[i].trimStart, to: clips[i].trimEnd) else { continue }
            measured[i] = l
        }
        guard !measured.isEmpty else { return }
        let target: Double
        if let t = loudnessMode.target {
            target = t
        } else {
            let sorted = measured.values.sorted()
            target = sorted[sorted.count / 2]
        }
        for (i, l) in measured {
            let g = (min(Self.loudnessLimit, max(-Self.loudnessLimit, target - l)) * 10).rounded() / 10
            if abs((clips[i].loudnessGainDB ?? .nan) - g) > 0.049 || clips[i].loudnessGainDB == nil {
                clips[i].loudnessGainDB = g
            }
            let lr = (l * 10).rounded() / 10
            if clips[i].lufs != lr { clips[i].lufs = lr }
        }
    }
}
