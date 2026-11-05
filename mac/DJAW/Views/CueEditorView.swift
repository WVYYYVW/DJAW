import SwiftUI

// MARK: - Single-track preview player

/// Plays one track on its own (outside the mix) for setting cues.
@Observable
final class CuePreview {
    private let engine = PlaybackEngine()
    private(set) var isPlaying = false
    /// Position in source seconds.
    var position: Double = 0
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var rate: Double = 1
    @ObservationIgnored private var duration: Double = 0

    func play(_ clip: Clip, master: Double, sync: Bool, from s: Double) {
        stopEngine()
        var c = clip
        c.start = 0
        c.trimStart = 0
        c.trimEnd = clip.duration
        c.edits = nil          // the CUE editor plays the raw track
        c.fadeInBeats = 0
        c.fadeOutBeats = 0
        c.tempoSync = sync
        c.fx = nil             // …without effects
        rate = c.rate(master: master)
        duration = clip.duration
        let from = min(max(0, s), max(0, clip.duration - 0.05))
        do {
            try engine.start(clips: [c], master: master, tempo: TempoMap(reference: master), outros: [:], from: from / rate)
            engine.applyAutomation(clips: [c], master: master, gridOffset: 0, time: from / rate)
            position = from
            isPlaying = true
            startTimer()
        } catch {
            isPlaying = false
        }
    }

    func pause() {
        guard isPlaying else { return }
        position = min(engine.currentTime * rate, duration)
        stopEngine()
    }

    func seek(_ s: Double, clip: Clip, master: Double, sync: Bool) {
        let v = min(max(0, s), clip.duration)
        if isPlaying {
            play(clip, master: master, sync: sync, from: v)
        } else {
            position = v
        }
    }

    private func stopEngine() {
        engine.stop()
        isPlaying = false
        timer?.invalidate()
        timer = nil
    }

