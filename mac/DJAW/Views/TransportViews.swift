import SwiftUI

struct TransportBar: View {
    @Environment(MixStore.self) private var store

    var body: some View {
        HStack(spacing: 10) {
            Button {
                store.seek(0)
                store.requestScroll(to: 0)
            } label: {
                Image(systemName: "backward.end.fill")
            }
            .help(L("先頭へ（Home）", "Go to start (Home)"))

            Button {
                store.togglePlay()
            } label: {
                Image(systemName: store.isPlaying ? "pause.fill" : "play.fill")
                    .frame(width: 16)
            }
            .help(L("再生 / 一時停止（Space）", "Play / pause (Space)"))
            .disabled(store.clips.isEmpty)

            TimeReadout()

            Divider().frame(height: 22)

            MasterBPMField()
        }
        .padding(.horizontal, 6)
    }
}

struct TimeReadout: View {
    @Environment(MixStore.self) private var store

    var body: some View {
        let position = store.grid.position(store.playhead)
        VStack(alignment: .leading, spacing: -1) {
            Text(Fmt.clock(store.tempoMap.real(store.playhead)))
                .font(Typo.readout(14))
            Text(L("小節 \(position.bar).\(position.beat)", "Bar \(position.bar).\(position.beat)"))
                .font(Typo.readout(10))
                .foregroundStyle(.secondary)
        }
        .frame(width: 92, height: 30, alignment: .leading)
        .fixedSize()
        .help(L("再生位置（時間 / ミックス全体の小節.拍）", "Playhead (time / bar.beat of the mix)"))
    }
}

struct MasterBPMField: View {
    @Environment(MixStore.self) private var store
    var compact = false

    var body: some View {
        let map = store.tempoMap
        let changes = map.hasChanges
        let binding = Binding(get: { changes ? (map.bpm(at: store.playhead) * 100).rounded() / 100 : store.masterBPM },
                              set: { store.setTempo(atTime: store.playhead, $0) })
        HStack(spacing: 4) {
            if !compact {
                Text("BPM")
                    .font(Typo.label(10))
                    .foregroundStyle(changes ? Color.accentColor : .secondary)
            }
            TextField("BPM", value: binding, format: .number.precision(.fractionLength(0...2)))
                .textFieldStyle(.roundedBorder)
                .frame(width: 64)
                .multilineTextAlignment(.trailing)
                .font(Typo.readout(12))
            Stepper("BPM", value: binding, in: 40...220, step: 1)
                .labelsHidden()
        }
        .help(changes
              ? L("再生位置でのミックスBPM。途中でテンポが変わるミックスでは、いまの区間のテンポを変更します", "Mix BPM at the playhead. In a mix with tempo changes, this edits the current section")
              : L("ミックスBPM — テンポを合わせた曲はこの速さで再生されます", "Mix BPM — synced tracks play at this tempo"))
    }
}

struct SnapPicker: View {
    @Environment(MixStore.self) private var store

    var body: some View {
        @Bindable var store = store
        Menu {
            Picker(L("ドラッグの単位", "Drag Step"), selection: $store.snap) {
                ForEach(SnapUnit.allCases) { unit in
                    Text(unit.title).tag(unit)
                }
            }
            .pickerStyle(.inline)
        } label: {
            Label(L("単位: \(store.snap.title)", "Step: \(store.snap.title)"), systemImage: "squareshape.split.3x3")
                .labelStyle(.titleAndIcon)
        }
        .help(L("タイムラインでドラッグした時に出口・入口・長さが動く単位（⌥を押すと1拍単位）", "How far mix points and lengths move when dragging on the timeline (hold ⌥ for 1 beat)"))
    }
}

/// Whole-mix overview. Click or drag to jump the timeline there.
struct OverviewStrip: View {
    @Environment(MixStore.self) private var store

    var body: some View {
        let clips = store.clips
        let master = store.masterBPM
        let duration = max(store.mixDuration, 1)
        let visible = store.visibleRange
        let playhead = store.playhead
        let selected = store.selectedClipID

        GeometryReader { geo in
            let inset: CGFloat = 10
            let width = max(1, geo.size.width - inset * 2)
            Canvas { ctx, size in
                func x(_ t: Double) -> CGFloat { inset + CGFloat(t / duration) * width }
                let laneH = (size.height - 14) / 2
                if clips.isEmpty {
                    ctx.draw(Text(L("ミックス全体マップ", "Mix overview")).font(.caption).foregroundStyle(.tertiary),
                             at: CGPoint(x: size.width / 2, y: size.height / 2))
                    return
                }
                for (i, clip) in clips.enumerated() {
                    let rect = CGRect(x: x(clip.start),
                                      y: 7 + CGFloat(i % 2) * laneH,
                                      width: max(2, x(clip.end(master: master)) - x(clip.start)),
                                      height: laneH - 2)
                    let color = Color.clip(clip.colorIndex)
                    ctx.fill(Path(roundedRect: rect, cornerRadius: 3),
                             with: .color(color.opacity(clip.id == selected ? 0.95 : 0.55)))
                }
                let viewport = CGRect(x: x(visible.lowerBound), y: 2,
                                      width: max(4, x(min(visible.upperBound, duration)) - x(visible.lowerBound)),
                                      height: size.height - 4)
                ctx.fill(Path(roundedRect: viewport, cornerRadius: 4), with: .color(.white.opacity(0.06)))
                ctx.stroke(Path(roundedRect: viewport, cornerRadius: 4), with: .color(.white.opacity(0.55)), lineWidth: 1)
                var line = Path()
                line.move(to: CGPoint(x: x(playhead), y: 0))
                line.addLine(to: CGPoint(x: x(playhead), y: size.height))
                ctx.stroke(line, with: .color(Color(nsColor: Theme.playhead)), lineWidth: 1.5)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let t = Double((value.location.x - inset) / width) * duration
                        store.requestScroll(to: min(max(0, t), duration))
                    }
            )
        }
        .background(Theme.panel)
        .help(L("ミックス全体。クリック・ドラッグで表示位置を移動", "Whole mix. Click or drag to jump the timeline"))
    }
}
