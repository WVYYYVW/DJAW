import SwiftUI
import AppKit

/// Which curve a click edits.
enum LaneTarget: String, CaseIterable, Identifiable {
    case incoming, outgoing, mirror
    var id: String { rawValue }
    var title: String {
        switch self {
        case .incoming: return L("入る側", "Incoming")
        case .outgoing: return L("出る側", "Outgoing")
        case .mirror: return L("対称", "Mirrored")
        }
    }

    var help: String {
        switch self {
        case .incoming: return L("この曲（入ってくる側）の線を編集します", "Edit the incoming track’s line")
        case .outgoing: return L("前の曲（出ていく側）の線を編集します", "Edit the outgoing track’s line")
        case .mirror: return L("入る側を描くと、出る側が自動で上下反転した形になります", "Draw the incoming line; the outgoing line follows as its mirror image")
        }
    }
}

struct SelectedPoint: Equatable {
    var kind: LaneKind
    var incoming: Bool
    var id: UUID
}

/// Large editor to draw the fader / HIGH / MID / LOW moves of one transition by hand.
struct TransitionEditorView: View {
    @Environment(MixStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let clipID: UUID

    @State private var target: LaneTarget = .mirror
    @State private var selection: SelectedPoint?
    @State private var saveName = ""
    @State private var visibleLanes: Set<LaneKind> = Set(LaneKind.allCases)
    /// Which group of lanes is shown: fader / EQ, effects, or stems (vocals / instrumental).
    @State private var lanePage = 0

    private var pageKinds: [LaneKind] {
        switch lanePage {
        case 1: return LaneKind.effects
        case 2: return LaneKind.stems
        default: return LaneKind.mixer.filter { visibleLanes.contains($0) }
        }
    }
    /// The sheet would otherwise focus the name field on open and swallow Space / Delete.
    @FocusState private var nameFocused: Bool

    var body: some View {
        Group {
            if let i = store.index(of: clipID), i > 0 {
                content(prev: store.clips[i - 1], clip: store.clips[i])
            } else {
                VStack(spacing: 12) {
                    Text(L("つなぎが見つかりません", "Transition not found"))
                    Button(L("閉じる", "Close")) { dismiss() }
                }
                .padding(40)
            }
        }
        .frame(width: 1120, height: 780)
        .background(Theme.background)
        .preferredColorScheme(.dark)
        .onAppear {
            DispatchQueue.main.async {
                nameFocused = false
                NSApp.keyWindow?.makeFirstResponder(nil)
            }
        }
    }

    private func content(prev: Clip, clip: Clip) -> some View {
        let lanes = clip.effectiveLanes
        let totalBeats = max(1, clip.transitionBars * 4)
        let colorA = Color.clip(prev.colorIndex)
        let colorB = Color.clip(clip.colorIndex)
        let master = store.masterBPM
        let tStart = clip.start
        let tEnd = min(prev.end(master: master), clip.end(master: master))

        return VStack(spacing: 0) {
            header(prev: prev, clip: clip, colorA: colorA, colorB: colorB)
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            Divider()

            if clip.transitionBars < 0.01 {
                ContentUnavailableView {
                    Label(L("重なりがありません", "No overlap"), systemImage: "scissors")
                } description: {
                    Text(L("つなぎの長さを 1小節以上にすると、フェーダーと EQ の動きを描けます。", "Set the length to 1 bar or more to draw fader and EQ moves."))
                } actions: {
                    Button(L("8小節にする", "Make it 8 bars")) { store.setTransitionLength(clip.id, bars: 8) }
                }
                .frame(maxHeight: .infinity)
            } else {
                toolbar(clip: clip, lanes: lanes, totalBeats: totalBeats)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 10)

                GeometryReader { geo in
                // Lanes share the free height (fader a bit taller); scroll only if it's too small.
                let kinds = pageKinds
                let weights = kinds.reduce(0.0) { $0 + ($1 == .volume ? 1.35 : 1.0) }
                let free = geo.size.height - 20 - 10 * CGFloat(kinds.count) - 12
                let unit = max(84, free / CGFloat(max(1, weights)))
                ScrollView {
                    VStack(spacing: 10) {
                        BarRuler(totalBeats: totalBeats, inset: 10, range: tStart...max(tStart + 0.001, tEnd))
                            .frame(height: 20)
                            .padding(.leading, 96)
                        if lanePage == 2 { StemStatus(clipID: clip.id) }
                        ForEach(LaneKind.allCases) { kind in
                            if kinds.contains(kind) {
                                HStack(spacing: 8) {
                                    laneHeader(kind, clip: clip, lanes: lanes)
                                        .frame(width: 88)
                                    AutomationLaneView(kind: kind,
                                                       lanes: lanes,
                                                       totalBeats: totalBeats,
                                                       colorOut: colorA,
                                                       colorIn: colorB,
                                                       target: target,
                                                       selection: $selection,
                                                       playRange: tStart...max(tStart + 0.001, tEnd),
                                                       onBegin: { store.pushUndo(); store.isInteracting = true },
                                                       onChange: { store.setLanes(clip.id, $0, undoable: false) },
                                                       onEnd: { store.isInteracting = false })
                                        .frame(height: unit * (kind == .volume ? 1.35 : 1.0))
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 12)
                }
                .scrollDisabled(free >= 84 * weights)
                }
            }

            Divider()
            footer(clip: clip)
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
        }
        .onKeyPress(phases: .down) { press in
            if press.key == .delete || press.key == .deleteForward {
                deleteSelected(clip: clip)
                return .handled
            }
            return .ignored
        }
    }

    // MARK: Header

    private func header(prev: Clip, clip: Clip, colorA: Color, colorB: Color) -> some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(L("つなぎエディタ", "Transition Editor"))
                    .font(.title3.bold())
                HStack(spacing: 6) {
                    Circle().fill(colorA).frame(width: 9, height: 9)
                    Text(prev.title).lineLimit(1)
                    Image(systemName: "arrow.right").foregroundStyle(.secondary)
                    Circle().fill(colorB).frame(width: 9, height: 9)
                    Text(clip.title).lineLimit(1)
                }
                .font(.callout)
            }
            Spacer()
            HStack(spacing: 6) {
                Text(L("長さ", "Length")).foregroundStyle(.secondary)
                ForEach([2.0, 4, 8, 16, 32], id: \.self) { bars in
                    Button("\(Int(bars))") { store.setTransitionLength(clip.id, bars: bars) }
                        .buttonStyle(.bordered)
                        .tint(abs(clip.transitionBars - bars) < 0.01 ? .accentColor : nil)
                }
                Stepper("", onIncrement: { store.setTransitionLength(clip.id, bars: clip.transitionBars + 1) },
                        onDecrement: { store.setTransitionLength(clip.id, bars: max(1, clip.transitionBars - 1)) })
                    .labelsHidden()
                Text(Fmt.bars(clip.transitionBars))
                    .monospacedDigit()
                    .frame(minWidth: 56, alignment: .leading)
            }
            Button {
                store.previewTransition(clip.id)
            } label: {
                Label(store.isPlaying ? L("再生中…", "Playing…") : L("試聴", "Preview"), systemImage: "play.fill")
            }
            .controlSize(.large)
            .help(L("4小節前から再生します。もう一度押すと最初から（上の小節番号をクリックすると、その位置から再生できます）", "Plays from 4 bars before. Press again to restart (click the bar numbers to play from there)"))
            if store.isPlaying {
                Button { store.pause() } label: { Image(systemName: "pause.fill") }
                    .controlSize(.large)
            }
            Button {
                store.saveTake(into: clip.id)
            } label: {
                Label(store.currentTakeID(into: clip.id) == nil ? L("候補に保存", "Save as Take") : L("保存済み", "Saved"),
                      systemImage: store.currentTakeID(into: clip.id) == nil ? "square.and.arrow.down" : "checkmark")
            }
            .controlSize(.large)
            .disabled(store.currentTakeID(into: clip.id) != nil)
            .help(L("いまのつなぎを候補として残します（インスペクタの「保存したつなぎ」から切り替え・聴き比べ）",
                    "Keeps this transition as a take (switch and compare under “Saved Takes” in the inspector)"))
            Button(L("完了", "Done")) {
                store.isInteracting = false
                dismiss()
            }
            .keyboardShortcut(.defaultAction)
            .controlSize(.large)
        }
    }

