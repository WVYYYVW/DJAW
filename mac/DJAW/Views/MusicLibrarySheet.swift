import SwiftUI
import AVFoundation

/// Browse the Music app library and add songs (purchased or imported, DRM-free) to DJAW.
struct MusicLibrarySheet: View {
    @Environment(MixStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    private enum Phase {
        case loading
        case failed(String)
        case ready(MusicLibrarySnapshot)
    }

    private enum Source: Hashable {
        case all
        case playlist(UInt64)
    }

    @State private var phase: Phase = .loading
    @State private var source: Source = .all
    @State private var query = ""
    @State private var selection: Set<UInt64> = []
    @State private var sortOrder = [KeyPathComparator(\MusicLibraryTrack.title, comparator: .localizedStandard)]
    @State private var preview: AVAudioPlayer?
    @State private var previewID: UInt64?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            switch phase {
            case .loading:
                ProgressView(L("ミュージックのライブラリを読み込み中…", "Reading the Music library…"))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                failure(message)
            case .ready(let snapshot):
                browser(snapshot)
            }
            Divider()
            footer
        }
        .frame(width: 980, height: 620)
        .task { await load() }
        .onDisappear { stopPreview() }
    }

    // MARK: Header / footer

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 3) {
                Label(L("ミュージックから追加", "Add from Music"), systemImage: "music.note.house")
                    .font(Typo.title(15))
                Text(L("購入した曲や自分で取り込んだ曲を、ミックス前の「ライブラリ」に追加します。Apple Music の配信曲は保護（DRM）されているため使えません。",
                       "Adds purchased or imported songs to the library. Apple Music subscription songs are copy-protected (DRM) and can't be used."))
                    .font(Typo.body())
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 20)
            if case .ready = phase {
                TextField(L("曲名・アーティスト・ジャンル・BPM", "Title, artist, genre, BPM"), text: $query)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 240)
            }
        }
        .padding(16)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            if case .ready(let snapshot) = phase {
                let skipped = snapshot.protectedCount + snapshot.cloudOnlyCount
                if skipped > 0 {
                    Label(L("使えない曲 \(skipped) 曲（保護 \(snapshot.protectedCount)・未ダウンロード \(snapshot.cloudOnlyCount)）は表示していません",
                            "\(skipped) songs hidden (\(snapshot.protectedCount) protected, \(snapshot.cloudOnlyCount) not downloaded)"),
                          systemImage: "lock")
                        .font(Typo.body(10))
                        .foregroundStyle(.secondary)
                        .help(L("未ダウンロードの曲は、ミュージックアプリでダウンロードすると表示されます。",
                                "Songs that aren't downloaded appear once you download them in the Music app."))
                }
            }
            Spacer()
            Button(L("キャンセル", "Cancel")) { dismiss() }
                .keyboardShortcut(.cancelAction)
            Button(addTitle) { add() }
                .keyboardShortcut(.defaultAction)
                .disabled(newSelection.isEmpty)
        }
        .padding(12)
    }

    private var addTitle: String {
        let n = newSelection.count
        return n == 0 ? L("ライブラリに追加", "Add to Library") : L("\(n)曲をライブラリに追加", "Add \(n) to Library")
    }

    // MARK: Browser

    private func browser(_ snapshot: MusicLibrarySnapshot) -> some View {
        HSplitView {
            List(selection: Binding<Source?>(get: { source }, set: { if let s = $0 { source = s; selection = [] } })) {
                Label(L("すべての曲（\(snapshot.tracks.count)）", "All Songs (\(snapshot.tracks.count))"),
                      systemImage: "music.note")
                    .tag(Source.all)
                if !snapshot.playlists.isEmpty {
                    Section(L("プレイリスト", "Playlists")) {
                        ForEach(snapshot.playlists) { p in
                            HStack {
                                Label(p.name, systemImage: p.isSmart ? "gearshape" : "music.note.list")
                                    .lineLimit(1)
                                Spacer()
                                Text("\(p.trackIDs.count)")
                                    .font(Typo.readout(10))
                                    .foregroundStyle(.secondary)
                            }
                            .tag(Source.playlist(p.id))
                            .help(p.unavailable > 0
                                  ? L("このプレイリストの \(p.unavailable) 曲は使えないため除いています", "\(p.unavailable) songs in this playlist can't be used")
                                  : p.name)
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .frame(minWidth: 170, idealWidth: 200, maxWidth: 260)

            let rows = visibleTracks(snapshot)
            VStack(spacing: 0) {
                Table(rows, selection: $selection, sortOrder: $sortOrder) {
                    TableColumn("") { t in
                        Button {
                            togglePreview(t)
                        } label: {
                            Image(systemName: previewID == t.id ? "stop.fill" : "play.fill")
                                .font(.system(size: 9))
                        }
                        .buttonStyle(.borderless)
                        .help(L("試聴（曲の中盤から）", "Preview (from the middle)"))
                    }
                    .width(22)
                    TableColumn(L("曲名", "Title"), value: \.title) { t in
                        HStack(spacing: 4) {
                            Text(t.title).lineLimit(1)
                            if isAdded(t) {
                                Text(L("追加済み", "Added"))
                                    .font(Typo.label(9))
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 4)
                                    .background(.quaternary, in: Capsule())
                            }
                        }
                        .opacity(isAdded(t) ? 0.55 : 1)
                    }
                    .width(min: 140, ideal: 220)
                    TableColumn(L("アーティスト", "Artist"), value: \.artist) { t in
                        Text(t.artist).lineLimit(1).foregroundStyle(.secondary)
                    }
                    .width(min: 80, ideal: 130)
                    TableColumn(L("ジャンル", "Genre"), value: \.genre) { t in
                        Text(t.genre).lineLimit(1).foregroundStyle(.secondary)
                    }
                    .width(min: 50, ideal: 80)
                    TableColumn("BPM", value: \.bpm) { t in
                        Text(t.bpm > 0 ? "\(t.bpm)" : "–")
                            .font(Typo.readout(11))
                            .foregroundStyle(t.bpm > 0 ? .primary : .tertiary)
                    }
                    .width(44)
                    TableColumn(L("時間", "Time"), value: \.duration) { t in
                        Text(Fmt.time(t.duration).components(separatedBy: ".").first ?? "")
                            .font(Typo.readout(11))
                            .foregroundStyle(.secondary)
                    }
                    .width(52)
                }
                .contextMenu(forSelectionType: UInt64.self) { ids in
                    Button(L("ライブラリに追加", "Add to Library")) { add(ids) }
                        .disabled(ids.isEmpty)
                } primaryAction: { ids in
                    add(ids)
                }
                .overlay {
                    if rows.isEmpty {
                        ContentUnavailableView(query.isEmpty ? L("使える曲がありません", "No usable songs") : L("見つかりません", "No matches"),
                                               systemImage: "music.note",
                                               description: Text(query.isEmpty
                                                                 ? L("購入した曲や、ファイルから取り込んだ曲が表示されます。", "Purchased and imported songs appear here.")
                                                                 : L("別の言葉で検索してください。", "Try a different search.")))
                    }
                }
                HStack {
                    Button(L("表示中をすべて選択", "Select All Shown")) { selection = Set(rows.map(\.id)) }
                        .disabled(rows.isEmpty)
                    if !selection.isEmpty {
                        Button(L("選択解除", "Deselect")) { selection = [] }
                    }
                    Spacer()
                    Text(L("\(rows.count)曲 ・ \(selection.count)曲を選択中", "\(rows.count) songs · \(selection.count) selected"))
                        .font(Typo.body(10))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
            }
            .frame(minWidth: 480)
        }
    }

    private func failure(_ message: String) -> some View {
        ContentUnavailableView {
            Label(L("ライブラリを読み込めません", "Can't read the library"), systemImage: "lock.shield")
        } description: {
            Text(message)
        } actions: {
            Button(L("システム設定を開く", "Open System Settings")) {
                if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Media") {
                    NSWorkspace.shared.open(url)
                }
            }
            Button(L("もう一度読み込む", "Try Again")) {
                Task { await load() }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: Data

    private func load() async {
        phase = .loading
        let result = await Task.detached(priority: .userInitiated) { () -> Result<MusicLibrarySnapshot, Error> in
            do { return .success(try MusicLibrary.load()) } catch { return .failure(error) }
        }.value
        switch result {
        case .success(let snapshot): phase = .ready(snapshot)
        case .failure(let error): phase = .failed(error.localizedDescription)
        }
    }

    private var snapshot: MusicLibrarySnapshot? {
        if case .ready(let s) = phase { return s }
        return nil
    }

    private func visibleTracks(_ snapshot: MusicLibrarySnapshot) -> [MusicLibraryTrack] {
        var tracks = snapshot.tracks
        if case .playlist(let pid) = source, let p = snapshot.playlists.first(where: { $0.id == pid }) {
            let byID = Dictionary(uniqueKeysWithValues: tracks.map { ($0.id, $0) })
            tracks = p.trackIDs.compactMap { byID[$0] }
        }
        let words = query.lowercased().split(separator: " ").map(String.init)
        if !words.isEmpty {
            tracks = tracks.filter { t in
                let hay = "\(t.title) \(t.artist) \(t.album) \(t.genre) \(t.bpm > 0 ? String(t.bpm) : "")".lowercased()
                return words.allSatisfy { hay.contains($0) }
            }
        }
        return tracks.sorted(using: sortOrder)
    }

    private var addedPaths: Set<String> {
        Set((store.clips + store.library).map { $0.url.standardizedFileURL.path })
    }

    private func isAdded(_ t: MusicLibraryTrack) -> Bool {
        addedPaths.contains(t.url.standardizedFileURL.path)
    }

    /// Selected songs that aren't already in DJAW.
    private var newSelection: [MusicLibraryTrack] {
        guard let snapshot else { return [] }
        let added = addedPaths
        return snapshot.tracks.filter { selection.contains($0.id) && !added.contains($0.url.standardizedFileURL.path) }
    }

    private func add(_ ids: Set<UInt64>? = nil) {
        guard let snapshot else { return }
        let added = addedPaths
        let chosen = ids ?? selection
        let urls = snapshot.tracks
            .filter { chosen.contains($0.id) && !added.contains($0.url.standardizedFileURL.path) }
            .map(\.url)
        guard !urls.isEmpty else { return }
        stopPreview()
        store.addFiles(urls, to: .library)
        dismiss()
    }

    // MARK: Preview

    private func togglePreview(_ t: MusicLibraryTrack) {
        if previewID == t.id { stopPreview(); return }
        stopPreview()
        guard let player = try? AVAudioPlayer(contentsOf: t.url) else { return }
        if store.isPlaying { store.togglePlay() }
        player.currentTime = player.duration * 0.4
        player.play()
        preview = player
        previewID = t.id
    }

    private func stopPreview() {
        preview?.stop()
        preview = nil
        previewID = nil
    }
}