    private func startTimer() {
        let t = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            MainActor.assumeIsolated { self.tick() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func tick() {
        guard isPlaying else { return }
        position = engine.currentTime * rate
        if position >= duration { pause() }
    }
}

enum CueQuantize: String, CaseIterable, Identifiable {
    case bar
    case beat
    case off

    var id: String { rawValue }

    var title: String {
        switch self {
        case .bar: return L("小節", "Bar")
        case .beat: return L("拍", "Beat")
        case .off: return L("オフ", "Off")
        }
    }

    func apply(_ bar: Double) -> Double {
        switch self {
        case .bar: return bar.rounded()
        case .beat: return (bar * 4).rounded() / 4
        case .off: return bar
        }
    }
}

// MARK: - Waveform painting

enum WavePainter {
    /// Draws the waveform between source times s0...s1 into rect (two layers: full band and lows).
    static func draw(_ ctx: GraphicsContext, rect: CGRect, waveform wf: Waveform, from s0: Double, to s1: Double, color: Color) {
        let width = Int(rect.width)
        guard s1 > s0, width > 1, !wf.peaks.isEmpty else { return }
        let count = wf.peaks.count
        let mid = rect.midY
        let half = rect.height / 2 * 0.95
        let norm = 1 / wf.maxPeak
        var tops: [CGPoint] = []
        var lows: [CGPoint] = []
        tops.reserveCapacity(width + 1)
        lows.reserveCapacity(width + 1)
        wf.peaks.withUnsafeBufferPointer { peaks in
            wf.lows.withUnsafeBufferPointer { lowBins in
                for px in 0...width {
                    let a = s0 + (s1 - s0) * Double(px) / Double(width)
                    let b = s0 + (s1 - s0) * Double(px + 1) / Double(width)
                    let x = rect.minX + CGFloat(px)
                    var b0 = Int(a * wf.binsPerSecond)
                    var b1 = Int(b * wf.binsPerSecond)
                    if b1 <= 0 || b0 >= count {
                        tops.append(CGPoint(x: x, y: mid))
                        lows.append(CGPoint(x: x, y: mid))
                        continue
                    }
                    b0 = max(0, b0)
                    b1 = min(count, max(b0 + 1, b1))
                    var p: Float = 0
                    var l: Float = 0
                    var i = b0
                    while i < b1 {
                        if peaks[i] > p { p = peaks[i] }
                        if lowBins[i] > l { l = lowBins[i] }
                        i += 1
                    }
                    tops.append(CGPoint(x: x, y: mid - CGFloat(min(1, p * norm)) * half))
                    lows.append(CGPoint(x: x, y: mid - CGFloat(min(1, l * norm)) * half))
                }
            }
        }
        func mirrored(_ pts: [CGPoint]) -> Path {
            var path = Path()
            guard let first = pts.first else { return path }
            path.move(to: first)
            for pt in pts.dropFirst() { path.addLine(to: pt) }
            for pt in pts.reversed() { path.addLine(to: CGPoint(x: pt.x, y: mid + (mid - pt.y))) }
            path.closeSubpath()
            return path
        }
        ctx.fill(mirrored(tops), with: .color(color.opacity(0.45)))
        ctx.fill(mirrored(lows), with: .color(color))
    }
}

// MARK: - Editor

struct CueEditorView: View {
    @Environment(MixStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State var clipID: UUID
    @State private var preview = CuePreview()
    @State private var quantize: CueQuantize = .bar
    @State private var syncToMaster = false
    @State private var notice: String?
    @FocusState private var focused: Bool

    var body: some View {
        Group {
            if let clip = store.clip(clipID) {
                editor(clip)
            } else {
                VStack(spacing: 12) {
                    Text(L("曲が見つかりません", "Track not found"))
                    Button(L("閉じる", "Close")) { dismiss() }
                }
                .padding(40)
            }
        }
        .frame(width: 1080, height: 760)
        .background(Theme.background)
        .preferredColorScheme(.dark)
        .onDisappear { preview.pause() }
    }

    // MARK: Layout

    private func editor(_ clip: Clip) -> some View {
        let waveform = store.waveforms[clip.url]
        let mixIndex = store.index(of: clip.id)
        let next: Clip? = mixIndex.flatMap { $0 + 1 < store.clips.count ? store.clips[$0 + 1] : nil }
        let prev: Clip? = mixIndex.flatMap { $0 > 0 ? store.clips[$0 - 1] : nil }

        return VStack(spacing: 0) {
            header(clip, mixIndex: mixIndex)
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            Divider()

            VStack(spacing: 10) {
                CueOverview(clip: clip, waveform: waveform, position: preview.position,
                            outgoingBars: next?.transitionBars, aiCues: store.aiCues(for: clip)) { s in
                    preview.seek(s, clip: clip, master: store.masterBPM, sync: syncToMaster)
                }
                .frame(height: 54)

                CueDetail(clip: clip, waveform: waveform, position: preview.position,
                          outgoingBars: next?.transitionBars, preview: preview,
                          onSeek: { s in preview.seek(s, clip: clip, master: store.masterBPM, sync: syncToMaster) },
                          onResume: { s in preview.play(clip, master: store.masterBPM, sync: syncToMaster, from: s) })
                .frame(minHeight: 200, maxHeight: .infinity)

                transport(clip)
            }
            .frame(maxHeight: .infinity)
            .padding(.horizontal, 20)
            .padding(.top, 14)

            if let notice {
                Label(notice, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .padding(.top, 6)
            }

            HStack(alignment: .top, spacing: 12) {
                CueTile(title: L("IN（入口）", "IN (mix-in)"),
                        subtitle: L("この曲が入り始める位置", "Where this track starts"),
                        key: "I", color: .green, value: clip.mixInBar,
                        info: prev.map { L("前の曲「\($0.title)」の OUT で入ります", "Enters at the OUT of “\($0.title)”") },
                        onSet: { setIn(clip) },
                        onPlay: { play(clip, fromBar: clip.mixInBar) },
                        onNudge: { d in store.setMixIn(clip.id, bar: clip.mixInBar + d) })
                CueTile(title: L("切替完了", "Switch done"),
                        subtitle: L("前の曲が消えて、この曲だけになる位置", "Where only this track remains"),
                        key: "L", color: .purple, value: clip.landingBar,
                        info: prev == nil
                            ? L("前の曲がないので使いません（2曲目以降で設定）", "Not used: there is no previous track")
                            : clip.transitionBars > 0.01
                            ? L("入口の \(Fmt.bars(clip.transitionBars)) 後", "\(Fmt.bars(clip.transitionBars)) after the mix-in")
                            : L("つなぎの長さを選ぶと入口が自動で決まります", "Picking a length places the mix-in automatically"),
                        onSet: { setLanding(clip) },
                        onPlay: { play(clip, fromBar: clip.landingBar) },
                        onNudge: { d in store.setLandingBar(clip.id, bar: clip.landingBar + d) },
                        extra: AnyView(
                            Toggle(L("長さを変えてもここを保つ", "Keep when length changes"),
                                   isOn: Binding(get: { clip.keepsLanding }, set: { store.setLandingLock(clip.id, $0) }))
                                .toggleStyle(.checkbox)
                                .font(.caption)
                                .disabled(prev == nil)
                        ))
                        .opacity(prev == nil ? 0.5 : 1)
                        .allowsHitTesting(prev != nil)
                CueTile(title: L("OUT（出口）", "OUT (mix-out)"),
                        subtitle: L("次の曲へのつなぎが始まる位置", "Where the next transition begins"),
                        key: "O", color: .orange, value: clip.mixOutBar,
                        info: next.map { n in
                            n.transitionBars < 0.01
                                ? L("ここで「\(n.title)」に切り替え", "Switches to “\(n.title)” here")
                                : L("ここから「\(n.title)」と \(Fmt.bars(n.transitionBars)) 重なる", "Overlaps “\(n.title)” for \(Fmt.bars(n.transitionBars))")
                        },
                        onSet: { setOut(clip) },
                        onPlay: { play(clip, fromBar: clip.mixOutBar - 4) },
                        playLabel: L("4小節前から", "From −4 bars"),
                        onNudge: { d in store.setMixOut(clip.id, bar: clip.mixOutBar + d) })
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)

            memoStrip(clip)
                .padding(.horizontal, 20)
                .padding(.top, 10)

            Color.clear.frame(height: 12)
            Divider()
            footer(clip)
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
        }
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onAppear {
            focused = true
            // Start at the mix-in so the cue being edited is in view.
            if preview.position == 0 {
                preview.position = max(0, clip.sourceTime(bar: clip.mixInBar))
            }
        }
        .onKeyPress(phases: .down) { press in
            handleKey(press, clip: clip)
        }
    }

    private func header(_ clip: Clip, mixIndex: Int?) -> some View {
        let order = store.allTrackIDs
        let index = order.firstIndex(of: clip.id) ?? 0
        return HStack(alignment: .center, spacing: 12) {
            RoundedRectangle(cornerRadius: 3)
                .fill(Color.clip(clip.colorIndex))
                .frame(width: 6, height: 38)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(clip.title)
                        .font(.title3.bold())
                        .lineLimit(1)
                    if let i = mixIndex {
                        badge(L("ミックス \(i + 1)曲目", "Mix track \(i + 1)"), color: .accentColor)
                    } else {
                        badge(L("ライブラリ", "Library"), color: .gray)
                    }
                }
                Text("\(clip.artist.isEmpty ? clip.url.lastPathComponent : clip.artist) · \(Fmt.bpm(clip.bpm)) BPM · \(Fmt.duration(clip.duration))")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            HStack(spacing: 6) {
                Button { go(to: order[index - 1]) } label: { Image(systemName: "chevron.left") }
                    .disabled(index == 0)
                    .help(L("前の曲", "Previous track"))
                Text("\(index + 1) / \(order.count)")
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 44)
                Button { go(to: order[index + 1]) } label: { Image(systemName: "chevron.right") }
                    .disabled(index >= order.count - 1)
                    .help(L("次の曲", "Next track"))
            }
            .controlSize(.large)
            Button(L("完了", "Done")) {
                preview.pause()
                dismiss()
            }
            .keyboardShortcut(.defaultAction)
            .controlSize(.large)
            .padding(.leading, 8)
        }
    }

    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.25)))
    }

    /// Transport centred under the waveform, like a DJ deck.
    private func transport(_ clip: Clip) -> some View {
        let positionBar = clip.bar(atSource: preview.position)
        return ZStack {
            // Left: position readout
            HStack {
                VStack(alignment: .leading, spacing: 0) {
                    Text(L("小節 ", "Bar ") + barBeatLabel(positionBar))
                        .font(Typo.readout(18, .regular))
                    Text(Fmt.clock(preview.position))
                        .font(Typo.readout(11, .regular))
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            // Centre: transport
            HStack(spacing: 10) {
                transportButton("backward.fill", L("4小節戻る（⇧←）", "Back 4 bars (⇧←)")) { moveBars(clip, -4) }
                transportButton("backward.frame.fill", L("1小節戻る（←）", "Back 1 bar (←)")) { moveBars(clip, -1) }
                Button { togglePlay(clip) } label: {
                    Image(systemName: preview.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 22, weight: .semibold))
                        .frame(width: 58, height: 58)
                        .background(Circle().fill(preview.isPlaying ? Color.orange : Color.accentColor))
                        .foregroundStyle(.white)
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.space, modifiers: [])
                .help(L("再生 / 一時停止（Space）", "Play / pause (Space)"))
                transportButton("forward.frame.fill", L("1小節進む（→）", "Forward 1 bar (→)")) { moveBars(clip, 1) }
                transportButton("forward.fill", L("4小節進む（⇧→）", "Forward 4 bars (⇧→)")) { moveBars(clip, 4) }
            }
            // Right: options
            HStack {
                Spacer()
                VStack(alignment: .trailing, spacing: 6) {
                    HStack(spacing: 6) {
                        Text(L("CUEを揃える", "Snap cues to")).font(.caption).foregroundStyle(.secondary)
                        Picker("", selection: $quantize) {
                            ForEach(CueQuantize.allCases) { q in Text(q.title).tag(q) }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .frame(width: 140)
                    }
                    Toggle(L("BPM \(Fmt.bpm(store.masterBPM)) で聴く", "Play at \(Fmt.bpm(store.masterBPM)) BPM"), isOn: $syncToMaster)
                        .toggleStyle(.checkbox)
                        .font(.caption)
                        .help(L("ミックスのマスターBPMに合わせた速さで再生します", "Play at the mix’s master BPM"))
                        .onChange(of: syncToMaster) {
                            if preview.isPlaying {
                                preview.play(clip, master: store.masterBPM, sync: syncToMaster, from: preview.position)
                            }
                        }
                }
            }
        }
        .frame(height: 62)
    }

    private func transportButton(_ symbol: String, _ help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .semibold))
                .frame(width: 40, height: 40)
                .background(Circle().fill(Color.primary.opacity(0.1)))
        }
        .buttonStyle(.plain)
        .help(help)
    }

    private func memoStrip(_ clip: Clip) -> some View {
        HStack(spacing: 8) {
            Button { addMemo(clip) } label: {
                Label(L("メモCUEを追加（M）", "Add memo cue (M)"), systemImage: "bookmark")
            }
            .help(L("ドロップやブレイクの頭に目印を付けておくと、IN / OUT を選ぶ時に使えます", "Mark drops and breakdowns to use them as IN / OUT later"))
            let ai = store.aiCues(for: clip)
            if !ai.isEmpty {
                Menu {
                    ForEach(ai, id: \.self) { cue in
                        Menu("◆ \(Clip.barLabel(cue.bar))" + L("小節目", "")) {
                            Button(L("ここから再生", "Play from here")) { play(clip, fromBar: cue.bar) }
                            Divider()
                            Button(L("IN にする", "Use as IN")) { store.setMixIn(clip.id, bar: cue.bar) }
                            Button(L("切替完了にする", "Use as switch point")) { store.setLandingBar(clip.id, bar: cue.bar) }
                            Button(L("OUT にする", "Use as OUT")) { store.setMixOut(clip.id, bar: cue.bar) }
                        }
                    }
                } label: {
                    Label(L("AIのCUE候補 \(ai.count)", "AI cues \(ai.count)"), systemImage: "diamond.fill")
                }
                .fixedSize()
                .tint(.yellow)
                .help(L("プロDJの CUE を学習した AI が選んだ位置（波形の上の ◆）", "Positions chosen by an AI trained on pro DJs' cues (◆ above the waveform)"))
            }
            if clip.cueList.isEmpty {
                Text(L("目印はまだありません", "No markers yet"))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(clip.cueList) { cue in
                            Menu {
                                Button(L("ここから再生", "Play from here")) { play(clip, fromBar: cue.bar) }
                                Divider()
                                Button(L("IN にする", "Use as IN")) { store.setMixIn(clip.id, bar: cue.bar) }
                                Button(L("切替完了にする", "Use as switch point")) { store.setLandingBar(clip.id, bar: cue.bar) }
                                Button(L("OUT にする", "Use as OUT")) { store.setMixOut(clip.id, bar: cue.bar) }
                                Divider()
                                Button(L("削除", "Delete"), role: .destructive) { store.removeCue(clip.id, cue: cue.id) }
                            } label: {
                                Label("\(cue.label) · \(Clip.barLabel(cue.bar))", systemImage: "bookmark.fill")
                            } primaryAction: {
                                play(clip, fromBar: cue.bar)
                            }
                            .menuStyle(.button)
                            .fixedSize()
                            .tint(.teal)
                        }
                    }
                }
            }
            Spacer()
            Button {
                store.useWholeTrack(clip.id)
            } label: {
                Label(L("曲全体を使う", "Use whole track"), systemImage: "arrow.left.and.right")
            }
            .help(L("IN を曲の頭、OUT を曲の最後に戻します", "Reset IN to the start and OUT to the end"))
        }
        .controlSize(.regular)
    }

    private func footer(_ clip: Clip) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "keyboard").foregroundStyle(.tertiary)
            Text(L("Space 再生・停止　I 入口　L 切替完了　O 出口　M メモ　←→ 1小節（⇧ 4小節）　波形をドラッグで移動",
                   "Space play/stop · I in · L switch · O out · M memo · ←→ 1 bar (⇧ 4) · drag waveform to scrub"))
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            if !store.isInMix(clip.id) {
                Button {
                    store.addToMix(clip.id)
                } label: {
                    Label(L("ミックスに入れる", "Add to Mix"), systemImage: "plus.rectangle.on.rectangle")
                }
            }
        }
    }

    // MARK: Actions

    private func barBeatLabel(_ bar: Double) -> String {
        let beats = Int(floor(bar * 4 + 1e-6))
        let barNumber = Int(floor(Double(beats) / 4)) + 1
        let beat = ((beats % 4) + 4) % 4 + 1
        return "\(barNumber).\(beat)"
    }

    private func togglePlay(_ clip: Clip) {
        if preview.isPlaying {
            preview.pause()
        } else {
            store.pause()
            preview.play(clip, master: store.masterBPM, sync: syncToMaster, from: preview.position)
        }
    }

    private func play(_ clip: Clip, fromBar bar: Double) {
        store.pause()
        preview.play(clip, master: store.masterBPM, sync: syncToMaster, from: max(0, clip.sourceTime(bar: bar)))
    }

    private func jump(_ clip: Clip, toBar bar: Double) {
        preview.seek(max(0, clip.sourceTime(bar: bar)), clip: clip, master: store.masterBPM, sync: syncToMaster)
    }

    private func moveBars(_ clip: Clip, _ bars: Double) {
        let target = quantize == .off ? clip.bar(atSource: preview.position) + bars
                                      : CueQuantize.bar.apply(clip.bar(atSource: preview.position)) + bars
        jump(clip, toBar: target)
    }

    private func setIn(_ clip: Clip) {
        let bar = quantize.apply(clip.bar(atSource: preview.position))
        if bar >= clip.mixOutBar && store.index(of: clip.id).map({ $0 + 1 < store.clips.count }) == true {
            notice = L("IN が OUT より後ろになっています。OUT も動かしてください。", "IN is after OUT — move OUT as well.")
        } else {
            notice = nil
        }
        store.setMixIn(clip.id, bar: bar)
    }

    private func setOut(_ clip: Clip) {
        let bar = quantize.apply(clip.bar(atSource: preview.position))
        if bar <= clip.mixInBar {
            notice = L("OUT は IN より後ろに置いてください。", "Put OUT after IN.")
            return
        }
        notice = nil
        store.setMixOut(clip.id, bar: bar)
    }

    private func setLanding(_ clip: Clip) {
        let bar = quantize.apply(clip.bar(atSource: preview.position))
        notice = nil
        store.setLandingBar(clip.id, bar: bar)
    }

    private func addMemo(_ clip: Clip) {
        store.addCue(clip.id, bar: quantize.apply(clip.bar(atSource: preview.position)))
    }

    private func go(to id: UUID) {
        preview.pause()
        notice = nil
        clipID = id
        store.selectedClipID = id
        if let c = store.clip(id) {
            preview.position = max(0, c.sourceTime(bar: c.mixInBar))
        }
    }

    private func handleKey(_ press: KeyPress, clip: Clip) -> KeyPress.Result {
        let shift = press.modifiers.contains(.shift)
        switch press.key {
        case .leftArrow:
            moveBars(clip, shift ? -4 : -1)
            return .handled
        case .rightArrow:
            moveBars(clip, shift ? 4 : 1)
            return .handled
        default:
            break
        }
        switch press.characters.lowercased() {
        case "i":
            setIn(clip)
            return .handled
        case "o":
            setOut(clip)
            return .handled
        case "m":
            addMemo(clip)
            return .handled
        case "l":
            setLanding(clip)
            return .handled
        default:
            return .ignored
        }
    }
}

