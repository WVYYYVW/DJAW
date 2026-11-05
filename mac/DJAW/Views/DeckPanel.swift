import SwiftUI

/// Visual-only "hardware" view: two turntables and a DJ mixer whose knobs,
/// kill lamps, channel faders and crossfader move by themselves, driven by the
/// same automation that renders the mix. Follows the playhead (also while scrubbing).
struct DeckPanel: View {
    @Environment(MixStore.self) private var store

    /// Height of the deck strip for the given space: ~42 % of it, clamped so the
    /// mixer always fits and the timeline keeps at least 200 pt.
    static func height(forAvailable available: CGFloat, mixer: Bool = true) -> CGFloat {
        guard mixer else {
            // Turntables alone need less room; give the timeline more.
            let wanted = min(260, max(160, available * 0.3))
            return max(160, min(wanted, available - 200))
        }
        let wanted = min(330, max(230, available * 0.42))
        return max(230, min(wanted, available - 200))
    }

    struct DeckInfo {
        var clip: Clip?
        var index: Int?
        var active: Bool
        /// The deck's last track has already finished.
        var ended: Bool = false
        var sourceTime: Double
        var state: Automation.State?
        var level: Double
        /// Loop being played right now: pass n of total.
        var loop: (pass: Int, of: Int, bars: Double)? = nil
    }

    var body: some View {
        // Redrawn in step with the display while playing (not with the 60 Hz timer), from the smoothed clock,
        // so the platters turn evenly.
        TimelineView(.animation(minimumInterval: nil, paused: !store.isPlaying)) { context in
            let _ = context.date
            decks(at: store.isPlaying ? store.smoothPlayhead() : store.playhead)
        }
    }

    private func decks(at t: Double) -> some View {
        let a = deckInfo(lane: 0, time: t)
        let b = deckInfo(lane: 1, time: t)
        let tempoNow = store.tempoMap.bpm(at: t)
        return GeometryReader { geo in
            let mixerWidth = min(320, max(270, geo.size.width * 0.28))
            HStack(spacing: 12) {
                TurntableView(side: 0, info: a, playing: store.isPlaying, master: tempoNow)
                if store.showMixer {
                    MixerView(a: a, b: b)
                        .frame(width: mixerWidth)
                        .transition(.opacity.combined(with: .scale(scale: 0.96)))
                }
                TurntableView(side: 1, info: b, playing: store.isPlaying, master: tempoNow)
            }
            .animation(.easeInOut(duration: 0.2), value: store.showMixer)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .background(
            LinearGradient(colors: [Color(white: 0.11), Color(white: 0.075)], startPoint: .top, endPoint: .bottom)
        )
    }

    /// Which track sits on a deck at time t: the one playing, else the next one cued up.
    private func deckInfo(lane: Int, time t: Double) -> DeckInfo {
        let clips = store.clips
        let master = store.masterBPM
        let indices = clips.indices.filter { $0 % 2 == lane }
        var chosen: Int?
        var active = false
        if let playing = indices.first(where: { clips[$0].start <= t && t <= clips[$0].end(master: master) }) {
            chosen = playing
            active = true
        } else if let upcoming = indices.first(where: { clips[$0].start > t }) {
            chosen = upcoming
        } else {
            chosen = indices.last
        }
        guard let i = chosen else {
            return DeckInfo(clip: nil, index: nil, active: false, sourceTime: 0, state: nil, level: 0)
        }
        let clip = clips[i]
        let source: Double
        if active {
            source = clip.sourceTime(timeline: t, master: master)
        } else if clip.start > t {
            source = clip.trimStart
        } else {
            source = clip.trimEnd
        }
        var state: Automation.State?
        var level = 0.0
        if active {
            let s = Automation.state(clips: clips, index: i, time: t, master: master)
            state = s
            // Meters only move while audio is actually playing.
            if store.isPlaying, let wf = store.waveforms[clip.url], !wf.peaks.isEmpty {
                let bin = min(wf.peaks.count - 1, max(0, Int(source * wf.binsPerSecond)))
                level = Double(wf.peaks[bin] / wf.maxPeak) * Double(s.volume)
            }
        }
        let ended = !active && clip.end(master: master) < t
        var info = DeckInfo(clip: clip, index: i, active: active, ended: ended, sourceTime: source, state: state, level: level)
        if active, let l = clip.activeLoop(at: t, master: master) {
            info.loop = (l.pass, l.of, l.edit.bars)
        }
        return info
    }
}

// MARK: - Turntable (jog wheel peeking in from the screen edge, Virtual DJ style)

private struct TurntableView: View {
    static func activeFX(_ fx: FXState) -> [String] {
        var out: [String] = []
        if fx.filter < -0.02 { out.append("LPF") }
        if fx.filter > 0.02 { out.append("HPF") }
        if fx.echo > 0.02 { out.append("ECHO") }
        if fx.reverb > 0.02 { out.append("REVERB") }
        if fx.flanger > 0.02 { out.append("FLANGER") }
        if fx.phaser > 0.02 { out.append("PHASER") }
        if fx.gate > 0.02 { out.append("TRANS") }
        if fx.crush > 0.02 { out.append("CRUSH") }
        if fx.roll > 0.5 { out.append("ROLL") }
        return Array(out.prefix(3))
    }