    // MARK: Toolbar

    private func toolbar(clip: Clip, lanes: TransitionLanes, totalBeats: Double) -> some View {
        HStack(spacing: 12) {
            Picker("", selection: $lanePage) {
                Text(L("フェーダー・EQ", "Fader / EQ")).tag(0)
                Text(L("FX", "FX")).tag(1)
                Text(L("ボーカル", "Vocals")).tag(2)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .help(L("編集するレーン：フェーダーと EQ／フィルター・エコー・リバーブ／ボーカルと伴奏（曲を分離して使います）",
                    "Lanes to edit: fader and EQ / filter, echo, reverb / vocals and instrumental (uses the separated stems)"))
            Text(L("描く線", "Edit")).foregroundStyle(.secondary)
            // Effects and stems are drawn for one track at a time (no mirror image).
            Picker("", selection: $target) {
                ForEach(LaneTarget.allCases.filter { lanePage == 0 || $0 != .mirror }) { t in Text(t.title).tag(t) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .help(target.help)
            .onChange(of: lanePage) { _, page in
                if page != 0 && target == .mirror { target = .outgoing }
            }
            // Which colour is which track.
            if let i = store.index(of: clip.id), i > 0 {
                HStack(spacing: 8) {
                    Label(L("前の曲", "Prev"), systemImage: "circle.fill")
                        .foregroundStyle(Color.clip(store.clips[i - 1].colorIndex))
                    Label(L("この曲", "This"), systemImage: "circle.fill")
                        .foregroundStyle(Color.clip(clip.colorIndex))
                }
                .font(.caption)
                .labelStyle(.titleAndIcon)
            }

            Menu {
                ForEach(TransitionPreset.all) { p in
                    Button(L("「\(p.title)」から始める", "Start from “\(p.title)”")) {
                        let lanes = TransitionLanes.sampled(style: p.style, shape: TransitionShape.defaults(for: p.style))
                        store.setLanes(clip.id, lanes)
                    }
                }
                if !store.customTransitions.isEmpty {
                    Divider()
                    ForEach(store.customTransitions) { p in
                        Button(p.name) { store.applyCustomTransition(clip.id, p) }
                    }
                }
            } label: {
                Label(L("ひな形", "Start from"), systemImage: "square.on.square")
            }
            .fixedSize()

            Spacer()
            selectionEditor(clip: clip, lanes: lanes, totalBeats: totalBeats)
        }
    }

    /// Precise numeric control of the selected point.
    @ViewBuilder
    private func selectionEditor(clip: Clip, lanes: TransitionLanes, totalBeats: Double) -> some View {
        if let sel = selection,
           let point = lanes.points(sel.kind, incoming: sel.incoming).first(where: { $0.id == sel.id }) {
            let pts = lanes.points(sel.kind, incoming: sel.incoming)
            let isEdge = pts.first?.id == point.id || pts.last?.id == point.id
            HStack(spacing: 8) {
                Text("\(sel.kind.title) · \(sel.incoming ? L("この曲", "This") : L("前の曲", "Prev"))")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
                Text(positionLabel(point.x, totalBeats: totalBeats))
                    .monospacedDigit()
                    .frame(minWidth: 84, alignment: .trailing)
                Stepper("", onIncrement: { movePoint(clip: clip, sel: sel, dx: 1 / totalBeats, dy: 0) },
                        onDecrement: { movePoint(clip: clip, sel: sel, dx: -1 / totalBeats, dy: 0) })
                    .labelsHidden()
                    .disabled(isEdge)
                Text("\(Int((point.y * 100).rounded()))%")
                    .monospacedDigit()
                    .frame(minWidth: 40, alignment: .trailing)
                Stepper("", onIncrement: { movePoint(clip: clip, sel: sel, dx: 0, dy: 0.05) },
                        onDecrement: { movePoint(clip: clip, sel: sel, dx: 0, dy: -0.05) })
                    .labelsHidden()
                Button(role: .destructive) { deleteSelected(clip: clip) } label: {
                    Image(systemName: "trash")
                }
                .disabled(isEdge)
                .help(L("点を削除（Delete）", "Delete point (Delete)"))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.07)))
        } else {
            Text(L("◆を上下にドラッグで曲線を曲げる・空いた所をクリックで点を追加・点をドラッグで移動・ダブルクリックで削除／直線に戻す", "Drag ◆ up/down to bend · click empty space to add a point · drag points to move · double-click to delete / straighten"))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func laneHeader(_ kind: LaneKind, clip: Clip, lanes: TransitionLanes) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(kind.title)
                .font(.system(size: 13, weight: .semibold))
            Text(kind.legend)
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
            Menu {
                if kind.isEffect || kind.isStem {
                    ForEach(TransitionLanes.effectPresets(kind)) { p in
                        Button(p.title) {
                            var l = lanes
                            l.apply(p, to: kind)
                            store.setLanes(clip.id, l)
                        }
                    }
                    Divider()
                    Button(L("消す（効果なし）", "Clear (no effect)")) {
                        var l = lanes
                        l.clear(kind)
                        store.setLanes(clip.id, l)
                    }
                } else {
                    ForEach(TransitionLanes.Template.allCases) { t in
                        Button(t.title) {
                            var l = lanes
                            l.apply(t, to: kind)
                            store.setLanes(clip.id, l)
                        }
                    }
                    Divider()
                    Button(L("出る側を入る側の反転にする", "Make out the mirror of in")) {
                        var l = lanes
                        l.mirrorToOutgoing(kind)
                        store.setLanes(clip.id, l)
                    }
                }
            } label: {
                Text(L("テンプレート", "Templates")).font(.caption)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .padding(.top, 4)
    }

    // MARK: Footer

    private func footer(clip: Clip) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "star.fill").foregroundStyle(.yellow)
            Text(L("このつなぎを保存して、ほかの曲間でも使う：", "Save this transition to reuse between other tracks:"))
                .font(.callout)
            TextField(L("名前（例：ハイから抜く16小節）", "Name (e.g. 16-bar high fade)"), text: $saveName)
                .textFieldStyle(.roundedBorder)
                .frame(width: 260)
                .focused($nameFocused)
                .onSubmit {
                    store.saveCustomTransition(from: clip.id, name: saveName)
                    saveName = ""
                    nameFocused = false
                }
            Button(L("マイつなぎに保存", "Save to My Transitions")) {
                store.saveCustomTransition(from: clip.id, name: saveName)
                saveName = ""
                nameFocused = false
            }
            .buttonStyle(.borderedProminent)
            Spacer()
            if lanePage == 0 {
            Toggle(isOn: Binding(get: { visibleLanes.contains(.mid) }, set: { on in
                if on { visibleLanes.insert(.mid) } else { visibleLanes.remove(.mid) }
            })) { Text(L("MID を表示", "Show MID")) }
                .toggleStyle(.checkbox)
            }
        }
    }

