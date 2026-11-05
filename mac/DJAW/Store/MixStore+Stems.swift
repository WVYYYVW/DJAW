import Foundation

/// Separating tracks into vocals / instrumental when a transition's vocal lanes need it.
extension MixStore {
    /// Tracks whose stems the mix needs (a drawn vocal / instrumental lane in a transition in or out).
    var tracksNeedingStems: [URL] {
        var out: [URL] = []
        for (i, c) in clips.enumerated() where MixRenderSession.usesStems(c, next: i + 1 < clips.count ? clips[i + 1] : nil) {
            if !out.contains(c.url) { out.append(c.url) }
        }
        return out
    }

    /// Starts separating the tracks that need it (in the background, one at a time).
    func prepareStemsIfNeeded() {
        guard StemSeparator.isAvailable else { return }
        prepareStems(tracksNeedingStems.filter { StemSeparator.stems(for: $0) == nil })
    }

    func prepareStems(_ urls: [URL]) {
        guard StemSeparator.isAvailable else { return }
        for url in urls where stemProgress[url] == nil && !missingFiles.contains(url) {
            stemProgress[url] = 0
            Self.stemQueue.async { [weak self] in
                let ok = (try? StemSeparator.separate(url, progress: { p in
                    Task { @MainActor in self?.stemProgress[url] = p }
                })) != nil
                Task { @MainActor in
                    guard let self else { return }
                    self.stemProgress[url] = nil
                    self.stemRevision &+= 1
                    if !ok { self.alertMessage = L("ボーカルと伴奏を分離できませんでした（\(url.lastPathComponent)）", "Could not separate the vocals (\(url.lastPathComponent))") }
                    // The tracks now play from their stems: render again.
                    self.mixInputsChanged()
                    if self.isPlaying { self.restartPlayback(at: nil) }
                }
            }
        }
    }

    nonisolated static let stemQueue = DispatchQueue(label: "DJAW.stems", qos: .utility)

    /// Which of the needed stems exist (part of what the mix waveform depends on).
    var stemSignature: Int {
        var h = Hasher()
        for u in tracksNeedingStems { h.combine(u); h.combine(StemSeparator.stems(for: u) != nil) }
        return h.finalize()
    }
}