    @Environment(MixStore.self) private var store
    let side: Int
    let info: DeckPanel.DeckInfo
    let playing: Bool
    let master: Double

    var body: some View {
        let accent = info.clip.map { Color.clip($0.colorIndex) } ?? Color.gray
        let _ = store.artworkRevision
        GeometryReader { geo in
            // Full wheel diameter; only the inner half is on screen.
            let compact = geo.size.width < 190
            let d = max(80, min(geo.size.height - 8, geo.size.width * (compact ? 1.8 : 0.8)))
            let visible = compact ? geo.size.width : d / 2
            HStack(spacing: 0) {
                if side == 0 { wheelSlot(accent, d: d, visible: visible) }
                if !compact {
                    details(accent)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                if side == 1 { wheelSlot(accent, d: d, visible: visible) }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .overlay(alignment: side == 0 ? .topTrailing : .topLeading) {
                // Narrow window: keep just the essentials on top of the wheel.
                if compact, let clip = info.clip {
                    VStack(alignment: side == 0 ? .trailing : .leading, spacing: 2) {
                        Text(L("デッキ ", "DECK ") + (side == 0 ? "A" : "B"))
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(accent)
                        Text(Fmt.bpm(clip.bpm * clip.rate(master: master)))
                            .font(.system(size: 18, weight: .regular))
                            .monospacedDigit()
                    }
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.55)))
                    .padding(8)
                }
            }
        }
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(white: 0.12)))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.white.opacity(0.06)))
    }

    /// A slot `visible` wide holding the wheel, pushed half off the outer edge.
    private func wheelSlot(_ accent: Color, d: CGFloat, visible: CGFloat) -> some View {
        jogWheel(accent)
            .frame(width: d, height: d)
            .frame(width: visible, alignment: side == 0 ? .trailing : .leading)
            .frame(maxHeight: .infinity)
            .clipped()
    }

    private var progress: Double {
        guard let clip = info.clip, clip.duration > 0 else { return 0 }
        return min(1, max(0, info.sourceTime / clip.duration))
    }

    private func jogWheel(_ accent: Color) -> some View {
        let artwork = info.clip.flatMap { store.artwork(for: $0.url) }
        let angle = Angle.degrees(info.sourceTime * 200) // 33⅓ rpm
        // Platter geometry (shared by the layers below).
        func radii(_ size: CGSize) -> (c: CGPoint, r: CGFloat, pr: CGFloat, lr: CGFloat) {
            let r = min(size.width, size.height) / 2 - 6
            let pr = r - 10
            return (CGPoint(x: size.width / 2, y: size.height / 2), r, pr, pr * (artwork == nil ? 0.4 : 0.5))
        }
        return ZStack {
            Canvas { ctx, size in
                let (c, r, pr, lr) = radii(size)
                // Outer ring: track position (like Virtual DJ)
                var ringBG = Path()
                ringBG.addArc(center: c, radius: r, startAngle: .degrees(0), endAngle: .degrees(360), clockwise: false)
                ctx.stroke(ringBG, with: .color(.white.opacity(0.08)), lineWidth: 6)
                var ring = Path()
                ring.addArc(center: c, radius: r, startAngle: .degrees(-90), endAngle: .degrees(-90 + 360 * progress), clockwise: false)
                ctx.stroke(ring, with: .color(accent), style: StrokeStyle(lineWidth: 6, lineCap: .round))

                // Platter
                ctx.fill(Path(ellipseIn: CGRect(x: c.x - pr, y: c.y - pr, width: pr * 2, height: pr * 2)),
                         with: .radialGradient(Gradient(colors: [Color(white: 0.16), Color(white: 0.05)]),
                                               center: c, startRadius: 0, endRadius: pr))
                var groove = pr * 0.94
                while groove > pr * 0.45 {
                    ctx.stroke(Path(ellipseIn: CGRect(x: c.x - groove, y: c.y - groove, width: groove * 2, height: groove * 2)),
                               with: .color(.white.opacity(0.04)), lineWidth: 1)
                    groove -= max(3, pr * 0.05)
                }
                // Rotating spokes so motion is easy to see
                for k in 0..<3 {
                    let a = angle.radians + Double(k) * 2 * .pi / 3
                    var spoke = Path()
                    spoke.move(to: CGPoint(x: c.x + cos(a) * pr * 0.5, y: c.y + sin(a) * pr * 0.5))
                    spoke.addLine(to: CGPoint(x: c.x + cos(a) * pr * 0.92, y: c.y + sin(a) * pr * 0.92))
                    ctx.stroke(spoke, with: .color(.white.opacity(k == 0 ? 0.6 : 0.15)), style: StrokeStyle(lineWidth: k == 0 ? 4 : 2, lineCap: .round))
                }
                if artwork == nil {
                    ctx.fill(Path(ellipseIn: CGRect(x: c.x - lr, y: c.y - lr, width: lr * 2, height: lr * 2)),
                             with: .color(info.clip == nil ? Color(white: 0.22) : accent))
                }
            }
            // Centre label: the cover turning with the record. A rotated image layer is turned by the GPU
            // instead of being redrawn every frame.
            if let artwork {
                GeometryReader { geo in
                    let g = radii(geo.size)
                    Image(decorative: artwork, scale: 1)
                        .resizable()
                        .interpolation(.medium)
                        .aspectRatio(contentMode: .fill)
                        .frame(width: g.lr * 2, height: g.lr * 2)
                        .clipShape(Circle())
                        .rotationEffect(angle)
                        .position(g.c)
                }
            }
            Canvas { ctx, size in
                let (c, _, pr, lr) = radii(size)
                let labelRect = CGRect(x: c.x - lr, y: c.y - lr, width: lr * 2, height: lr * 2)
                if artwork != nil {
                    // A thin ring in the track's colour around the cover.
                    ctx.stroke(Path(ellipseIn: labelRect), with: .color(accent), lineWidth: 3)
                }
                ctx.stroke(Path(ellipseIn: labelRect), with: .color(.black.opacity(0.4)), lineWidth: 2)
                ctx.fill(Path(ellipseIn: CGRect(x: c.x - 4, y: c.y - 4, width: 8, height: 8)), with: .color(Color(white: 0.85)))
                // Glow while playing
                if info.active && playing {
                    ctx.stroke(Path(ellipseIn: CGRect(x: c.x - pr, y: c.y - pr, width: pr * 2, height: pr * 2)),
                               with: .color(accent.opacity(0.5)), lineWidth: 2)
                }
            }
            .allowsHitTesting(false)
        }
    }

    private func details(_ accent: Color) -> some View {
        let align: HorizontalAlignment = side == 0 ? .leading : .trailing
        let frameAlign: Alignment = side == 0 ? .topLeading : .topTrailing
        return VStack(alignment: align, spacing: 6) {
            HStack(spacing: 6) {
                if side == 1 { statusLamp }
                Text("DECK " + (side == 0 ? "A" : "B"))
                    .font(Typo.label(10))
                    .tracking(Typo.labelTracking)
                    .foregroundStyle(accent)
                if side == 0 { statusLamp }
            }
            if let clip = info.clip {
                Text(clip.title)
                    .font(Typo.title(14))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: side == 0 ? .leading : .trailing)
                    .help(clip.title)
                if !clip.artist.isEmpty {
                    Text(clip.artist)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: side == 0 ? .leading : .trailing)
                }
                Spacer(minLength: 2)
                let rate = clip.rate(master: master)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(Fmt.bpm(clip.bpm * rate))
                        .font(Typo.display(30))
                        .monospacedDigit()
                        .foregroundStyle(accent)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    Text("BPM").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                }
                HStack(spacing: 6) {
                    Text(L("ピッチ ", "Pitch ") + Fmt.ratePercent(rate))
                        .font(Typo.readout(11))
                        .foregroundStyle(abs(rate - 1) > 0.08 ? Color.orange : Color.secondary)
                    if clip.keepsKey && abs(rate - 1) > 0.0005 {
                        lamp("KEY LOCK", color: .teal)
                    }
                    if clip.semitoneShift != 0 {
                        lamp(String(format: "KEY %+d", clip.semitoneShift), color: .purple)
                    }
                }
                .lineLimit(1)
                if let fx = info.state?.fx, !fx.isQuiet {
                    HStack(spacing: 4) {
                        ForEach(Self.activeFX(fx), id: \.self) { name in
                            lamp(name, color: .orange)
                        }
                    }
                    .lineLimit(1)
                }
                if let loop = info.loop {
                    HStack(spacing: 4) {
                        Image(systemName: "repeat")
                        Text("LOOP \(loop.bars < 1 ? "\(Int(loop.bars * 4))/4" : "\(Int(loop.bars))")  \(loop.pass)/\(loop.of)")
                    }
                    .font(Typo.label(10))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.yellow))
                    .foregroundStyle(.black)
                }
                Spacer(minLength: 2)
                HStack(spacing: 14) {
                    if side == 1 { remaining(clip) }
                    VStack(alignment: align, spacing: 0) {
                        Text(L("小節", "BAR")).font(Typo.label(9)).tracking(Typo.labelTracking).foregroundStyle(.secondary)
                        Text(Clip.barLabel(floor(clip.bar(atSource: info.sourceTime))))
                            .font(Typo.readout(16, .regular))
                            .lineLimit(1)
                    }
                    if side == 0 { remaining(clip) }
                }
            } else {
                Text(L("空き", "Empty")).font(.title3).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: frameAlign)
    }

    private func remaining(_ clip: Clip) -> some View {
        VStack(alignment: side == 0 ? .leading : .trailing, spacing: 0) {
            Text(L("残り", "REMAIN")).font(Typo.label(9)).tracking(Typo.labelTracking).foregroundStyle(.secondary)
            Text("−" + Fmt.time(max(0, clip.duration - info.sourceTime)))
                .font(Typo.readout(16, .regular))
                .lineLimit(1)
                .fixedSize()
        }
    }

    private func lamp(_ text: String, color: Color) -> some View {
        Text(text)
            .font(Typo.label(8)).tracking(Typo.labelTracking)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.85)))
            .foregroundStyle(.black)
    }

    private var statusLamp: some View {
        let on = info.active && playing
        // Loaded but not sounding (stopped transport, or waiting for its turn).
        let cued = info.clip != nil && !info.ended && !on
        return Text(on ? "PLAY" : (cued ? "CUE" : (info.ended ? "END" : "—")))
            .font(Typo.label(9)).tracking(Typo.labelTracking)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(on ? Color.green.opacity(0.85) : (cued ? Color.orange.opacity(0.7) : Color.gray.opacity(0.3))))
            .foregroundStyle(.black)
    }
}