    // MARK: Helpers

    private func positionLabel(_ x: Double, totalBeats: Double) -> String {
        let beats = Int((x * totalBeats).rounded())
        let bar = beats / 4 + 1
        let beat = beats % 4 + 1
        return L("\(bar)小節 \(beat)拍", "bar \(bar).\(beat)")
    }

    private func movePoint(clip: Clip, sel: SelectedPoint, dx: Double, dy: Double) {
        var lanes = clip.effectiveLanes
        var pts = lanes.points(sel.kind, incoming: sel.incoming)
        guard let k = pts.firstIndex(where: { $0.id == sel.id }) else { return }
        let lo = k > 0 ? pts[k - 1].x : 0
        let hi = k + 1 < pts.count ? pts[k + 1].x : 1
        if k > 0 && k < pts.count - 1 {
            pts[k].x = min(hi, max(lo, pts[k].x + dx))
        }
        pts[k].y = min(1, max(0, pts[k].y + dy))
        lanes.setPoints(sel.kind, incoming: sel.incoming, pts)
        if target == .mirror && sel.incoming { lanes.mirrorToOutgoing(sel.kind) }
        store.setLanes(clip.id, lanes)
    }

    private func deleteSelected(clip: Clip) {
        guard let sel = selection else { return }
        var lanes = clip.effectiveLanes
        var pts = lanes.points(sel.kind, incoming: sel.incoming)
        guard let k = pts.firstIndex(where: { $0.id == sel.id }), k > 0, k < pts.count - 1 else { return }
        pts.remove(at: k)
        lanes.setPoints(sel.kind, incoming: sel.incoming, pts)
        if target == .mirror && sel.incoming { lanes.mirrorToOutgoing(sel.kind) }
        store.setLanes(clip.id, lanes)
        selection = nil
    }
}

