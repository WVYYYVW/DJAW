import Foundation

/// The .djaw file layout.
///
/// Plain JSON (older files, autosaves) or a self-contained package:
///
///     "DJAWPACK"  (8 bytes)
///     version     UInt32 little-endian
///     jsonLength  UInt64 little-endian
///     JSON        ProjectFile, whose `media` lists the embedded audio
///     audio files back to back (offsets relative to the end of the JSON)
///
/// Audio is stored byte-for-byte as the original files (MP3 stays MP3), so nothing is re-encoded.
nonisolated enum ProjectContainer {
    static let magic = Data("DJAWPACK".utf8)
    static let version: UInt32 = 1

    struct Media: Codable, Sendable, Hashable {
        var id: String
        var fileName: String
        var offset: UInt64
        var length: UInt64
    }

    struct Opened: Sendable {
        var file: ProjectFile
        /// Byte offset of the first embedded file (nil for plain JSON files).
        var blobStart: UInt64?
    }

    // MARK: Write

    /// Writes the project with the given audio files embedded (atomically).
    static func write(_ project: ProjectFile, embedding media: [(id: String, url: URL)], to url: URL) throws {
        let fm = FileManager.default
        var file = project
        var entries: [Media] = []
        var offset: UInt64 = 0
        for m in media {
            let size = (try fm.attributesOfItem(atPath: m.url.path)[.size] as? NSNumber)?.uint64Value ?? 0
            entries.append(Media(id: m.id, fileName: m.url.lastPathComponent, offset: offset, length: size))
            offset += size
        }
        file.media = entries
        let json = try JSONEncoder.djaw.encode(file)

        let tmpDir = try fm.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: url, create: true)
        let tmp = tmpDir.appendingPathComponent(url.lastPathComponent)
        guard fm.createFile(atPath: tmp.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        let out = try FileHandle(forWritingTo: tmp)
        do {
            var header = magic
            var v = version.littleEndian
            header.append(Data(bytes: &v, count: 4))
            var n = UInt64(json.count).littleEndian
            header.append(Data(bytes: &n, count: 8))
            try out.write(contentsOf: header)
            try out.write(contentsOf: json)
            for (m, entry) in zip(media, entries) {
                let input = try FileHandle(forReadingFrom: m.url)
                defer { try? input.close() }
                var copied: UInt64 = 0
                while copied < entry.length, let chunk = try input.read(upToCount: 4 << 20), !chunk.isEmpty {
                    let take = min(UInt64(chunk.count), entry.length - copied)
                    try out.write(contentsOf: take == UInt64(chunk.count) ? chunk : chunk.prefix(Int(take)))
                    copied += take
                }
                guard copied == entry.length else { throw CocoaError(.fileReadCorruptFile) }
            }
            try out.close()
        } catch {
            try? out.close()
            try? fm.removeItem(at: tmpDir)
            throw error
        }
        if fm.fileExists(atPath: url.path) {
            _ = try fm.replaceItemAt(url, withItemAt: tmp)
        } else {
            try fm.moveItem(at: tmp, to: url)
        }
        try? fm.removeItem(at: tmpDir)
    }

    // MARK: Read

    static func read(_ url: URL) throws -> Opened {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        let head = try h.read(upToCount: 20) ?? Data()
        if head.count == 20, head.prefix(8) == magic {
            let length = head.subdata(in: 12..<20).withUnsafeBytes { $0.loadUnaligned(as: UInt64.self) }.littleEndian
            guard let json = try h.read(upToCount: Int(length)), json.count == Int(length) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            let file = try JSONDecoder.djaw.decode(ProjectFile.self, from: json)
            return Opened(file: file, blobStart: 20 + length)
        }
        let data = try Data(contentsOf: url)
        return Opened(file: try JSONDecoder.djaw.decode(ProjectFile.self, from: data), blobStart: nil)
    }

    /// Copies one embedded audio file out of the package (skipped if already extracted).
    static func extract(_ m: Media, from url: URL, blobStart: UInt64, to dest: URL) throws {
        let fm = FileManager.default
        if let size = (try? fm.attributesOfItem(atPath: dest.path)[.size] as? NSNumber)?.uint64Value, size == m.length {
            return
        }
        try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        let partial = dest.appendingPathExtension("part")
        fm.createFile(atPath: partial.path, contents: nil)
        let input = try FileHandle(forReadingFrom: url)
        defer { try? input.close() }
        let out = try FileHandle(forWritingTo: partial)
        try input.seek(toOffset: blobStart + m.offset)
        var left = m.length
        while left > 0 {
            guard let chunk = try input.read(upToCount: Int(min(left, 4 << 20))), !chunk.isEmpty else {
                try? out.close()
                throw CocoaError(.fileReadCorruptFile)
            }
            try out.write(contentsOf: chunk)
            left -= UInt64(chunk.count)
        }
        try out.close()
        try? fm.removeItem(at: dest)
        try fm.moveItem(at: partial, to: dest)
    }

    /// Where audio from a package is unpacked: ~/Library/Application Support/DJAW/Media/<project>/
    static func mediaFolder(projectID: String) -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DJAW/Media/\(projectID)", isDirectory: true)
    }
}