// MARK: - Mixer

private struct MixerView: View {
    let a: DeckPanel.DeckInfo
    let b: DeckPanel.DeckInfo

    var body: some View {
        VStack(spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                ChannelStrip(info: a, label: "A")
                VStack(spacing: 6) {
                    Text("MIXER")
                        .font(Typo.label(9)).tracking(Typo.labelTracking)
                        .foregroundStyle(.secondary)
                    lamp("ECHO", on: (a.state?.echoWet ?? 0) > 50 || (b.state?.echoWet ?? 0) > 50, color: .purple)
                    Spacer(minLength: 0)
                }
                .frame(width: 44)
                ChannelStrip(info: b, label: "B")
            }
            Crossfader(position: crossfaderPosition)
                .frame(height: 26)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(white: 0.15)))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.white.opacity(0.07)))
    }

    /// −1 = full A, +1 = full B, derived from the two channel levels.
    private var crossfaderPosition: Double {
        let va = a.active ? (a.state?.envelope ?? 0) : 0
        let vb = b.active ? (b.state?.envelope ?? 0) : 0
        if va + vb < 0.0001 { return 0 }
        return (vb - va) / (va + vb)
    }

    private func lamp(_ text: String, on: Bool, color: Color) -> some View {
        Text(text)
            .font(Typo.label(8)).tracking(Typo.labelTracking)
            .frame(width: 40, height: 16)
            .background(RoundedRectangle(cornerRadius: 3).fill(on ? color : Color(white: 0.22)))
            .foregroundStyle(on ? Color.black : Color.secondary)
            .shadow(color: on ? color.opacity(0.8) : .clear, radius: 5)
    }
}

