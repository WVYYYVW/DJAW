import Foundation
import AVFoundation
import ImageIO
import UniformTypeIdentifiers

/// What DJAW knows about a track besides its audio: the name and artist shown everywhere, album / year / label /
/// genre / notes, and the artwork. Edited in DJAW and used for the decks, the track list, the playing guide and
/// the video export.
nonisolated struct TrackProfile: Codable, Hashable, Sendable {
    var title: String
    var artist: String
    var album: String = ""
    var year: String = ""
    var genre: String = ""
    var label: String = ""
    var comment: String = ""
    /// Artwork chosen in DJAW (JPEG). nil = the artwork inside the audio file, if it has one.
    var artwork: Data? = nil
    /// The user removed the artwork (also the one inside the file).
    var noArtwork: Bool? = nil

    init(title: String, artist: String) {
        self.title = title
        self.artist = artist
    }
}

/// Track profiles, kept per audio content (like the analyses) so they follow the track into every mix:
/// ~/Library/Application Support/DJAW/Profiles/<fingerprint>.json, and inside every .djaw that uses the track.
nonisolated enum TrackProfiles {
    private static var folder: URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let dir = base.appendingPathComponent("DJAW/Profiles", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static func fileURL(_ key: String) -> URL? { folder?.appendingPathComponent(key + ".json") }

    static func load(_ url: URL) -> TrackProfile? {
        guard let key = AnalysisCache.fingerprint(url) else { return nil }
        return load(key: key)
    }

    static func load(key: String) -> TrackProfile? {
        guard let f = fileURL(key), let d = try? Data(contentsOf: f) else { return nil }
        return try? JSONDecoder().decode(TrackProfile.self, from: d)
    }

    static func store(_ p: TrackProfile, for url: URL) {
        guard let key = AnalysisCache.fingerprint(url), let f = fileURL(key), let d = try? JSONEncoder().encode(p) else { return }
        try? d.write(to: f, options: .atomic)
    }

    /// Profiles of these files, keyed by fingerprint (to save inside a .djaw).
    static func blobs(for urls: [URL]) -> [String: TrackProfile]? {
        var out: [String: TrackProfile] = [:]
        for u in Set(urls) {
            if let key = AnalysisCache.fingerprint(u), let p = load(key: key) { out[key] = p }
        }
        return out.isEmpty ? nil : out
    }

    /// Takes over profiles saved in a .djaw (a profile edited on this Mac wins).
    static func importBlobs(_ blobs: [String: TrackProfile]) {
        for (key, p) in blobs {
            guard key.count == 64, key.allSatisfy(\.isHexDigit), let f = fileURL(key) else { continue }
            if FileManager.default.fileExists(atPath: f.path) { continue }
            if let d = try? JSONEncoder().encode(p) { try? d.write(to: f, options: .atomic) }
        }
    }

    // MARK: Artwork

    /// The artwork stored inside the audio file (ID3 / MP4 tags), if any.
    static func embeddedArtwork(_ url: URL) async -> Data? {
        let asset = AVURLAsset(url: url)
        guard let items = try? await asset.load(.commonMetadata) else { return nil }
        for item in items where item.commonKey == .commonKeyArtwork {
            if let d = try? await item.load(.dataValue) { return d }
        }
        // Some files only carry it in their format-specific tags.
        if let formats = try? await asset.load(.availableMetadataFormats) {
            for f in formats {
                guard let more = try? await asset.loadMetadata(for: f) else { continue }
                for item in more where item.commonKey == .commonKeyArtwork || (item.identifier?.rawValue.lowercased().contains("apic") ?? false)
                    || (item.identifier?.rawValue.lowercased().contains("covr") ?? false) {
                    if let d = try? await item.load(.dataValue) { return d }
                }
            }
        }
        return nil
    }

    /// Any image (file data) as a square-ish JPEG of at most `maxSize` px, for storing.
    static func normalizedJPEG(_ data: Data, maxSize: Int = 800) -> Data? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                     kCGImageSourceThumbnailMaxPixelSize: maxSize,
                                     kCGImageSourceCreateThumbnailWithTransform: true]
        guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let dst = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dst, img, [kCGImageDestinationLossyCompressionQuality: 0.88] as CFDictionary)
        guard CGImageDestinationFinalize(dst) else { return nil }
        return out as Data
    }

    /// A decoded copy of at most maxSize px (cheap to draw every frame).
    static func cgImage(_ data: Data, maxSize: Int) -> CGImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                     kCGImageSourceThumbnailMaxPixelSize: maxSize,
                                     kCGImageSourceCreateThumbnailWithTransform: true,
                                     kCGImageSourceShouldCacheImmediately: true]
        return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
    }

    static func cgImage(_ data: Data) -> CGImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(src, 0, nil)
    }
}