// MARK: - Ruler

private struct BarRuler: View {
    @Environment(MixStore.self) private var store
    let totalBeats: Double
    let inset: CGFloat
    /// Timeline span of the transition: clicking or dragging on the ruler moves the playback position there.
    let range: ClosedRange<Double>
    @State private var scrubbing = false

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Canvas { ctx, size in
                    let bars = Int(ceil(totalBeats / 4))
                    let step = bars > 32 ? 4 : (bars > 16 ? 2 : 1)
                    for b in stride(from: 0, through: bars, by: step) {
                        let x = inset + CGFloat(min(1, Double(b * 4) / totalBeats)) * (size.width - inset * 2)
                        ctx.fill(Path(CGRect(x: x, y: size.height - 6, width: 1, height: 6)), with: .color(.white.opacity(0.4)))
                        if b < bars {
                            ctx.draw(Text("\(b + 1)").font(Typo.readout(11)).foregroundStyle(.secondary),
                                     at: CGPoint(x: x + 4, y: size.height / 2 - 2), anchor: .leading)
                        }
                    }
                }
                RulerPlayhead(range: range, inset: inset)
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { v in
                    if !scrubbing { scrubbing = true; store.beginScrub() }
                    store.scrub(to: time(at: v.location.x, width: geo.size.width))
                }
                .onEnded { v in
                    scrubbing = false
                    store.endScrub(at: time(at: v.location.x, width: geo.size.width))
                    // In the editor, picking a spot is for listening to it: play from there.
                    if !store.isPlaying { store.play() }
                })
            .help(L("クリック／ドラッグで再生位置を移動", "Click or drag to move the playback position"))
        }
    }

    private func time(at px: CGFloat, width: CGFloat) -> Double {
        let x = Double((px - inset) / max(1, width - inset * 2))
        return range.lowerBound + min(1, max(0, x)) * (range.upperBound - range.lowerBound)
    }
}