private struct ChannelStrip: View {
    let info: DeckPanel.DeckInfo
    let label: String

    var body: some View {
        let s = info.state
        let accent = info.clip.map { Color.clip($0.colorIndex) } ?? Color.gray
        let base = info.clip
        VStack(spacing: 4) {
            Text("CH " + label)
                .font(Typo.label(9)).tracking(Typo.labelTracking)
                .foregroundStyle(accent)
                .lineLimit(1)
            // Knobs on the left, meter + fader using the full height on the right,
            // so everything fits the compact deck strip without overlapping.
            HStack(alignment: .top, spacing: 6) {
                VStack(spacing: 4) {
                    knobRow("HIGH", db: Double(s?.high ?? Float(base?.eqHigh ?? 0)))
                    knobRow("MID", db: Double(s?.mid ?? Float(base?.eqMid ?? 0)))
                    knobRow("LOW", db: Double(s?.low ?? Float(base?.eqLow ?? 0)))
                }
                HStack(spacing: 4) {
                    LevelMeter(level: info.level)
                    ChannelFader(position: info.active ? (s?.envelope ?? 0) : 0, color: accent)
                }
                .frame(maxHeight: .infinity)
            }
            .frame(maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity)
    }

    private func knobRow(_ title: String, db: Double) -> some View {
        let killed = db < -20
        return HStack(spacing: 4) {
            EQKnob(title: title, db: db)
            Text("KILL")
                .font(Typo.label(7)).tracking(Typo.labelTracking)
                .frame(width: 24, height: 13)
                .background(RoundedRectangle(cornerRadius: 3).fill(killed ? Color.orange : Color(white: 0.22)))
                .foregroundStyle(killed ? Color.black : Color.secondary)
                .shadow(color: killed ? Color.orange.opacity(0.8) : .clear, radius: 4)
        }
    }
}

private struct EQKnob: View {
    let title: String
    /// −40 (kill) ... +6 dB
    let db: Double

