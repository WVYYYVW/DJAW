import SwiftUI
import AppKit
import UniformTypeIdentifiers

/// Edit a track's profile: artwork, title, artist, album, year, genre, label and notes.
struct TrackProfileSheet: View {
    @Environment(MixStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let clipID: UUID
    @State private var draft = TrackProfile(title: "", artist: "")
    @State private var fileArtwork: NSImage?
    @State private var loaded = false
    @State private var dropping = false
    @State private var message: String?

    private var clip: Clip? { store.clip(clipID) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L("曲の情報", "Track Info")).font(.title3.bold())
            HStack(alignment: .top, spacing: 18) {
                artworkWell
                Form {
                    TextField(L("曲名", "Title"), text: $draft.title)
                    TextField(L("アーティスト", "Artist"), text: $draft.artist)
                    TextField(L("アルバム", "Album"), text: $draft.album)
                    TextField(L("年", "Year"), text: $draft.year)
                    TextField(L("ジャンル", "Genre"), text: $draft.genre)
                    TextField(L("レーベル", "Label"), text: $draft.label)
                    TextField(L("メモ", "Notes"), text: $draft.comment, axis: .vertical)
                        .lineLimit(2...4)
                    if let c = clip {
                        LabeledContent(L("ファイル", "File")) {
                            Text(c.url.lastPathComponent).lineLimit(1).truncationMode(.middle).foregroundStyle(.secondary)
                        }
                        LabeledContent("BPM") { Text(Fmt.bpm(c.bpm)).monospacedDigit().foregroundStyle(.secondary) }
                    }
                }
                .formStyle(.columns)
                .frame(minWidth: 320)
            }
            Text(L("ここで決めた情報は、デッキ・曲リスト・演奏手順・映像の書き出しに使われ、同じ曲を使う他のミックスにも引き継がれます（曲ファイル自体は書き換えません）。",
                   "This info is used on the decks, in the track list, the playing guide and video exports, and carries over to other mixes using the same track (the audio file itself is not changed)."))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                if let message { Text(message).font(.caption).foregroundStyle(.orange) }
                Spacer()
                Button(L("キャンセル", "Cancel")) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(L("保存", "Save")) {
                    if let c = clip { store.saveProfile(draft, forTrackAt: c.url) }
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(22)
        .frame(width: 640)
        .task {
            guard !loaded, let c = clip else { return }
            loaded = true
            draft = store.trackProfile(for: c)
            if let d = await TrackProfiles.embeddedArtwork(c.url) { fileArtwork = NSImage(data: d) }
        }
    }

    private var shownArtwork: NSImage? {
        if draft.noArtwork == true { return nil }
        if let d = draft.artwork { return NSImage(data: d) }
        return fileArtwork
    }

    private var artworkWell: some View {
        VStack(spacing: 8) {
            ZStack {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.clip(clip?.colorIndex ?? 0).opacity(0.25))
                if let img = shownArtwork {
                    Image(nsImage: img)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 200, height: 200)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                } else {
                    VStack(spacing: 6) {
                        Image(systemName: "photo").font(.system(size: 36))
                        Text(L("画像をドロップ", "Drop an image")).font(.caption)
                    }
                    .foregroundStyle(.secondary)
                }
                if dropping {
                    RoundedRectangle(cornerRadius: 8).stroke(Color.accentColor, lineWidth: 3)
                }
            }
            .frame(width: 200, height: 200)
            .onDrop(of: [.image, .fileURL], isTargeted: $dropping) { providers in
                guard let p = providers.first else { return false }
                if p.canLoadObject(ofClass: URL.self) {
                    _ = p.loadObject(ofClass: URL.self) { url, _ in
                        guard let url, let d = try? Data(contentsOf: url) else { return }
                        Task { @MainActor in setArtwork(d) }
                    }
                    return true
                }
                p.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { d, _ in
                    guard let d else { return }
                    Task { @MainActor in setArtwork(d) }
                }
                return true
            }
            HStack(spacing: 6) {
                Button(L("選ぶ…", "Choose…")) { chooseImage() }
                Button(L("貼り付け", "Paste")) { pasteImage() }
            }
            .controlSize(.small)
            HStack(spacing: 6) {
                if draft.artwork != nil || draft.noArtwork == true {
                    Button(L("ファイルの画像に戻す", "Use File’s Artwork")) {
                        draft.artwork = nil
                        draft.noArtwork = nil
                    }
                    .disabled(fileArtwork == nil && draft.noArtwork != true)
                }
                if shownArtwork != nil {
                    Button(L("画像なし", "No Artwork")) {
                        draft.artwork = nil
                        draft.noArtwork = true
                    }
                }
            }
            .controlSize(.small)
        }
        .frame(width: 200)
    }

    private func setArtwork(_ data: Data) {
        guard let jpeg = TrackProfiles.normalizedJPEG(data) else {
            message = L("この画像は読み込めませんでした", "Could not read that image")
            return
        }
        message = nil
        draft.artwork = jpeg
        draft.noArtwork = nil
    }

    private func chooseImage() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url, let d = try? Data(contentsOf: url) else { return }
        setArtwork(d)
    }

    private func pasteImage() {
        let pb = NSPasteboard.general
        if let img = NSImage(pasteboard: pb), let tiff = img.tiffRepresentation {
            setArtwork(tiff)
        } else {
            message = L("クリップボードに画像がありません", "No image on the clipboard")
        }
    }
}
