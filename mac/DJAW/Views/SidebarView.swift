import SwiftUI

/// Mix order. Drag rows to reorder; transitions follow automatically.
struct SidebarView: View {
    @Environment(MixStore.self) private var store

    var body: some View {
        let selection = Binding<Set<UUID>>(
            get: {
                if store.isMultiSelecting { return store.librarySelection }
                return store.selectedClipID.map { [$0] } ?? []
            },
            set: { store.setSidebarSelection($0) })
        List(selection: selection) {
            if !store.clips.isEmpty {
                Section {
                    ForEach(Array(store.clips.enumerated()), id: \.element.id) { index, clip in
                        TrackRow(index: index, clip: clip)
                            .tag(clip.id)
                            .contextMenu { rowMenu(clip) }
                    }
                    .onMove { store.moveClips(from: $0, to: $1) }
                } header: {
                    Text(L("ミックス順（ドラッグで並べ替え）", "Mix order (drag to reorder)"))
                }
            }
            if !store.library.isEmpty {
                Section {
                    ForEach(store.library) { clip in
                        LibraryRow(clip: clip)
                            .tag(clip.id)
                            .contextMenu {
                                if store.isMultiSelecting && store.librarySelection.contains(clip.id) {
                                    multiMenu
                                } else {
                                Button(L("曲の情報（ジャケット・アーティスト）を編集…", "Edit Track Info (Artwork, Artist)…")) { store.openProfileEditor(clip.id) }
                                Button(L("CUE（IN / OUT）を編集…", "Edit Cues (IN / OUT)…")) { store.openCueEditor(clip.id) }
                                Button(L("ミックスの末尾に入れる", "Add to End of Mix")) { store.addToMix(clip.id, at: store.clips.count) }
                                Button(L("選択中の曲の後に入れる", "Add After Selected Track")) { store.addToMix(clip.id) }
                                Divider()
                                Button(L("Finderで表示", "Show in Finder")) { store.revealInFinder(clip.id) }
                                Button(L("ライブラリから削除", "Remove from Library"), role: .destructive) {
                                    store.removeFromLibrary([clip.id])
                                }
                                }
                            }
                    }
                } header: {
                    Text(L("ライブラリ（未配置）", "Library (not in mix)"))
                }
            }
            if !store.pending.isEmpty {
                Section(L("解析中", "Analyzing")) {
                    ForEach(store.pending) { item in
                        HStack(spacing: 8) {
                            if let st = store.analysisStatus[item.url] {
                                AnalysisRing(status: st)
                            } else {
                                ProgressView().controlSize(.small)
                            }
                            VStack(alignment: .leading, spacing: 1) {
                                Text(item.name).lineLimit(1).foregroundStyle(.secondary)
                                if let st = store.analysisStatus[item.url] { AnalysisCaption(status: st) }
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .overlay {
            if store.clips.isEmpty && store.library.isEmpty && store.pending.isEmpty {
                ContentUnavailableView {
                    Label(L("曲がありません", "No tracks"), systemImage: "music.note.list")
                } description: {
                    Text(L("音声ファイルやフォルダをここかタイムラインにドロップしてください", "Drop audio files or folders here or on the timeline"))
                } actions: {
                    Button(L("曲を追加…", "Add Tracks…")) { store.presentAddFiles() }
                    Button(L("ミュージックから追加…", "Add from Music…")) { store.showMusicLibrary = true }
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                Divider()
                HStack {
                    Button {
                        store.presentAddFiles()
                    } label: {
                        Label(L("曲を追加", "Add Tracks"), systemImage: "plus")
                    }
                    .buttonStyle(.borderless)
                    Button {
                        store.showMusicLibrary = true
                    } label: {
                        Image(systemName: "music.note.house")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(L("ミュージックから追加", "Add from Music"))
                    .help(L("ミュージックのライブラリから追加（⌥⇧⌘I）", "Add from the Music library (⌥⇧⌘I)"))
                    if store.library.count > 1 {
                        Button(store.isMultiSelecting ? L("選択解除", "Deselect") : L("ライブラリを全選択", "Select Library")) {
                            if store.isMultiSelecting { store.setSidebarSelection([]) } else { store.selectAllLibrary() }
                        }
                        .buttonStyle(.borderless)
                        .help(L("ライブラリの曲をまとめて選択（⌥⌘A）。⌘クリック／⇧クリックでも複数選択できます",
                                "Select all library tracks (⌥⌘A). You can also ⌘-click / ⇧-click"))
                    }
                    Spacer()
                    if !(store.clips.isEmpty && store.library.isEmpty) {
                        let p = store.progressSummary
                        VStack(alignment: .trailing, spacing: 1) {
                            Text(L("\(store.clips.count)曲 · \(Fmt.duration(store.realMixDuration))", "\(store.clips.count) tracks · \(Fmt.duration(store.realMixDuration))"))
                            Text(L("CUE \(p.cues)/\(p.cueTotal) · つなぎ \(p.transitions)/\(p.transitionTotal)",
                                   "Cues \(p.cues)/\(p.cueTotal) · Transitions \(p.transitions)/\(p.transitionTotal)"))
                        }
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .help(L("進捗：IN / OUT を設定した曲と、つなぎ方を決めた曲の数", "Progress: tracks with cues set and transitions chosen"))
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .background(.bar)
        }
        .dropDestination(for: URL.self) { urls, _ in
            store.addFiles(urls, to: .library)
            return true
        }
    }

    @ViewBuilder
    private var multiMenu: some View {
        let ids = store.selectedLibraryIDs
        Button(L("\(ids.count)曲をミックスの末尾に入れる", "Add \(ids.count) Tracks to End of Mix")) { store.addToMix(ids, at: store.clips.count) }
        Button(L("\(ids.count)曲でおまかせミックス…", "Auto-Arrange \(ids.count) Tracks…")) { store.autoArrange(preselecting: ids) }
        Divider()
        Button(L("\(ids.count)曲をライブラリから削除", "Remove \(ids.count) Tracks from Library"), role: .destructive) { store.removeFromLibrary(ids) }
    }

    @ViewBuilder
    private func rowMenu(_ clip: Clip) -> some View {
        Button(clip.cueDone == true ? L("CUE を未完了に戻す", "Mark Cues as Not Done") : L("CUE を完了にする", "Mark Cues as Done")) {
            store.setProgress(clip.id, cue: !(clip.cueDone ?? false))
        }
        if (store.index(of: clip.id) ?? 0) > 0 {
            Button(store.isTransitionLocked(into: clip.id) ? L("前の曲とのつなぎの固定を解除", "Unlock Transition from Previous Track")
                                                           : L("前の曲とのつなぎを固定", "Lock Transition from Previous Track")) {
                store.toggleTransitionLock(into: clip.id)
            }
        }
        Divider()
        Button(L("曲の情報（ジャケット・アーティスト）を編集…", "Edit Track Info (Artwork, Artist)…")) { store.openProfileEditor(clip.id) }
        Button(L("CUE（IN / OUT）を編集…", "Edit Cues (IN / OUT)…")) { store.openCueEditor(clip.id) }
        Button(L("ライブラリに戻す", "Move Back to Library")) { store.removeFromMix(clip.id) }
        Divider()
        Button(L("ここから再生", "Play from Here")) {
            store.seek(clip.start)
            if !store.isPlaying { store.play() }
        }
        Button(L("Finderで表示", "Show in Finder")) { store.revealInFinder(clip.id) }
        Divider()
        Button(L("ミックスから削除", "Remove from Mix"), role: .destructive) { store.deleteClip(clip.id) }
    }
}

/// A prepared-but-unplaced track: shows its cues and a one-click way into the mix.
private struct LibraryRow: View {
    @Environment(MixStore.self) private var store
    let clip: Clip

    var body: some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 2)
                .fill(Color.clip(clip.colorIndex))
                .frame(width: 4, height: 30)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(clip.title)
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                    ProgressIcons(clip: clip, showTransition: false)
                }
                if let st = store.analysisStatus[clip.url] {
                    AnalysisCaption(status: st)
                } else {
                    Text("IN \(Clip.barLabel(clip.mixInBar)) · OUT \(Clip.barLabel(clip.mixOutBar)) · \(Fmt.bpm(clip.bpm)) BPM" + (store.structures[clip.url]?.key.map { " · \($0.camelot)" } ?? ""))
                        .font(Typo.readout(10, .regular))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            if let st = store.analysisStatus[clip.url] { AnalysisRing(status: st) }
            Button {
                store.openCueEditor(clip.id)
            } label: {
                Image(systemName: "slider.horizontal.below.rectangle")
            }
            .buttonStyle(.borderless)
            .help(L("CUE（IN / OUT）を編集", "Edit cues (IN / OUT)"))
            Button {
                store.addToMix(clip.id)
            } label: {
                Image(systemName: "plus.circle.fill")
            }
            .buttonStyle(.borderless)
            .help(L("ミックスに入れる（選択中の曲の後ろ、なければ末尾）", "Add to the mix (after the selected track, or at the end)"))
        }
        .padding(.vertical, 2)
    }
}

private struct TrackRow: View {
    @Environment(MixStore.self) private var store
    let index: Int
    let clip: Clip

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if index > 0 {
                transitionLine
            }
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.clip(clip.colorIndex))
                    .frame(width: 4, height: 30)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text("\(index + 1)")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                        Text(clip.title)
                            .font(.system(size: 12, weight: .semibold))
                            .lineLimit(1)
                        ProgressIcons(clip: clip, showTransition: index > 0)
                    }
                    HStack(spacing: 6) {
                        LaneBadge(lane: index % 2)
                        if let st = store.analysisStatus[clip.url] {
                            AnalysisCaption(status: st)
                        } else {
                            Text(clip.artist.isEmpty ? clip.url.lastPathComponent : clip.artist)
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                Spacer(minLength: 4)
                if let st = store.analysisStatus[clip.url] { AnalysisRing(status: st, size: 18) }
                VStack(alignment: .trailing, spacing: 2) {
                    HStack(spacing: 3) {
                        if store.missingFiles.contains(clip.url) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.red)
                                .help(L("ファイルが見つかりません", "File not found"))
                        }
                        if let key = store.structures[clip.url]?.key {
                            Text(key.camelot)
                                .font(Typo.label(9)).tracking(Typo.labelTracking)
                                .foregroundStyle(.purple)
                                .help(key.name)
                        }
                        Text(Fmt.bpm(clip.bpm))
                            .font(Typo.readout(11))
                    }
                    Text(Fmt.duration(clip.length(master: store.masterBPM)))
                        .font(Typo.readout(10, .regular))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var transitionLine: some View {
        // Look the neighbour up live: the stored `index` can be stale for one
        // render right after tracks are removed or reordered.
        let live = store.index(of: clip.id) ?? 0
        let prev = live > 0 ? store.clips[live - 1] : clip
        let label: String
        if clip.transitionBars < 0.01 {
            label = L("直結 · \(Clip.barLabel(prev.mixOutBar)) → \(Clip.barLabel(clip.mixInBar))", "Direct · \(Clip.barLabel(prev.mixOutBar)) → \(Clip.barLabel(clip.mixInBar))")
        } else {
            label = "\(Fmt.bars(clip.transitionBars)) · \(clip.transition.title) · \(Clip.barLabel(prev.mixOutBar)) → \(Clip.barLabel(clip.mixInBar))"
        }
        let locked = store.isLocked(live)
        return HStack(spacing: 4) {
            Image(systemName: "arrow.turn.down.right")
            Text(label).lineLimit(1)
            Spacer(minLength: 2)
            Button {
                store.toggleTransitionLock(into: clip.id)
            } label: {
                Image(systemName: locked ? "lock.fill" : "lock.open")
                    .foregroundStyle(locked ? Color.orange : Color.secondary.opacity(0.6))
            }
            .buttonStyle(.plain)
            .help(locked
                  ? L("この2曲のつなぎは固定中（クリックで解除）。曲の追加・並べ替え・自動ミックスでも変わりません",
                      "This transition is locked (click to unlock). Adding, reordering and auto-mix leave it as it is")
                  : L("この2曲のつなぎを固定する（間に曲が入らず、自動ミックスでも作り直されません）",
                      "Lock this transition (nothing gets put between the two, and auto-mix keeps it)"))
        }
        .font(.system(size: 10, weight: .medium))
        .foregroundStyle(.secondary)
        .padding(.leading, 14)
    }
}

/// Small progress marks: cues set / transition chosen.
struct ProgressIcons: View {
    let clip: Clip
    let showTransition: Bool

    var body: some View {
        HStack(spacing: 2) {
            if clip.cueDone == true {
                Image(systemName: "scope")
                    .foregroundStyle(.green)
                    .help(L("CUE 設定済み", "Cues set"))
            }
            if showTransition && clip.transitionDone == true {
                Image(systemName: "link")
                    .foregroundStyle(.purple)
                    .help(L("つなぎ設定済み", "Transition chosen"))
            }
        }
        .font(Typo.label(9)).tracking(Typo.labelTracking)
    }
}

struct LaneBadge: View {
    let lane: Int

    var body: some View {
        Text(lane == 0 ? "A" : "B")
            .font(Typo.label(9)).tracking(Typo.labelTracking)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(RoundedRectangle(cornerRadius: 3).fill(Color.primary.opacity(0.12)))
    }
}