/// The playback position on the ruler (a small marker you can grab).
private struct RulerPlayhead: View {
    @Environment(MixStore.self) private var store
    let range: ClosedRange<Double>
    let inset: CGFloat

    var body: some View {
        Canvas { ctx, size in
            let t = store.playhead
            guard range.contains(t) else { return }
            let x = (t - range.lowerBound) / (range.upperBound - range.lowerBound)
            let px = inset + CGFloat(x) * (size.width - inset * 2)
            var tri = Path()
            tri.move(to: CGPoint(x: px - 5, y: 0))
            tri.addLine(to: CGPoint(x: px + 5, y: 0))
            tri.addLine(to: CGPoint(x: px, y: 8))
            tri.closeSubpath()
            let color = Color(nsColor: Theme.playhead)
            ctx.fill(tri, with: .color(color))
            ctx.fill(Path(CGRect(x: px - 1, y: 0, width: 2, height: size.height)), with: .color(color))
        }
        .allowsHitTesting(false)
    }
}

// MARK: - Playhead (isolated so playback does not redraw the whole editor)

private struct LanePlayhead: View {
    @Environment(MixStore.self) private var store
    let range: ClosedRange<Double>
    let inset: CGFloat

    var body: some View {
        Canvas { ctx, size in
            let t = store.playhead
            guard range.contains(t) else { return }
            let x = (t - range.lowerBound) / (range.upperBound - range.lowerBound)
            let px = inset + CGFloat(x) * (size.width - inset * 2)
            ctx.fill(Path(CGRect(x: px - 1, y: 0, width: 2, height: size.height)), with: .color(Color(nsColor: Theme.playhead)))
        }
        .allowsHitTesting(false)
    }
}

// MARK: - One automation lane

/// One lane: smooth curves you shape by dragging points (position) and
/// the ◆ handle in the middle of each segment (how much the curve bends).
private struct AutomationLaneView: View {
    let kind: LaneKind
    let lanes: TransitionLanes
    let totalBeats: Double
    let colorOut: Color
    let colorIn: Color
    let target: LaneTarget
    @Binding var selection: SelectedPoint?
    let playRange: ClosedRange<Double>
    let onBegin: () -> Void
    let onChange: (TransitionLanes) -> Void
    let onEnd: () -> Void

