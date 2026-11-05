import Foundation
import CryptoKit

/// Finished track analyses, so a track is analysed once.
///
/// - Kept in ~/Library/Application Support/DJAW/Analysis/<fingerprint>.analysis (compressed binary plist).
/// - Saved inside every .djaw as well (`ProjectFile.analyses`), so a mix opens without analysing again,
///   also on another Mac or when the audio comes out of the .djaw package.
/// - Keyed by the audio's content (size + the first and last 256 KB), not by its path or date,
///   so a copied, moved or unpacked file is still recognised.
nonisolated enum AnalysisCache {
    /// Bump when the analysis itself changes (older entries are then analysed again).
    static let version = 1

    private struct Entry: Codable {
        var version: Int
        var neuralVersion: Int
        var genreVersion: Int
        var analysis: TrackAnalysis
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var keys: [String: (stamp: String, key: String)] = [:]

    private static var folder: URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let dir = base.appendingPathComponent("DJAW/Analysis", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static func fileURL(_ key: String) -> URL? { folder?.appendingPathComponent(key + ".analysis") }

    /// Content fingerprint of an audio file (nil if it cannot be read).
    static func fingerprint(_ url: URL) -> String? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = (attrs[.size] as? NSNumber)?.uint64Value else { return nil }
        // Remember it per path + size + date, so it is hashed once per session.
        let stamp = "\(size)|\((attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0)"
        lock.lock()
        if let k = keys[url.path], k.stamp == stamp { lock.unlock(); return k.key }
        lock.unlock()
        guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? h.close() }
        let chunk = 256 << 10
        var hasher = SHA256()
        hasher.update(data: Data("\(size)".utf8))
        if let head = try? h.read(upToCount: chunk) { hasher.update(data: head) }
        if size > UInt64(2 * chunk) {
            try? h.seek(toOffset: size - UInt64(chunk))
            if let tail = try? h.read(upToCount: chunk) { hasher.update(data: tail) }
        }
        let key = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        lock.lock()
        keys[url.path] = (stamp, key)
        lock.unlock()
        return key
    }

    // MARK: Read / write

    static func load(_ url: URL) -> TrackAnalysis? {
        guard let key = fingerprint(url), let f = fileURL(key), let data = try? Data(contentsOf: f) else { return nil }
        return decode(data)
    }

    static func store(_ url: URL, _ a: TrackAnalysis) {
        guard let key = fingerprint(url), let f = fileURL(key), let data = encode(a) else { return }
        try? data.write(to: f, options: .atomic)
    }

    /// The stored blob for a file (to save it inside a .djaw).
    static func blob(for url: URL) -> (key: String, data: Data)? {
        guard let key = fingerprint(url), let f = fileURL(key), let data = try? Data(contentsOf: f),
              decode(data) != nil else { return nil }
        return (key, data)
    }

    /// Takes over analyses saved in a .djaw (kept unless this Mac already has a current one).
    static func importBlobs(_ blobs: [String: Data]) {
        for (key, data) in blobs {
            guard key.count == 64, key.allSatisfy(\.isHexDigit), let f = fileURL(key) else { continue }
            if let old = try? Data(contentsOf: f), decode(old) != nil { continue }
            guard decode(data) != nil else { continue }
            try? data.write(to: f, options: .atomic)
        }
    }

    private static func encode(_ a: TrackAnalysis) -> Data? {
        let e = PropertyListEncoder()
        e.outputFormat = .binary
        guard let raw = try? e.encode(Entry(version: version, neuralVersion: NeuralAnalyzer.version,
                                            genreVersion: GenreAnalyzer.version, analysis: a)) else { return nil }
        return try? (raw as NSData).compressed(using: .lzfse) as Data
    }

    private static func decode(_ data: Data) -> TrackAnalysis? {
        guard let raw = try? (data as NSData).decompressed(using: .lzfse) as Data,
              let e = try? PropertyListDecoder().decode(Entry.self, from: raw),
              e.version == version, e.neuralVersion == NeuralAnalyzer.version, e.genreVersion == GenreAnalyzer.version
        else { return nil }
        return e.analysis
    }
}

// MARK: - Compact coding for the long float arrays (raw bytes instead of one plist object per number)

nonisolated private func floatData(_ a: [Float]) -> Data {
    a.withUnsafeBufferPointer { Data(buffer: $0) }
}

nonisolated private func floats(_ d: Data) -> [Float] {
    let n = d.count / MemoryLayout<Float>.size
    var out = [Float](repeating: 0, count: n)
    _ = out.withUnsafeMutableBytes { d.copyBytes(to: $0, count: n * MemoryLayout<Float>.size) }
    return out
}

nonisolated extension Waveform: Codable {
    private enum CodingKeys: String, CodingKey { case binsPerSecond, peaks, lows, maxPeak }

    nonisolated init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(binsPerSecond: try c.decode(Double.self, forKey: .binsPerSecond),
                  peaks: floats(try c.decode(Data.self, forKey: .peaks)),
                  lows: floats(try c.decode(Data.self, forKey: .lows)),
                  maxPeak: try c.decode(Float.self, forKey: .maxPeak))
    }

    nonisolated func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(binsPerSecond, forKey: .binsPerSecond)
        try c.encode(floatData(peaks), forKey: .peaks)
        try c.encode(floatData(lows), forKey: .lows)
        try c.encode(maxPeak, forKey: .maxPeak)
    }
}

nonisolated extension BandEnergies: Codable {
    private enum CodingKeys: String, CodingKey { case low, full, high, frameRate, duration, key, hints, fineLow, fineFull, fineRate }

    nonisolated init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(low: floats(try c.decode(Data.self, forKey: .low)),
                  full: floats(try c.decode(Data.self, forKey: .full)),
                  high: floats(try c.decode(Data.self, forKey: .high)),
                  frameRate: try c.decode(Double.self, forKey: .frameRate),
                  duration: try c.decode(Double.self, forKey: .duration),
                  key: try c.decodeIfPresent(MusicalKey.self, forKey: .key),
                  hints: try c.decodeIfPresent(StructureHints.self, forKey: .hints),
                  fineLow: floats(try c.decodeIfPresent(Data.self, forKey: .fineLow) ?? Data()),
                  fineFull: floats(try c.decodeIfPresent(Data.self, forKey: .fineFull) ?? Data()),
                  fineRate: try c.decodeIfPresent(Double.self, forKey: .fineRate) ?? 500)
    }

    nonisolated func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(floatData(low), forKey: .low)
        try c.encode(floatData(full), forKey: .full)
        try c.encode(floatData(high), forKey: .high)
        try c.encode(frameRate, forKey: .frameRate)
        try c.encode(duration, forKey: .duration)
        try c.encodeIfPresent(key, forKey: .key)
        try c.encodeIfPresent(hints, forKey: .hints)
        try c.encode(floatData(fineLow), forKey: .fineLow)
        try c.encode(floatData(fineFull), forKey: .fineFull)
        try c.encode(fineRate, forKey: .fineRate)
    }
}
