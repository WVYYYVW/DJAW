import SwiftUI

/// "Auto-arrange": tick some tracks and let DJAW pick the running order and build the transitions.
/// Deliberately a side tool in a sheet — mixing by hand stays the main way of working.
struct AutoArrangeSheet: View {
    @Environment(MixStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var selected: Set<UUID> = []
    @State private var reorder = true
    @State private var replace = true
    @State private var didInit = false
    /// After building, the sheet shows the planned transitions so each can be checked and edited.
    @State private var built = false
    @State private var editing: CueEditorTarget?
    @State private var depthBeforeBuild = 0

    /// Mix tracks first (in their order), then the library.
    private var allTracks: [Clip] { store.clips + store.library }

    private var chosenInListOrder: [UUID] { allTracks.map(\.id).filter { selected.contains($0) } }

    private var preview: [UUID] {
        reorder ? store.suggestedOrder(chosenInListOrder) : chosenInListOrder
    }

    var body: some View {
        Group {
            if built { results } else { chooser }
        }
        .frame(width: 760, height: 560)
        .sheet(item: $editing) { target in
            TransitionEditorView(clipID: target.id)
                .background(UndoShortcuts())
        }
        .onAppear {
            guard !didInit else { return }
            didInit = true
            // Start with the tracks picked in the library, else the library plus the current mix.
            if let pre = store.autoArrangePreselect, !pre.isEmpty {
                selected = pre
                replace = false
            } else {
                selected = Set(allTracks.map(\.id))
            }
            store.autoArrangePreselect = nil
        }
    }

    // MARK: Step 1 — choose tracks

    private var chooser: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Label(L("おまかせミックス", "Auto-Arrange"), systemImage: "wand.and.stars")
                        .font(.title3.bold())
                    Text(L("選んだ曲の順番とつなぎを、BPM・キー・曲の構成から自動で組み立てます。あとから自由に手直しできます。",
                           "DJAW picks the running order and the transitions from BPM, key and structure. You can rework everything by hand afterwards."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(16)
            Divider()

            HStack(alignment: .top, spacing: 0) {
                // Left: choose tracks
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(L("使う曲", "Tracks to use")).font(.headline)
                        Spacer()
                        Button(L("すべて", "All")) { selected = Set(allTracks.map(\.id)) }
                        Button(L("なし", "None")) { selected = [] }
                    }
                    .controlSize(.small)
                    List {
                        ForEach(allTracks) { clip in
                            Toggle(isOn: Binding(
                                get: { selected.contains(clip.id) },
                                set: { on in if on { selected.insert(clip.id) } else { selected.remove(clip.id) } })) {
                                trackLabel(clip, inMix: store.index(of: clip.id) != nil)
                            }
                            .toggleStyle(.checkbox)
                        }
                    }
                    .listStyle(.bordered(alternatesRowBackgrounds: true))
                }
                .padding(14)
                .frame(width: 330)

                Divider()

                // Right: proposed order
                VStack(alignment: .leading, spacing: 6) {
                    Text(reorder ? L("提案された曲順", "Suggested order") : L("曲順（そのまま）", "Order (as listed)"))
                        .font(.headline)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            let ids = preview
                            ForEach(Array(ids.enumerated()), id: \.element) { n, id in
                                if n > 0, let a = store.clip(ids[n - 1]), let b = store.clip(id) {
                                    compatibility(a, b)
                                }
                                if let c = store.clip(id) {
                                    HStack(spacing: 8) {
                                        Text("\(n + 1)")
                                            .font(.system(size: 11, weight: .semibold))
                                            .frame(width: 20, height: 20)
                                            .background(Circle().fill(Color.clip(c.colorIndex).opacity(0.5)))
                                        trackLabel(c, inMix: false)
                                    }
                                    .padding(.vertical, 3)
                                }
                            }
                            if ids.count < 2 {
                                Text(L("2曲以上選んでください", "Choose at least two tracks"))
                                    .foregroundStyle(.secondary)
                                    .padding(.top, 8)
                            }
                        }
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }

            Divider()
            HStack(spacing: 14) {
                Toggle(L("曲順も自動で決める", "Choose the order too"), isOn: $reorder)
                Picker(L("スタイル", "Style"), selection: Binding(get: { store.mixStyle }, set: { store.mixStyle = $0 })) {
                    ForEach(MixStyle.allCases) { Text($0.title).tag($0) }
                }
                .frame(width: 250)
                .help(store.mixStyle.detail)
                Picker(L("流れ", "Energy"), selection: Binding(get: { store.setArc }, set: { store.setArc = $0 })) {
                    ForEach(SetArc.allCases) { Text($0.title).tag($0) }
                }
                .frame(width: 230)
                .disabled(!reorder)
                .help(L("曲順を決めるとき、盛り上がり（エナジー）の流れをどう作るか", "How the energy should develop over the order"))
                Picker("", selection: $replace) {
                    Text(L("ミックスを作り直す", "Replace the mix")).tag(true)
                    Text(L("今のミックスの後ろに追加", "Append to the mix")).tag(false)
                }
                .labelsHidden()
                .frame(width: 210)
                .help(L("作り直す場合、選ばなかったミックスの曲はライブラリに戻ります（⌘Zで元に戻せます）",
                        "When replacing, unchosen mix tracks go back to the library (undo with ⌘Z)"))
                Spacer()
                if pendingAnalysis {
                    Label(L("解析中の曲があります", "Some tracks are still being analysed"), systemImage: "hourglass")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Button(L("キャンセル", "Cancel")) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(L("ミックスを作成", "Build the Mix")) {
                    depthBeforeBuild = store.undoDepth
                    store.autoArrange(chosenInListOrder, reorder: reorder, replace: replace)
                    built = true
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(selected.count < (replace ? 2 : 1))
            }
            .padding(16)
        }
    }

    // MARK: Step 2 — check and fine-tune each transition

    private var results: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Label(L("ミックスを作成しました", "Mix built"), systemImage: "checkmark.circle")
                        .font(.title3.bold())
                    Text(L("各つなぎを試聴し、気になる所はつなぎエディタで LOW / HIGH やフェーダーの動きを描き直せます。",
                           "Preview each transition and redraw its LOW / HIGH and fader moves in the Transition Editor where needed."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(L("マスター \(Fmt.bpm(store.masterBPM)) BPM", "Master \(Fmt.bpm(store.masterBPM)) BPM"))
                    .font(Typo.readout(12))
                    .foregroundStyle(.secondary)
            }
            .padding(16)
            Divider()

            ScrollView {
                VStack(spacing: 8) {
                    ForEach(Array(store.clips.enumerated()), id: \.element.id) { i, clip in
                        if i > 0 { transitionRow(i, clip) }
                    }
                    if store.clips.count < 2 {
                        Text(L("つなぎはありません", "No transitions"))
                            .foregroundStyle(.secondary)
                            .padding(.top, 20)
                    }
                }
                .padding(14)
            }

            Divider()
            HStack(spacing: 12) {
                Button {
                    if store.isPlaying { store.pause() }
                    // Roll back the build and every edit made since.
                    while store.undoDepth > depthBeforeBuild && store.canUndo { store.undo() }
                    built = false
                } label: {
                    Label(L("取り消して選び直す", "Undo & Choose Again"), systemImage: "arrow.uturn.backward")
                }
                Spacer()
                Button(L("完了", "Done")) {
                    if store.isPlaying { store.pause() }
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
            }
            .padding(16)
        }
    }

    private func transitionRow(_ i: Int, _ clip: Clip) -> some View {
        let prev = store.clips[i - 1]
        let kind = clip.transitionBars < 0.01
            ? clip.transition.title
            : "\(Fmt.bars(clip.transitionBars)) · \(clip.transition.title)"
        let lines = (store.autoNote(for: clip) ?? "").split(separator: "\n").map(String.init)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("\(i)→\(i + 1)")
                    .font(Typo.readout(11))
                    .foregroundStyle(.secondary)
                    .frame(width: 34, alignment: .leading)
                Circle().fill(Color.clip(prev.colorIndex)).frame(width: 8, height: 8)
                Text(prev.title).lineLimit(1).truncationMode(.middle)
                Image(systemName: "arrow.right").font(.caption).foregroundStyle(.secondary)
                Circle().fill(Color.clip(clip.colorIndex)).frame(width: 8, height: 8)
                Text(clip.title).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 8)
                Text(kind)
                    .font(Typo.label(10))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.primary.opacity(0.08)))
            }
            .font(.callout)
            if !lines.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(lines.prefix(3), id: \.self) { line in
                        Text("• " + line)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.leading, 42)
            }
            HStack(spacing: 8) {
                Spacer()
                Button {
                    if store.isPlaying { store.pause() } else { store.previewTransition(clip.id) }
                } label: {
                    Label(store.isPlaying ? L("停止", "Stop") : L("試聴", "Preview"),
                          systemImage: store.isPlaying ? "stop.fill" : "play.fill")
                }
                Button {
                    store.autoMixTransition(into: clip.id)
                } label: {
                    Label(L("決め直す", "Re-decide"), systemImage: "wand.and.stars")
                }
                .help(L("このつなぎだけ、曲を解析して決め直します", "Re-plans only this transition from the analysis"))
                Button {
                    if store.isPlaying { store.pause() }
                    store.selectedClipID = clip.id
                    editing = CueEditorTarget(id: clip.id)
                } label: {
                    Label(L("つなぎエディタ…", "Transition Editor…"), systemImage: "slider.horizontal.3")
                }
                .buttonStyle(.borderedProminent)
                .disabled(clip.transitionBars < 0.01)
                .help(clip.transitionBars < 0.01
                      ? L("カットインは重なりがないため描けません", "A cut has no overlap to draw")
                      : L("LOW / MID / HIGH とフェーダーの時間変化を描きます", "Draw the LOW / MID / HIGH and fader moves over time"))
            }
            .controlSize(.small)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
    }

    private var pendingAnalysis: Bool {
        selected.contains { id in store.clip(id).map { store.structures[$0.url] == nil } ?? false }
    }

    private func trackLabel(_ c: Clip, inMix: Bool) -> some View {
        HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 1) {
                Text(c.title).lineLimit(1)
                HStack(spacing: 6) {
                    Text("\(Fmt.bpm(c.bpm)) BPM").monospacedDigit()
                    if let key = store.structures[c.url]?.key {
                        Text(key.camelot).foregroundStyle(.purple)
                    }
                    if inMix {
                        Text(L("ミックス中", "in mix")).foregroundStyle(.tertiary)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
    }

    /// Small line between two tracks: tempo change and key match.
    private func compatibility(_ a: Clip, _ b: Clip) -> some View {
        let pct = (b.bpm / max(1, a.bpm) - 1) * 100
        let ka = store.structures[a.url]?.key, kb = store.structures[b.url]?.key
        let keyOK: Bool? = (ka != nil && kb != nil) ? ka!.isCompatible(with: kb!) : nil
        return HStack(spacing: 6) {
            Image(systemName: "arrow.down")
                .font(Typo.label(9)).tracking(Typo.labelTracking)
            Text(String(format: "%+.1f%%", pct))
                .foregroundStyle(abs(pct) > 6 ? Color.orange : Color.secondary)
            if let keyOK {
                Label(keyOK ? L("キー相性◎", "Keys match") : L("キー注意", "Key clash"),
                      systemImage: keyOK ? "checkmark.circle" : "exclamationmark.triangle")
                    .foregroundStyle(keyOK ? Color.green : Color.orange)
            }
        }
        .font(.caption2)
        .padding(.leading, 6)
        .padding(.vertical, 2)
    }
}