    private enum Grab: Equatable {
        case point(UUID)
        case bend(UUID)   // id of the segment's start point
    }

    @State private var grab: Grab?
    @State private var began = false
    @State private var lastTap: (grab: Grab, time: Date)?
    @State private var hover: Grab?

    private let pointRadius: CGFloat = 8
    private let hitRadius: CGFloat = 18
    private let inset: CGFloat = 10

    var body: some View {
        GeometryReader { geo in
            let size = geo.size
            Canvas { ctx, size in
                let rect = CGRect(origin: .zero, size: size)
                ctx.fill(Path(roundedRect: rect, cornerRadius: 8), with: .color(Color.white.opacity(0.04)))
                var b = 0.0
                while b <= totalBeats {
                    let x = xPos(b / totalBeats, size)
                    let isBar = Int(b) % 4 == 0
                    if isBar || totalBeats <= 64 {
                        ctx.fill(Path(CGRect(x: x, y: 0, width: 1, height: size.height)),
                                 with: .color(.white.opacity(isBar ? 0.13 : 0.04)))
                    }
                    b += 1
                }
                for level in [0.0, 0.5, 1.0] {
                    let y = yPos(level, size)
                    ctx.fill(Path(CGRect(x: 0, y: y, width: size.width, height: 1)), with: .color(.white.opacity(level == 0.5 ? 0.05 : 0.1)))
                }

                // The line being edited is drawn last, on top (they often overlap on effect / stem lanes).
                for incoming in (editIncoming ? [false, true] : [true, false]) {
                    let pts = lanes.points(kind, incoming: incoming)
                    let color = incoming ? colorIn : colorOut
                    let editable = isEditable(incoming: incoming)
                    let curve = curvePath(pts, size)
                    var area = curve
                    if let first = pts.first, let last = pts.last {
                        area.addLine(to: CGPoint(x: xPos(last.x, size), y: yPos(0, size)))
                        area.addLine(to: CGPoint(x: xPos(first.x, size), y: yPos(0, size)))
                        area.closeSubpath()
                    }
                    ctx.fill(area, with: .color(color.opacity(editable ? 0.18 : 0.07)))
                    ctx.stroke(curve, with: .color(color.opacity(editable ? 1 : 0.45)), lineWidth: editable ? 3 : 2)
                    guard editable else { continue }

                    // ◆ bend handles in the middle of each segment
                    for k in 0..<max(0, pts.count - 1) {
                        let a = pts[k], nb = pts[k + 1]
                        guard xPos(nb.x, size) - xPos(a.x, size) > 26, abs(nb.y - a.y) > 0.02 else { continue }
                        let c = bendHandle(a, nb, size)
                        let active = grab == .bend(a.id) || hover == .bend(a.id)
                        let r: CGFloat = active ? 8 : 6.5
                        var diamond = Path()
                        diamond.move(to: CGPoint(x: c.x, y: c.y - r))
                        diamond.addLine(to: CGPoint(x: c.x + r, y: c.y))
                        diamond.addLine(to: CGPoint(x: c.x, y: c.y + r))
                        diamond.addLine(to: CGPoint(x: c.x - r, y: c.y))
                        diamond.closeSubpath()
                        ctx.fill(diamond, with: .color(active ? color : Color(white: 0.15)))
                        ctx.stroke(diamond, with: .color(color), lineWidth: 2)
                    }
                    // Points
                    for p in pts {
                        let cp = CGPoint(x: xPos(p.x, size), y: yPos(p.y, size))
                        let isSelected = selection?.id == p.id
                        let r = isSelected || hover == .point(p.id) ? pointRadius + 2 : pointRadius
                        let circle = Path(ellipseIn: CGRect(x: cp.x - r, y: cp.y - r, width: r * 2, height: r * 2))
                        ctx.fill(circle, with: .color(isSelected ? color : .white))
                        ctx.stroke(circle, with: .color(isSelected ? .white : color), lineWidth: 3)
                    }
                }

            }
            .overlay { LanePlayhead(range: playRange, inset: inset) }
            .contentShape(Rectangle())
            .onContinuousHover { phase in
                switch phase {
                case .active(let p):
                    let g = hitTest(p, size: size)
                    if g != hover { hover = g }
                    switch g {
                    case .point: NSCursor.openHand.set()
                    case .bend: NSCursor.resizeUpDown.set()
                    case nil: NSCursor.crosshair.set()
                    }
                case .ended:
                    hover = nil
                    NSCursor.arrow.set()
                }
            }
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { v in handleDrag(v, size: size) }
                    .onEnded { v in handleEnd(v, size: size) }
            )
        }
    }

    // MARK: Geometry

    private func xPos(_ x: Double, _ size: CGSize) -> CGFloat { inset + CGFloat(x) * (size.width - inset * 2) }
    private func yPos(_ y: Double, _ size: CGSize) -> CGFloat { inset + CGFloat(1 - y) * (size.height - inset * 2) }
    private func xValue(_ px: CGFloat, _ size: CGSize) -> Double { Double((px - inset) / (size.width - inset * 2)) }
    private func yValue(_ py: CGFloat, _ size: CGSize) -> Double { 1 - Double((py - inset) / (size.height - inset * 2)) }

    private func curvePath(_ pts: [AutoPoint], _ size: CGSize) -> Path {
        var path = Path()
        guard let first = pts.first else { return path }
        path.move(to: CGPoint(x: xPos(first.x, size), y: yPos(first.y, size)))
        for k in 0..<max(0, pts.count - 1) {
            let a = pts[k], b = pts[k + 1]
            let steps = max(2, Int((xPos(b.x, size) - xPos(a.x, size)) / 3))
            for s in 1...steps {
                let t = Double(s) / Double(steps)
                let x = a.x + (b.x - a.x) * t
                path.addLine(to: CGPoint(x: xPos(x, size), y: yPos(a.segmentValue(to: b, t: t), size)))
            }
        }
        return path
    }

    private func bendHandle(_ a: AutoPoint, _ b: AutoPoint, _ size: CGSize) -> CGPoint {
        CGPoint(x: xPos((a.x + b.x) / 2, size), y: yPos(a.segmentValue(to: b, t: 0.5), size))
    }

    private func isEditable(incoming: Bool) -> Bool {
        switch target {
        case .incoming, .mirror: return incoming
        case .outgoing: return !incoming
        }
    }

    private var editIncoming: Bool { target != .outgoing }

    private func snapX(_ x: Double) -> Double {
        if NSEvent.modifierFlags.contains(.option) { return min(1, max(0, x)) }
        return min(1, max(0, (x * totalBeats).rounded() / totalBeats))
    }

    private func snapY(_ y: Double) -> Double {
        let v = min(1, max(0, y))
        if NSEvent.modifierFlags.contains(.option) { return v }
        for level in [0.0, 0.5, 1.0] where abs(v - level) < 0.04 { return level }
        return v
    }

    // MARK: Hit testing

    private func hitTest(_ p: CGPoint, size: CGSize) -> Grab? {
        let pts = lanes.points(kind, incoming: editIncoming)
        var best: (Grab, CGFloat)?
        for q in pts {
            let d = hypot(xPos(q.x, size) - p.x, yPos(q.y, size) - p.y)
            if d <= hitRadius, d < (best?.1 ?? .infinity) { best = (.point(q.id), d) }
        }
        if best != nil { return best?.0 }
        for k in 0..<max(0, pts.count - 1) {
            let a = pts[k], b = pts[k + 1]
            guard xPos(b.x, size) - xPos(a.x, size) > 26, abs(b.y - a.y) > 0.02 else { continue }
            let c = bendHandle(a, b, size)
            if hypot(c.x - p.x, c.y - p.y) <= 16 { return .bend(a.id) }
        }
        return nil
    }

    private func commit(_ pts: [AutoPoint]) {
        var l = lanes
        l.setPoints(kind, incoming: editIncoming, pts)
        // Effects and stems are drawn per side (a mirror image of an echo or a vocal cut makes no sense).
        if target == .mirror && !kind.isEffect && !kind.isStem { l.mirrorToOutgoing(kind) }
        onChange(l)
    }

    // MARK: Gestures

    private func handleDrag(_ v: DragGesture.Value, size: CGSize) {
        var pts = lanes.points(kind, incoming: editIncoming)
        if grab == nil {
            if let g = hitTest(v.startLocation, size: size) {
                grab = g
                if case .point(let id) = g { selection = SelectedPoint(kind: kind, incoming: editIncoming, id: id) }
            } else {
                // Click on empty space: add a point there.
                onBegin()
                began = true
                let point = AutoPoint(x: snapX(xValue(v.startLocation.x, size)), y: snapY(yValue(v.startLocation.y, size)))
                pts.append(point)
                commit(pts.sorted { $0.x < $1.x })
                grab = .point(point.id)
                selection = SelectedPoint(kind: kind, incoming: editIncoming, id: point.id)
            }
            return
        }
        guard hypot(v.translation.width, v.translation.height) >= 2 else { return }
        if !began {
            onBegin()
            began = true
        }
        switch grab {
        case .point(let id):
            guard let k = pts.firstIndex(where: { $0.id == id }) else { return }
            if k > 0 && k < pts.count - 1 {
                pts[k].x = min(pts[k + 1].x, max(pts[k - 1].x, snapX(xValue(v.location.x, size))))
            }
            pts[k].y = snapY(yValue(v.location.y, size))
            commit(pts)
        case .bend(let id):
            guard let k = pts.firstIndex(where: { $0.id == id }), k + 1 < pts.count else { return }
            let mid = min(1, max(0, yValue(v.location.y, size)))
            pts[k].bend = AutoPoint.bend(from: pts[k], to: pts[k + 1], passingMid: mid)
            commit(pts)
        case .none:
            break
        }
    }

    private func handleEnd(_ v: DragGesture.Value, size: CGSize) {
        defer {
            grab = nil
            if began { onEnd() }
            began = false
        }
        guard hypot(v.translation.width, v.translation.height) < 2, let g = grab else { return }
        let now = Date()
        if let last = lastTap, last.grab == g, now.timeIntervalSince(last.time) < 0.4 {
            // Double-click: delete a point, or straighten a curve.
            var pts = lanes.points(kind, incoming: editIncoming)
            switch g {
            case .point(let id):
                if let k = pts.firstIndex(where: { $0.id == id }), k > 0, k < pts.count - 1 {
                    if !began { onBegin(); began = true }
                    pts.remove(at: k)
                    commit(pts)
                    selection = nil
                }
            case .bend(let id):
                if let k = pts.firstIndex(where: { $0.id == id }) {
                    if !began { onBegin(); began = true }
                    pts[k].bend = 0
                    commit(pts)
                }
            }
            lastTap = nil
        } else {
            lastTap = (g, now)
        }
    }
}

