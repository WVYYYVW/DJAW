import AppKit

/// Closure-backed menu item for context menus.
final class ActionMenuItem: NSMenuItem {
    private let handler: () -> Void

    init(_ title: String, enabled: Bool = true, handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(fire), keyEquivalent: "")
        self.target = self
        self.isEnabled = enabled
    }

    required init(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @objc private func fire() { handler() }
}

/// The DAW-style arrangement view. Two alternating lanes (A/B), a bar ruler,
/// waveforms, gain envelopes and transition markers. Drawn with Core Graphics,
/// only the visible part is rendered so long mixes stay fast.
final class TimelineNSView: NSView {
    let store: MixStore
    private(set) var pps: Double

    let inset: CGFloat = 24
    let rulerHeight: CGFloat = 34
    let laneGap: CGFloat = 18
    let headerHeight: CGFloat = 20

    enum Part { case body, trimLeft, trimRight, fadeIn, fadeOut }

    enum Hit {
        case none
        case ruler
        case emptyLane
        case clip(UUID, Part)
        case transition(UUID)
    }

    private struct DragState {
        var hit: Hit
        var startPoint: NSPoint
        var startTime: Double
        var original: Clip?
        /// The bar value being edited when the drag began.
        var originalValue: Double = 0
        var moved = false
        /// The previous track as it was when the drag began.
        var originalPrev: Clip?
        /// ⌘ held at mouse-down: slide the audio inside the box instead of moving the box.
        var slip = false
    }

    /// While the first track's start is dragged, everything is drawn this much later (timeline seconds),
    /// so the audio stays under the mouse and only the edge moves.
    private var leadShift: Double = 0

    private var drag: DragState?
    private var hoverClip: UUID?
    private var dropTime: Double?
    private var dropIndex = 0
    private var dragLabel: (text: String, point: NSPoint)?
    private var chipRects: [(UUID, NSRect)] = []
    private var trackingArea: NSTrackingArea?
    private var lastFitRequest: Int
    private var lastScrollRequestID = 0
    private var pendingStorePPS = false
    /// Auto-follow pauses for a moment after the user scrolls or zooms by hand.
    private var followSuspendedUntil = Date.distantPast
    /// What the last full redraw showed, so a playhead-only change redraws just two thin strips.
    private var drawnRevision = -1
    private var drawnPPS = -1.0
    private var drawnSnap: SnapUnit?
    private var drawnPlayheadX: CGFloat?
    private var isProgrammaticScroll = false
    /// Tempo map for the frame being drawn.
    private var tempo = TempoMap(reference: 120)

