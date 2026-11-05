import SwiftUI
import AppKit

struct InspectorView: View {
    @Environment(MixStore.self) private var store

    var body: some View {
        Group {
            if store.isMultiSelecting {
                MultiLibraryInspector()
            } else if let index = store.selectedIndex {
                ClipInspector(snapshot: store.clips[index])
            } else if let id = store.selectedClipID, let clip = store.clip(id) {
                LibraryInspector(clip: clip)
            } else {
                MixInspector()
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Artwork

/// A track's artwork (or its colour with a note icon), with the track colour as a frame.
struct ArtworkThumb: View {
    @Environment(MixStore.self) private var store
    let clip: Clip
    let size: CGFloat

    var body: some View {
        let _ = store.artworkRevision
        let img = store.artwork(for: clip.url)
        ZStack {
            RoundedRectangle(cornerRadius: 5).fill(Color.clip(clip.colorIndex).opacity(0.3))
            if let img {
                Image(decorative: img, scale: 1)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                Image(systemName: "music.note").foregroundStyle(Color.clip(clip.colorIndex))
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: 5))
        .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.clip(clip.colorIndex), lineWidth: 2))
        .contentShape(Rectangle())
    }
}

// MARK: - Library track

private struct LibraryInspector: View {
    @Environment(MixStore.self) private var store
    let clip: Clip

    var body: some View {
        Form {
            Section {
                HStack(alignment: .top, spacing: 10) {
                    ArtworkThumb(clip: clip, size: 48)
                        .onTapGesture { store.openProfileEditor(clip.id) }
                        .help(L("クリックで曲の情報（ジャケット・アーティスト）を編集", "Click to edit the track info (artwork, artist)"))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(clip.title).font(.headline).lineLimit(2)
                        if !clip.artist.isEmpty {
                            Text(clip.artist).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Text("\(Fmt.bpm(clip.bpm)) BPM · \(Fmt.duration(clip.duration))")
                            .font(.caption).monospacedDigit().foregroundStyle(.secondary)
                        Text(L("ライブラリ（未配置）", "Library (not in mix)"))
                            .font(.caption2.bold())
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Section {
                LabeledContent("IN") { Text(Fmt.barOrdinal(clip.mixInBar)).monospacedDigit().foregroundStyle(.green) }
                LabeledContent("OUT") { Text(Fmt.barOrdinal(clip.mixOutBar)).monospacedDigit().foregroundStyle(.orange) }
                Button {
                    store.openCueEditor(clip.id)
                } label: {
                    Label(L("CUE（IN / OUT）を編集…", "Edit Cues (IN / OUT)…"), systemImage: "slider.horizontal.below.rectangle")
                }
                .buttonStyle(.borderedProminent)
            } header: {
                Text(L("CUE", "Cues"))
            }
            Section {
                Button {
                    store.addToMix(clip.id, at: store.clips.count)
                } label: {
                    Label(L("ミックスの末尾に入れる", "Add to End of Mix"), systemImage: "plus.rectangle.on.rectangle")
                }
                Text(L("ミックスに入れると、前の曲の OUT からこの曲の IN で直結されます。つなぎ方はそのあと選びます。",
                       "In the mix, it connects directly from the previous track’s OUT to this track’s IN. Pick a transition afterwards."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section {
                Button(role: .destructive) {
                    store.deleteSelected()
                } label: {
                    Label(L("ライブラリから削除", "Remove from Library"), systemImage: "trash")
                }
            }
        }
    }
}

// MARK: - Clip

private struct ClipInspector: View {
    @Environment(MixStore.self) private var store
    /// Values are looked up live by id: SwiftUI can re-render this view with stale
    /// stored properties right after a track is removed or moved, so a remembered
    /// position must never be used to index into the mix.
    let snapshot: Clip
    private var index: Int { store.index(of: snapshot.id) ?? -1 }
    private var clip: Clip { index >= 0 ? store.clipAt(index, or: snapshot) : snapshot }

    private var isLast: Bool { index == store.clips.count - 1 }

    var body: some View {
        if index >= 0 { content }
    }

    @ViewBuilder
    private var content: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            Picker("", selection: $store.inspectorTab) {
                ForEach(InspectorTab.allCases) { tab in
                    Text(tab == .fx && (clip.fx?.count ?? 0) > 0 ? "FX \(clip.fx!.count)" : tab.title).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 2)
            Form {
                header
                switch store.inspectorTab {
                case .transition:
                    if index > 0 {
                        TakesSection(clipID: clip.id)
                        VariationsSection(clipID: clip.id)
                        TransitionEditor(clipID: clip.id)
                    } else {
                        Section(L("つなぎ", "Transition")) {
                            Label(L("ミックスの1曲目です", "This is the first track of the mix"), systemImage: "flag.checkered")
                                .foregroundStyle(.secondary)
                        }
                    }
                    TempoChangeSection(clipID: clip.id)
                    if !isLast { nextTransitionSection }
                case .deck:
                    Section {
                        Button {
                            store.openCueEditor(clip.id)
                        } label: {
                            Label(L("CUE（IN / OUT）を編集…", "Edit Cues (IN / OUT)…"), systemImage: "slider.horizontal.below.rectangle")
                        }
                        .help(L("この曲だけを聴きながら入口と出口を設定します（タイムラインで曲をダブルクリックでも開きます）",
                                "Set IN and OUT while listening to this track alone (or double-click it on the timeline)"))
                    }
                    GenreSection(clipID: clip.id)
                    AIAnalysisSection(clipID: clip.id)
                    DJControlsSection(clipID: clip.id)
                    tempoSection
                    gridSection
                case .fx:
                    FXSection(clipID: clip.id)
                case .mixer:
                    mixerSection
                    fadeSection
                }
            }
        }
    }

    private var actionsMenu: some View {
        Menu {
            Button {
                store.removeFromMix(clip.id)
            } label: {
                Label(L("ライブラリに戻す", "Move Back to Library"), systemImage: "tray.and.arrow.down")
            }
            Button {
                store.revealInFinder(clip.id)
            } label: {
                Label(L("Finderで表示", "Show in Finder"), systemImage: "folder")
            }
            Divider()
            Button(role: .destructive) {
                store.deleteClip(clip.id)
            } label: {
                Label(L("ミックスから削除", "Remove from Mix"), systemImage: "trash")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(L("この曲の操作", "Track actions"))
    }

    private var header: some View {
        Section {
            HStack(alignment: .top, spacing: 10) {
                ArtworkThumb(clip: clip, size: 48)
                    .onTapGesture { store.openProfileEditor(clip.id) }
                    .help(L("クリックで曲の情報（ジャケット・アーティスト）を編集", "Click to edit the track info (artwork, artist)"))
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .top) {
                        Text(clip.title)
                            .font(.headline)
                            .lineLimit(2)
                        Spacer(minLength: 4)
                        actionsMenu
                    }
                    Text(clip.artist.isEmpty ? clip.url.lastPathComponent : clip.artist)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        LaneBadge(lane: index % 2)
                        Text(L("\(index + 1)曲目 · \(Fmt.bpm(clip.bpm)) BPM · \(Fmt.duration(clip.duration))", "Track \(index + 1) · \(Fmt.bpm(clip.bpm)) BPM · \(Fmt.duration(clip.duration))"))
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                        if let key = store.structures[clip.url]?.key {
                            KeyBadge(key: key)
                        }
                    }
                }
            }
            .padding(.vertical, 2)
            if let s = store.structures[clip.url] {
                StructureSummary(structure: s, clip: clip)
            }
        }
    }

    private var nextTransitionSection: some View {
        let next = store.clipAt(index + 1, or: clip)
        let kind = next.transitionBars < 0.01 ? next.transition.title : Fmt.bars(next.transitionBars) + " " + next.transition.title
        let outBar = Fmt.barOrdinal(clip.mixOutBar)
        return Section(L("次の曲へ", "Into the Next Track")) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(next.title).lineLimit(1)
                    Text(L("出口 \(outBar) · \(kind)", "Mix-out \(outBar) · \(kind)"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button(L("編集", "Edit")) { store.selectedClipID = next.id }
                    .controlSize(.small)
            }
        }
    }

    private var tempoSection: some View {
        Section {
            LabeledContent("BPM") {
                HStack(spacing: 6) {
                    TextField("BPM",
                              value: Binding(get: { clip.bpm }, set: { store.setClipBPM(clip.id, $0) }),
                              format: .number.precision(.fractionLength(0...2)))
                        .labelsHidden()
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 70)
                        .multilineTextAlignment(.trailing)
                    Menu {
                        Button(L("×2（\(Fmt.bpm(clip.bpm * 2))）", "×2 (\(Fmt.bpm(clip.bpm * 2)))")) { store.scaleClipBPM(clip.id, by: 2) }
                        Button(L("÷2（\(Fmt.bpm(clip.bpm / 2))）", "÷2 (\(Fmt.bpm(clip.bpm / 2)))")) { store.scaleClipBPM(clip.id, by: 0.5) }
                        Divider()
                        Button(L("BPMを再解析", "Re-analyze BPM")) { store.reanalyze(clip.id) }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                }
            }
            Toggle(L("ミックスBPMに合わせる", "Sync to Mix BPM"), isOn: Binding(get: { clip.tempoSync }, set: { store.setTempoSync(clip.id, $0) }))
            if clip.tempoSync {
                let rate = clip.rate(master: store.masterBPM)
                LabeledContent(L("再生速度", "Speed")) {
                    Text(Fmt.ratePercent(rate))
                        .monospacedDigit()
                        .foregroundStyle(abs(rate - 1) > 0.08 ? Color.orange : Color.secondary)
                }
                if abs(rate - 1) > 0.08 {
                    Label(L("テンポ差が大きいため音質が劣化する場合があります", "Large tempo change — sound quality may suffer"), systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
        } header: {
            Text(L("テンポ", "Tempo"))
        }
    }

    private var gridSection: some View {
        Section {
            LabeledContent(L("1小節目の位置", "Bar 1 Position")) {
                HStack(spacing: 4) {
                    Button { store.shiftDownbeat(clip.id, beats: -1) } label: { Image(systemName: "chevron.left") }
                        .help(L("1拍前へ", "One beat earlier"))
                    Button { store.shiftDownbeat(clip.id, beats: 1) } label: { Image(systemName: "chevron.right") }
                        .help(L("1拍後ろへ", "One beat later"))
                }
                .controlSize(.small)
            }
            LabeledContent(L("グリッド微調整", "Grid Fine-Tune")) {
                HStack(spacing: 4) {
                    Button("−10ms") { store.nudgeGrid(clip.id, milliseconds: -10) }
                    Button("+10ms") { store.nudgeGrid(clip.id, milliseconds: 10) }
                }
                .controlSize(.small)
            }
        } header: {
            Text(L("ビートグリッド", "Beat Grid"))
        } footer: {
            Text(L("小節番号が曲の展開とずれている時は「1小節目の位置」を1拍ずつ動かします。キックがずれて聞こえる時は微調整を使います。", "If bar numbers don’t match the song’s phrases, move “Bar 1 Position” one beat at a time. If the kicks sound flammed, use fine-tune."))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var mixerSection: some View {
        Section(L("ミキサー", "Mixer")) {
            ValueSlider(title: L("音量", "Volume"), value: clip.gainDB, range: -18...6, defaultValue: 0, format: Fmt.db,
                        onBegin: { store.pushUndo() },
                        onChange: { v in store.updateClip(clip.id, undoable: false) { $0.gainDB = v } })
            if store.loudnessMode != .off {
                HStack {
                    Label(L("ラウドネス補正", "Loudness"), systemImage: "speaker.wave.2")
                    Spacer()
                    if let g = clip.loudnessGainDB, let l = clip.lufs {
                        Text(L("\(String(format: "%+.1f", g)) dB（\(String(format: "%.1f", l)) LUFS）", "\(String(format: "%+.1f", g)) dB (\(String(format: "%.1f", l)) LUFS)"))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    } else {
                        Text(L("測定中…", "Measuring…")).foregroundStyle(.secondary)
                    }
                }
                .font(.caption)
                .help(L("この曲の使う区間の音量（LUFS）を測り、ミックス全体の設定に合わせて自動で足し引きしています。上の「音量」はこれに加えて効きます。",
                        "The loudness (LUFS) of the part of this track the mix plays is measured and corrected automatically to the mix setting. “Volume” above comes on top."))
            }
            ValueSlider(title: "LOW", value: clip.eqLow, range: -26...6, defaultValue: 0, format: Fmt.db,
                        onBegin: { store.pushUndo() },
                        onChange: { v in store.updateClip(clip.id, undoable: false) { $0.eqLow = v } })
            ValueSlider(title: "MID", value: clip.eqMid, range: -26...6, defaultValue: 0, format: Fmt.db,
                        onBegin: { store.pushUndo() },
                        onChange: { v in store.updateClip(clip.id, undoable: false) { $0.eqMid = v } })
            ValueSlider(title: "HIGH", value: clip.eqHigh, range: -26...6, defaultValue: 0, format: Fmt.db,
                        onBegin: { store.pushUndo() },
                        onChange: { v in store.updateClip(clip.id, undoable: false) { $0.eqHigh = v } })
        }
    }

    @ViewBuilder
    private var fadeSection: some View {
        if index == 0 || isLast {
            Section(L("フェード", "Fades")) {
                if index == 0 {
                    ValueSlider(title: L("フェードイン", "Fade In"), value: clip.fadeInBeats, range: 0...64, step: 1, defaultValue: 0,
                                format: Fmt.beats,
                                onBegin: { store.pushUndo() },
                                onChange: { v in store.updateClip(clip.id, undoable: false) { $0.fadeInBeats = v } })
                }
                if isLast {
                    ValueSlider(title: L("フェードアウト", "Fade Out"), value: clip.fadeOutBeats, range: 0...64, step: 1, defaultValue: 0,
                                format: Fmt.beats,
                                onBegin: { store.pushUndo() },
                                onChange: { v in store.updateClip(clip.id, undoable: false) { $0.fadeOutBeats = v } })
                    BarControl(title: L("終了位置", "End Point"),
                               value: clip.endBar ?? clip.bar(atSource: clip.trimEnd),
                               suffix: clip.endBar == nil ? L("（曲の最後）", " (end of track)") : nil) { delta in
                        let current = clip.endBar ?? floor(clip.lastBar)
                        let v = current + delta
                        store.setEndBar(clip.id, bar: v >= clip.lastBar - 0.01 ? nil : v)
                    }
                }
            }
        }
    }
}

// MARK: - Transition editor

/// The guided "how do I connect these two tracks" panel.
private struct TransitionEditor: View {
    @Environment(MixStore.self) private var store
    let clipID: UUID
    @State private var editBand: EQBand = .low

    private var index: Int { store.index(of: clipID) ?? 0 }
    // Looked up safely: closures inside the view can run once more right after the
    // track has left the mix (e.g. moved back to the library).
    private var clip: Clip { store.clipAt(index, or: .placeholder) }
    private var prev: Clip { store.clipAt(index - 1, or: clip) }

    var body: some View {
        if index > 0 { content }
    }

    @State private var showFine = false

    /// Styles in the order a DJ would usually reach for them.
    private static let styleOrder: [TransitionStyle] = [.crossfade, .bassSwap, .filter, .echoOut, .cut, .brake, .backspin, .custom]

    @ViewBuilder
    private var content: some View {
        // 1) What happens, and the two most useful actions.
        Section {
            if let sentence = store.transitionSentence(at: index) {
                Text(sentence)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.accentColor.opacity(0.12)))
            }
            Toggle(isOn: Binding(get: { store.isTransitionLocked(into: clip.id) },
                                 set: { store.setTransitionLocked(into: clip.id, $0) })) {
                VStack(alignment: .leading, spacing: 1) {
                    Label(L("このつなぎを固定", "Lock This Transition"), systemImage: "lock.fill")
                    Text(L("2曲の間に曲が入らず、並べ替えでは2曲まとめて動きます。自動ミックス・パターン切り替えでも作り直しません（手での調整はできます）",
                           "Nothing is put between the two, reordering moves them together, and auto-mix / patterns keep it (you can still edit it by hand)"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .toggleStyle(.switch)
            .controlSize(.small)
            TransitionDiagram(clipID: clip.id)
                .frame(height: 86)
            if let sim = store.simplification(at: index) {
                HStack(spacing: 8) {
                    Label(L("音はそのまま \(Fmt.bars(sim.oldBars)) → \(Fmt.bars(sim.newBars)) に短く書けます",
                            "Same sound in \(Fmt.bars(sim.newBars)) instead of \(Fmt.bars(sim.oldBars))"), systemImage: "scissors")
                        .font(.caption)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    Button(L("簡単にする", "Simplify")) { store.simplifyTransition(into: clip.id) }
                        .controlSize(.small)
                }
                .help(L("前の曲がそのまま鳴っていて次の曲が無音の部分（またはその逆）を、つなぎから外します。聞こえる音は変わりません。⌘Z で戻せます。",
                        "Drops the bars where only one track plays unchanged and the other is silent. What you hear stays the same. ⌘Z undoes it."))
            }
            HStack(spacing: 8) {
                Button {
                    store.autoMixTransition(into: clip.id)
                } label: {
                    Label(L("自動で決める", "Auto"), systemImage: "wand.and.stars")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(.purple)
                .help(L("2曲のイントロ・ドロップ・アウトロとキーを解析して、出口・入口・長さ・つなぎ方をまとめて決めます",
                        "Analyses both tracks’ intro, drops, outro and key, and sets mix-out, mix-in, length and style"))
                Button {
                    store.previewTransition(clip.id)
                } label: {
                    Label(L("試聴", "Preview"), systemImage: "play.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .help(L("つなぎの4小節前から再生します", "Plays from 4 bars before the transition"))
            }
            .controlSize(.large)
            Button {
                store.openTransitionEditor(clip.id)
            } label: {
                Label(L("つなぎエディタで LOW / HIGH・フェーダーを描く…", "Draw LOW / HIGH & Fader in Transition Editor…"), systemImage: "slider.horizontal.3")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(clip.transitionBars < 0.01)
            .help(L("自動ミックスで決まったつなぎも、ここから描き直せます（⌘T、タイムラインのつなぎ表示をダブルクリックでも開きます）",
                    "Redraw any transition, including auto-mixed ones (also ⌘T, or double-click the transition on the timeline)"))
            if let note = store.autoNote(for: clip) {
                VStack(alignment: .leading, spacing: 4) {
                    Label(L("自動ミックスの判断", "Why the auto-mix chose this"), systemImage: "wand.and.stars")
                        .font(.caption.bold())
                        .foregroundStyle(.purple)
                    ForEach(note.split(separator: "\n").map(String.init), id: \.self) { line in
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Text("•").foregroundStyle(.secondary)
                            Text(line).fixedSize(horizontal: false, vertical: true)
                        }
                        .font(.caption)
                    }
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.purple.opacity(0.10)))
            }
        } header: {
            Text(L("前の曲からのつなぎ", "Transition from Previous Track"))
        }

        // 2) How: the type, then how long it overlaps.
        Section {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 4), spacing: 6) {
                ForEach(Self.styleOrder) { style in
                    StyleTile(style: style, selected: clip.transition == style,
                              outColor: Color.clip(prev.colorIndex), inColor: Color.clip(clip.colorIndex)) {
                        store.setTransitionStyle(clip.id, style)
                    }
                }
            }
            .padding(.vertical, 2)
            Text(clip.transition.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if clip.transition.usesLength {
                LengthChooser(clip: clip)
            }
            if !clip.transition.spinChoices.isEmpty {
                SpinChooser(clip: clip)
            }

            if !store.customTransitions.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L("マイつなぎ", "My Transitions"))
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(store.customTransitions) { preset in
                                let on = clip.transition == .custom && clip.lanes == preset.lanes
                                Button {
                                    store.applyCustomTransition(clip.id, preset)
                                } label: {
                                    Label("\(preset.name) · \(Int(preset.bars))", systemImage: "star.fill")
                                        .font(.caption)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 4)
                                        .background(Capsule().fill(on ? Color.accentColor.opacity(0.25) : Color.primary.opacity(0.07)))
                                }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button(L("削除", "Delete"), role: .destructive) { store.deleteCustomTransition(preset.id) }
                                }
                            }
                        }
                    }
                }
            }
        } header: {
            Text(L("つなぎ方", "Style"))
        }

        // 3) Where: the three positions, each nudged in place.
        Section {
            PositionRow(title: L("前の曲の出口", "Previous mix-out"), value: prev.mixOutBar, color: .orange,
                        help: L("ここから2曲が重なり始めます", "The two tracks start overlapping here")) { delta in
                store.setEntryPoint(clip.id, previousMixOut: prev.mixOutBar + delta)
            }
            PositionRow(title: L("この曲の入口", "This track’s mix-in"), value: clip.mixInBar, color: .green,
                        help: L("この曲のどこから鳴らし始めるか", "Where in this track playback starts")) { delta in
                store.setMixIn(clip.id, bar: clip.mixInBar + delta)
            }
            if clip.transitionBars > 0.01 {
                PositionRow(title: L("切替完了", "Switch done"), value: clip.landingBar, color: .purple,
                            help: L("前の曲が消えて、この曲だけになる位置（ドロップ頭が定番）", "Where only this track remains (usually a drop)")) { delta in
                    store.setLandingBar(clip.id, bar: clip.landingBar + delta)
                }
                Toggle(L("長さを変えても「切替完了」を動かさない", "Keep “switch done” when changing the length"),
                       isOn: Binding(get: { clip.keepsLanding }, set: { store.setLandingLock(clip.id, $0) }))
                    .font(.caption)
            }
        } header: {
            Text(L("位置", "Positions"))
        } footer: {
            Text(L("‹ › で1小節、« » で4小節（⌥を押しながらで1拍）。タイムラインでは曲のドラッグで出口、左端で入口、右端で長さを変えられます。",
                   "‹ › move 1 bar, « » 4 bars (hold ⌥ for 1 beat). On the timeline, drag a track to move the mix-out, its left edge for the mix-in, the right edge for the length."))
                .font(.caption)
                .foregroundStyle(.secondary)
        }

        // 4) Fine tuning, out of the way until needed.
        Section {
            DisclosureGroup(isExpanded: $showFine) {
                if clip.transition.editableVolume && clip.transitionBars > 0.01 {
                    TransitionCurveEditor(clipID: clip.id, band: editBand)
                        .frame(height: 200)
                    curveControls
                }
                Button {
                    store.openTransitionEditor(clip.id)
                } label: {
                    Label(L("つなぎエディタで自由に描く…", "Draw Freely in the Transition Editor…"), systemImage: "pencil.and.outline")
                }
            } label: {
                Label(L("音量カーブとEQを細かく調整", "Fine-tune volume curves & EQ"), systemImage: "slider.horizontal.3")
            }
        }
    }

    private var totalBeats: Double { max(1, clip.transitionBars * 4) }

    /// "3小節目" / "3小節目 2拍" inside the transition.
    private func positionLabel(_ x: Double) -> String {
        let beats = Int((x * totalBeats).rounded())
        let bar = beats / 4 + 1
        let beat = beats % 4 + 1
        return beat == 1 ? L("\(bar)小節目", "bar \(bar)") : L("\(bar)小節目 \(beat)拍", "bar \(bar) beat \(beat)")
    }

    private var curveControls: some View {
        let shape = clip.transitionShape
        let step = 1 / totalBeats
        let band = shape.band(editBand)
        func setBand(_ change: @escaping (inout BandSwap) -> Void) {
            let which = editBand
            store.setTransitionShape(clip.id) { s in
                var b = s.band(which)
                change(&b)
                s.setBand(which, b)
            }
        }
        return Group {
            Picker(L("音量カーブ", "Volume curve"), selection: Binding(
                get: { shape.volumeCurve },
                set: { v in store.setTransitionShape(clip.id) { $0.volumeCurve = v } })) {
                ForEach(CurveShape.allCases) { c in Text(c.title).tag(c) }
            }
            LabeledContent(L("次の曲が上がりきる", "Next track at full")) {
                HStack(spacing: 6) {
                    Text(positionLabel(shape.inRise)).monospacedDigit()
                    Stepper("", onIncrement: { store.setTransitionShape(clip.id) { $0.inRise += step } },
                            onDecrement: { store.setTransitionShape(clip.id) { $0.inRise -= step } })
                        .labelsHidden()
                }
            }
            LabeledContent(L("前の曲が下がり始める", "Previous starts fading")) {
                HStack(spacing: 6) {
                    Text(positionLabel(shape.outFadeStart)).monospacedDigit()
                    Stepper("", onIncrement: { store.setTransitionShape(clip.id) { $0.outFadeStart += step } },
                            onDecrement: { store.setTransitionShape(clip.id) { $0.outFadeStart -= step } })
                        .labelsHidden()
                }
            }

            Picker(L("EQの入れ替え", "EQ swap"), selection: $editBand) {
                ForEach(EQBand.allCases) { b in
                    Text(shape.band(b).enabled ? "● " + b.title : b.title).tag(b)
                }
            }
            .pickerStyle(.segmented)

            Toggle(L("\(editBand.title) を入れ替える", "Swap \(editBand.title)"), isOn: Binding(
                get: { band.enabled },
                set: { on in setBand { $0.enabled = on } }))
            if band.enabled {
                Toggle(L("次の曲の \(editBand.title) も入れる（オフ＝前の曲を削るだけ）", "Bring in the next track’s \(editBand.title) too (off = only cut the previous)"),
                       isOn: Binding(get: { band.affectsIncoming }, set: { on in setBand { $0.affectsIncoming = on } }))
                LabeledContent(L("入れ替え開始", "Swap starts")) {
                    HStack(spacing: 6) {
                        Text(positionLabel(band.point)).monospacedDigit()
                        Stepper("", onIncrement: { setBand { $0.point += step } },
                                onDecrement: { setBand { $0.point -= step } })
                            .labelsHidden()
                    }
                }
                LabeledContent(L("かける長さ", "Takes")) {
                    HStack(spacing: 6) {
                        Text(band.ramp < step * 0.5 ? L("瞬時", "Instant") : Fmt.beats((band.ramp * totalBeats).rounded()))
                            .monospacedDigit()
                        Stepper("", onIncrement: { setBand { $0.ramp += step } },
                                onDecrement: { setBand { $0.ramp = max(0, $0.ramp - step) } })
                            .labelsHidden()
                    }
                }
                Picker(L("\(editBand.title) のカーブ", "\(editBand.title) curve"), selection: Binding(
                    get: { band.curve },
                    set: { v in setBand { $0.curve = v } })) {
                    ForEach(CurveShape.allCases) { c in Text(c.title).tag(c) }
                }
                HStack(spacing: 6) {
                    Text(L("すぐ設定:", "Quick:")).font(.caption).foregroundStyle(.secondary)
                    Button(L("全体で徐々に", "Gradual, whole")) { setBand { $0.point = 0; $0.ramp = 1; $0.curve = .smooth } }
                    Button(L("中間で瞬時", "Instant, middle")) { setBand { $0.point = 0.5; $0.ramp = 0; $0.curve = .linear } }
                    Button(L("後半で徐々に", "Gradual, 2nd half")) { setBand { $0.point = 0.5; $0.ramp = 0.5; $0.curve = .smooth } }
                }
                .controlSize(.small)
            }
            if clip.shape != nil {
                Button {
                    store.resetTransitionShape(clip.id)
                } label: {
                    Label(L("カーブを既定に戻す", "Reset curve"), systemImage: "arrow.uturn.backward")
                }
            }
            Text(L("図の点をドラッグしても調整できます（1拍単位）。縦線＝選んでいる帯域の入れ替え開始、小さい点＝入れ替え終わり。",
                   "You can also drag the points in the diagram (1-beat steps). The vertical line is where the selected band starts swapping, the small dot where it ends."))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

/// Interactive curve editor for one transition: drag the points to shape it.
private struct TransitionCurveEditor: View {
    @Environment(MixStore.self) private var store
    let clipID: UUID
    let band: EQBand

    private var index: Int { store.index(of: clipID) ?? 0 }
    private var clip: Clip { store.clipAt(index, or: .placeholder) }

    private enum Handle { case inRise, outFade, bandStart, bandEnd }
    @State private var active: Handle?

    private static func color(_ b: EQBand) -> Color {
        switch b {
        case .low: return .orange
        case .mid: return .yellow
        case .high: return .cyan
        }
    }

    var body: some View {
        if index > 0 { content }
    }

    @ViewBuilder
    private var content: some View {
        let clips = store.clips
        let prev = store.clipAt(index - 1, or: clip)
        let shape = clip.transitionShape
        let totalBeats = max(1, clip.transitionBars * 4)
        let style = clip.transition
        let selected = shape.band(band)

        GeometryReader { geo in
            // Wide enough that the end handles (radius ≈ 11 incl. stroke) are never clipped.
            let pad: CGFloat = 14
            let w = geo.size.width - pad * 2
            let rowH = (geo.size.height - 22) / 2
            Canvas { ctx, size in
                func x(_ v: Double) -> CGFloat { pad + CGFloat(v) * w }
                for (y0, c, incoming) in [(CGFloat(0), prev, false), (rowH + 4, clip, true)] {
                    let rect = CGRect(x: pad, y: y0, width: w, height: rowH)
                    ctx.fill(Path(roundedRect: rect, cornerRadius: 5), with: .color(Color.clip(c.colorIndex).opacity(0.16)))
                    var b = 0.0
                    while b <= totalBeats {
                        let isBar = Int(b) % 4 == 0
                        if isBar || totalBeats <= 32 {
                            ctx.fill(Path(CGRect(x: x(b / totalBeats), y: y0, width: 1, height: rowH)),
                                     with: .color(.white.opacity(isBar ? 0.14 : 0.05)))
                        }
                        b += 1
                    }
                    var vol = Path()
                    var bandPaths: [EQBand: Path] = [:]
                    var px: CGFloat = 0
                    while px <= w {
                        let v = Double(px / w)
                        let curve = incoming ? Automation.incoming(style, shape, v) : Automation.outgoing(style, shape, v)
                        let point = CGPoint(x: x(v), y: y0 + rowH - CGFloat(curve.volume) * (rowH - 6) - 3)
                        if px == 0 { vol.move(to: point) } else { vol.addLine(to: point) }
                        for eq in EQBand.allCases where shape.band(eq).enabled {
                            let kill: Double
                            switch eq {
                            case .low: kill = curve.lowKill
                            case .mid: kill = curve.midKill
                            case .high: kill = curve.highKill
                            }
                            let p = CGPoint(x: x(v), y: y0 + rowH - CGFloat(1 - kill) * (rowH - 6) - 3)
                            if px == 0 { bandPaths[eq, default: Path()].move(to: p) } else { bandPaths[eq, default: Path()].addLine(to: p) }
                        }
                        px += 2
                    }
                    ctx.stroke(vol, with: .color(Color.clip(c.colorIndex)), lineWidth: 2.5)
                    for (eq, path) in bandPaths {
                        ctx.stroke(path, with: .color(Self.color(eq).opacity(eq == band ? 1 : 0.5)),
                                   style: StrokeStyle(lineWidth: eq == band ? 1.8 : 1.2, dash: [4, 3]))
                    }
                    ctx.draw(Text(incoming ? L("この曲", "This track") : L("前の曲", "Previous"))
                                .font(Typo.label(9)).tracking(Typo.labelTracking).foregroundStyle(.white.opacity(0.6)),
                             at: CGPoint(x: pad + 4, y: y0 + 8), anchor: .leading)
                }
                if selected.enabled {
                    let color = Self.color(band)
                    let sx = x(selected.point)
                    let ex = x(selected.point + selected.ramp)
                    ctx.fill(Path(CGRect(x: sx - 1, y: 0, width: 2, height: rowH * 2 + 4)), with: .color(color))
                    if selected.ramp > 0 {
                        ctx.fill(Path(CGRect(x: sx, y: rowH + 1, width: ex - sx, height: 2)), with: .color(color.opacity(0.8)))
                    }
                    dot(ctx, CGPoint(x: sx, y: rowH + 2), color, active == .bandStart)
                    dot(ctx, CGPoint(x: ex, y: rowH + 2), color, active == .bandEnd, small: true)
                }
                dot(ctx, CGPoint(x: x(shape.inRise), y: rowH + 14), .green, active == .inRise)
                dot(ctx, CGPoint(x: x(shape.outFadeStart), y: 11), Color.clip(prev.colorIndex), active == .outFade)
                var bar = 0.0
                let labelStep = totalBeats > 64 ? 16.0 : (totalBeats > 32 ? 8.0 : 4.0)
                while bar <= totalBeats {
                    ctx.draw(Text("\(Int(bar / 4) + 1)").font(Typo.readout(9, .regular)).foregroundStyle(.secondary),
                             at: CGPoint(x: x(bar / totalBeats), y: size.height - 7))
                    bar += labelStep
                }
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { v in
                        let raw = Double((v.location.x - pad) / w)
                        let snapped = min(1, max(0, (raw * totalBeats).rounded() / totalBeats))
                        if active == nil {
                            active = nearestHandle(v.startLocation, shape: shape, selected: selected, pad: pad, w: w, rowH: rowH)
                            if active == nil { return }
                            store.pushUndo()
                            store.isInteracting = true
                        }
                        let which = band
                        switch active {
                        case .inRise:
                            store.setTransitionShape(clip.id, undoable: false) { $0.inRise = max(1 / totalBeats, snapped) }
                        case .outFade:
                            store.setTransitionShape(clip.id, undoable: false) { $0.outFadeStart = min(1 - 1 / totalBeats, snapped) }
                        case .bandStart:
                            store.setTransitionShape(clip.id, undoable: false) { s in
                                var b = s.band(which)
                                let end = b.point + b.ramp
                                b.point = snapped
                                b.ramp = max(0, end - snapped)
                                s.setBand(which, b)
                            }
                        case .bandEnd:
                            store.setTransitionShape(clip.id, undoable: false) { s in
                                var b = s.band(which)
                                b.ramp = max(0, snapped - b.point)
                                s.setBand(which, b)
                            }
                        case .none:
                            break
                        }
                    }
                    .onEnded { _ in
                        active = nil
                        store.isInteracting = false
                    }
            )
        }
        .help(L("点をドラッグ：緑＝次の曲が上がりきる位置、上の点＝前の曲が下がり始める位置、縦線＝EQ入れ替え開始、小さい点＝入れ替え終わり",
                "Drag the points: green = next track at full, top point = previous starts fading, vertical line = EQ swap start, small dot = swap end"))
    }

    private func nearestHandle(_ p: CGPoint, shape: TransitionShape, selected: BandSwap, pad: CGFloat, w: CGFloat, rowH: CGFloat) -> Handle? {
        func x(_ v: Double) -> CGFloat { pad + CGFloat(v) * w }
        var candidates: [(Handle, CGPoint)] = [
            (.inRise, CGPoint(x: x(shape.inRise), y: rowH + 14)),
            (.outFade, CGPoint(x: x(shape.outFadeStart), y: 11)),
        ]
        if selected.enabled {
            candidates.append((.bandEnd, CGPoint(x: x(selected.point + selected.ramp), y: rowH + 2)))
            candidates.append((.bandStart, CGPoint(x: x(selected.point), y: rowH + 2)))
        }
        let best = candidates.min { hypot($0.1.x - p.x, $0.1.y - p.y) < hypot($1.1.x - p.x, $1.1.y - p.y) }
        if let best, hypot(best.1.x - p.x, best.1.y - p.y) < 30 { return best.0 }
        if selected.enabled, abs(p.x - x(selected.point)) < 8 { return .bandStart }
        return nil
    }

    private func dot(_ ctx: GraphicsContext, _ p: CGPoint, _ color: Color, _ active: Bool, small: Bool = false) {
        let r: CGFloat = small ? 7 : (active ? 11 : 9)
        let rect = CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)
        ctx.fill(Path(ellipseIn: rect), with: .color(.white))
        ctx.stroke(Path(ellipseIn: rect), with: .color(color), lineWidth: 2.5)
    }
}

private struct PresetCard: View {
    let preset: TransitionPreset
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: preset.symbol)
                        .frame(width: 16)
                        .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                    Text(preset.title)
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                Text(preset.bars < 0.01 ? L("瞬時", "Instant") : L("\(Int(preset.bars))小節", "\(Int(preset.bars)) bars"))
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(selected ? Color.accentColor.opacity(0.18) : Color.primary.opacity(0.05))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(selected ? Color.accentColor : Color.clear, lineWidth: 1.5)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(preset.detail)
    }
}

/// Mini A/B picture of the transition with the real automation curves.
private struct TransitionDiagram: View {
    @Environment(MixStore.self) private var store
    let clipID: UUID

    private var index: Int { store.index(of: clipID) ?? 0 }

    var body: some View {
        if index > 0 { content }
    }

    @ViewBuilder
    private var content: some View {
        let clips = store.clips
        let master = store.masterBPM
        let bar = store.barLength
        let prev = store.clipAt(index - 1, or: .placeholder)
        let cur = store.clipAt(index, or: prev)
        let tStart = cur.start
        let tEnd = max(tStart + 0.001, min(prev.end(master: master), cur.end(master: master)))
        let pad = max(bar * 2, (tEnd - tStart) * 0.35)
        let lower = tStart - pad
        let upper = tEnd + pad

        Canvas { ctx, size in
            let w = size.width
            let laneH = (size.height - 18) / 2
            func xPos(_ t: Double) -> CGFloat { CGFloat((t - lower) / (upper - lower)) * w }

            for (lane, i) in [(0, index - 1), (1, index)] {
                let c = clips[i]
                let y0 = CGFloat(lane) * (laneH + 4)
                let x0 = max(0, xPos(c.start))
                let x1 = min(w, xPos(c.end(master: master)))
                guard x1 > x0 else { continue }
                let rect = CGRect(x: x0, y: y0, width: x1 - x0, height: laneH)
                let color = Color.clip(c.colorIndex)
                ctx.fill(Path(roundedRect: rect, cornerRadius: 4), with: .color(color.opacity(0.22)))

                var path = Path()
                var x = x0
                var first = true
                while x <= x1 {
                    let t = lower + Double(x / w) * (upper - lower)
                    let s = Automation.state(clips: clips, index: i, time: t, master: master)
                    let y = y0 + laneH - CGFloat(min(1, s.envelope)) * (laneH - 4) - 2
                    if first { path.move(to: CGPoint(x: x, y: y)); first = false } else { path.addLine(to: CGPoint(x: x, y: y)) }
                    if s.lowKilled {
                        ctx.fill(Path(CGRect(x: x, y: y0 + laneH - 3, width: 2, height: 3)), with: .color(.orange))
                    }
                    if s.echoWet > 50 {
                        ctx.fill(Path(CGRect(x: x, y: y0, width: 2, height: 3)), with: .color(.purple))
                    }
                    x += 2
                }
                ctx.stroke(path, with: .color(color), lineWidth: 2)
            }

            for (t, label, color) in [(tStart, "OUT \(Clip.barLabel(prev.mixOutBar)) / IN \(Clip.barLabel(cur.mixInBar))", Color.orange)] {
                let x = xPos(t)
                var line = Path()
                line.move(to: CGPoint(x: x, y: 0))
                line.addLine(to: CGPoint(x: x, y: size.height - 16))
                ctx.stroke(line, with: .color(color), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                ctx.draw(Text(label).font(Typo.label(9)).tracking(Typo.labelTracking).foregroundStyle(color),
                         at: CGPoint(x: min(max(x, 60), w - 60), y: size.height - 7))
            }
            if tEnd - tStart > 0.05 {
                let x = xPos(tEnd)
                var line = Path()
                line.move(to: CGPoint(x: x, y: 0))
                line.addLine(to: CGPoint(x: x, y: size.height - 16))
                ctx.stroke(line, with: .color(.secondary), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
            }
        }
        .accessibilityLabel(L("トランジションの図", "Transition diagram"))
    }
}

// MARK: - Mix (nothing selected)

private struct MixInspector: View {
    @Environment(MixStore.self) private var store

    var body: some View {
        @Bindable var store = store
        Form {
            if store.aiGridMismatches > 0 || store.analyzingCount > 0 || store.analysisSummary != nil {
                Section {
                    if store.analyzingCount > 0 || store.analysisSummary != nil {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text(L("曲を1曲ずつ解析中（残り\(store.analysisStatus.count)曲・各曲の進み具合は左のリストに表示）", "Analysing tracks one at a time (\(store.analysisStatus.count) left; progress is shown next to each track)"))
                                .font(.callout)
                        }
                    }
                    let n = store.aiGridMismatches
                    if n > 0 {
                        Label(L("\(n)曲で、保存されている拍・小節が AI の解析とずれています。", "\(n) tracks have a beat grid that disagrees with the AI analysis."),
                              systemImage: "exclamationmark.triangle")
                            .font(.callout)
                        Button {
                            store.alignAllGridsToAI()
                        } label: {
                            Label(L("すべて AI の拍・小節に合わせる", "Match All to the AI Grid"), systemImage: "metronome")
                        }
                        .buttonStyle(.borderedProminent)
                        Text(L("つなぎの位置（小節）はそのまま、拍の位置だけを正しくします。⌘Z で戻せます。", "Mix points stay on the same bars; only the beat positions are corrected. ⌘Z undoes it."))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } header: {
                    Text(L("AI 解析", "AI Analysis"))
                }
            }
            Section {
                let p = store.progressSummary
                LabeledContent(L("CUE 設定済み", "Cues set")) {
                    HStack {
                        ProgressView(value: Double(p.cues), total: Double(max(1, p.cueTotal))).frame(width: 90)
                        Text("\(p.cues)/\(p.cueTotal)").monospacedDigit()
                    }
                }
                LabeledContent(L("つなぎ設定済み", "Transitions set")) {
                    HStack {
                        ProgressView(value: Double(p.transitions), total: Double(max(1, p.transitionTotal))).frame(width: 90)
                        Text("\(p.transitions)/\(p.transitionTotal)").monospacedDigit()
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(L("メモ", "Notes"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField("", text: $store.notes,
                              prompt: Text(L("構成案・やることなど", "Ideas, to-dos…")),
                              axis: .vertical)
                        .labelsHidden()
                        .textFieldStyle(.plain)
                        .lineLimit(3...8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } header: {
                Text(L("進捗とメモ", "Progress & Notes"))
            } footer: {
                Text(store.embedMedia
                     ? L("進捗・メモ・作業位置と曲の音声が .djaw ファイル1つにまとめて保存されます（ファイル > 曲の音声をファイルに含めて保存 で切替）。",
                         "Progress, notes, work position and the audio are all saved in one .djaw file (File ▸ Include Audio When Saving).")
                     : L("進捗・メモ・作業位置は .djaw ファイルに保存されます。音声は元の曲ファイルから読み込みます。",
                         "Progress, notes and work position are saved in the .djaw file; audio is read from the original files."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            MixPatternsSection()
            Section(L("ミックス", "Mix")) {
                LabeledContent(L("曲数", "Tracks"), value: L("\(store.clips.count)曲", "\(store.clips.count)"))
                LabeledContent(L("長さ", "Length"), value: Fmt.duration(store.realMixDuration))
                let genres = store.genreSummary
                if !genres.isEmpty {
                    LabeledContent(L("ジャンル", "Genres")) {
                        Text(genres.map { "\($0.genre.short) ×\($0.count)" }.joined(separator: "  "))
                            .multilineTextAlignment(.trailing)
                    }
                    .help(L("おまかせミックスは曲のジャンルに合わせてつなぎ方を変えます（曲を選んで「デッキ」で変更できます）",
                            "The auto-mix connects each track the way its genre is usually mixed (change it per track under Deck)."))
                }
                LabeledContent(L("マスターBPM", "Master BPM")) { MasterBPMField(compact: true) }
                Picker(L("ドラッグの単位", "Drag Step"), selection: $store.snap) {
                    ForEach(SnapUnit.allCases) { unit in Text(unit.title).tag(unit) }
                }
                Picker(L("言語", "Language"), selection: $store.language) {
                    ForEach(AppLanguage.allCases) { lang in Text(lang.title).tag(lang) }
                }
                Toggle(L("曲を追加したら CUE エディタを開く", "Open CUE editor after adding"), isOn: $store.openCueEditorOnAdd)
            }

            Section {
                Picker(L("つなぎ方", "Style"), selection: Binding(
                    get: { TransitionPreset.matching(style: store.defaultTransitionStyle, bars: Double(store.defaultTransitionBars))?.id ?? "bass" },
                    set: { id in
                        if let p = TransitionPreset.all.first(where: { $0.id == id }) {
                            store.defaultTransitionStyle = p.style
                            store.defaultTransitionBars = Int(p.bars)
                        }
                    })) {
                    ForEach(TransitionPreset.all) { p in
                        Label(p.title, systemImage: p.symbol).tag(p.id)
                    }
                }
            } header: {
                Text(L("標準のつなぎ", "Default Transition"))
            }

            Section {
                Picker(L("スタイル", "Style"), selection: Binding(get: { store.mixStyle }, set: { store.mixStyle = $0 })) {
                    ForEach(MixStyle.allCases) { Text($0.title).tag($0) }
                }
                Picker(L("曲順の流れ", "Set Energy"), selection: Binding(get: { store.setArc }, set: { store.setArc = $0 })) {
                    ForEach(SetArc.allCases) { Text($0.title).tag($0) }
                }
                .help(L("曲順も自動で決めるとき、盛り上がりの流れをどう作るか", "When the order is chosen automatically: how the energy should develop"))
                Picker(L("曲の使い方", "Track Use"), selection: Binding(get: { store.trackUse }, set: { store.trackUse = $0 })) {
                    ForEach(TrackUse.allCases) { Text($0.title).tag($0) }
                }
                .help(store.trackUse.detail)
                let simple = store.simplifiableTransitions.count
                Button {
                    store.simplifyAllTransitions()
                } label: {
                    Label(simple > 0 ? L("短く書けるつなぎを簡単にする（\(simple)か所）", "Simplify Transitions (\(simple))")
                                     : L("短く書けるつなぎはありません", "No transitions to simplify"), systemImage: "scissors")
                }
                .disabled(simple == 0)
                .help(L("片方の曲が無音で、もう片方がそのまま鳴っているだけの部分をつなぎから外して、同じ音のまま短く表します（⌘Z で戻せます）",
                        "Drops the bars of each transition where one track is silent and the other plays unchanged — same sound, shorter transitions (⌘Z undoes)"))
                Picker(L("音量をそろえる", "Even out loudness"), selection: Binding(get: { store.loudnessMode }, set: { store.loudnessMode = $0 })) {
                    ForEach(LoudnessMode.allCases) { Text($0.title).tag($0) }
                }
                .help(L("曲ごとの音量感（ラウドネス・LUFS）を測って、使う区間がそろうように各曲の音量を自動で補正します。試聴・書き出し・ミックス後の波形すべてに効きます。",
                        "Measures each track’s loudness (LUFS) over the part the mix plays and corrects its level automatically — for the preview, the export and the mix waveform."))
                if store.loudnessMode != .off {
                    Text(store.loudnessMode.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Toggle(L("ミックス後の波形を表示", "Show the mixed-down waveform"), isOn: Binding(get: { store.showMixWaveform }, set: { store.showMixWaveform = $0 }))
                    .help(L("A / B の下に、書き出しと同じ処理で作った最終的な波形を表示します（編集のたびに裏で作り直します）",
                            "Shows the final mix under the A / B lanes, rendered exactly like an export (re-rendered in the background after edits)"))
                Toggle(L("つなぎを書き出して確認する", "Render & check transitions"), isOn: Binding(get: { store.verifyTransitions }, set: { store.verifyTransitions = $0 }))
                    .help(L("おまかせミックスの後、つなぎを1つずつ書き出して音量の落ち込み・低音の濁り・キックの二重を調べ、問題があれば次の案に差し替えます",
                            "After auto-mixing, each transition is rendered and checked for level holes, muddy bass and flamming kicks; failing ones get the next-best plan"))
                Text(store.mixStyle == .auto
                     ? store.mixStyle.detail + (store.clips.count > 1 ? L("（いまの曲なら「\(store.styleSummary(store.clips.indices))」）", " (now: “\(store.styleSummary(store.clips.indices))”)") : "")
                     : store.mixStyle.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    store.autoMixAll()
                } label: {
                    Label(L("曲を解析して全体を自動ミックス", "Analyse & Auto-Mix Everything"), systemImage: "wand.and.stars")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.clips.count < 2)
                Button {
                    store.showAutoArrange = true
                } label: {
                    Label(L("曲を選んでおまかせミックス（曲順も）…", "Pick Tracks & Auto-Arrange (Order Too)…"), systemImage: "list.number")
                        .frame(maxWidth: .infinity)
                }
                .disabled(store.clips.count + store.library.count < 2)
            } header: {
                Text(L("自動ミックス", "Auto-Mix"))
            } footer: {
                Text(L("各曲のイントロ・ドロップ・ブレイク・アウトロ、フレーズ（8小節）の区切り、キーを波形から解析し、曲間ごとに出口・入口・重ねる長さ・つなぎ方を決めます。次の曲のドロップで切り替わり、低音がぶつからないように組み立てます（⌘Z で取り消し可）。曲を追加しただけでは自動でミックスされません。",
                       "Analyses each track’s intro, drops, breaks and outro, its 8-bar phrases and its key, then picks the mix-out, mix-in, overlap length and style for every transition — landing on the next track’s drop without clashing bass (undo with ⌘Z). Adding tracks never mixes them on its own."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section(L("操作", "Controls")) {
                ShortcutRow(keys: "Space", text: L("再生 / 一時停止", "Play / Pause"))
                ShortcutRow(keys: L("曲をドラッグ", "Drag track"), text: L("前の曲の出口を移動", "Move previous mix-out"))
                ShortcutRow(keys: L("右端ドラッグ", "Drag right edge"), text: L("つなぎの長さ", "Transition length"))
                ShortcutRow(keys: L("左端ドラッグ", "Drag left edge"), text: L("この曲の入口", "This track’s mix-in"))
                ShortcutRow(keys: L("⌥ + ドラッグ", "⌥ + drag"), text: L("1拍単位で調整", "Adjust by 1 beat"))
                ShortcutRow(keys: "← →", text: L("出口を1小節移動（⇧で4小節）", "Move mix-out 1 bar (⇧ 4 bars)"))
                ShortcutRow(keys: L("⌘ + スクロール", "⌘ + scroll"), text: L("ズーム（ピンチも可）", "Zoom (or pinch)"))
                ShortcutRow(keys: L("曲をダブルクリック", "Double-click track"), text: L("CUE（IN / OUT）を編集", "Edit cues (IN / OUT)"))
                ShortcutRow(keys: "⌫", text: L("選択した曲を削除", "Delete Selected Track"))
                ShortcutRow(keys: "⌘Z", text: L("取り消す", "Undo"))
            }
        }
    }
}

private struct ShortcutRow: View {
    let keys: String
    let text: String

    var body: some View {
        HStack {
            Text(text)
            Spacer()
            Text(keys)
                .font(.system(size: 11, weight: .medium))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(RoundedRectangle(cornerRadius: 4).fill(Color.primary.opacity(0.1)))
        }
    }
}

// MARK: - Reusable controls

/// Shows a bar number with −4 / −1 / +1 / +4 buttons.
struct BarControl: View {
    let title: String
    let value: Double
    var color: Color = .secondary
    var suffix: String? = nil
    let onDelta: (Double) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title)
                Spacer()
                Text(Fmt.barOrdinal(value) + (suffix ?? ""))
                    .font(Typo.readout(12))
                    .foregroundStyle(color)
            }
            HStack(spacing: 4) {
                ForEach([-4.0, -1, 1, 4], id: \.self) { d in
                    Button(d > 0 ? "+\(Int(d))" : "\(Int(d))") { onDelta(d) }
                        .buttonStyle(.bordered)
                        .frame(maxWidth: .infinity)
                }
                Divider().frame(height: 16)
                Button { onDelta(-0.25) } label: { Image(systemName: "chevron.left") }
                    .buttonStyle(.bordered)
                    .help(L("1拍前へ", "One beat earlier"))
                Button { onDelta(0.25) } label: { Image(systemName: "chevron.right") }
                    .buttonStyle(.bordered)
                    .help(L("1拍後ろへ", "One beat later"))
            }
            .controlSize(.small)
        }
    }
}

struct ValueSlider: View {
    let title: String
    let value: Double
    let range: ClosedRange<Double>
    var step: Double? = nil
    let defaultValue: Double
    let format: (Double) -> String
    let onBegin: () -> Void
    let onChange: (Double) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title)
                Spacer()
                Text(format(value))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                if abs(value - defaultValue) > 0.001 {
                    Button {
                        onBegin()
                        onChange(defaultValue)
                    } label: {
                        Image(systemName: "arrow.uturn.backward.circle.fill")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .help(L("リセット", "Reset"))
                }
            }
            let binding = Binding(get: { value }, set: { onChange($0) })
            if let step {
                Slider(value: binding, in: range, step: step) { editing in if editing { onBegin() } }
            } else {
                Slider(value: binding, in: range) { editing in if editing { onBegin() } }
            }
        }
    }
}


// MARK: - Analysis display

/// Camelot key badge (e.g. "8A · Am").
struct KeyBadge: View {
    let key: MusicalKey

    var body: some View {
        Text("\(key.camelot) · \(key.name)")
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(Color.purple.opacity(0.25)))
            .help(L("推定キー（キャメロット表記）。数字が同じか±1の曲同士は和音がぶつかりにくいです",
                    "Estimated key (Camelot). Tracks with the same number or ±1 mix in key"))
    }
}

/// Coloured strip of the detected sections with their bar ranges.
private struct StructureSummary: View {
    let structure: TrackStructure
    let clip: Clip

    var body: some View {
        let total = Double(max(1, structure.musicEnd - structure.musicStart))
        VStack(alignment: .leading, spacing: 4) {
            GeometryReader { geo in
                HStack(spacing: 1) {
                    ForEach(Array(structure.sections.enumerated()), id: \.offset) { _, sec in
                        Rectangle()
                            .fill(SectionColors.color(sec.kind))
                            .frame(width: max(2, geo.size.width * Double(sec.end - sec.start) / total - 1))
                            .help("\(sec.kind.title) \(bar(sec.start))–\(bar(sec.end - 1))")
                    }
                }
            }
            .frame(height: 8)
            .clipShape(RoundedRectangle(cornerRadius: 3))
            Text(L("最初のドロップ \(bar(structure.firstDrop))小節目 · アウトロ \(bar(structure.lastDropEnd))小節目〜",
                   "First drop: bar \(bar(structure.firstDrop)) · Outro from bar \(bar(structure.lastDropEnd))"))
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    /// 1-based bar label on the clip's own grid.
    private func bar(_ b: Int) -> String {
        Clip.barLabel((clip.bar(atSource: structure.time(ofBar: Double(b))) * 4).rounded() / 4)
    }
}

enum SectionColors {
    static func color(_ k: SectionKind) -> Color {
        switch k {
        case .intro: return Color.gray.opacity(0.55)
        case .drop: return Color.orange
        case .breakdown: return Color.teal.opacity(0.8)
        case .outro: return Color.gray.opacity(0.35)
        }
    }
}

// MARK: - Transition controls

/// One transition type as a tile with a tiny picture of how the two volumes move.
private struct StyleTile: View {
    let style: TransitionStyle
    let selected: Bool
    let outColor: Color
    let inColor: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Canvas { ctx, size in
                    let shape = TransitionShape.defaults(for: style)
                    var pOut = Path(), pIn = Path()
                    let steps = 48
                    for k in 0...steps {
                        let x = Double(k) / Double(steps)
                        var o = Automation.outgoing(style, shape, x).volume
                        if style == .brake { o = x < 0.5 ? 1 - pow(max(0, (x - 0.1) / 0.4), 2) * 0.85 : 0 }
                        if style == .backspin { o = x < 0.5 ? (x < 0.3 ? 1 : 1 - sin((x - 0.3) / 0.2 * .pi) * 0.6 - (x - 0.3) / 0.2 * 0.4) : 0 }
                        let i = Automation.incoming(style, shape, x).volume
                        let px = CGFloat(x) * size.width
                        let yo = 2 + (size.height - 4) * (1 - CGFloat(o))
                        let yi = 2 + (size.height - 4) * (1 - CGFloat(i))
                        if k == 0 { pOut.move(to: CGPoint(x: px, y: yo)); pIn.move(to: CGPoint(x: px, y: yi)) }
                        else { pOut.addLine(to: CGPoint(x: px, y: yo)); pIn.addLine(to: CGPoint(x: px, y: yi)) }
                    }
                    ctx.stroke(pOut, with: .color(outColor), style: StrokeStyle(lineWidth: 1.8, lineCap: .round, dash: style == .echoOut ? [2, 2] : []))
                    ctx.stroke(pIn, with: .color(inColor), style: StrokeStyle(lineWidth: 1.8, lineCap: .round))
                    if style == .bassSwap || style == .filter {
                        // Where the low end changes hands.
                        let x = size.width * 0.5
                        var tick = Path()
                        tick.move(to: CGPoint(x: x, y: 1))
                        tick.addLine(to: CGPoint(x: x, y: size.height - 1))
                        ctx.stroke(tick, with: .color(.orange), style: StrokeStyle(lineWidth: 1.2, dash: [2, 2]))
                    }
                }
                .frame(height: 20)
                Text(style.title)
                    .font(.system(size: 11, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 8).fill(selected ? Color.accentColor.opacity(0.2) : Color.primary.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(selected ? Color.accentColor : Color.clear, lineWidth: 1.5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(style.detail)
    }
}

/// "Overlap: [4] [8] [16] [32] bars ±" — independent of the type.
private struct LengthChooser: View {
    @Environment(MixStore.self) private var store
    let clip: Clip

    var body: some View {
        let choices = clip.transition.lengthChoices
        let isCustom = !choices.contains { abs($0 - clip.transitionBars) < 0.01 }
        HStack(spacing: 5) {
            Text(clip.transition == .echoOut ? L("残響の長さ", "Echo tail") : L("重ねる長さ", "Overlap"))
                .font(.callout)
                .lineLimit(1)
            Spacer(minLength: 2)
            if isCustom {
                chip(clip.transitionBars, on: true)
            }
            ForEach(choices, id: \.self) { bars in
                chip(bars, on: abs(clip.transitionBars - bars) < 0.01)
            }
            Text(L("小節", "bars")).font(.caption).foregroundStyle(.secondary)
            Stepper("", onIncrement: { store.setTransitionLength(clip.id, bars: clip.transitionBars + 1) },
                    onDecrement: { store.setTransitionLength(clip.id, bars: max(1, clip.transitionBars - 1)) })
                .labelsHidden()
                .controlSize(.small)
                .help(L("1小節ずつ調整", "Adjust by 1 bar"))
        }
    }

    private func chip(_ bars: Double, on: Bool) -> some View {
        Button {
            store.setTransitionLength(clip.id, bars: bars)
        } label: {
            Text(abs(bars - bars.rounded()) < 0.05 ? "\(Int(bars.rounded()))" : String(format: "%.1f", bars))
                .font(.system(size: 12, weight: .semibold))
                .monospacedDigit()
                .frame(minWidth: 24)
                .padding(.vertical, 3)
                .padding(.horizontal, 2)
                .background(RoundedRectangle(cornerRadius: 6).fill(on ? Color.accentColor : Color.primary.opacity(0.08)))
                .foregroundStyle(on ? Color.white : Color.primary)
        }
        .buttonStyle(.plain)
    }
}

/// A mix position with the value in the middle and nudges on both sides.
private struct PositionRow: View {
    let title: String
    let value: Double
    let color: Color
    let help: String
    let onDelta: (Double) -> Void

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(title)
                .font(.callout)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .help(help)
            Spacer(minLength: 4)
            nudge("chevron.left.2", -4)
            nudge("chevron.left", -1)
            Text(Fmt.barOrdinal(value))
                .font(Typo.readout(12))
                .foregroundStyle(color)
                .lineLimit(1)
                .frame(minWidth: 60)
            nudge("chevron.right", 1)
            nudge("chevron.right.2", 4)
        }
    }

    private func nudge(_ symbol: String, _ bars: Double) -> some View {
        Button {
            // ⌥ = one beat instead of whole bars.
            let d = NSEvent.modifierFlags.contains(.option) ? (bars > 0 ? 0.25 : -0.25) : bars
            onDelta(d)
        } label: {
            Image(systemName: symbol)
                .font(Typo.label(9)).tracking(Typo.labelTracking)
                .frame(width: 14, height: 14)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .help(bars < 0 ? L("\(Int(-bars))小節前へ（⌥で1拍）", "\(Int(-bars)) bar(s) earlier (⌥: 1 beat)")
                       : L("\(Int(bars))小節後ろへ（⌥で1拍）", "\(Int(bars)) bar(s) later (⌥: 1 beat)"))
    }
}


// MARK: - Several library tracks

private struct MultiLibraryInspector: View {
    @Environment(MixStore.self) private var store

    var body: some View {
        let ids = store.selectedLibraryIDs
        let tracks = ids.compactMap { store.clip($0) }
        let total = tracks.reduce(0) { $0 + $1.duration }
        let bpms = tracks.map(\.bpm).filter { $0 > 0 }
        Form {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L("\(tracks.count)曲を選択中", "\(tracks.count) tracks selected"))
                        .font(Typo.title(15))
                    HStack(spacing: 12) {
                        Label(Fmt.duration(total), systemImage: "clock")
                        if let lo = bpms.min(), let hi = bpms.max() {
                            Label(lo == hi ? "\(Fmt.bpm(lo)) BPM" : "\(Fmt.bpm(lo))–\(Fmt.bpm(hi)) BPM", systemImage: "metronome")
                        }
                    }
                    .font(Typo.readout(11, .regular))
                    .foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
                ForEach(tracks) { c in
                    HStack(spacing: 8) {
                        RoundedRectangle(cornerRadius: 2).fill(Color.clip(c.colorIndex)).frame(width: 3, height: 16)
                        Text(c.title).lineLimit(1).truncationMode(.middle)
                        Spacer()
                        if let key = store.structures[c.url]?.key {
                            Text(key.camelot).font(Typo.label(9)).foregroundStyle(.purple)
                        }
                        Text(Fmt.bpm(c.bpm)).font(Typo.readout(11))
                    }
                    .font(.callout)
                }
            }

            Section {
                Button {
                    store.addToMix(ids, at: store.clips.count)
                } label: {
                    Label(L("\(tracks.count)曲をミックスの末尾に入れる", "Add \(tracks.count) Tracks to End of Mix"), systemImage: "text.append")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .help(L("リストの順番のまま、ミックスの最後に並べます（つなぎは自分で設定）", "Appends them in list order (set the transitions yourself)"))
                Button {
                    store.autoArrange(preselecting: ids)
                } label: {
                    Label(L("この\(tracks.count)曲でおまかせミックス…", "Auto-Arrange These \(tracks.count) Tracks…"), systemImage: "wand.and.stars")
                        .frame(maxWidth: .infinity)
                }
                .help(L("曲順とつなぎを自動で組み立てます", "Builds the order and transitions automatically"))
            } header: {
                Text(L("まとめて操作", "Actions"))
            }

            Section {
                Button(role: .destructive) {
                    store.removeFromLibrary(ids)
                } label: {
                    Label(L("\(tracks.count)曲をライブラリから削除", "Remove \(tracks.count) Tracks from Library"), systemImage: "trash")
                }
                Button(L("選択解除", "Deselect")) { store.setSidebarSelection([]) }
            } footer: {
                Text(L("⌘クリックで1曲ずつ、⇧クリックで範囲を選べます。⌫ で選んだ曲を削除します（⌘Z で元に戻せます）。",
                       "⌘-click to pick tracks, ⇧-click for a range. ⌫ removes them (undo with ⌘Z)."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}


extension MixStore {
    /// Mix track at `i`, or `fallback` when `i` is out of range (never traps).
    func clipAt(_ i: Int, or fallback: Clip) -> Clip {
        i >= 0 && i < clips.count ? clips[i] : fallback
    }
}


// MARK: - DJ controls (loops, beat jump, key)

/// Controller-style operations for one mix track: n-bar loops, beat jumps, key lock and key shift.
private struct DJControlsSection: View {
    @Environment(MixStore.self) private var store
    let clipID: UUID
    @AppStorage("DJAW.loopBars") private var loopBars: Double = 4
    @AppStorage("DJAW.loopRepeats") private var loopRepeats: Int = 1
    @AppStorage("DJAW.jumpBars") private var jumpBars: Double = 4

    private static let loopSizes: [Double] = [0.25, 0.5, 1, 2, 4, 8, 16, 32]
    private static let jumpSizes: [Double] = [1, 2, 4, 8, 16, 32]

    var body: some View {
        if let clip = store.clip(clipID), store.index(of: clipID) != nil { content(clip) }
    }

    private func sizeLabel(_ bars: Double) -> String {
        if bars == 0.25 { return "¼" }
        if bars == 0.5 { return "½" }
        return "\(Int(bars))"
    }

    @ViewBuilder
    private func content(_ clip: Clip) -> some View {
        let here = store.sourceBar(clipID, atTimeline: store.playhead)
        Section {
            // Loop
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Label(L("ループ", "Loop"), systemImage: "repeat")
                        .font(.callout.weight(.semibold))
                    Spacer()
                    Stepper(value: $loopRepeats, in: 1...16) {
                        Text(L("×\(loopRepeats + 1)回", "×\(loopRepeats + 1)"))
                            .font(Typo.readout(11))
                    }
                    .help(L("ループ部分を何回鳴らすか（合計）", "How many times the loop plays in total"))
                }
                sizeRow(Self.loopSizes, selected: loopBars) { loopBars = $0 }
                HStack(spacing: 6) {
                    Button {
                        if let here { store.addLoop(clipID, atBar: here, bars: loopBars, repeats: loopRepeats) }
                    } label: {
                        Label(L("再生位置でループ", "Loop at Playhead"), systemImage: "scope")
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(here == nil)
                    .help(here == nil ? L("再生位置をこの曲の上に置いてください", "Put the playhead on this track first")
                                      : L("再生位置の小節から（クオンタイズして）ループします", "Loops from the playhead (quantized)"))
                    Button {
                        store.addLoop(clipID, atBar: clip.mixOutBar - loopBars, bars: loopBars, repeats: loopRepeats)
                    } label: {
                        Label(L("出口の手前をループ", "Loop Before Mix-Out"), systemImage: "arrow.uturn.backward")
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(store.index(of: clipID).map { $0 >= store.clips.count - 1 } ?? true)
                    .help(L("次の曲へ入る直前の小節を繰り返して、つなぎ前を伸ばします", "Repeats the bars right before the mix-out to extend the run-up"))
                }
                .controlSize(.small)
            }

            // Beat jump
            VStack(alignment: .leading, spacing: 6) {
                Label(L("ビートジャンプ（先へ飛ばす）", "Beat Jump (skip ahead)"), systemImage: "forward.end")
                    .font(.callout.weight(.semibold))
                sizeRow(Self.jumpSizes, selected: jumpBars) { jumpBars = $0 }
                Button {
                    if let here { store.addJump(clipID, atBar: here, bars: jumpBars) }
                } label: {
                    Label(L("再生位置で \(sizeLabel(jumpBars))小節飛ばす", "Skip \(sizeLabel(jumpBars)) bars at Playhead"), systemImage: "scope")
                        .frame(maxWidth: .infinity)
                }
                .controlSize(.small)
                .disabled(here == nil)
            }

            // Existing edits
            if let edits = clip.edits, !edits.isEmpty {
                ForEach(edits) { e in
                    HStack(spacing: 6) {
                        Image(systemName: e.kind == .loop ? "repeat" : "forward.end")
                            .foregroundStyle(e.kind == .loop ? Color.yellow : Color.pink)
                        Text(e.summary)
                            .font(.caption)
                            .lineLimit(2)
                        Spacer(minLength: 4)
                        if e.kind == .loop {
                            Stepper("", value: Binding(get: { e.repeats }, set: { store.setEditRepeats(clipID, e.id, $0) }), in: 1...32)
                                .labelsHidden()
                                .controlSize(.mini)
                        }
                        Button {
                            store.removeEdit(clipID, e.id)
                        } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                        }
                        .buttonStyle(.borderless)
                        .help(L("解除", "Remove"))
                    }
                }
                let delta = edits.reduce(0) { $0 + $1.deltaBars }
                let deltaText = (delta >= 0 ? "+" : "−") + (abs(delta - delta.rounded()) < 0.01 ? "\(Int(abs(delta).rounded()))" : String(format: "%.2f", abs(delta)))
                Text(L("曲の長さ \(deltaText)小節", "Track length \(deltaText) bars"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Key
            VStack(alignment: .leading, spacing: 6) {
                Toggle(isOn: Binding(get: { clip.keepsKey }, set: { store.setKeyLock(clipID, $0) })) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(L("キーロック", "Key Lock"))
                        Text(L("オフにするとテンポに合わせて音程も変わります（レコード風）", "Off: pitch follows the tempo, like vinyl"))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .toggleStyle(.switch)
                .controlSize(.small)
                HStack(spacing: 6) {
                    Text(L("キーシフト", "Key Shift"))
                    Spacer()
                    if let base = store.structures[clip.url]?.key {
                        let now = base.shifted(by: clip.semitoneShift)
                        Text(clip.semitoneShift == 0 ? now.camelot : "\(base.camelot) → \(now.camelot)")
                            .font(Typo.label(10))
                            .foregroundStyle(.purple)
                    }
                    Text(clip.semitoneShift == 0 ? "±0" : String(format: "%+d", clip.semitoneShift))
                        .font(Typo.readout(12))
                        .frame(minWidth: 28, alignment: .trailing)
                    Stepper("", value: Binding(get: { clip.semitoneShift }, set: { store.setKeyShift(clipID, $0) }), in: -6...6)
                        .labelsHidden()
                }
                if let i = store.index(of: clipID), i > 0, let d = store.suggestedKeyShift(for: clipID), d != clip.semitoneShift {
                    Button {
                        store.matchKeyToPrevious(clipID)
                    } label: {
                        Label(L("前の曲とキーを合わせる（\(d >= 0 ? "+" : "")\(d)）", "Match Key to Previous (\(d >= 0 ? "+" : "")\(d))"), systemImage: "tuningfork")
                            .frame(maxWidth: .infinity)
                    }
                    .controlSize(.small)
                    .help(L("前の曲と和音がぶつからない、いちばん小さいキーシフトにします", "Applies the smallest key shift that makes the keys compatible"))
                }
            }
        } header: {
            Text(L("DJ操作（ループ・ジャンプ・キー）", "DJ Controls (Loop · Jump · Key)"))
        } footer: {
            Text(L("ループやジャンプを入れると曲の長さが変わり、後ろの曲は自動でずれます。タイムラインで右クリックしても追加できます（⌘Z で取り消し可）。",
                   "Loops and jumps change the track length and the following tracks move with it. You can also right-click on the timeline (undo with ⌘Z)."))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func sizeRow(_ sizes: [Double], selected: Double, pick: @escaping (Double) -> Void) -> some View {
        HStack(spacing: 4) {
            ForEach(sizes, id: \.self) { b in
                let on = abs(b - selected) < 0.001
                Button { pick(b) } label: {
                    Text(sizeLabel(b))
                        .font(Typo.readout(11))
                        .frame(maxWidth: .infinity, minHeight: 20)
                        .background(RoundedRectangle(cornerRadius: 5).fill(on ? Color.accentColor : Color.primary.opacity(0.08)))
                        .foregroundStyle(on ? Color.white : Color.primary)
                }
                .buttonStyle(.plain)
                .help(b < 1 ? L("\(Int(b * 4))拍", "\(Int(b * 4)) beat(s)") : L("\(Int(b))小節", "\(Int(b)) bar(s)"))
            }
            Text(L("小節", "bars")).font(.caption2).foregroundStyle(.secondary)
        }
    }
}

// MARK: - Brake / backspin length

private struct SpinChooser: View {
    @Environment(MixStore.self) private var store
    let clip: Clip

    var body: some View {
        let current = clip.spinBeats ?? clip.transition.defaultSpinBeats
        HStack(spacing: 5) {
            Text(clip.transition == .brake ? L("止まるまで", "Stops over") : L("回す長さ", "Spin length"))
                .font(.callout)
            Spacer(minLength: 2)
            ForEach(clip.transition.spinChoices, id: \.self) { beats in
                let on = abs(current - beats) < 0.01
                Button {
                    store.setSpinBeats(clip.id, beats)
                } label: {
                    Text("\(Int(beats))")
                        .font(.system(size: 12, weight: .semibold))
                        .monospacedDigit()
                        .frame(minWidth: 24)
                        .padding(.vertical, 3)
                        .background(RoundedRectangle(cornerRadius: 6).fill(on ? Color.accentColor : Color.primary.opacity(0.08)))
                        .foregroundStyle(on ? Color.white : Color.primary)
                }
                .buttonStyle(.plain)
            }
            Text(L("拍", "beats")).font(.caption).foregroundStyle(.secondary)
        }
        .help(L("出口の手前の何拍を使うか。次の曲は出口ちょうどで入ります", "How many beats before the mix-out it takes. The next track drops exactly at the mix-out"))
    }
}

// MARK: - Tempo changes

/// "Change the mix tempo from this track on", like moving the pitch fader through a transition.
private struct TempoChangeSection: View {
    @Environment(MixStore.self) private var store
    let clipID: UUID

    private var index: Int { store.index(of: clipID) ?? 0 }
    private var clip: Clip { store.clipAt(index, or: .placeholder) }

    var body: some View {
        Section {
            if index == 0 {
                LabeledContent(L("ミックスの開始BPM", "Starting BPM")) {
                    BPMEntry(value: store.masterBPM) { store.setMasterBPM($0) }
                }
                Text(L("2曲目以降で「この曲からテンポを変える」を使うと、途中でBPMを変えられます。",
                       "Use “Change tempo from this track” on a later track to change the BPM mid-mix."))
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                let before = store.tempoBefore(index)
                Toggle(L("この曲からテンポを変える", "Change tempo from this track"), isOn: Binding(
                    get: { clip.tempo != nil },
                    set: { on in store.setTrackTempo(clip.id, on ? (clip.bpm > 1 ? clip.bpm : before + 4) : nil) }))
                if let target = clip.tempo {
                    LabeledContent(L("BPM", "BPM")) {
                        HStack(spacing: 6) {
                            Text(Fmt.bpm(before)).monospacedDigit().foregroundStyle(.secondary)
                            Image(systemName: "arrow.right").font(.caption).foregroundStyle(.secondary)
                            BPMEntry(value: target) { store.setTrackTempo(clip.id, $0) }
                        }
                    }
                    if abs(target - clip.bpm) > 0.05 && clip.bpm > 1 {
                        Button(L("この曲の元のBPM（\(Fmt.bpm(clip.bpm))）にする", "Use this track’s own BPM (\(Fmt.bpm(clip.bpm)))")) {
                            store.setTrackTempo(clip.id, clip.bpm)
                        }
                        .controlSize(.small)
                    }
                    Picker(L("変わり方", "How"), selection: Binding(
                        get: { clip.tempoBars.map { Int($0.rounded()) } ?? -1 },
                        set: { store.setTempoBars(clip.id, $0 < 0 ? nil : Double($0)) })) {
                        Text(clip.transition.isCutLike ? L("つなぎで一瞬で", "Instantly at the switch") : L("つなぎの間に徐々に（\(Fmt.bars(clip.transitionBars))）", "Over the transition (\(Fmt.bars(clip.transitionBars)))")).tag(-1)
                        Text(L("切替の瞬間に", "Instantly")).tag(0)
                        ForEach([4, 8, 16, 32], id: \.self) { n in
                            Text(L("\(n)小節かけて", "Over \(n) bars")).tag(n)
                        }
                    }
                    let rateNow = clip.rate(master: target)
                    Text(L("この曲は \(Fmt.ratePercent(rateNow)) で再生されます。BPM が大きく変わるときは、つなぎ方を「カットイン」「ブレーキ」「バックスピン」にすると自然です。",
                           "This track plays at \(Fmt.ratePercent(rateNow)). For big tempo jumps, Cut In, Brake or Backspin sound most natural."))
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    let rate = clip.rate(master: before)
                    Text(L("前の曲と同じ \(Fmt.bpm(before)) BPM で再生（この曲の速さ \(Fmt.ratePercent(rate))）",
                           "Plays at the previous \(Fmt.bpm(before)) BPM (this track at \(Fmt.ratePercent(rate)))"))
                        .font(.caption)
                        .foregroundStyle(abs(rate - 1) > 0.06 ? Color.orange : Color.secondary)
                    if abs(rate - 1) > 0.04 && clip.tempoSync && clip.bpm > 1 {
                        Button(L("この曲のBPM（\(Fmt.bpm(clip.bpm))）に変える", "Switch to this track’s BPM (\(Fmt.bpm(clip.bpm)))")) {
                            store.setTrackTempo(clip.id, clip.bpm)
                        }
                        .controlSize(.small)
                    }
                }
            }
        } header: {
            Text(L("テンポ（ミックスBPM）", "Tempo (Mix BPM)"))
        }
    }
}

private struct BPMEntry: View {
    let value: Double
    let set: (Double) -> Void

    var body: some View {
        HStack(spacing: 2) {
            TextField("", value: Binding(get: { value }, set: { set($0) }), format: .number.precision(.fractionLength(0...2)))
                .textFieldStyle(.roundedBorder)
                .frame(width: 62)
                .multilineTextAlignment(.trailing)
                .font(Typo.readout(12))
            Stepper("", onIncrement: { set(value + 1) }, onDecrement: { set(value - 1) })
                .labelsHidden()
                .controlSize(.small)
        }
    }
}

// MARK: - Effects

private struct FXSection: View {
    @Environment(MixStore.self) private var store
    let clipID: UUID

    private var clip: Clip { store.clip(clipID) ?? .placeholder }

    var body: some View {
        Section {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 3), spacing: 6) {
                ForEach(FXKind.allCases) { kind in
                    Button {
                        add(kind)
                    } label: {
                        VStack(spacing: 3) {
                            Image(systemName: kind.symbol)
                                .font(.system(size: 13))
                                .foregroundStyle(Color(hue: kind.hue, saturation: 0.6, brightness: 0.95))
                            Text(kind.title)
                                .font(.system(size: 10.5, weight: .medium))
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .background(RoundedRectangle(cornerRadius: 7).fill(Color.primary.opacity(0.05)))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(kind.detail)
                }
            }
            Text(L("再生位置に置きます（再生位置がこの曲の外なら、出口の手前）。タイムラインの曲を右クリック ▸「ここにエフェクト」でも追加できます。",
                   "Placed at the playhead (or just before the mix-out if the playhead is elsewhere). You can also right-click a track ▸ “Add Effect Here”."))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        } header: {
            Text(L("エフェクトを追加", "Add an Effect"))
        }

        let list = (clip.fx ?? []).sorted { $0.bar < $1.bar }
        if list.isEmpty {
            Section {
                Label(L("この曲にはエフェクトがありません", "No effects on this track"), systemImage: "sparkles")
                    .foregroundStyle(.secondary)
            }
        }
        ForEach(list) { fx in
            FXRow(clipID: clipID, fx: fx, expanded: store.focusedFX == fx.id || list.count == 1)
        }
    }

    private func add(_ kind: FXKind) {
        var bar: Double? = nil
        if let b = store.sourceBar(clipID, atTimeline: store.playhead) { bar = (b * 4).rounded(.down) / 4 }
        if let id = store.addFX(clipID, kind: kind, atBar: bar) { store.focusedFX = id }
    }
}

private struct FXRow: View {
    @Environment(MixStore.self) private var store
    let clipID: UUID
    let fx: ClipFX
    let expanded: Bool

    var body: some View {
        Section {
            Button {
                store.focusedFX = expanded ? nil : fx.id
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: fx.kind.symbol)
                        .foregroundStyle(Color(hue: fx.kind.hue, saturation: 0.6, brightness: 0.95))
                        .frame(width: 18)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 4) {
                            Text(fx.kind.title).font(.callout.weight(.semibold))
                            if fx.auto == true {
                                Image(systemName: "wand.and.stars").font(.caption2).foregroundStyle(.purple)
                                    .help(L("自動ミックスが置いたエフェクト", "Placed by the auto-mix"))
                            }
                        }
                        Text(L("\(Clip.barLabel(fx.bar))〜\(Clip.barLabel(fx.end))小節 · \(fx.shape.title) · \(Int((fx.amount * 100).rounded()))%",
                               "Bars \(Clip.barLabel(fx.bar))–\(Clip.barLabel(fx.end)) · \(fx.shape.title) · \(Int((fx.amount * 100).rounded()))%"))
                            .font(.caption).monospacedDigit().foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded {
                PositionRow(title: L("開始", "Starts"), value: fx.bar, color: Color(hue: fx.kind.hue, saturation: 0.6, brightness: 0.95),
                            help: L("この曲の何小節目から", "Bar of this track where it starts")) { delta in
                    store.updateFX(clipID, fx.id) { $0.bar += delta }
                }
                HStack(spacing: 5) {
                    Text(L("長さ", "Length")).font(.callout)
                    Spacer(minLength: 2)
                    ForEach([0.25, 0.5, 1, 2, 4, 8, 16], id: \.self) { b in
                        chip(b < 1 ? "\(Int(b * 4))\(L("拍", "b"))" : "\(Int(b))", on: abs(fx.bars - b) < 0.01) {
                            store.updateFX(clipID, fx.id) { $0.bars = b }
                        }
                    }
                }
                ValueSlider(title: L("強さ", "Amount"), value: fx.amount, range: 0...1, defaultValue: fx.kind.defaultAmount,
                            format: { "\(Int(($0 * 100).rounded()))%" },
                            onBegin: { store.pushUndo() },
                            onChange: { v in store.updateFX(clipID, fx.id, undoable: false) { $0.amount = v } })
                Picker(L("かかり方", "Shape"), selection: Binding(get: { fx.shape }, set: { v in store.updateFX(clipID, fx.id) { $0.shape = v } })) {
                    ForEach(FXShape.allCases) { sh in
                        Label(sh.title, systemImage: sh.symbol).tag(sh)
                    }
                }
                if !fx.kind.divisions.isEmpty {
                    HStack(spacing: 5) {
                        Text(fx.kind == .flanger || fx.kind == .phaser ? L("うねりの周期", "Sweep") : L("リズム", "Rhythm"))
                            .font(.callout)
                        Spacer(minLength: 2)
                        ForEach(fx.kind.divisions, id: \.self) { d in
                            chip(FXKind.divisionLabel(d), on: abs(fx.division - d) < 0.001) {
                                store.updateFX(clipID, fx.id) { $0.division = d }
                            }
                        }
                        Text(L("拍", "beats")).font(.caption).foregroundStyle(.secondary)
                    }
                }
                HStack {
                    Button {
                        if let c = store.clip(clipID) {
                            store.seek(max(0, c.timelineTime(bar: fx.bar - 2, master: store.masterBPM)))
                            store.requestScroll(to: c.timelineTime(bar: fx.bar, master: store.masterBPM))
                            if !store.isPlaying { store.play() }
                        }
                    } label: {
                        Label(L("試聴", "Preview"), systemImage: "play.fill")
                    }
                    Spacer()
                    Button(role: .destructive) {
                        store.removeFX(clipID, fx.id)
                    } label: {
                        Label(L("削除", "Remove"), systemImage: "trash")
                    }
                }
                .controlSize(.small)
            }
        }
    }

    private func chip(_ text: String, on: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(text)
                .font(.system(size: 11, weight: .semibold))
                .monospacedDigit()
                .frame(minWidth: 20)
                .padding(.vertical, 3)
                .padding(.horizontal, 3)
                .background(RoundedRectangle(cornerRadius: 6).fill(on ? Color.accentColor : Color.primary.opacity(0.08)))
                .foregroundStyle(on ? Color.white : Color.primary)
        }
        .buttonStyle(.plain)
    }
}


// MARK: - Genre

private struct GenreSection: View {
    @Environment(MixStore.self) private var store
    let clipID: UUID

    private var clip: Clip { store.clip(clipID) ?? .placeholder }

    var body: some View {
        let result = store.genreResults[clip.url]
        let used = store.genre(for: clip)
        Section {
            Picker(L("ジャンル", "Genre"), selection: Binding(get: { clip.genre }, set: { store.setGenre(clipID, $0) })) {
                Text(L("自動（\(used.map { $0.title } ?? L("不明", "unknown"))）", "Auto (\(used.map { $0.title } ?? "unknown"))"))
                    .tag(MixGenre?.none)
                Divider()
                ForEach(MixGenre.allCases) { g in Text(g.title).tag(MixGenre?.some(g)) }
            }
            if let used {
                Text(used.mixSummary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let src = store.genreSource(for: clip) {
                LabeledContent(L("判定の根拠", "Based on"), value: src)
                    .font(.caption)
            }
            if let t = result?.traits, t.count == 4 {
                LabeledContent(L("歌・盛り上がり", "Vocals · Energy")) {
                    Text(L("歌 \(Int((t[0] * 100).rounded()))%・エナジー \(Int(((store.energyLevel(clip) ?? 0) * 100).rounded()))",
                           "vocals \(Int((t[0] * 100).rounded()))% · energy \(Int(((store.energyLevel(clip) ?? 0) * 100).rounded()))"))
                        .monospacedDigit()
                }
                .font(.caption)
                .help(L("歌：歌・ラップが聞こえる区間の割合（つなぎで歌同士が重ならないようにするのに使います）。エナジー：パーティー感・激しさ・踊りやすさとドロップの音量（曲順の流れに使います）",
                        "Vocals: share of the track with singing / rapping (used to keep vocals from overlapping). Energy: party / aggressive / danceable feel and drop loudness (used for the set's energy curve)"))
            }
            if let r = result, !r.styles.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L("AI が聴き取ったスタイル（Discogs）", "Styles the AI hears (Discogs)"))
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                    ForEach(r.styles.prefix(4), id: \.label) { st in
                        HStack(spacing: 6) {
                            Text(st.name).font(.caption)
                            Spacer(minLength: 4)
                            ProgressView(value: min(1, st.score)).frame(width: 60)
                            Text("\(Int((st.score * 100).rounded()))%").font(.caption).monospacedDigit().frame(width: 34, alignment: .trailing)
                        }
                    }
                }
            } else if result == nil && GenreAnalyzer.isAvailable {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(L("解析中…", "Analysing…")).font(.callout).foregroundStyle(.secondary)
                }
            }
        } header: {
            Text(L("ジャンル（おまかせミックスのつなぎ方）", "Genre (How the Auto-Mix Connects)"))
        }
    }
}

// MARK: - AI analysis (beat grid + cue suggestions)

private struct AIAnalysisSection: View {
    @Environment(MixStore.self) private var store
    let clipID: UUID

    private var clip: Clip { store.clip(clipID) ?? .placeholder }

    var body: some View {
        Section {
            if let a = store.aiGrid(for: clip) {
                LabeledContent(L("拍の一致", "Beat match")) {
                    HStack(spacing: 6) {
                        Text("\(Int((a.currentFit * 100).rounded()))%")
                            .monospacedDigit()
                            .foregroundStyle(a.currentFit < 0.6 ? Color.orange : Color.secondary)
                        if store.gridDiffersFromAI(clip) {
                            Image(systemName: "arrow.right").font(.caption).foregroundStyle(.secondary)
                            Text("\(Int((a.fit * 100).rounded()))%").monospacedDigit().foregroundStyle(.green)
                        }
                    }
                }
                .help(L("AI が聴き取った拍のうち、いまの拍グリッドに乗っている割合", "Share of the beats the AI heard that sit on the current grid"))
                if store.gridDiffersFromAI(clip) {
                    Button {
                        store.applyAIGrid(clip.id)
                    } label: {
                        Label(L("AI の拍・小節に合わせる（\(Fmt.bpm(a.bpm)) BPM）", "Match the AI Grid (\(Fmt.bpm(a.bpm)) BPM)"), systemImage: "metronome")
                    }
                    .buttonStyle(.borderedProminent)
                }
                if a.grid.tempoVaries {
                    Label(L("曲の途中でテンポが変わる（またはハーフ／倍テンになる）部分があります。拍がずれる区間ではループや長いつなぎを避けるのが安全です。",
                            "The tempo changes (or goes half / double time) inside this track. Avoid loops and long blends where the grid drifts."),
                          systemImage: "waveform.path.ecg")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                let cues = store.aiCues(for: clip)
                if !cues.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(L("プロDJならここに CUE（AI予測）", "Where a pro DJ would cue (AI)"))
                            .font(.caption.bold())
                            .foregroundStyle(.secondary)
                        FlowChips(cues: cues, clip: clip)
                    }
                }
            } else if NeuralAnalyzer.isAvailable {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(L("解析中…", "Analysing…")).font(.callout).foregroundStyle(.secondary)
                }
            } else {
                Text(L("AI モデルが見つかりません", "AI models not found")).font(.callout).foregroundStyle(.secondary)
            }
        } header: {
            Text(L("AI 解析（拍・小節・CUE）", "AI Analysis (Beats, Bars, Cues)"))
        }
    }
}

private struct FlowChips: View {
    @Environment(MixStore.self) private var store
    let cues: [CueBar]
    let clip: Clip

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 64), spacing: 6)], alignment: .leading, spacing: 6) {
            ForEach(cues, id: \.self) { cue in
                Menu {
                    Button(L("入口（IN）にする", "Use as Mix-In")) { store.setMixIn(clip.id, bar: cue.bar) }
                    Button(L("切替完了にする", "Use as Switch Point")) { store.setLandingBar(clip.id, bar: cue.bar) }
                    Button(L("出口（OUT）にする", "Use as Mix-Out")) { store.setMixOut(clip.id, bar: cue.bar) }
                } label: {
                    Text("◆ \(Clip.barLabel(cue.bar))")
                        .font(.system(size: 11, weight: .semibold))
                        .monospacedDigit()
                }
                .menuStyle(.button)
                .fixedSize()
                .tint(Color(hue: 0.13, saturation: 0.7, brightness: 0.95).opacity(0.4 + 0.6 * cue.score))
                .help(L("\(Clip.barLabel(cue.bar))小節目（強さ \(Int((cue.score * 100).rounded()))%）", "Bar \(Clip.barLabel(cue.bar)) (strength \(Int((cue.score * 100).rounded()))%)"))
            }
        }
    }
}


// MARK: - Saved takes of one transition

/// Several transitions for the same two tracks, kept side by side: save, listen, pick one.
private struct TakesSection: View {
    @Environment(MixStore.self) private var store
    let clipID: UUID
    @State private var renaming: UUID?
    @State private var draft = ""

    var body: some View {
        let list = store.takes(into: clipID)
        let current = store.currentTakeID(into: clipID)
        Section {
            if list.isEmpty {
                Text(L("いまのつなぎを候補として保存しておくと、別のつなぎ方を作っても消えません。いくつか作って聴き比べ、最後に使うものを選べます。",
                       "Save the current transition as a take and it stays even when you make another one. Make a few, compare them and pick one."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(list) { t in row(t, isCurrent: t.id == current) }
                if current == nil {
                    Label(L("いまのつなぎはまだ保存されていません", "The current transition is not saved yet"), systemImage: "pencil.circle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
            HStack(spacing: 8) {
                Button {
                    store.saveTake(into: clipID)
                } label: {
                    Label(L("いまのつなぎを保存", "Save Current"), systemImage: "square.and.arrow.down")
                }
                .disabled(current != nil)
                .help(L("いまのつなぎ（出口・入口・長さ・カーブ・テンポ）を候補として残します", "Keeps the current transition (exit, entry, length, curves, tempo) as a take"))
                Button {
                    store.newTakeFromAuto(into: clipID)
                } label: {
                    Label(L("新しい候補を作る", "New Take"), systemImage: "plus.square.on.square")
                }
                .help(L("いまのつなぎを保存してから、おすすめのつなぎで新しく作り直します。気に入らなければ一覧から戻せます",
                        "Saves the current transition, then starts a new one from the recommended plan. Switch back from the list at any time"))
            }
        } header: {
            Text(L("保存したつなぎ（\(list.count)）", "Saved Takes (\(list.count))"))
        }
    }

    @ViewBuilder
    private func row(_ t: TransitionTake, isCurrent: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: isCurrent ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(isCurrent ? Color.accentColor : Color.secondary)
            VStack(alignment: .leading, spacing: 1) {
                if renaming == t.id {
                    TextField("", text: $draft)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { store.renameTake(into: clipID, t.id, to: draft); renaming = nil }
                } else {
                    Text(t.name).font(.callout.bold())
                        .onTapGesture(count: 2) { draft = t.name; renaming = t.id }
                        .help(L("ダブルクリックで名前を変更", "Double-click to rename"))
                }
                Text(t.summary).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 4)
            Button { store.previewTake(into: clipID, t.id) } label: { Image(systemName: "play.fill") }
                .help(L("このつなぎに切り替えて試聴（⌘Z で戻せます）", "Switch to this take and listen (⌘Z goes back)"))
            Button(L("使う", "Use")) { store.useTake(into: clipID, t.id) }
                .disabled(isCurrent)
            Button { store.deleteTake(into: clipID, t.id) } label: { Image(systemName: "trash") }
                .buttonStyle(.borderless)
                .help(L("この候補を削除", "Delete this take"))
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Variations of one transition

/// Compare different ways of connecting the previous track and this one, listen to each, and keep one.
private struct VariationsSection: View {
    @Environment(MixStore.self) private var store
    let clipID: UUID
    @State private var checking = false
    @State private var expanded: UUID?

    var body: some View {
        let i = store.index(of: clipID) ?? 0
        let prev = i > 0 ? store.clips[i - 1] : nil
        let list = store.variationList(into: clipID) ?? []
        Section {
            HStack(spacing: 6) {
                Button { select(i - 1) } label: { Image(systemName: "chevron.left") }
                    .disabled(i < 2)
                    .help(L("ひとつ前のつなぎ", "Previous transition"))
                VStack(alignment: .leading, spacing: 1) {
                    Text(prev?.title ?? "").lineLimit(1).font(.caption)
                    Text("→ " + (store.clip(clipID)?.title ?? "")).lineLimit(1).font(.caption.bold())
                }
                Spacer(minLength: 4)
                Button { select(i + 1) } label: { Image(systemName: "chevron.right") }
                    .disabled(i + 1 >= store.clips.count)
                    .help(L("次のつなぎ", "Next transition"))
            }
            if list.isEmpty {
                Button {
                    store.computeVariations(into: clipID)
                } label: {
                    Label(L("つなぎ方の候補を出す", "Show Variations"), systemImage: "square.stack.3d.up")
                }
            } else {
                ForEach(Array(list.enumerated()), id: \.element.id) { k, v in
                    row(k, v)
                }
                HStack {
                    Button {
                        checking = true
                        Task {
                            await store.checkVariations(into: clipID)
                            checking = false
                        }
                    } label: {
                        Label(L("すべて書き出して確認", "Render & Check All"), systemImage: "waveform.badge.magnifyingglass")
                    }
                    .disabled(checking)
                    if checking { ProgressView().controlSize(.small) }
                    Spacer()
                    Button {
                        store.computeVariations(into: clipID)
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .help(L("いまの曲の状態から候補を出し直す", "Recompute the variations"))
                }
                Text(L("「試聴」はその案に切り替えてつなぎの4小節前から再生します。⌘Z で元の案に戻せます。",
                       "“Listen” switches to that variation and plays from 4 bars before it. ⌘Z goes back."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            Text(L("この2曲のつなぎ方（候補）", "Ways to Connect These Two"))
        }
        .onAppear { if store.variationList(into: clipID) == nil { store.computeVariations(into: clipID) } }
        .onChange(of: clipID) { _, id in if store.variationList(into: id) == nil { store.computeVariations(into: id) } }
        .onChange(of: prev?.id) { _, _ in if store.variationList(into: clipID) == nil { store.computeVariations(into: clipID) } }
    }

    private func select(_ k: Int) {
        guard k > 0, k < store.clips.count else { return }
        store.selectedClipID = store.clips[k].id
    }

    @ViewBuilder
    private func row(_ k: Int, _ v: MixStore.TransitionVariation) -> some View {
        let p = v.plan
        let current = store.isCurrentVariation(into: clipID, k)
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: current ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(current ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(v.label).font(.callout.bold())
                    Text(summary(p)).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 4)
                Button { store.previewVariation(into: clipID, k) } label: { Image(systemName: "play.fill") }
                    .help(L("この案に切り替えて試聴", "Switch to this variation and listen"))
                Button(L("使う", "Use")) { store.applyVariation(into: clipID, k) }
                    .disabled(current)
            }
            if let problems = v.problems {
                Label(problems.isEmpty ? L("書き出して確認：問題なし", "Checked: no problems") : problems.joined(separator: "、"),
                      systemImage: problems.isEmpty ? "checkmark.seal" : "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(problems.isEmpty ? Color.green : Color.orange)
            }
            if expanded == v.id {
                Text(p.reasons.joined(separator: "\n"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { expanded = expanded == v.id ? nil : v.id }
        .padding(.vertical, 2)
    }

    private func summary(_ p: AutoMixPlan) -> String {
        let how = p.style.isCutLike || p.length == 0 ? p.style.title : L("\(p.style.title) \(p.length)小節", "\(p.style.title), \(p.length) bars")
        return L("\(how)・前の曲 \(p.outBar + 1)小節目で抜け始め・この曲は \(p.inBar + 1)小節目から",
                 "\(how) · out from bar \(p.outBar + 1) · in at bar \(p.inBar + 1)")
    }
}

// MARK: - Whole-mix patterns

struct MixPatternsSection: View {
    @Environment(MixStore.self) private var store

    var body: some View {
        if !store.mixPatterns.isEmpty || store.verifyProgress != nil {
            Section {
                ForEach(store.mixPatterns) { p in
                    HStack(spacing: 8) {
                        Image(systemName: p.id == store.currentPatternID ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(p.id == store.currentPatternID ? Color.accentColor : Color.secondary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(p.title).font(.callout.bold())
                            Text(p.detail).font(.caption).foregroundStyle(.secondary)
                            Text(L("ブレンド \(p.blends)・カット \(p.cuts)・平均 \(Int(p.averageBars.rounded()))小節・全長 \(Fmt.duration(p.duration))",
                                   "\(p.blends) blends · \(p.cuts) cuts · avg \(Int(p.averageBars.rounded())) bars · \(Fmt.duration(p.duration))"))
                                .font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                        }
                        Spacer(minLength: 4)
                        Button(L("この案にする", "Use")) { store.usePattern(p.id) }
                            .disabled(p.id == store.currentPatternID)
                    }
                }
                if let v = store.verifyProgress {
                    HStack(spacing: 8) {
                        ProgressView(value: Double(v.done), total: Double(max(1, v.total))).frame(width: 90)
                        Text(L("つなぎを書き出して確認中（\(v.done)/\(v.total)）", "Rendering & checking transitions (\(v.done)/\(v.total))"))
                            .font(.caption)
                    }
                }
                Text(L("案を選んでから、気になるつなぎを選ぶと「この2曲のつなぎ方」で個別に差し替えられます。",
                       "Pick a pattern, then select a track to swap the transition into it under “Ways to Connect These Two”."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } header: {
                Text(L("おまかせミックスの案", "Auto-Mix Patterns"))
            }
        }
    }
}