    var body: some View {
        VStack(spacing: 1) {
            Canvas { ctx, size in
                let d = min(size.width, size.height)
                let c = CGPoint(x: size.width / 2, y: size.height / 2)
                let r = d / 2 - 2
                // Map dB to −135°...+135°, 0 dB at the top centre.
                let norm: Double = db >= 0 ? 0.5 + min(db, 6) / 6 * 0.5 : 0.5 - min(1, -db / 26) * 0.5
                let angle = Angle.degrees(-225 + norm * 270)
                var track = Path()
                track.addArc(center: c, radius: r, startAngle: .degrees(-225), endAngle: .degrees(45), clockwise: false)
                ctx.stroke(track, with: .color(.white.opacity(0.12)), lineWidth: 2)
                var value = Path()
                value.addArc(center: c, radius: r, startAngle: .degrees(-90), endAngle: angle, clockwise: angle.degrees < -90)
                ctx.stroke(value, with: .color(db < -20 ? .orange : .accentColor), lineWidth: 2)
                ctx.fill(Path(ellipseIn: CGRect(x: c.x - r + 3, y: c.y - r + 3, width: (r - 3) * 2, height: (r - 3) * 2)),
                         with: .color(Color(white: 0.27)))
                var pointer = Path()
                pointer.move(to: c)
                pointer.addLine(to: CGPoint(x: c.x + cos(angle.radians) * (r - 4), y: c.y + sin(angle.radians) * (r - 4)))
                ctx.stroke(pointer, with: .color(.white), style: StrokeStyle(lineWidth: 2, lineCap: .round))
            }
            .frame(width: 28, height: 28)
            Text(title)
                .font(Typo.label(7)).tracking(0.3)
                .lineLimit(1)
                .fixedSize()
                .foregroundStyle(.secondary)
        }
    }
}

private struct ChannelFader: View {
    let position: Double
    let color: Color