    init(store: MixStore) {
        self.store = store
        self.pps = store.pixelsPerSecond
        self.lastFitRequest = store.fitRequest
        super.init(frame: NSRect(x: 0, y: 0, width: 1200, height: 320))
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override var isOpaque: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // MARK: - Geometry

    /// Tempo strip between the ruler and the lanes.
    let tempoStripHeight: CGFloat = 16
    var lanesTop: CGFloat { rulerHeight + tempoStripHeight + 6 }

    var laneHeight: CGFloat {
        max(64, (bounds.height - lanesTop - laneGap - 14 - mixLaneSpace) / 2)
    }

    /// The mixed-down waveform lane under A / B (what an export writes).
    let mixLaneHeight: CGFloat = 64
    var mixLaneSpace: CGFloat { store.showMixWaveform ? mixLaneHeight + 10 : 0 }
    var mixLaneRect: NSRect { NSRect(x: 0, y: lanesBottom + 8, width: bounds.width, height: mixLaneHeight) }

    func laneRect(_ lane: Int) -> NSRect {
        NSRect(x: 0, y: lanesTop + CGFloat(lane) * (laneHeight + laneGap), width: bounds.width, height: laneHeight)
    }

    var lanesBottom: CGFloat { laneRect(1).maxY }

    func x(for t: Double) -> CGFloat { inset + CGFloat((t + leadShift) * pps) }
    func time(at x: CGFloat) -> Double { Double(x - inset) / pps - leadShift }

    func clipRect(_ i: Int) -> NSRect {
        let c = store.clips[i]
        let lane = laneRect(i % 2)
        let width = max(3, CGFloat(c.length(master: store.masterBPM) * pps))
        return NSRect(x: x(for: c.start), y: lane.minY + 3, width: width, height: lane.height - 6)
    }

    private var viewport: NSRect {
        enclosingScrollView?.contentView.bounds ?? visibleRect
    }

    // MARK: - Sync with store

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        NotificationCenter.default.removeObserver(self)
        guard let clip = superview as? NSClipView else { return }
        clip.postsBoundsChangedNotifications = true
        clip.postsFrameChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(clipBoundsChanged(_:)),
                                               name: NSView.boundsDidChangeNotification, object: clip)
        NotificationCenter.default.addObserver(self, selector: #selector(clipFrameChanged(_:)),
                                               name: NSView.frameDidChangeNotification, object: clip)
    }

    @objc private func clipBoundsChanged(_ note: Notification) {
        if !isProgrammaticScroll && store.isPlaying {
            suspendFollow()
        }
        needsDisplay = true
        reportVisibleRange()
    }

    private func suspendFollow() {
        followSuspendedUntil = Date().addingTimeInterval(2.5)
    }

    @objc private func clipFrameChanged(_ note: Notification) {
        updateDocumentSize()
        needsDisplay = true
        reportVisibleRange()
    }

    /// Called from SwiftUI whenever relevant store state changes.
    func sync() {
        updateDocumentSize()
        if !pendingStorePPS, abs(store.pixelsPerSecond - pps) > 0.0001 {
            let vr = viewport
            let playheadX = x(for: store.playhead)
            let anchor = (playheadX >= vr.minX && playheadX <= vr.maxX) ? store.playhead : time(at: vr.midX)
            setZoom(store.pixelsPerSecond, anchorTime: anchor, anchorViewX: x(for: anchor) - vr.minX, report: false)
        }
        if store.fitRequest != lastFitRequest {
            lastFitRequest = store.fitRequest
            fitToWindow()
        }
        if let request = store.scrollRequest, request.id != lastScrollRequestID {
            lastScrollRequestID = request.id
            center(on: request.time)
        }
        if store.isPlaying, store.followPlayhead, drag == nil {
            followPlayhead()
        }
        // Only the playhead moved (60 times a second while playing): redraw the strips where it was and is,
        // not every track on screen — that is what made big mixes slow.
        if store.revision == drawnRevision, pps == drawnPPS, store.snap == drawnSnap {
            let nx = x(for: store.playhead)
            if let ox = drawnPlayheadX, abs(ox - nx) < 0.25 { return }
            for px in [drawnPlayheadX, nx].compactMap({ $0 }) {
                setNeedsDisplay(NSRect(x: px - 8, y: 0, width: 16, height: bounds.height))
            }
            drawnPlayheadX = nx
            return
        }
        needsDisplay = true
    }

    func updateDocumentSize() {
        guard let sv = enclosingScrollView else { return }
        let vb = sv.contentView.bounds
        var width = max(vb.width, inset * 2 + CGFloat((store.mixDuration + 90) * pps))
        // Never shrink while dragging, otherwise the view jumps under the mouse.
        if drag != nil { width = max(width, frame.width) }
        let height = vb.height
        if abs(frame.width - width) > 0.5 || abs(frame.height - height) > 0.5 {
            setFrameSize(NSSize(width: width, height: height))
        }
    }

    private func reportVisibleRange() {
        let vr = viewport
        let a = max(0, time(at: vr.minX))
        let b = max(a + 0.1, time(at: vr.maxX))
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.store.visibleRange != a...b { self.store.visibleRange = a...b }
        }
    }

    func scroll(toX targetX: CGFloat) {
        guard let sv = enclosingScrollView else { return }
        let clip = sv.contentView
        let maxX = max(0, bounds.width - clip.bounds.width)
        isProgrammaticScroll = true
        clip.scroll(to: NSPoint(x: min(max(0, targetX), maxX), y: 0))
        sv.reflectScrolledClipView(clip)
        isProgrammaticScroll = false
    }

    func center(on t: Double) {
        updateDocumentSize()
        scroll(toX: x(for: t) - viewport.width / 2)
    }

    /// Follows the playhead page by page: when it reaches 85 % of the view, the view jumps so it is at 15 %.
    /// (Scrolling a little every frame redrew the whole timeline 60 times a second, which got slow with many tracks.)
    private func followPlayhead() {
        guard Date() >= followSuspendedUntil else { return }
        let vr = viewport
        let px = x(for: store.playhead)
        if px > vr.minX + vr.width * 0.85 || px < vr.minX {
            scroll(toX: px - vr.width * 0.15)
        }
    }

    func setZoom(_ value: Double, anchorTime: Double, anchorViewX: CGFloat, report: Bool) {
        let v = min(400, max(1, value))
        pps = v
        if report { store.pixelsPerSecond = v }
        updateDocumentSize()
        scroll(toX: x(for: anchorTime) - anchorViewX)
        needsDisplay = true
    }

    func zoom(by factor: Double, at point: NSPoint) {
        let t = time(at: point.x)
        setZoom(pps * factor, anchorTime: t, anchorViewX: point.x - viewport.minX, report: true)
    }

    func fitToWindow() {
        let available = Double(viewport.width - inset * 2 - 24)
        let duration = max(store.mixDuration, 30)
        let value = min(400, max(1, available / duration))
        pps = value
        pendingStorePPS = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.store.pixelsPerSecond = value
            self.pendingStorePPS = false
        }
        updateDocumentSize()
        scroll(toX: 0)
        needsDisplay = true
    }

    // MARK: - Drawing

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let area = dirtyRect
        drawnRevision = store.revision
        drawnPPS = pps
        drawnSnap = store.snap
        drawnPlayheadX = x(for: store.playhead)

        Theme.timelineBG.setFill()
        area.fill()

        drawLanes(area)
        drawGrid(area)

        chipRects.removeAll()
        let master = store.masterBPM
        tempo = store.tempoMap
        for i in store.clips.indices {
            let r = clipRect(i)
            if r.intersects(area) { drawClip(i, rect: r, master: master, ctx: ctx, area: area) }
        }
        drawTransitions(area)
        if store.showMixWaveform { drawMixLane(area) }

        if store.clips.isEmpty { drawEmptyState() }
        drawRuler(area)
        drawTempoStrip(area)
        drawDropAndLabels()
        drawPlayhead(area)
    }

    private func drawLanes(_ area: NSRect) {
        let vr = viewport
        for lane in 0..<2 {
            let r = laneRect(lane)
            let band = NSRect(x: area.minX, y: r.minY, width: area.width, height: r.height)
            Theme.laneBG.setFill()
            band.fill()
            let label = lane == 0 ? "A" : "B"
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
                .foregroundColor: NSColor.white.withAlphaComponent(0.18),
            ]
            (label as NSString).draw(at: NSPoint(x: vr.minX + 6, y: r.maxY - 16), withAttributes: attrs)
        }
    }

    /// The final mix as the export renders it (min / max per pixel, after the export's gain and clipping).
    /// Red where the export clips. While the mix is rendered again, the finished part is drawn bright and the rest
    /// of the previous render dimmed.
    private func drawMixLane(_ area: NSRect) {
        let r = mixLaneRect
        guard r.intersects(area) else { return }
        Theme.laneBG.setFill()
        NSRect(x: area.minX, y: r.minY, width: area.width, height: r.height).fill()
        NSColor.white.withAlphaComponent(0.10).setFill()
        NSRect(x: area.minX, y: r.midY, width: area.width, height: 0.5).fill()

        let done = store.mixPeaks
        let partial = store.mixPeaksPartial
        let rendering = store.mixWaveformIsRendering
        let stale = store.mixStaleRange
        let half = r.height / 2 - 3
        let x0 = max(area.minX, x(for: 0)), x1 = area.maxX
        if x1 > x0 {
            var px = floor(x0)
            while px < x1 {
                let ra = tempo.real(time(at: px)), rb = tempo.real(time(at: px + 1))
                // Which render to draw this column from.
                // (A render still running does not know its peak yet, so it is drawn without the normalization.)
                var src: OfflineRenderer.MixPeaks?
                // A partial update leaves everything outside the stretch being rendered as it is.
                var fresh = !rendering || (stale.map { !$0.contains(ra) && !$0.contains(rb) } ?? false)
                var isFinal = true
                if let p = partial, rb <= p.rendered {
                    src = p; fresh = true; isFinal = false
                } else {
                    src = done
                }
                if let p = src {
                    let gain: Float = store.exportNormalize && isFinal ? OfflineRenderer.normalizeGain(peak: p.peak) : 1
                    let b0 = max(0, Int(ra * p.binsPerSecond)), b1 = min(p.mins.count, max(b0 + 1, Int(rb * p.binsPerSecond)))
                    if b0 < b1 {
                        var lo: Float = 0, hi: Float = 0, loud: Float = 0
                        for b in b0..<b1 {
                            lo = min(lo, p.mins[b]); hi = max(hi, p.maxs[b])
                            if b < p.rms.count { loud = max(loud, p.rms[b]) }
                        }
                        lo *= gain; hi *= gain; loud *= gain
                        let clipped = hi > 1 || lo < -1
                        lo = max(-1, lo); hi = min(1, hi)
                        let alpha: CGFloat = fresh ? 1 : 0.35
                        // Peaks (light) with the loudness (RMS) inside, like most DAWs: a loud master fills the
                        // peaks to full scale, but its loudness still shows drops, breaks and transitions.
                        NSColor(calibratedRed: 0.45, green: 0.85, blue: 0.95, alpha: 0.4 * alpha).setFill()
                        let yTop = r.midY - CGFloat(hi) * half, yBot = r.midY - CGFloat(lo) * half
                        NSRect(x: px, y: yTop, width: 1, height: max(1, yBot - yTop)).fill()
                        let core = CGFloat(min(1, loud * 1.41)) * half
                        NSColor(calibratedRed: 0.45, green: 0.85, blue: 0.95, alpha: 0.95 * alpha).setFill()
                        NSRect(x: px, y: r.midY - core, width: 1, height: max(1, 2 * core)).fill()
                        // Where the export would clip: a red mark along the top and bottom edges only.
                        if clipped {
                            NSColor.systemRed.withAlphaComponent(0.95 * alpha).setFill()
                            NSRect(x: px, y: r.midY - half - 3, width: 1, height: 3).fill()
                            NSRect(x: px, y: r.midY + half, width: 1, height: 3).fill()
                        }
                    }
                }
                px += 1
            }
        }

        // Caption at the left edge of the view.
        let vr = viewport
        var text = L("MIX（書き出しと同じ波形）", "MIX (exactly what Export writes)")
        let sr = store.exportSampleRate / 1000
        text += L(" · \(sr == sr.rounded() ? String(Int(sr)) : String(format: "%.1f", sr)) kHz", " · \(String(format: "%g", sr)) kHz")
        text += store.exportNormalize ? L(" · 正規化あり", " · normalized") : L(" · 正規化なし", " · not normalized")
        if !store.exportNormalize, !rendering, let p = done {
            var over = 0, maxV: Float = 0
            for b in p.maxs.indices {
                let v = max(p.maxs[b], -p.mins[b])
                if v > 1 { over += 1; maxV = max(maxV, v) }
            }
            if over > 0 {
                let pct = 100 * Double(over) / Double(max(1, p.maxs.count))
                let db = 20 * log10(Double(maxV))
                text += L("  — 赤い印の所で音割れ（全体の\(String(format: "%.0f", pct))%、最大 +\(String(format: "%.1f", db)) dB）。書き出しの「正規化」で防げます",
                          "  — clips at the red marks (\(String(format: "%.0f", pct))% of the mix, up to +\(String(format: "%.1f", db)) dB); turn on Normalize when exporting")
            }
        }
        if rendering, stale != nil {
            text += L("  — 変更した所だけ更新中", "  — updating the changed part")
        } else if rendering {
            let pct = partial.map { p in Int(100 * p.rendered / max(1, tempo.real(store.mixDuration))) } ?? 0
            text += L("  — 更新中 \(min(99, pct))%", "  — updating \(min(99, pct))%")
        } else if done == nil {
            text += L("  — 準備中…", "  — preparing…")
        }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
            .foregroundColor: NSColor.white.withAlphaComponent(rendering ? 0.55 : 0.4),
        ]
        (text as NSString).draw(at: NSPoint(x: vr.minX + 6, y: r.minY + 2), withAttributes: attrs)
    }

    private func drawGrid(_ area: NSRect) {
        let g = store.grid
        let beatPx = g.beat * pps
        let barPx = g.bar * pps
        let phrase = g.bar * 4
        let t0 = time(at: area.minX) - phrase
        let t1 = time(at: area.maxX)
        let top = lanesTop
        let bottom = lanesBottom

        // Alternate 4-bar phrases with a subtle shade.
        var k = floor((t0 - g.offset) / phrase)
        while true {
            let ts = g.offset + k * phrase
            if ts > t1 { break }
            if Int(k) % 2 != 0 {
                NSColor.white.withAlphaComponent(0.018).setFill()
                NSRect(x: x(for: ts), y: top, width: CGFloat(phrase * pps), height: bottom - top).fill()
            }
            k += 1
        }

        let stepBeats: Double = beatPx >= 7 ? 1 : (barPx >= 7 ? 4 : 16)
        let step = g.beat * stepBeats
        var n = floor((t0 - g.offset) / step)
        while true {
            let t = g.offset + n * step
            if t > t1 { break }
            let beatIndex = Int((n * stepBeats).rounded())
            let alpha: CGFloat
            if beatIndex % 16 == 0 { alpha = 0.15 } else if beatIndex % 4 == 0 { alpha = 0.085 } else { alpha = 0.035 }
            NSColor.white.withAlphaComponent(alpha).setFill()
            NSRect(x: x(for: t), y: top, width: 1, height: bottom - top).fill()
            n += 1
        }
    }

    private func drawRuler(_ area: NSRect) {
        let r = NSRect(x: area.minX, y: 0, width: area.width, height: rulerHeight)
        Theme.rulerBG.setFill()
        r.fill()
        NSColor.white.withAlphaComponent(0.08).setFill()
        NSRect(x: area.minX, y: rulerHeight - 1, width: area.width, height: 1).fill()

        let g = store.grid
        let barPx = g.bar * pps
        var labelBars = 1
        for c in [1, 2, 4, 8, 16, 32, 64, 128] {
            labelBars = c
            if Double(c) * barPx >= 58 { break }
        }
        let tickBars = barPx >= 6 ? 1 : labelBars
        let t0 = time(at: area.minX - 80)
        let t1 = time(at: area.maxX)
        var n = Int(floor((t0 - g.offset) / g.bar))
        n -= ((n % tickBars) + tickBars) % tickBars

        let barAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: NSColor.white.withAlphaComponent(0.82),
        ]
        let timeAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .regular),
            .foregroundColor: NSColor.white.withAlphaComponent(0.38),
        ]

        while true {
            let t = g.offset + Double(n) * g.bar
            if t > t1 { break }
            let px = x(for: t)
            let isLabel = ((n % labelBars) + labelBars) % labelBars == 0
            let h: CGFloat = isLabel ? 11 : 5
            NSColor.white.withAlphaComponent(isLabel ? 0.42 : 0.18).setFill()
            NSRect(x: px, y: rulerHeight - h, width: 1, height: h).fill()
            if isLabel && t >= -0.001 {
                ("\(n + 1)" as NSString).draw(at: NSPoint(x: px + 4, y: 3), withAttributes: barAttrs)
                (Fmt.duration(tempo.real(t)) as NSString).draw(at: NSPoint(x: px + 4, y: 18), withAttributes: timeAttrs)
            }
            n += tickBars
        }
    }

    private func drawClip(_ i: Int, rect r: NSRect, master: Double, ctx: CGContext, area: NSRect) {
        let clip = store.clips[i]
        let color = NSColor.clip(clip.colorIndex)
        let selected = clip.id == store.selectedClipID
        let hovered = clip.id == hoverClip
        let missing = store.missingFiles.contains(clip.url)
        let path = NSBezierPath(roundedRect: r, xRadius: 6, yRadius: 6)

        color.withAlphaComponent(selected ? 0.24 : 0.15).setFill()
        path.fill()

        let header = NSRect(x: r.minX, y: r.minY, width: r.width, height: headerHeight)
        let wave = NSRect(x: r.minX, y: header.maxY + 2, width: r.width, height: max(10, r.maxY - header.maxY - 4))

        ctx.saveGState()
        path.addClip()
        color.withAlphaComponent(selected ? 0.55 : 0.36).setFill()
        header.fill()
        if missing {
            NSColor.systemRed.withAlphaComponent(0.18).setFill()
            wave.fill()
        } else {
            drawWaveform(clip, rect: wave, color: color, master: master, area: area)
            drawSections(clip, wave: wave, master: master)
            drawEdits(clip, wave: wave, master: master)
            drawOutro(i, clip: clip, wave: wave, master: master)
            drawFX(clip, wave: wave, master: master)
            drawAICues(clip, wave: wave, master: master)
        }
        drawEnvelope(i, clip: clip, rect: wave, master: master, area: area)
        ctx.restoreGState()

        let borderColor: NSColor = selected ? .white.withAlphaComponent(0.92) : color.withAlphaComponent(hovered ? 0.95 : 0.55)
        borderColor.setStroke()
        path.lineWidth = selected ? 2 : 1
        path.stroke()

        // Header text sticks to the left edge of the viewport while scrolling.
        let vr = viewport
        let textX = max(r.minX + 8, vr.minX + 8)
        let textWidth = r.maxX - textX - 8
        if textWidth > 24 {
            let para = NSMutableParagraphStyle()
            para.lineBreakMode = .byTruncatingTail
            let text = NSMutableAttributedString(string: clip.title, attributes: [
                .font: NSFont.systemFont(ofSize: 11.5, weight: .semibold),
                .foregroundColor: NSColor.white,
                .paragraphStyle: para,
            ])
            var info = "   \(Fmt.bpm(clip.bpm)) BPM"
            let rate = clip.rate(master: tempo.bpm(at: clip.start))
            if clip.tempoSync && abs(rate - 1) > 0.0005 { info += " → \(Fmt.ratePercent(rate))" }
            if !clip.tempoSync { info += L("（同期オフ）", " (sync off)") }
            if missing { info += L("   ⚠︎ ファイルが見つかりません", "   ⚠︎ File not found") }
            text.append(NSAttributedString(string: info, attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .medium),
                .foregroundColor: NSColor.white.withAlphaComponent(0.66),
                .paragraphStyle: para,
            ]))
            text.draw(in: NSRect(x: textX, y: r.minY + 3, width: textWidth, height: 15))
        }

        // Beat-alignment warning
        if clip.tempoSync && clip.bpm > 0 {
            let g = store.grid
            let d = Mathx.posMod(clip.downbeatPhase(master: master) - g.offset, g.beat)
            let deviation = min(d, g.beat - d)
            if deviation > 0.008 && r.width > 90 {
                let warn = NSAttributedString(string: L("拍ズレ \(Int((deviation * 1000).rounded()))ms", "Off-beat \(Int((deviation * 1000).rounded())) ms"), attributes: [
                    .font: NSFont.systemFont(ofSize: 9.5, weight: .semibold),
                    .foregroundColor: NSColor.systemOrange,
                ])
                let s = warn.size()
                let wx = min(r.maxX, vr.maxX) - s.width - 8
                if wx > textX + 60 { warn.draw(at: NSPoint(x: wx, y: r.minY + 4)) }
            }
        }

        drawMixMarkers(i, clip: clip, rect: r, wave: wave, master: master)
        if selected || hovered {
            drawHandles(i, clip: clip, rect: r, master: master, color: color)
        }
    }

    /// Mix BPM over time: a line with the value at each change.
    private func drawTempoStrip(_ area: NSRect) {
        let strip = NSRect(x: area.minX, y: rulerHeight, width: area.width, height: tempoStripHeight)
        Theme.rulerBG.blended(withFraction: 0.35, of: .black)?.setFill()
        strip.fill()
        let pts = tempo.points
        let lo = (pts.map(\.bpm).min() ?? 120) - 2
        let hi = (pts.map(\.bpm).max() ?? 120) + 2
        func y(_ b: Double) -> CGFloat {
            hi - lo < 4.01 ? strip.midY : strip.maxY - 3 - CGFloat((b - lo) / (hi - lo)) * (strip.height - 6)
        }
        let line = NSBezierPath()
        line.lineWidth = 1.5
        let t0 = time(at: area.minX - 2), t1 = time(at: area.maxX + 2)
        line.move(to: NSPoint(x: x(for: t0), y: y(tempo.bpm(at: t0))))
        for p in pts where p.t > t0 && p.t < t1 { line.line(to: NSPoint(x: x(for: p.t), y: y(p.bpm))) }
        line.line(to: NSPoint(x: x(for: t1), y: y(tempo.bpm(at: t1))))
        let changes = tempo.hasChanges
        (changes ? NSColor.systemTeal : NSColor.white.withAlphaComponent(0.18)).setStroke()
        line.stroke()

        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .semibold),
            .foregroundColor: NSColor.systemTeal,
        ]
        if changes {
            var prev = pts[0].bpm
            for p in pts.dropFirst() where abs(p.bpm - prev) > 0.004 {
                let px = x(for: p.t)
                if px > area.minX - 80 && px < area.maxX + 4 {
                    let label = "\(Fmt.bpm(p.bpm))" as NSString
                    label.draw(at: NSPoint(x: px + 3, y: strip.minY + 2), withAttributes: attrs)
                }
                prev = p.bpm
            }
        }
        let vr = viewport
        let tag = "TEMPO \(Fmt.bpm(tempo.bpm(at: max(0, time(at: vr.minX)))))" as NSString
        tag.draw(at: NSPoint(x: vr.minX + 6, y: strip.minY + 2), withAttributes: [
            .font: NSFont.systemFont(ofSize: 8.5, weight: .bold),
            .foregroundColor: NSColor.white.withAlphaComponent(0.35),
        ])
    }

    /// CUE-DETR suggestions: small diamonds on the top edge of the waveform.
    private func drawAICues(_ clip: Clip, wave: NSRect, master: Double) {
        let cues = store.aiCues(for: clip)
        guard !cues.isEmpty else { return }
        for cue in cues {
            let s = clip.sourceTime(bar: cue.bar)
            guard s >= clip.trimStart - 0.01 && s <= clip.trimEnd + 0.01 else { continue }
            let px = x(for: clip.timelineTime(source: s, master: master))
            let d = NSBezierPath()
            d.move(to: NSPoint(x: px, y: wave.minY + 1))
            d.line(to: NSPoint(x: px + 4, y: wave.minY + 5))
            d.line(to: NSPoint(x: px, y: wave.minY + 9))
            d.line(to: NSPoint(x: px - 4, y: wave.minY + 5))
            d.close()
            NSColor(calibratedHue: 0.13, saturation: 0.75, brightness: 1, alpha: 0.45 + 0.55 * cue.score).setFill()
            d.fill()
        }
    }

    /// Brake / backspin at the end of the outgoing track.
    private func drawOutro(_ i: Int, clip: Clip, wave: NSRect, master: Double) {
        guard i + 1 < store.clips.count, let o = clip.outro(next: store.clips[i + 1]) else { return }
        let rate = clip.rate(master: master)
        let x0 = x(for: clip.start + o.elapsedStart / rate)
        let x1 = x(for: clip.start + (o.elapsedStart + o.length) / rate)
        guard x1 - x0 > 1 else { return }
        let band = NSRect(x: x0, y: wave.minY, width: x1 - x0, height: wave.height)
        NSColor.systemRed.withAlphaComponent(0.22).setFill()
        band.fill()
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(rect: band).addClip()
        NSColor.systemRed.withAlphaComponent(0.45).setStroke()
        let hatch = NSBezierPath()
        hatch.lineWidth = 1
        var hx = band.minX - band.height
        while hx < band.maxX {
            hatch.move(to: NSPoint(x: hx, y: band.maxY))
            hatch.line(to: NSPoint(x: hx + band.height, y: band.minY))
            hx += 7
        }
        hatch.stroke()
        NSGraphicsContext.restoreGraphicsState()
        let label = (o.kind == .brake ? "⏷ BRAKE" : "⟲ SPIN") as NSString
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 9, weight: .bold),
            .foregroundColor: NSColor.white,
        ]
        let size = label.size(withAttributes: attrs)
        let pill = NSRect(x: max(x0 + 2, x1 - size.width - 8), y: wave.minY + 3, width: size.width + 6, height: size.height + 1)
        NSColor.systemRed.setFill()
        NSBezierPath(roundedRect: pill, xRadius: 3, yRadius: 3).fill()
        label.draw(at: NSPoint(x: pill.minX + 3, y: pill.minY), withAttributes: attrs)
    }

    /// Effect regions: a coloured strip along the bottom of the waveform, shaped like the effect's level.
    private func drawFX(_ clip: Clip, wave: NSRect, master: Double) {
        guard let list = clip.fx, !list.isEmpty else { return }
        let h: CGFloat = min(16, wave.height * 0.3)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 8.5, weight: .bold),
            .foregroundColor: NSColor.white,
        ]
        for (n, fx) in list.enumerated() {
            let x0 = x(for: clip.timelineTime(bar: fx.bar, master: master))
            let x1 = x(for: clip.timelineTime(bar: fx.end, master: master))
            guard x1 - x0 > 1 else { continue }
            let row = CGFloat(n % 2)
            let band = NSRect(x: x0, y: wave.maxY - h - row * (h + 1), width: x1 - x0, height: h)
            let color = NSColor(calibratedHue: fx.kind.hue, saturation: 0.65, brightness: 0.95, alpha: 1)
            color.withAlphaComponent(0.22).setFill()
            NSBezierPath(roundedRect: band, xRadius: 2, yRadius: 2).fill()
            // Level profile.
            let shape = NSBezierPath()
            shape.move(to: NSPoint(x: band.minX, y: band.maxY))
            let steps = max(2, min(60, Int(band.width / 4)))
            for k in 0...steps {
                let b = fx.bar + fx.bars * Double(k) / Double(steps) * 0.9999
                let lv = fx.amount > 0 ? fx.level(atBar: b) / max(fx.amount, 0.001) : 0
                shape.line(to: NSPoint(x: band.minX + band.width * CGFloat(k) / CGFloat(steps), y: band.maxY - CGFloat(lv) * (band.height - 2)))
            }
            shape.line(to: NSPoint(x: band.maxX, y: band.maxY))
            shape.close()
            color.withAlphaComponent(0.55).setFill()
            shape.fill()
            let label = fx.kind.short as NSString
            let size = label.size(withAttributes: attrs)
            if band.width > size.width + 6 {
                label.draw(at: NSPoint(x: band.minX + 3, y: band.minY + (band.height - size.height) / 2), withAttributes: attrs)
            }
        }
    }

    /// Loop passes (tinted, "LOOP 2/3") and beat jumps (zig-zag mark), like a controller's loop display.
    private func drawEdits(_ clip: Clip, wave: NSRect, master: Double) {
        guard clip.hasEdits else { return }
        let segs = clip.playSegments()
        let rate = clip.rate(master: master)
        let loopColor = NSColor.systemYellow
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .semibold),
            .foregroundColor: NSColor.black.withAlphaComponent(0.85),
        ]
        for edit in clip.edits ?? [] {
            let a = clip.sourceTime(bar: edit.bar), b = clip.sourceTime(bar: edit.end)
            switch edit.kind {
            case .loop:
                let passes = segs.filter { $0.from < b - 1e-6 && $0.to > a + 1e-6 }
                guard passes.count > 1 else { continue }
                for (n, seg) in passes.enumerated() {
                    let s0 = max(seg.from, a), s1 = min(seg.to, b)
                    let x0 = x(for: clip.start + (seg.elapsed + s0 - seg.from) / rate)
                    let x1 = x(for: clip.start + (seg.elapsed + s1 - seg.from) / rate)
                    guard x1 - x0 > 1 else { continue }
                    let band = NSRect(x: x0, y: wave.minY, width: x1 - x0, height: wave.height)
                    loopColor.withAlphaComponent(n == 0 ? 0.08 : 0.16).setFill()
                    band.fill()
                    loopColor.withAlphaComponent(0.9).setFill()
                    NSRect(x: x0, y: wave.minY, width: 1.5, height: wave.height).fill()
                    let label = "⟲ \(n + 1)/\(passes.count)" as NSString
                    let size = label.size(withAttributes: attrs)
                    if x1 - x0 > size.width + 8 {
                        let pill = NSRect(x: x0 + 3, y: wave.minY + 3, width: size.width + 6, height: size.height + 1)
                        loopColor.setFill()
                        NSBezierPath(roundedRect: pill, xRadius: 3, yRadius: 3).fill()
                        label.draw(at: NSPoint(x: pill.minX + 3, y: pill.minY), withAttributes: attrs)
                    }
                }
            case .jump:
                // Where the jump happens: end of the piece that stops at its trigger.
                guard let seg = segs.first(where: { abs($0.to - a) < 1e-4 }) else { continue }
                let px = x(for: clip.start + (seg.elapsed + seg.to - seg.from) / rate)
                NSColor.systemPink.setStroke()
                let path = NSBezierPath()
                path.lineWidth = 1.5
                var y = wave.minY
                path.move(to: NSPoint(x: px, y: y))
                while y < wave.maxY {
                    y += 6
                    path.line(to: NSPoint(x: px + ((Int(y) / 6) % 2 == 0 ? -3 : 3), y: min(y, wave.maxY)))
                }
                path.stroke()
                let label = "⇥ \(edit.lengthLabel)" as NSString
                let size = label.size(withAttributes: attrs)
                let pill = NSRect(x: px + 4, y: wave.minY + 3, width: size.width + 6, height: size.height + 1)
                NSColor.systemPink.setFill()
                NSBezierPath(roundedRect: pill, xRadius: 3, yRadius: 3).fill()
                label.draw(at: NSPoint(x: pill.minX + 3, y: pill.minY), withAttributes: attrs)
            }
        }
    }

    /// Thin coloured band under the header: intro / drop / break / outro found by the analysis.
    private func drawSections(_ clip: Clip, wave: NSRect, master: Double) {
        guard let st = store.structures[clip.url] else { return }
        let band = NSRect(x: wave.minX, y: wave.minY - 2, width: wave.width, height: 4)
        for sec in st.sections {
            let t0 = clip.timelineTime(source: st.time(ofBar: Double(sec.start)), master: master)
            let t1 = clip.timelineTime(source: st.time(ofBar: Double(sec.end)), master: master)
            let x0 = max(band.minX, x(for: t0)), x1 = min(band.maxX, x(for: t1))
            guard x1 - x0 > 1 else { continue }
            let color: NSColor
            switch sec.kind {
            case .intro: color = NSColor.white.withAlphaComponent(0.28)
            case .drop: color = NSColor.systemOrange.withAlphaComponent(0.95)
            case .breakdown: color = NSColor.systemTeal.withAlphaComponent(0.85)
            case .outro: color = NSColor.white.withAlphaComponent(0.16)
            }
            color.setFill()
            NSRect(x: x0, y: band.minY, width: x1 - x0 - 1, height: band.height).fill()
        }
    }

    /// Track bar numbers at phrase boundaries plus IN / OUT flags, so mix points can be read off the waveform.
    private func drawMixMarkers(_ i: Int, clip: Clip, rect r: NSRect, wave: NSRect, master: Double) {
        guard clip.bpm > 0 else { return }
        let barPx = clip.barSource / clip.rate(master: master) * pps
        var step = 1.0
        for candidate in [1.0, 2, 4, 8, 16, 32, 64] {
            step = candidate
            if candidate * barPx >= 34 { break }
        }
        let vr = viewport
        let firstBar = clip.bar(atSource: clip.trimStart)
        let lastBar = clip.bar(atSource: clip.trimEnd)
        var b = ceil((firstBar - clip.mixInBar) / step) * step + clip.mixInBar
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .semibold),
            .foregroundColor: NSColor.white.withAlphaComponent(0.5),
        ]
        var lastPx = -CGFloat.infinity
        while b <= lastBar {
            let px = x(for: clip.timelineTime(bar: b, master: master))
            // Bars skipped by a beat jump all land on the jump point: label only one.
            if px - lastPx < 12 { b += step; continue }
            lastPx = px
            if px >= vr.minX - 30 && px <= vr.maxX && px >= r.minX && px <= r.maxX - 16 {
                NSColor.white.withAlphaComponent(0.22).setFill()
                NSRect(x: px, y: wave.maxY - 12, width: 1, height: 10).fill()
                (Clip.barLabel(b) as NSString).draw(at: NSPoint(x: px + 3, y: wave.maxY - 13), withAttributes: attrs)
            }
            b += step
        }

        // Memory cues
        for cue in clip.cueList {
            let cx = x(for: clip.timelineTime(bar: cue.bar, master: master))
            guard cx >= r.minX, cx <= r.maxX, cx >= vr.minX - 60, cx <= vr.maxX + 10 else { continue }
            NSColor.systemTeal.withAlphaComponent(0.85).setFill()
            NSRect(x: cx - 0.5, y: wave.minY + 16, width: 1, height: wave.height - 30).fill()
            let tri = NSBezierPath()
            tri.move(to: NSPoint(x: cx - 4, y: wave.minY + 16))
            tri.line(to: NSPoint(x: cx + 4, y: wave.minY + 16))
            tri.line(to: NSPoint(x: cx, y: wave.minY + 22))
            tri.close()
            tri.fill()
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 9, weight: .semibold),
                .foregroundColor: NSColor.systemTeal,
            ]
            (cue.label as NSString).draw(at: NSPoint(x: cx + 4, y: wave.minY + 22), withAttributes: attrs)
        }

        // IN flag at the mix-in point
        let inX = x(for: clip.timelineTime(bar: clip.mixInBar, master: master))
        if inX >= r.minX - 1 && inX <= r.maxX {
            drawFlag("IN \(Clip.barLabel(clip.mixInBar))", x: inX, y: wave.minY + 1, color: .systemGreen, alignRight: false)
        }
        // Switch-done flag: from here only this track plays
        if i > 0, clip.transitionBars > 0.01 {
            let landX = x(for: clip.timelineTime(bar: clip.landingBar, master: master))
            if landX >= r.minX && landX <= r.maxX {
                NSColor.systemPurple.withAlphaComponent(0.85).setFill()
                NSRect(x: landX - 0.5, y: wave.minY, width: 1.5, height: wave.height).fill()
                drawFlag(L("切替 ", "SW ") + Clip.barLabel(clip.landingBar), x: landX, y: wave.minY + 1, color: .systemPurple, alignRight: false)
            }
        }

        // OUT flag where the next transition starts
        if i + 1 < store.clips.count {
            let outX = x(for: clip.timelineTime(bar: clip.mixOutBar, master: master))
            if outX >= r.minX && outX <= r.maxX {
                NSColor.systemOrange.withAlphaComponent(0.9).setFill()
                NSRect(x: outX - 0.5, y: wave.minY, width: 1.5, height: wave.height).fill()
                drawFlag("OUT \(Clip.barLabel(clip.mixOutBar))", x: outX, y: wave.minY + 1, color: .systemOrange, alignRight: true)
            }
        }
    }

    private func drawFlag(_ text: String, x px: CGFloat, y: CGFloat, color: NSColor, alignRight: Bool) {
        let string = NSAttributedString(string: text, attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .semibold),
            .foregroundColor: NSColor.black.withAlphaComponent(0.85),
        ])
        let s = string.size()
        let w = s.width + 8
        let rect = NSRect(x: alignRight ? px - w : px, y: y, width: w, height: 13)
        color.withAlphaComponent(0.92).setFill()
        NSBezierPath(roundedRect: rect, xRadius: 3, yRadius: 3).fill()
        string.draw(at: NSPoint(x: rect.minX + 4, y: rect.midY - s.height / 2))
    }

    private func drawWaveform(_ clip: Clip, rect: NSRect, color: NSColor, master: Double, area: NSRect) {
        guard let wf = store.waveforms[clip.url], !wf.peaks.isEmpty else {
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 11, weight: .medium),
                .foregroundColor: NSColor.white.withAlphaComponent(0.4),
            ]
            (L("波形を読み込み中…", "Loading waveform…") as NSString).draw(at: NSPoint(x: max(rect.minX, viewport.minX) + 10, y: rect.midY - 7), withAttributes: attrs)
            return
        }
        let x0 = max(rect.minX, area.minX)
        let x1 = min(rect.maxX, area.maxX)
        guard x1 > x0 else { return }

        let toSource = clip.sourceMapper(master: master)
        let mid = rect.midY
        let half = rect.height / 2 * 0.94
        let norm = 1 / wf.maxPeak
        let gain = Float(min(1.4, pow(10, (clip.gainDB + (clip.loudnessGainDB ?? 0)) / 20)))
        let count = wf.peaks.count
        let bps = wf.binsPerSecond

        var tops: [CGPoint] = []
        var lowTops: [CGPoint] = []
        let estimated = Int(x1 - x0) + 2
        tops.reserveCapacity(estimated)
        lowTops.reserveCapacity(estimated)

        wf.peaks.withUnsafeBufferPointer { peaks in
            wf.lows.withUnsafeBufferPointer { lows in
                var px = floor(x0)
                while px <= x1 {
                    let ta = time(at: px)
                    let tb = time(at: px + 1)
                    let sa = toSource(ta)
                    var sb = toSource(tb)
                    if sb < sa { sb = sa + (tb - ta) }   // pixel spans a loop restart
                    var b0 = Int(sa * bps)
                    var b1 = Int(sb * bps)
                    b0 = min(max(0, b0), count - 1)
                    b1 = min(count, max(b0 + 1, b1))
                    var p: Float = 0
                    var l: Float = 0
                    var b = b0
                    while b < b1 {
                        if peaks[b] > p { p = peaks[b] }
                        if lows[b] > l { l = lows[b] }
                        b += 1
                    }
                    let a = CGFloat(min(1, p * norm * gain))
                    let al = CGFloat(min(1, l * norm * gain))
                    tops.append(CGPoint(x: px, y: mid - a * half))
                    lowTops.append(CGPoint(x: px, y: mid - al * half))
                    px += 1
                }
            }
        }

        func fillMirrored(_ points: [CGPoint], _ fill: NSColor) {
            guard let first = points.first else { return }
            let p = NSBezierPath()
            p.move(to: first)
            for pt in points.dropFirst() { p.line(to: pt) }
            for pt in points.reversed() { p.line(to: CGPoint(x: pt.x, y: mid + (mid - pt.y))) }
            p.close()
            fill.setFill()
            p.fill()
        }

        fillMirrored(tops, color.withAlphaComponent(0.42))
        fillMirrored(lowTops, color.withAlphaComponent(0.95))
    }

    /// Darkens the region above the gain envelope so fades and transitions read at a glance.
    private func drawEnvelope(_ i: Int, clip: Clip, rect: NSRect, master: Double, area: NSRect) {
        let x0 = max(rect.minX, area.minX)
        let x1 = min(rect.maxX, area.maxX)
        guard x1 > x0 else { return }
        var points: [CGPoint] = []
        var killSegments: [(CGFloat, CGFloat)] = []
        var killStart: CGFloat?
        var attenuated = false
        var px = x0
        while true {
            let cx = min(px, x1)
            let state = Automation.state(clips: store.clips, index: i, time: time(at: cx), master: master)
            let v = CGFloat(min(1, max(0, state.envelope)))
            if v < 0.995 { attenuated = true }
            points.append(CGPoint(x: cx, y: rect.minY + (1 - v) * rect.height))
            if state.lowKilled {
                if killStart == nil { killStart = cx }
            } else if let s = killStart {
                killSegments.append((s, cx))
                killStart = nil
            }
            if cx >= x1 { break }
            px += 3
        }
        if let s = killStart { killSegments.append((s, x1)) }

        if attenuated {
            let shade = NSBezierPath()
            shade.move(to: CGPoint(x: x0, y: rect.minY))
            for p in points { shade.line(to: p) }
            shade.line(to: CGPoint(x: x1, y: rect.minY))
            shade.close()
            NSColor.black.withAlphaComponent(0.42).setFill()
            shade.fill()

            let line = NSBezierPath()
            line.move(to: points[0])
            for p in points.dropFirst() { line.line(to: p) }
            line.lineWidth = 1.5
            NSColor.white.withAlphaComponent(0.85).setStroke()
            line.stroke()
        }

        for (a, b) in killSegments {
            NSColor.systemOrange.withAlphaComponent(0.9).setFill()
            NSRect(x: a, y: rect.maxY - 3, width: b - a, height: 3).fill()
        }
    }

    private func handlePoints(_ clip: Clip, rect r: NSRect, master: Double) -> (fadeIn: NSPoint, fadeOut: NSPoint) {
        let beat = 60 / master
        let y = r.minY + headerHeight + 26
        let fi = min(r.maxX - 6, max(r.minX + 6, x(for: clip.start + clip.fadeInBeats * beat)))
        let fo = max(r.minX + 6, min(r.maxX - 6, x(for: clip.end(master: master) - clip.fadeOutBeats * beat)))
        return (NSPoint(x: fi, y: y), NSPoint(x: fo, y: y))
    }

    private func drawHandles(_ i: Int, clip: Clip, rect r: NSRect, master: Double, color: NSColor) {
        let h = handlePoints(clip, rect: r, master: master)
        var points: [NSPoint] = []
        if i == 0 { points.append(h.fadeIn) }
        if i == store.clips.count - 1 { points.append(h.fadeOut) }
        for p in points {
            let dot = NSBezierPath(ovalIn: NSRect(x: p.x - 7, y: p.y - 7, width: 14, height: 14))
            NSColor.white.setFill()
            dot.fill()
            color.setStroke()
            dot.lineWidth = 1.5
            dot.stroke()
        }
        // Trim grips
        NSColor.white.withAlphaComponent(0.55).setFill()
        let gh = min(24, r.height * 0.3)
        NSBezierPath(roundedRect: NSRect(x: r.minX + 2, y: r.midY - gh / 2, width: 3, height: gh), xRadius: 1.5, yRadius: 1.5).fill()
        NSBezierPath(roundedRect: NSRect(x: r.maxX - 5, y: r.midY - gh / 2, width: 3, height: gh), xRadius: 1.5, yRadius: 1.5).fill()
    }

    private func drawTransitions(_ area: NSRect) {
        let master = store.masterBPM
        let barLen = 240 / master
        let midY = laneRect(0).maxY + laneGap / 2
        for i in store.clips.indices where i > 0 {
            let prev = store.clips[i - 1]
            let cur = store.clips[i]
            let start = cur.start
            let end = min(prev.end(master: master), cur.end(master: master))
            guard end - start > 0.005 else { continue }
            let xa = x(for: start)
            let xb = x(for: end)
            guard xb >= area.minX - 200, xa <= area.maxX + 200 else { continue }
            let selected = cur.id == store.selectedClipID

            // Bracket in the lane gap
            let lineColor = selected ? NSColor.controlAccentColor : NSColor.white.withAlphaComponent(0.35)
            lineColor.setFill()
            NSRect(x: xa, y: midY - 0.5, width: xb - xa, height: 1).fill()
            NSRect(x: xa, y: midY - 4, width: 1, height: 8).fill()
            NSRect(x: xb - 1, y: midY - 4, width: 1, height: 8).fill()

            let glyph = cur.transition == .brake ? "⏷" : cur.transition == .backspin ? "⟲" : "✂︎"
            var label = cur.transitionBars < 0.01
                ? "\(glyph) \(cur.transition.title)"
                : "\(Fmt.bars((end - start) / barLen)) · \(cur.transition.title)"
            if let t = cur.tempo, i > 0 {
                let before = store.tempoBefore(i)
                if abs(t - before) > 0.004 { label += "  ♩\(Fmt.bpm(before))→\(Fmt.bpm(t))" }
            }
            if store.isLocked(i) { label = "🔒 " + label }
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
                .foregroundColor: NSColor.white.withAlphaComponent(0.92),
            ]
            let text = NSAttributedString(string: label, attributes: attrs)
            let size = text.size()
            let chipWidth = size.width + 18
            let chip = NSRect(x: (xa + xb) / 2 - chipWidth / 2, y: midY - 9, width: chipWidth, height: 18)
            let chipPath = NSBezierPath(roundedRect: chip, xRadius: 9, yRadius: 9)
            Theme.chipBG.setFill()
            chipPath.fill()
            (selected ? NSColor.controlAccentColor : NSColor.white.withAlphaComponent(0.25)).setStroke()
            chipPath.lineWidth = selected ? 1.5 : 1
            chipPath.stroke()
            text.draw(at: NSPoint(x: chip.minX + 9, y: chip.midY - size.height / 2))
            chipRects.append((cur.id, chip))
        }
    }

    private func drawEmptyState() {
        let vr = viewport
        let area = NSRect(x: vr.minX + 24, y: lanesTop + 4, width: vr.width - 48, height: lanesBottom - lanesTop - 8)
        let highlight = dropTime != nil
        let box = NSBezierPath(roundedRect: area, xRadius: 14, yRadius: 14)
        box.lineWidth = 2
        box.setLineDash([7, 6], count: 2, phase: 0)
        (highlight ? NSColor.controlAccentColor : NSColor.white.withAlphaComponent(0.14)).setStroke()
        box.stroke()
        if highlight {
            NSColor.controlAccentColor.withAlphaComponent(0.08).setFill()
            box.fill()
        }

        let center = NSPoint(x: area.midX, y: area.midY)
        let analyzing = !store.pending.isEmpty
        let symbol = analyzing ? "waveform" : "square.and.arrow.down.on.square"
        let tint = NSColor.white.withAlphaComponent(highlight ? 0.75 : 0.38)
        let config = NSImage.SymbolConfiguration(pointSize: 40, weight: .light)
            .applying(NSImage.SymbolConfiguration(paletteColors: [tint]))
        var y = center.y - 52
        if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(config) {
            let s = image.size
            image.draw(in: NSRect(x: center.x - s.width / 2, y: y, width: s.width, height: s.height),
                       from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            y += s.height + 14
        }

        let title = analyzing ? L("解析中…（BPMと波形を検出しています）", "Analyzing… (detecting BPM and waveform)") : L("音声ファイルをここにドロップ", "Drop audio files here")
        let sub = analyzing ? L("解析が終わると曲全体がそのまま並びます。IN / OUT とつなぎ方はあとから設定します", "When done, whole tracks are lined up. Set IN / OUT and transitions afterwards") : L("MP3・WAV・AIFF・M4A・FLAC ／ フォルダごとでもOK ／ ツールバーの ＋ からも追加できます", "MP3 · WAV · AIFF · M4A · FLAC — folders work too — or use ＋ in the toolbar")
        let para = NSMutableParagraphStyle()
        para.alignment = .center
        let titleAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 17, weight: .semibold),
            .foregroundColor: NSColor.white.withAlphaComponent(0.85),
            .paragraphStyle: para,
        ]
        let subAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12),
            .foregroundColor: NSColor.white.withAlphaComponent(0.45),
            .paragraphStyle: para,
        ]
        (title as NSString).draw(in: NSRect(x: area.minX, y: y, width: area.width, height: 24), withAttributes: titleAttrs)
        (sub as NSString).draw(in: NSRect(x: area.minX, y: y + 26, width: area.width, height: 20), withAttributes: subAttrs)
    }

    private func drawDropAndLabels() {
        if let d = dropTime, !store.clips.isEmpty {
            let appending = dropIndex >= store.clips.count
            let px = appending ? x(for: store.mixDuration) : x(for: store.clips[dropIndex].start)
            NSColor.controlAccentColor.setFill()
            NSRect(x: px - 1, y: lanesTop, width: 2, height: lanesBottom - lanesTop).fill()
            let label = appending ? L("ミックスの末尾に追加", "Add to the end of the mix") : L("\(dropIndex + 1)曲目として挿入", "Insert as track \(dropIndex + 1)")
            drawPill(label, at: NSPoint(x: px + 6, y: lanesTop + 6), fill: .controlAccentColor)
            _ = d
        }
        if let label = dragLabel {
            drawPill(label.text, at: NSPoint(x: label.point.x + 14, y: max(lanesTop + 4, label.point.y - 30)), fill: Theme.chipBG)
        }
    }

    private func drawPill(_ text: String, at origin: NSPoint, fill: NSColor) {
        let string = NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: NSColor.white,
        ])
        let s = string.size()
        var rect = NSRect(x: origin.x, y: origin.y, width: s.width + 18, height: 22)
        let vr = viewport
        if rect.maxX > vr.maxX - 6 { rect.origin.x = vr.maxX - 6 - rect.width }
        let path = NSBezierPath(roundedRect: rect, xRadius: 11, yRadius: 11)
        fill.setFill()
        path.fill()
        NSColor.white.withAlphaComponent(0.25).setStroke()
        path.lineWidth = 1
        path.stroke()
        string.draw(at: NSPoint(x: rect.minX + 9, y: rect.midY - s.height / 2))
    }

    private func drawPlayhead(_ area: NSRect) {
        let px = x(for: store.playhead)
        guard px >= area.minX - 10, px <= area.maxX + 10 else { return }
        Theme.playhead.setFill()
        NSRect(x: px - 0.75, y: rulerHeight - 6, width: 1.5, height: bounds.height).fill()
        let head = NSBezierPath()
        head.move(to: NSPoint(x: px - 6, y: rulerHeight - 12))
        head.line(to: NSPoint(x: px + 6, y: rulerHeight - 12))
        head.line(to: NSPoint(x: px + 6, y: rulerHeight - 5))
        head.line(to: NSPoint(x: px, y: rulerHeight))
        head.line(to: NSPoint(x: px - 6, y: rulerHeight - 5))
        head.close()
        head.fill()
    }

    // MARK: - Hit testing

    func region(at p: NSPoint) -> Hit {
        if p.y < rulerHeight { return .ruler }
        for (id, r) in chipRects where r.insetBy(dx: -3, dy: -3).contains(p) {
            return .transition(id)
        }
        let master = store.masterBPM
        for i in store.clips.indices.reversed() {
            let r = clipRect(i)
            guard r.contains(p) else { continue }
            let c = store.clips[i]
            let h = handlePoints(c, rect: r, master: master)
            if i == 0, hypot(p.x - h.fadeIn.x, p.y - h.fadeIn.y) < 13 { return .clip(c.id, .fadeIn) }
            if i == store.clips.count - 1, hypot(p.x - h.fadeOut.x, p.y - h.fadeOut.y) < 13 { return .clip(c.id, .fadeOut) }
            if r.width > 28 {
                if p.x - r.minX < 7 { return .clip(c.id, .trimLeft) }
                if r.maxX - p.x < 7 { return .clip(c.id, .trimRight) }
            }
            return .clip(c.id, .body)
        }
        if p.y >= lanesTop && p.y <= lanesBottom { return .emptyLane }
        return .none
    }

    // MARK: - Mouse

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: .zero,
                                  options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
                                  owner: self,
                                  userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseMoved(with event: NSEvent) {
        guard drag == nil else { return }
        let p = convert(event.locationInWindow, from: nil)
        var hover: UUID?
        switch region(at: p) {
        case .clip(let id, let part):
            hover = id
            switch part {
            case .trimLeft, .trimRight: NSCursor.resizeLeftRight.set()
            case .fadeIn, .fadeOut: NSCursor.pointingHand.set()
            case .body:
                if store.index(of: id) == 0 { NSCursor.arrow.set() } else { NSCursor.openHand.set() }
            }
        case .transition:
            NSCursor.pointingHand.set()
        default:
            NSCursor.arrow.set()
        }
        if hover != hoverClip {
            hoverClip = hover
            needsDisplay = true
        }
    }

    override func mouseExited(with event: NSEvent) {
        hoverClip = nil
        NSCursor.arrow.set()
        needsDisplay = true
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let p = convert(event.locationInWindow, from: nil)
        let t = time(at: p.x)
        var hit = region(at: p)
        if case .transition(let id) = hit {
            if event.clickCount >= 2 {
                store.openTransitionEditor(id)
                return
            }
            // Dragging a transition chip moves the entry point, like dragging the incoming track.
            store.selectedClipID = id
            store.showInspector = true
            hit = .clip(id, .body)
        }
        switch hit {
        case .ruler:
            followSuspendedUntil = .distantPast
            store.beginScrub()
            store.scrub(to: t)
            drag = DragState(hit: hit, startPoint: p, startTime: t)
        case .emptyLane:
            store.selectedClipID = nil
            store.seek(t)
        case .clip(let id, let part):
            store.selectedClipID = id
            if event.clickCount >= 2 {
                store.openCueEditor(id)
                drag = nil
                return
            }
            guard let i = store.index(of: id) else { return }
            let clip = store.clips[i]
            var value = 0.0
            switch part {
            case .body:
                value = i > 0 ? store.clips[i - 1].mixOutBar : 0
            case .trimLeft:
                value = clip.mixInBar
            case .trimRight:
                if i + 1 < store.clips.count {
                    value = store.clips[i + 1].transitionBars
                } else {
                    value = clip.endBar ?? clip.bar(atSource: clip.trimEnd)
                }
            case .fadeIn:
                value = clip.fadeInBeats
            case .fadeOut:
                value = clip.fadeOutBeats
            }
            drag = DragState(hit: hit, startPoint: p, startTime: t, original: clip, originalValue: value,
                             originalPrev: i > 0 ? store.clips[i - 1] : nil, slip: event.modifierFlags.contains(.command))
        case .transition, .none:
            break
        }
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard var d = drag else { return }
        _ = autoscroll(with: event)
        let p = convert(event.locationInWindow, from: nil)
        let t = time(at: p.x)
        let fine = event.modifierFlags.contains(.option)

        switch d.hit {
        case .ruler:
            store.scrub(to: t)

        case .clip(let id, let part):
            guard let orig = d.original, let i = store.index(of: id) else { break }
            if !d.moved {
                guard abs(p.x - d.startPoint.x) >= 3 else { return }
                d.moved = true
                store.pushUndo()
                store.isInteracting = true
                if part == .body { NSCursor.closedHand.set() }
            }
            let master = store.masterBPM
            let unit = fine ? 0.25 : store.snap.bars
            let deltaBars = (t - d.startTime) / store.barLength
            let steps = (deltaBars / unit).rounded() * unit
            let isLast = i == store.clips.count - 1

            switch part {
            case .body where d.slip:
                // ⌘-drag: the audio slides with the mouse inside the box.
                store.slipContent(id, by: -steps, origIn: orig.mixInBar, origOut: orig.mixOutBar, origEnd: orig.endBar)
                if let c = store.clip(id) {
                    dragLabel = (L("中身をずらす · \(Clip.barLabel(c.mixInBar))小節目から", "Slip · from bar \(Clip.barLabel(c.mixInBar))"), p)
                }

            case .body:
                guard i > 0 else {
                    dragLabel = (L("最初の曲は動かせません（⌘ドラッグで中身をずらす・左端で開始位置）", "The first track stays at the start (⌘-drag slides its audio; drag its left edge to trim)"), p)
                    break
                }
                // The whole track (and everything after it) moves with the mouse.
                let value = d.originalValue + steps
                store.setEntryPoint(id, previousMixOut: value, undoable: false)
                let prev = store.clips[i - 1]
                dragLabel = (L("「\(prev.title)」の \(Clip.barLabel(prev.mixOutBar))小節目から入る", "Enter at bar \(Clip.barLabel(prev.mixOutBar)) of “\(prev.title)”"), p)

            case .trimLeft:
                if i > 0, let prevOrig = d.originalPrev {
                    // The edge follows the mouse; this track's audio and the previous track's end stay put,
                    // so the overlap between the two gets longer / shorter.
                    store.dragIncomingEdge(id, by: steps, origIn: orig.mixInBar, origPrevOut: prevOrig.mixOutBar,
                                           origBars: orig.transitionBars)
                    if let c = store.clip(id) {
                        dragLabel = (c.transitionBars < 0.01
                                     ? L("重なりなし（\(Clip.barLabel(c.mixInBar))小節目から直結）", "No overlap (straight in at bar \(Clip.barLabel(c.mixInBar)))")
                                     : L("重なり \(Fmt.bars(c.transitionBars)) · \(Clip.barLabel(c.mixInBar))小節目から", "Overlap \(Fmt.bars(c.transitionBars)) · from bar \(Clip.barLabel(c.mixInBar))"), p)
                    }
                } else {
                    // First track: where it starts. The mix always begins at 0, so the view is drawn shifted
                    // during the drag to keep the audio under the mouse.
                    let moved = store.dragFirstStart(id, by: steps, origIn: orig.mixInBar)
                    leadShift = moved * store.barLength
                    if let c = store.clip(id) {
                        dragLabel = (L("開始: \(Clip.barLabel(c.mixInBar))小節目", "Start: bar \(Clip.barLabel(c.mixInBar))"), p)
                    }
                }

            case .trimRight:
                if !isLast {
                    let next = store.clips[i + 1]
                    store.setTransitionLength(next.id, bars: d.originalValue + steps, undoable: false, makeRoom: false)
                    if let n = store.clip(next.id) {
                        dragLabel = (n.transitionBars < 0.01 ? L("直結（重ねない）", "Direct (no overlap)") : L("トランジション: \(Fmt.bars(n.transitionBars))", "Transition: \(Fmt.bars(n.transitionBars))"), p)
                    }
                } else {
                    let maxBar = orig.lastBar
                    let value = min(maxBar, d.originalValue + steps)
                    store.setEndBar(id, bar: value >= maxBar - 0.01 ? nil : value, undoable: false)
                    dragLabel = (L("終了: \(Clip.barLabel(value))小節目", "End: bar \(Clip.barLabel(value))"), p)
                }

            case .fadeIn:
                let beat = 60 / master
                let maxBeats = max(0, orig.length(master: master) / beat - orig.fadeOutBeats)
                var beats = max(0, (t - orig.start) / beat)
                beats = fine ? beats : beats.rounded()
                beats = min(beats, maxBeats)
                store.updateClip(id, undoable: false) { $0.fadeInBeats = beats }
                dragLabel = (L("フェードイン: \(Fmt.beats(beats))", "Fade in: \(Fmt.beats(beats))"), p)

            case .fadeOut:
                let beat = 60 / master
                let maxBeats = max(0, orig.length(master: master) / beat - orig.fadeInBeats)
                var beats = max(0, (orig.end(master: master) - t) / beat)
                beats = fine ? beats : beats.rounded()
                beats = min(beats, maxBeats)
                store.updateClip(id, undoable: false) { $0.fadeOutBeats = beats }
                dragLabel = (L("フェードアウト: \(Fmt.beats(beats))", "Fade out: \(Fmt.beats(beats))"), p)
            }

        default:
            break
        }
        drag = d
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        defer {
            drag = nil
            dragLabel = nil
            needsDisplay = true
        }
        guard let d = drag else { return }
        let p = convert(event.locationInWindow, from: nil)
        store.isInteracting = false
        switch d.hit {
        case .ruler:
            store.endScrub(at: time(at: p.x))
        case .clip(_, let part):
            if leadShift != 0 {
                // Keep the audio where it was on screen once the mix moves back to start at 0.
                let shiftX = CGFloat(leadShift * pps)
                leadShift = 0
                updateDocumentSize()
                scroll(toX: viewport.minX - shiftX)
            }
            if d.moved {
                drag = nil
                updateDocumentSize()
                store.finishTimingEdit()
                if part == .body { NSCursor.openHand.set() }
            }
        default:
            break
        }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let p = convert(event.locationInWindow, from: nil)
        let t = max(0, time(at: p.x))
        let menu = NSMenu()
        let store = self.store
        if case .clip(let id, _) = region(at: p), let clip = store.clip(id) {
            store.selectedClipID = id
            menu.addItem(ActionMenuItem(L("CUE（IN / OUT）を編集…", "Edit Cues (IN / OUT)…")) { store.openCueEditor(id) })
            menu.addItem(ActionMenuItem(L("ライブラリに戻す", "Move Back to Library")) { store.removeFromMix(id) })
            if let i = store.index(of: id), i > 0 {
                menu.addItem(ActionMenuItem(L("つなぎエディタで描く…", "Draw in Transition Editor…")) { store.openTransitionEditor(id) })
                if let sim = store.simplification(at: i) {
                    menu.addItem(ActionMenuItem(L("つなぎを簡単にする（\(Fmt.bars(sim.oldBars)) → \(Fmt.bars(sim.newBars))・音は同じ）",
                                                  "Simplify Transition (\(Fmt.bars(sim.oldBars)) → \(Fmt.bars(sim.newBars)), same sound)")) {
                        store.simplifyTransition(into: id)
                    })
                }
            }
            menu.addItem(.separator())
            menu.addItem(ActionMenuItem(L("ここから再生", "Play from Here")) {
                store.seek(t)
                if !store.isPlaying { store.play() }
            })
            menu.addItem(.separator())
            menu.addItem(ActionMenuItem(L("曲の情報（ジャケット・アーティスト）を編集…", "Edit Track Info (Artwork, Artist)…")) { store.openProfileEditor(id) })
            menu.addItem(.separator())
            menu.addItem(ActionMenuItem(L("BPMを2倍にする（\(Fmt.bpm(clip.bpm * 2))）", "Double BPM (\(Fmt.bpm(clip.bpm * 2)))")) { store.scaleClipBPM(id, by: 2) })
            menu.addItem(ActionMenuItem(L("BPMを半分にする（\(Fmt.bpm(clip.bpm / 2))）", "Halve BPM (\(Fmt.bpm(clip.bpm / 2)))")) { store.scaleClipBPM(id, by: 0.5) })
            menu.addItem(ActionMenuItem(L("BPMを再解析", "Re-analyze BPM")) { store.reanalyze(id) })
            menu.addItem(.separator())
            menu.addItem(ActionMenuItem(L("入口を1小節目にする", "Set Mix-In to Bar 1")) { store.trimToFirstDownbeat(id) })
            menu.addItem(ActionMenuItem(L("曲の頭から再生する", "Play From the Very Start")) { store.resetTrim(id) })
            menu.addItem(.separator())
            if let bar = store.sourceBar(id, atTimeline: t) {
                let loops = NSMenu()
                for bars in [0.25, 0.5, 1, 2, 4, 8, 16, 32] {
                    let title = bars < 1 ? L("\(Int(bars * 4))拍", "\(Int(bars * 4)) beat" + (bars > 0.25 ? "s" : "")) : L("\(Int(bars))小節", "\(Int(bars)) bar" + (bars > 1 ? "s" : ""))
                    loops.addItem(ActionMenuItem(title + L("（×2）", " (×2)")) { store.addLoop(id, atBar: bar, bars: bars, repeats: 1) })
                }
                let loopParent = NSMenuItem(title: L("ここからループ", "Loop From Here"), action: nil, keyEquivalent: "")
                loopParent.submenu = loops
                menu.addItem(loopParent)
                let jumps = NSMenu()
                for bars in [1.0, 2, 4, 8, 16, 32] {
                    jumps.addItem(ActionMenuItem(L("\(Int(bars))小節先へ", "\(Int(bars)) bar" + (bars > 1 ? "s" : "") + " ahead")) { store.addJump(id, atBar: bar, bars: bars) })
                }
                let jumpParent = NSMenuItem(title: L("ここでビートジャンプ", "Beat Jump Here"), action: nil, keyEquivalent: "")
                jumpParent.submenu = jumps
                menu.addItem(jumpParent)
            }
            if let bar = store.sourceBar(id, atTimeline: t) {
                let fxMenu = NSMenu()
                for kind in FXKind.allCases {
                    let item = ActionMenuItem(kind.title) {
                        let start = (bar * 4).rounded(.down) / 4
                        if let fxID = store.addFX(id, kind: kind, atBar: start) {
                            store.inspectorTab = .fx
                            store.focusedFX = fxID
                        }
                    }
                    item.image = NSImage(systemSymbolName: kind.symbol, accessibilityDescription: nil)
                    fxMenu.addItem(item)
                }
                let fxParent = NSMenuItem(title: L("ここにエフェクト", "Add Effect Here"), action: nil, keyEquivalent: "")
                fxParent.submenu = fxMenu
                menu.addItem(fxParent)
            }
            if clip.fx?.isEmpty == false {
                menu.addItem(ActionMenuItem(L("この曲のエフェクトをすべて解除", "Clear All Effects")) { store.removeAllFX(id) })
            }
            if clip.hasEdits {
                menu.addItem(ActionMenuItem(L("この曲のループ／ジャンプをすべて解除", "Clear All Loops / Jumps")) { store.removeAllEdits(id) })
            }
            if let i = store.index(of: id), i > 0 {
                let sub = NSMenu()
                for bars in [0.0, 4, 8, 16, 32] {
                    let title = bars == 0 ? L("直結（重ねない）", "Direct (no overlap)") : L("\(Int(bars))小節", "\(Int(bars)) bars")
                    let item = ActionMenuItem(title) { store.setTransitionLength(id, bars: bars) }
                    item.state = abs(clip.transitionBars - bars) < 0.01 ? .on : .off
                    sub.addItem(item)
                }
                let parent = NSMenuItem(title: L("トランジションの長さ", "Transition Length"), action: nil, keyEquivalent: "")
                parent.submenu = sub
                menu.addItem(parent)
                let styles = NSMenu()
                for style in TransitionStyle.allCases {
                    let item = ActionMenuItem(style.title) { store.setTransitionStyle(id, style) }
                    item.state = clip.transition == style ? .on : .off
                    styles.addItem(item)
                }
                let styleParent = NSMenuItem(title: L("トランジションの種類", "Transition Type"), action: nil, keyEquivalent: "")
                styleParent.submenu = styles
                menu.addItem(styleParent)
                _ = i
            }
            menu.addItem(.separator())
            menu.addItem(ActionMenuItem(L("Finderで表示", "Show in Finder")) { store.revealInFinder(id) })
            menu.addItem(ActionMenuItem(L("ミックスから削除", "Remove from Mix")) { store.deleteClip(id) })
        } else {
            menu.addItem(ActionMenuItem(L("再生位置をここに移動", "Move Playhead Here")) { store.seek(t) })
            menu.addItem(ActionMenuItem(L("曲を追加…", "Add Tracks…")) { store.presentAddFiles() })
            menu.addItem(ActionMenuItem(L("全体を自動ミックス", "Auto-Mix Everything"), enabled: store.clips.count > 1) { store.autoMixAll() })
        }
        return menu
    }

    // MARK: - Scroll & zoom

    override func scrollWheel(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        suspendFollow()
        if event.modifierFlags.contains(.command) {
            let k = event.hasPreciseScrollingDeltas ? 0.01 : 0.08
            zoom(by: exp(Double(event.scrollingDeltaY) * k), at: p)
            return
        }
        let dx = event.scrollingDeltaX
        let dy = event.scrollingDeltaY
        if abs(dx) >= abs(dy) {
            super.scrollWheel(with: event)
            return
        }
        let multiplier: CGFloat = event.hasPreciseScrollingDeltas ? 1 : 14
        scroll(toX: viewport.minX - dy * multiplier)
    }

    override func magnify(with event: NSEvent) {
        suspendFollow()
        zoom(by: 1 + Double(event.magnification), at: convert(event.locationInWindow, from: nil))
    }

    // MARK: - Keyboard

    override func keyDown(with event: NSEvent) {
        let shift = event.modifierFlags.contains(.shift)
        let option = event.modifierFlags.contains(.option)
        let beat = store.beatLength
        switch event.keyCode {
        case 123, 124: // left / right: move the entry point of the selected track
            let direction: Double = event.keyCode == 123 ? -1 : 1
            if let id = store.selectedClipID, let i = store.index(of: id), i > 0 {
                let bars = option ? 0.25 : (shift ? 4.0 : 1.0)
                store.moveEntry(id, byBars: direction * bars)
            } else {
                store.seek(store.playhead + direction * (shift ? beat * 16 : beat * 4))
            }
        case 53: // escape
            store.selectedClipID = nil
        case 24, 69: // = / keypad +
            store.zoom(by: 1.4)
        case 27, 78: // - / keypad -
            store.zoom(by: 1 / 1.4)
        default:
            super.keyDown(with: event)
        }
    }

    // MARK: - Drag & drop from Finder

    private func fileURLs(from info: NSDraggingInfo) -> [URL] {
        let objects = info.draggingPasteboard.readObjects(forClasses: [NSURL.self],
                                                          options: [.urlReadingFileURLsOnly: true])
        return (objects as? [URL]) ?? []
    }

    private func updateDrop(_ info: NSDraggingInfo) -> NSDragOperation {
        guard !fileURLs(from: info).isEmpty else { return [] }
        let p = convert(info.draggingLocation, from: nil)
        let t = max(0, time(at: p.x))
        dropTime = t
        dropIndex = store.lockSafeIndex(store.insertionIndex(forTime: t))
        needsDisplay = true
        return .copy
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        updateDrop(sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        updateDrop(sender)
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        dropTime = nil
        needsDisplay = true
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = fileURLs(from: sender)
        let index = dropIndex
        dropTime = nil
        needsDisplay = true
        guard !urls.isEmpty else { return false }
        store.addFiles(urls, to: .mix(index >= store.clips.count ? nil : index))
        return true
    }
}