// MARK: - Stems status

/// Whether the two tracks' vocals / instrumental are separated yet (needed for the vocal lanes).
private struct StemStatus: View {
    @Environment(MixStore.self) private var store
    let clipID: UUID

    var body: some View {
        let _ = store.stemRevision
        HStack(spacing: 10) {
            Image(systemName: "person.wave.2").foregroundStyle(.secondary)
            if !StemSeparator.isAvailable {
                Text(L("ボーカル分離のモデルが入っていないため、この版では使えません。", "The vocal separation model is not installed in this build."))
            } else if let i = store.index(of: clipID), i > 0 {
                ForEach([store.clips[i - 1], store.clips[i]], id: \.id) { c in
                    if let p = store.stemProgress[c.url] {
                        ProgressView(value: p).frame(width: 80)
                        Text(L("「\(c.title)」を分離中…", "Separating “\(c.title)”…")).lineLimit(1)
                    } else if StemSeparator.stems(for: c.url) != nil {
                        Label(c.title, systemImage: "checkmark.circle.fill").foregroundStyle(.green).lineLimit(1)
                    } else {
                        Button(L("「\(c.title)」を分離", "Separate “\(c.title)”")) { store.prepareStems([c.url]) }
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .font(.caption)
        .padding(.leading, 96)
        .help(L("ボーカルと伴奏の分離は1曲につき1回（数十秒）だけ行い、保存して使い回します。線を描くと自動で始まります。",
                "Vocals and instrumental are separated once per track (tens of seconds) and kept. Drawing a line starts it automatically."))
    }
}