    var body: some View {
        GeometryReader { geo in
            let h = geo.size.height
            let capH: CGFloat = 12
            let y = (1 - CGFloat(min(1, max(0, position)))) * (h - capH)
            ZStack(alignment: .top) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.black.opacity(0.6))
                    .frame(width: 4)
                    .frame(maxHeight: .infinity)
                RoundedRectangle(cornerRadius: 3)
                    .fill(LinearGradient(colors: [Color(white: 0.85), Color(white: 0.55)], startPoint: .top, endPoint: .bottom))
                    .overlay(Rectangle().fill(color).frame(height: 2))
                    .frame(width: 22, height: capH)
                    .offset(y: y)
            }
            .frame(width: geo.size.width)
        }
        .frame(width: 24)
    }
}

private struct LevelMeter: View {
    let level: Double

    var body: some View {
        GeometryReader { geo in
            let segments = 12
            VStack(spacing: 1.5) {
                ForEach((0..<segments).reversed(), id: \.self) { k in
                    let threshold = Double(k) / Double(segments)
                    let on = level > threshold
                    let color: Color = k >= segments - 2 ? .red : (k >= segments - 4 ? .yellow : .green)
                    RoundedRectangle(cornerRadius: 1)
                        .fill(on ? color : Color.white.opacity(0.08))
                        .frame(height: max(1, (geo.size.height - CGFloat(segments) * 1.5) / CGFloat(segments)))
                }
            }
        }
        .frame(width: 6)
    }
}

private struct Crossfader: View {
    /// −1 (A) ... +1 (B)
    let position: Double

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let capW: CGFloat = 26
            let x = CGFloat((position + 1) / 2) * (w - capW)
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.black.opacity(0.6))
                    .frame(height: 4)
                HStack {
                    Text("A").font(Typo.label(8)).tracking(Typo.labelTracking).foregroundStyle(.secondary)
                    Spacer()
                    Text("B").font(Typo.label(8)).tracking(Typo.labelTracking).foregroundStyle(.secondary)
                }
                .offset(y: -10)
                RoundedRectangle(cornerRadius: 3)
                    .fill(LinearGradient(colors: [Color(white: 0.85), Color(white: 0.55)], startPoint: .top, endPoint: .bottom))
                    .overlay(Rectangle().fill(Color.black.opacity(0.6)).frame(width: 2))
                    .frame(width: capW, height: 16)
                    .offset(x: x)
            }
            .frame(height: geo.size.height)
        }
    }
}
