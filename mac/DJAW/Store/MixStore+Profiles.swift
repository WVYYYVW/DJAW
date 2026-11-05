import Foundation
import AppKit

/// Editing a track's profile (title, artist, album, artwork, …) and the artwork shown in DJAW.
extension MixStore {
    /// The profile of a track: what was saved for it, else what the file / analysis gave.
    func trackProfile(for c: Clip) -> TrackProfile {
        if let p = TrackProfiles.load(c.url) { return p }
        return TrackProfile(title: c.title, artist: c.artist)
    }

    func openProfileEditor(_ id: UUID) {
        guard clip(id) != nil else { return }
        profileEditorTarget = CueEditorTarget(id: id)
    }

    /// Saves the profile for every copy of this track (mix and library), undoably for the names.
    func saveProfile(_ p: TrackProfile, forTrackAt url: URL) {
        var p = p
        p.title = p.title.trimmingCharacters(in: .whitespacesAndNewlines)
        p.artist = p.artist.trimmingCharacters(in: .whitespacesAndNewlines)
        if p.title.isEmpty { p.title = url.deletingPathExtension().lastPathComponent }
        pushUndo()
        TrackProfiles.store(p, for: url)
        for i in clips.indices where clips[i].url == url {
            clips[i].title = p.title
            clips[i].artist = p.artist
        }
        for i in library.indices where library[i].url == url {
            library[i].title = p.title
            library[i].artist = p.artist
        }
        artworkCache[url] = nil
        artworkRevision &+= 1
        isDirty = true
    }

    /// Artwork for a track (nil while it is loading or if there is none). Loads it in the background on first use.
    func artwork(for url: URL) -> CGImage? {
        if let cached = artworkCache[url] { return cached }
        guard !artworkLoading.contains(url) else { return nil }
        artworkLoading.insert(url)
        Task.detached(priority: .utility) { [weak self] in
            let img = await Self.loadArtwork(url, maxSize: 640)
            await MainActor.run {
                guard let self else { return }
                self.artworkLoading.remove(url)
                self.artworkCache[url] = .some(img)
                self.artworkRevision &+= 1
            }
        }
        return nil
    }

    /// The artwork data that is in use for a track (DJAW's own, else the file's).
    nonisolated static func artworkData(_ url: URL) async -> Data? {
        let p = TrackProfiles.load(url)
        if p?.noArtwork == true { return nil }
        if let d = p?.artwork { return d }
        return await TrackProfiles.embeddedArtwork(url)
    }

    /// maxSize: decode a smaller copy (on-screen use; the video export wants the full size).
    nonisolated static func loadArtwork(_ url: URL, maxSize: Int? = nil) async -> CGImage? {
        guard let d = await artworkData(url) else { return nil }
        if let maxSize { return TrackProfiles.cgImage(d, maxSize: maxSize) }
        return TrackProfiles.cgImage(d)
    }

    /// Fills in title / artist from saved profiles (after opening a mix or adding tracks).
    func applySavedProfiles() {
        var cache: [URL: TrackProfile?] = [:]
        func p(_ u: URL) -> TrackProfile? {
            if let v = cache[u] { return v }
            let v = TrackProfiles.load(u)
            cache[u] = .some(v)
            return v
        }
        for i in clips.indices {
            if let pr = p(clips[i].url), clips[i].title != pr.title || clips[i].artist != pr.artist {
                clips[i].title = pr.title; clips[i].artist = pr.artist
            }
        }
        for i in library.indices {
            if let pr = p(library[i].url), library[i].title != pr.title || library[i].artist != pr.artist {
                library[i].title = pr.title; library[i].artist = pr.artist
            }
        }
    }

    /// Tracks as the visuals see them (names, colours, artwork, when each comes in), for the live preview.
    func previewTrackVisuals() -> [VideoExporter.TrackVisual] {
        let tempo = tempoMap, master = masterBPM
        let all = clips
        return all.enumerated().map { i, c in
            let start = tempo.real(c.start)
            let landing = tempo.real(Automation.switchTime(clips: all, index: i, master: master))
            let art = artwork(for: c.url)
            return VideoExporter.TrackVisual(title: c.title, artist: c.artist, artwork: art, hue: ClipPalette.hue(c.colorIndex),
                                             start: start, landing: max(start, landing), end: tempo.real(c.end(master: master)),
                                             sections: VisualPainter.sections(clip: c, structure: structures[c.url], master: master, tempo: tempo),
                                             palette: VisualPainter.palette(art))
        }
    }
}