/// One cue point (IN / switch / OUT): what it is, where it is, and how to set it.
private struct CueTile: View {
    let title: String
    let subtitle: String
    let key: String
    let color: Color
    let value: Double
    let info: String?
    let onSet: () -> Void
    let onPlay: () -> Void
    var playLabel: String = L("ここから試聴", "Play from here")
    let onNudge: (Double) -> Void
    var extra: AnyView? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.headline)
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text(Fmt.barOrdinal(value))
                    .font(Typo.readout(18, .regular))
                    .foregroundStyle(color)
            }

            Button(action: onSet) {
                HStack {
                    Image(systemName: "scope")
                    Text(L("再生位置にセット", "Set at playhead"))
                    Spacer()
                    Text(L("キー ", "Key ") + key)
                        .font(.system(size: 11, weight: .semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.25)))
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(color)
            .controlSize(.large)

            HStack(spacing: 4) {
                Button(action: onPlay) {
                    Label(playLabel, systemImage: "play.fill")
                }
                Spacer(minLength: 4)
                Button("−1") { onNudge(-1) }.help(L("1小節前へ", "1 bar earlier"))
                Button("+1") { onNudge(1) }.help(L("1小節後ろへ", "1 bar later"))
                Button { onNudge(-0.25) } label: { Image(systemName: "chevron.left") }.help(L("1拍前へ", "1 beat earlier"))
                Button { onNudge(0.25) } label: { Image(systemName: "chevron.right") }.help(L("1拍後ろへ", "1 beat later"))
            }
            .controlSize(.small)

            if let extra { extra }
            if let info {
                Text(info)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.05)))
        .overlay(alignment: .top) {
            UnevenRoundedRectangle(topLeadingRadius: 10, topTrailingRadius: 10)
                .fill(color)
                .frame(height: 3)
        }
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(color.opacity(0.3)))
    }
}

