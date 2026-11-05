import Foundation
import iTunesLibrary

/// One song from the Music app library that DJAW can actually play
/// (a local, DRM-free file — purchased or imported, not an Apple Music subscription stream).
nonisolated struct MusicLibraryTrack: Identifiable, Hashable, Sendable {
    var id: UInt64
    var title: String
    var artist: String
    var album: String
    var genre: String
    /// BPM tag from the Music app (0 = not set).
    var bpm: Int
    var duration: Double
    var url: URL
    var addedDate: Date?
}

nonisolated struct MusicLibraryPlaylist: Identifiable, Hashable, Sendable {
    var id: UInt64
    var name: String
    var isSmart: Bool
    var trackIDs: [UInt64]
    /// Songs in the playlist DJAW cannot use (subscription / cloud-only / protected).
    var unavailable: Int
}

nonisolated struct MusicLibrarySnapshot: Sendable {
    var tracks: [MusicLibraryTrack]
    var playlists: [MusicLibraryPlaylist]
    /// Songs skipped because DJAW cannot read their audio.
    var protectedCount: Int
    var cloudOnlyCount: Int
}

nonisolated enum MusicLibraryError: LocalizedError {
    case unavailable(String)

    var errorDescription: String? {
        switch self {
        case .unavailable(let detail):
            return L("ミュージックのライブラリを読み込めませんでした。\nシステム設定 ▸ プライバシーとセキュリティ ▸ メディアと Apple Music で DJAW を許可してください。\n(\(detail))",
                     "Could not read the Music library.\nAllow DJAW under System Settings ▸ Privacy & Security ▸ Media & Apple Music.\n(\(detail))")
        }
    }
}

/// Reads the Music app library (via the iTunesLibrary framework).
nonisolated enum MusicLibrary {
    static func load() throws -> MusicLibrarySnapshot {
        let library: ITLibrary
        do {
            library = try ITLibrary(apiVersion: "1.1")
        } catch {
            throw MusicLibraryError.unavailable(error.localizedDescription)
        }
        let fm = FileManager.default
        var tracks: [MusicLibraryTrack] = []
        var usable = Set<UInt64>()
        var protected = 0
        var cloudOnly = 0
        for item in library.allMediaItems where item.mediaKind == .kindSong {
            let pid = item.persistentID.uint64Value
            if item.isDRMProtected { protected += 1; continue }
            guard let url = item.location, url.isFileURL, fm.fileExists(atPath: url.path) else {
                cloudOnly += 1
                continue
            }
            tracks.append(MusicLibraryTrack(
                id: pid,
                title: item.title,
                artist: item.artist?.name ?? "",
                album: item.album.title ?? "",
                genre: item.genre,
                bpm: item.beatsPerMinute,
                duration: Double(item.totalTime) / 1000,
                url: url,
                addedDate: item.addedDate))
            usable.insert(pid)
        }
        var playlists: [MusicLibraryPlaylist] = []
        for p in library.allPlaylists {
            guard !p.isPrimary, p.isVisible, p.kind != .folder, p.distinguishedKind == .kindNone else { continue }
            let songs = p.items.filter { $0.mediaKind == .kindSong }
            guard !songs.isEmpty else { continue }
            let ids = songs.map { $0.persistentID.uint64Value }
            let ok = ids.filter { usable.contains($0) }
            playlists.append(MusicLibraryPlaylist(id: p.persistentID.uint64Value, name: p.name,
                                                  isSmart: p.kind == .smart, trackIDs: ok,
                                                  unavailable: ids.count - ok.count))
        }
        tracks.sort { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
        playlists.sort { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        return MusicLibrarySnapshot(tracks: tracks, playlists: playlists,
                                    protectedCount: protected, cloudOnlyCount: cloudOnly)
    }
}