// MARK: - Overview (whole track)

private struct CueOverview: View {
    let clip: Clip
    let waveform: Waveform?
    let position: Double
    let outgoingBars: Double?
    var aiCues: [CueBar] = []
    let onSeek: (Double) -> Void

    var body: some View {
        GeometryReader { geo in
            Canvas { ctx, size in
                let duration = max(clip.duration, 0.1)
                func x(_ s: Double) -> CGFloat { CGFloat(s / duration) * size.width }
                let rect = CGRect(origin: .zero, size: size)
                ctx.fill(Path(roundedRect: rect, cornerRadius: 6), with: .color(.black.opacity(0.35)))
                if let waveform {
                    WavePainter.draw(ctx, rect: rect.insetBy(dx: 0, dy: 4), waveform: waveform,
                                     from: 0, to: duration, color: Color.clip(clip.colorIndex))
                }
                let sIn = max(0, clip.sourceTime(bar: clip.mixInBar))
                let sOut = clip.sourceTime(bar: clip.mixOutBar)
                let sEnd = min(duration, clip.sourceTime(bar: clip.mixOutBar + (outgoingBars ?? 0)))
                // Dim the parts that are not played
                ctx.fill(Path(CGRect(x: 0, y: 0, width: x(sIn), height: size.height)), with: .color(.black.opacity(0.55)))
                if outgoingBars != nil {
                    ctx.fill(Path(CGRect(x: x(sEnd), y: 0, width: size.width - x(sEnd), height: size.height)), with: .color(.black.opacity(0.55)))
                    ctx.fill(Path(CGRect(x: x(sOut), y: 0, width: max(1, x(sEnd) - x(sOut)), height: 4)), with: .color(.orange))
                }
                // 8-bar lines
                if clip.bpm > 0 {
                    let barPx = Double(x(clip.barSource))
                    let step = barPx * 8 >= 40 ? 8.0 : 16.0
                    var b = ceil(clip.bar(atSource: 0) / step) * step
                    while clip.sourceTime(bar: b) < duration {
                        let px = x(clip.sourceTime(bar: b))
                        ctx.fill(Path(CGRect(x: px, y: size.height - 8, width: 1, height: 8)), with: .color(.white.opacity(0.35)))
                        ctx.draw(Text(Clip.barLabel(b)).font(Typo.readout(8, .regular)).foregroundStyle(.white.opacity(0.5)),
                                 at: CGPoint(x: px + 2, y: size.height - 12), anchor: .leading)
                        b += step
                    }
                }
                for cue in clip.cueList {
                    let px = x(clip.sourceTime(bar: cue.bar))
                    ctx.fill(Path(CGRect(x: px - 0.5, y: 0, width: 1.5, height: size.height)), with: .color(.teal))
                }
                // AI cue suggestions: small diamonds along the top edge.
                for cue in aiCues {
                    let px = x(clip.sourceTime(bar: cue.bar))
                    var d = Path()
                    d.move(to: CGPoint(x: px, y: 1)); d.addLine(to: CGPoint(x: px + 4, y: 5))
                    d.addLine(to: CGPoint(x: px, y: 9)); d.addLine(to: CGPoint(x: px - 4, y: 5)); d.closeSubpath()
                    ctx.fill(d, with: .color(Color(hue: 0.13, saturation: 0.75, brightness: 1).opacity(0.45 + 0.55 * cue.score)))
                }
                marker(ctx, x: x(sIn), height: size.height, color: .green, label: "IN")
                if clip.keepsLanding || clip.transitionBars > 0.01 {
                    marker(ctx, x: x(clip.sourceTime(bar: clip.landingBar)), height: size.height, color: .purple, label: L("切替", "SW"))
                }
                marker(ctx, x: x(sOut), height: size.height, color: .orange, label: "OUT")
                let px = x(position)
                ctx.fill(Path(CGRect(x: px - 1, y: 0, width: 2, height: size.height)), with: .color(Color(nsColor: Theme.playhead)))
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { v in
                onSeek(Double(min(max(0, v.location.x), geo.size.width) / geo.size.width) * clip.duration)
            })
        }
        .help(L("曲全体。クリック・ドラッグで移動", "Whole track. Click or drag to jump"))
    }

    private func marker(_ ctx: GraphicsContext, x: CGFloat, height: CGFloat, color: Color, label: String) {
        ctx.fill(Path(CGRect(x: x - 1, y: 0, width: 2, height: height)), with: .color(color))
        ctx.draw(Text(label).font(Typo.label(9)).tracking(Typo.labelTracking).foregroundStyle(color),
                 at: CGPoint(x: x + 3, y: 7), anchor: .leading)
    }
}

// MARK: - Detail (scrolling, playhead fixed in the centre)

private struct CueDetail: View {
    let clip: Clip
    let waveform: Waveform?
    let position: Double
    let outgoingBars: Double?
    let preview: CuePreview
    let onSeek: (Double) -> Void
    let onResume: (Double) -> Void

    @State private var dragStart: Double?
    @State private var wasPlaying = false

    private var windowBars: Double { 16 }

    var body: some View {
        GeometryReader { geo in
            let window = windowBars * clip.barSource
            Canvas { ctx, size in
                let s0 = position - window / 2
                let s1 = position + window / 2
                func x(_ s: Double) -> CGFloat { CGFloat((s - s0) / window) * size.width }
                let rect = CGRect(origin: .zero, size: size)
                ctx.fill(Path(roundedRect: rect, cornerRadius: 8), with: .color(.black.opacity(0.4)))

                let sIn = clip.sourceTime(bar: clip.mixInBar)
                let sOut = clip.sourceTime(bar: clip.mixOutBar)

                // Beat grid
                if clip.bpm > 0 {
                    let beat = clip.barSource / 4
                    var k = ceil((s0 - clip.firstBeat) / beat)
                    while clip.firstBeat + k * beat < s1 {
                        let s = clip.firstBeat + k * beat
                        let isBar = Int(k) % 4 == 0
                        let px = x(s)
                        ctx.fill(Path(CGRect(x: px, y: 0, width: 1, height: size.height)),
                                 with: .color(.white.opacity(isBar ? 0.16 : 0.05)))
                        if isBar {
                            ctx.draw(Text(Clip.barLabel(k / 4)).font(Typo.readout(10))
                                        .foregroundStyle(.white.opacity(0.6)),
                                     at: CGPoint(x: px + 3, y: size.height - 9), anchor: .leading)
                        }
                        k += 1
                    }
                }

                if let waveform {
                    WavePainter.draw(ctx, rect: rect.insetBy(dx: 0, dy: 18), waveform: waveform,
                                     from: s0, to: s1, color: Color.clip(clip.colorIndex))
                }

                // Unplayed areas and the outgoing transition
                if sIn > s0 {
                    ctx.fill(Path(CGRect(x: 0, y: 0, width: x(sIn), height: size.height)), with: .color(.black.opacity(0.5)))
                }
                if let bars = outgoingBars {
                    let sEnd = clip.sourceTime(bar: clip.mixOutBar + bars)
                    if sEnd < s1 {
                        ctx.fill(Path(CGRect(x: x(sEnd), y: 0, width: size.width - x(sEnd), height: size.height)),
                                 with: .color(.black.opacity(0.5)))
                    }
                    if bars > 0.01 {
                        ctx.fill(Path(CGRect(x: x(sOut), y: 0, width: x(sEnd) - x(sOut), height: 5)), with: .color(.orange.opacity(0.9)))
                    }
                }

                for cue in clip.cueList {
                    flag(ctx, x: x(clip.sourceTime(bar: cue.bar)), height: size.height, color: .teal, label: cue.label)
                }
                flag(ctx, x: x(sIn), height: size.height, color: .green, label: "IN " + Clip.barLabel(clip.mixInBar))
                if clip.keepsLanding || clip.transitionBars > 0.01 {
                    let sLand = clip.sourceTime(bar: clip.landingBar)
                    if clip.transitionBars > 0.01 {
                        ctx.fill(Path(CGRect(x: x(sIn), y: size.height - 22, width: x(sLand) - x(sIn), height: 4)),
                                 with: .color(.purple.opacity(0.8)))
                    }
                    flag(ctx, x: x(sLand), height: size.height, color: .purple, label: L("切替 ", "SW ") + Clip.barLabel(clip.landingBar))
                }
                flag(ctx, x: x(sOut), height: size.height, color: .orange, label: "OUT " + Clip.barLabel(clip.mixOutBar))

                // Playhead
                let center = size.width / 2
                ctx.fill(Path(CGRect(x: center - 1, y: 0, width: 2, height: size.height)), with: .color(Color(nsColor: Theme.playhead)))
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { v in
                        if dragStart == nil {
                            dragStart = position
                            wasPlaying = preview.isPlaying
                            preview.pause()
                        }
                        let delta = -Double(v.translation.width / geo.size.width) * window
                        preview.position = min(max(0, (dragStart ?? position) + delta), clip.duration)
                    }
                    .onEnded { v in
                        var target = preview.position
                        if abs(v.translation.width) < 3, let start = dragStart {
                            // A click: jump to the clicked spot
                            target = start + Double((v.location.x - geo.size.width / 2) / geo.size.width) * window
                        }
                        dragStart = nil
                        if wasPlaying {
                            onResume(target)
                        } else {
                            onSeek(target)
                        }
                    }
            )
        }
        .help(L("ドラッグでスクラッチのように移動、クリックでその位置へ", "Drag to scrub, click to jump"))
    }

    private func flag(_ ctx: GraphicsContext, x: CGFloat, height: CGFloat, color: Color, label: String) {
        ctx.fill(Path(CGRect(x: x - 1, y: 0, width: 2, height: height)), with: .color(color))
        let text = Text(label).font(.system(size: 10, weight: .semibold)).foregroundStyle(.black)
        let resolved = ctx.resolve(text)
        let size = resolved.measure(in: CGSize(width: 200, height: 20))
        let box = CGRect(x: x, y: 4, width: size.width + 8, height: 16)
        ctx.fill(Path(roundedRect: box, cornerRadius: 3), with: .color(color))
        ctx.draw(resolved, at: CGPoint(x: box.minX + 4, y: box.midY), anchor: .leading)
    }
}
