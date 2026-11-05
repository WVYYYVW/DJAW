import Foundation
import CoreGraphics
import CoreText
import CoreImage
import CoreVideo

/// One stretch of a track's structure on the mix's clock (real seconds).
nonisolated struct VisualSection: Sendable {
    var start: Double
    var end: Double
    var kind: SectionKind
    /// The last bars before a drop (the build-up).
    var build: Bool = false
}

/// Draws the visuals for the video export and the live preview.
///
/// Built like club visuals rather than a plain spectrum: a director follows each track's structure
/// (calm in intros and breakdowns, a build-up that tightens, the big hit on the drop, a new look every phrase),
/// a feedback buffer gives trails and depth (the previous frame zoomed, turned and faded, as in MilkDrop),
/// a bloom makes the light glow, colours come from the artwork, and full-screen flashes are limited to at most
/// three a second (photosensitivity guideline).
nonisolated final class VisualPainter {
    let o: VideoExporter.Options
    let tracks: [VideoExporter.TrackVisual]
    let fx: VisualFeatureSource
    let tempo: TempoMap
    let gridOffset: Double
    let master: Double
    let w: CGFloat, h: CGFloat
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    /// Smoothed spectrum (falls slowly like a VU meter).
    private var smooth = [Float](repeating: 0, count: VideoExporter.Features.bands)
    /// The previous frame (before overlays), fed back into the next one.
    private var previous: CGImage?
    private var lastFrame = -10
    private var flashes: [Double] = []
    private static let ci = CIContext(options: [.cacheIntermediates: false])

    init(options: VideoExporter.Options, tracks: [VideoExporter.TrackVisual], features: VisualFeatureSource,
         tempo: TempoMap, gridOffset: Double, master: Double) {
        o = options; self.tracks = tracks; fx = features; self.tempo = tempo; self.gridOffset = gridOffset; self.master = master
        w = CGFloat(options.width); h = CGFloat(options.height)
    }

    // MARK: The moment

    struct Moment {
        var t: Double
        var beat: Double
        var level: CGFloat, low: CGFloat, mid: CGFloat, high: CGFloat, kick: CGFloat
        var hue: Double
        var hue2: Double
        var main: Int
        var incoming: Int?
        var spectrum: [Float]
        /// Direction: how hard the visuals go now (0 calm … 1 full drop), the section, and phrase timing.
        var intensity: CGFloat
        var kind: SectionKind
        var build: CGFloat          // 0…1 through a build-up
        var dropHit: CGFloat        // 1 at a drop's first beat, fading over two beats
        var preDrop: Bool           // the last beat before a drop
        var phrase: Int             // 8-bar phrase number
        var style: VisualStyle      // what is drawn (Auto VJ picks one per section / phrase)
    }

    func moment(_ f: Int) -> Moment {
        let t = Double(f) / Double(o.fps)
        let ref = tempo.reference(atReal: t)
        let beat = (ref - gridOffset) * master / 60
        var main = 0
        for (i, tr) in tracks.enumerated() where tr.landing <= t { main = i }
        var incoming: Int?
        if main + 1 < tracks.count, tracks[main + 1].start <= t { incoming = main + 1 }
        func hues(_ k: Int) -> (Double, Double) {
            let tr = tracks[k]
            if let a = tr.palette.first { return (a, tr.palette.count > 1 ? tr.palette[1] : (a + 0.33).truncatingRemainder(dividingBy: 1)) }
            return (tr.hue, (tr.hue + 0.33).truncatingRemainder(dividingBy: 1))
        }
        var (hue, hue2) = tracks.isEmpty ? (0.6, 0.9) : hues(main)
        if let k = incoming {
            let a = tracks[k].start, b = max(a + 0.01, tracks[k].landing)
            let x = min(1, max(0, (t - a) / (b - a)))
            let (h1, h2) = hues(k)
            hue = mixHue(hue, h1, x); hue2 = mixHue(hue2, h2, x)
        }
        let ff = fx.frame(f) ?? FeatureFrame.silent
        for i in smooth.indices { smooth[i] = max(i < ff.spectrum.count ? ff.spectrum[i] : 0, smooth[i] - 0.035) }

        // Direction from the structure of the track that is playing (the incoming one once it has taken over).
        var kind = SectionKind.drop
        var build: CGFloat = 0, dropHit: CGFloat = 0, preDrop = false
        var intensity: CGFloat = 0.75
        if !tracks.isEmpty, let sec = tracks[main].sections.first(where: { $0.start <= t && t < $0.end }) {
            kind = sec.kind
            let beatSec = 60 / max(1, tempo.bpm(at: ref))
            switch sec.kind {
            case .intro, .outro: intensity = 0.4
            case .breakdown: intensity = 0.3
            case .drop: intensity = 1
            }
            if sec.build {
                build = CGFloat(min(1, max(0, (t - sec.start) / max(0.01, sec.end - sec.start))))
                intensity = 0.4 + 0.5 * build
                preDrop = sec.end - t < beatSec
            }
            if sec.kind == .drop {
                let since = t - sec.start
                dropHit = CGFloat(max(0, 1 - since / (2 * beatSec)))
            }
        }
        // Loudness still matters (a quiet drop is not a big one).
        intensity = min(1, intensity * (0.6 + 0.5 * CGFloat(ff.level)))
        let phrase = Int(floor(beat / 32))
        let style = o.style == .auto ? autoScene(phrase) : o.style
        return Moment(t: t, beat: beat, level: CGFloat(ff.level), low: CGFloat(ff.low), mid: CGFloat(ff.mid),
                      high: CGFloat(ff.high), kick: CGFloat(ff.kick), hue: hue, hue2: hue2, main: main, incoming: incoming,
                      spectrum: smooth, intensity: intensity, kind: kind, build: build, dropHit: dropHit, preDrop: preDrop,
                      phrase: phrase, style: style)
    }

    private func mixHue(_ a: Double, _ b: Double, _ x: Double) -> Double {
        var d = b - a
        if d > 0.5 { d -= 1 } else if d < -0.5 { d += 1 }
        var v = a + d * x
        if v < 0 { v += 1 }
        return v.truncatingRemainder(dividingBy: 1)
    }

    func color(_ hue: Double, _ s: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
        let hh = CGFloat((hue.truncatingRemainder(dividingBy: 1) + 1).truncatingRemainder(dividingBy: 1)) * 6
        let i = Int(hh) % 6, f = hh - floor(hh)
        let b = min(1, max(0, b)), s = min(1, max(0, s))
        let p = b * (1 - s), q = b * (1 - s * f), u = b * (1 - s * (1 - f))
        let (r, g, bl): (CGFloat, CGFloat, CGFloat)
        switch i {
        case 0: (r, g, bl) = (b, u, p)
        case 1: (r, g, bl) = (q, b, p)
        case 2: (r, g, bl) = (p, b, u)
        case 3: (r, g, bl) = (p, q, b)
        case 4: (r, g, bl) = (u, p, b)
        default: (r, g, bl) = (b, p, q)
        }
        return CGColor(colorSpace: space, components: [r, g, bl, min(1, max(0, a))])!
    }


    // MARK: Auto VJ scenes

    /// Scenes are decided once per 8-bar phrase, from what the playing track does in the middle of it, and then
    /// held: a new drop brings the next look straight away, otherwise a look stays at least 16 bars (32 in a
    /// long drop) — so it never flickers between looks on short sections or around transitions.
    private var scenes: [VisualStyle] = []
    private var sceneState: (dropKey: String?, since: Int, dropCount: Int) = (nil, 0, 0)

    private func autoScene(_ phrase: Int) -> VisualStyle {
        let p = max(0, phrase)
        while scenes.count <= p { scenes.append(nextScene(scenes.count)) }
        return scenes[p]
    }

    private func nextScene(_ p: Int) -> VisualStyle {
        // What the playing track does in the middle of this phrase.
        let midBeat = Double(p) * 32 + 16
        let t = tempo.real(gridOffset + midBeat * 60 / max(1, master))
        var main = 0
        for (i, tr) in tracks.enumerated() where tr.landing <= t { main = i }
        let sec = tracks.isEmpty ? nil : tracks[main].sections.first { $0.start <= t && t < $0.end }
        let kind = sec?.kind ?? .drop
        let previous = scenes.last
        let held = p - sceneState.since
        let rotation: [VisualStyle] = [.lasers, .tunnel, .pulse]
        var wanted: VisualStyle
        if kind == .drop {
            let key = "\(main)|\(sec.map { Int($0.start * 10) } ?? -1)"
            if key != sceneState.dropKey {
                // A new drop: the next look in the rotation, at once.
                sceneState.dropKey = key
                sceneState.dropCount += 1
                sceneState.since = p
                return rotation[(sceneState.dropCount - 1) % rotation.count]
            }
            // The same long drop: a new look every 32 bars.
            wanted = held >= 4 ? rotation[(rotation.firstIndex(of: previous ?? .lasers).map { $0 + 1 } ?? 0) % rotation.count] : (previous ?? .lasers)
        } else {
            sceneState.dropKey = nil
            wanted = sec?.build == true ? .tunnel : .pulse
            // Short sections between drops don't flip the look back and forth.
            if let previous, previous != wanted, held < 2 { return previous }
        }
        if wanted != previous { sceneState.since = p }
        return wanted
    }

    // MARK: Frames

    func draw(frame f: Int, into pb: CVPixelBuffer) {
        CVPixelBufferLockBaseAddress(pb, [])
        defer { CVPixelBufferUnlockBaseAddress(pb, []) }
        guard let base = CVPixelBufferGetBaseAddress(pb),
              let ctx = CGContext(data: base, width: o.width, height: o.height, bitsPerComponent: 8,
                                  bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return }
        draw(frame: f, in: ctx)
    }

    /// One frame as an image (the live preview).
    func image(frame f: Int) -> CGImage? {
        guard let ctx = CGContext(data: nil, width: o.width, height: o.height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return nil }
        draw(frame: f, in: ctx)
        return ctx.makeImage()
    }

    func draw(frame f: Int, in ctx: CGContext) {
        // A jump (seek in the preview) starts the trails afresh.
        if abs(f - lastFrame) > 2 { previous = nil; flashes = [] }
        lastFrame = f
        let m = moment(f)
        let full = CGRect(x: 0, y: 0, width: w, height: h)
        background(ctx, m)
        feedback(ctx, m)
        ctx.setBlendMode(.plusLighter)
        switch m.style {
        case .pulse, .auto: pulse(ctx, m)
        case .tunnel: tunnel(ctx, m)
        case .lasers: lasers(ctx, m)
        case .spectrum: spectrumBars(ctx, m)
        }
        ctx.setBlendMode(.normal)
        if m.style == .pulse || (m.style == .auto) { disc(ctx, center: CGPoint(x: w / 2, y: h / 2), radius: h * 0.2 * (1 + 0.07 * m.kick * m.intensity), m) }
        // What is fed back next time: the picture before the glow and the text.
        previous = ctx.makeImage()
        bloom(ctx, m, full)
        flash(ctx, m, full)
        vignette(ctx, full)
        if o.showTrackInfo { trackInfo(ctx, m) }
        if !o.mixTitle.isEmpty, m.t < 6 { title(ctx, o.mixTitle, alpha: CGFloat(min(1, m.t / 0.8, (6 - m.t) / 1))) }
    }

    // MARK: Layers

    private func background(_ ctx: CGContext, _ m: Moment) {
        ctx.setFillColor(CGColor(colorSpace: space, components: [0.01, 0.01, 0.02, 1])!)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        // Darker before the drop, for the contrast when it hits.
        let glow = m.preDrop ? 0.02 : 0.08 + (0.14 + 0.22 * m.kick) * m.intensity
        let g = CGGradient(colorsSpace: space, colors: [color(m.hue, 0.85, glow), color(m.hue2, 0.9, 0)] as CFArray, locations: [0, 1])!
        ctx.drawRadialGradient(g, startCenter: CGPoint(x: w / 2, y: h / 2), startRadius: 0,
                               endCenter: CGPoint(x: w / 2, y: h / 2), endRadius: max(w, h) * 0.75, options: [])
    }

    /// The previous frame, zoomed in a little, turned and faded: trails and a sense of depth.
    private func feedback(_ ctx: CGContext, _ m: Moment) {
        guard let prev = previous, !m.preDrop else { return }
        let zoom: CGFloat = 1.006 + 0.03 * m.intensity * (0.4 + m.kick) + 0.02 * m.build
        let turn = CGFloat(0.0025 * sin(m.beat * .pi / 16)) * (m.kind == .drop ? 1.5 : 0.6)
        let decay: CGFloat = m.kind == .drop ? 0.82 : 0.9
        ctx.saveGState()
        ctx.translateBy(x: w / 2, y: h / 2)
        ctx.rotate(by: turn)
        ctx.scaleBy(x: zoom, y: zoom)
        ctx.setAlpha(decay)
        ctx.interpolationQuality = .low
        ctx.draw(prev, in: CGRect(x: -w / 2, y: -h / 2, width: w, height: h))
        ctx.restoreGState()
    }

    private func bloom(_ ctx: CGContext, _ m: Moment, _ full: CGRect) {
        guard let img = ctx.makeImage() else { return }
        let input = CIImage(cgImage: img)
        let glowed = input.applyingFilter("CIBloom", parameters: [kCIInputRadiusKey: h * 0.02,
                                                                    kCIInputIntensityKey: 0.5 + 0.6 * m.intensity])
            .cropped(to: input.extent)
        guard let out = Self.ci.createCGImage(glowed, from: input.extent) else { return }
        ctx.draw(out, in: full)
    }

    /// A white-ish flash on the drop's first beat and (gently) on strong kicks in drops — never more than three
    /// a second, as photosensitivity guidelines ask.
    private func flash(_ ctx: CGContext, _ m: Moment, _ full: CGRect) {
        flashes.removeAll { m.t - $0 > 1 }
        var a: CGFloat = 0
        if m.dropHit > 0.9 { a = 0.45 }
        else if m.kind == .drop && m.kick > 0.8 && m.intensity > 0.85 { a = 0.12 * m.kick }
        guard a > 0 else { return }
        if flashes.count >= 3 { return }
        if flashes.last.map({ m.t - $0 < 0.3 }) != true { flashes.append(m.t) }
        ctx.setFillColor(color(m.hue2, 0.25, 1, a))
        ctx.fill(full)
    }

    private func vignette(_ ctx: CGContext, _ full: CGRect) {
        let g = CGGradient(colorsSpace: space, colors: [CGColor(colorSpace: space, components: [0, 0, 0, 0])!,
                                                         CGColor(colorSpace: space, components: [0, 0, 0, 0.55])!] as CFArray,
                           locations: [0.55, 1])!
        ctx.drawRadialGradient(g, startCenter: CGPoint(x: w / 2, y: h / 2), startRadius: 0,
                               endCenter: CGPoint(x: w / 2, y: h / 2), endRadius: hypot(w, h) / 2, options: [])
    }

    // MARK: Looks

    private func pulse(_ ctx: CGContext, _ m: Moment) {
        let c = CGPoint(x: w / 2, y: h / 2)
        let r = h * 0.2 * (1 + 0.07 * m.kick * m.intensity)
        let phase = m.beat - floor(m.beat)
        // Rings on the beat (twice as fast in the last bars of a build-up).
        let rate = m.build > 0.5 ? 2.0 : 1.0
        let p0 = (m.beat * rate) - floor(m.beat * rate)
        if m.intensity > 0.35 {
            for k in 0..<3 {
                let p = (p0 + Double(k)) / 3
                let rr = r * (1.1 + CGFloat(p) * 2.4)
                ctx.setStrokeColor(color(m.hue, 0.7, 1, CGFloat(1 - p) * (0.1 + 0.4 * m.intensity)))
                ctx.setLineWidth(h * 0.006)
                ctx.strokeEllipse(in: CGRect(x: c.x - rr, y: c.y - rr, width: rr * 2, height: rr * 2))
            }
        }
        _ = phase
        // Circular spectrum (mirrored left / right).
        let nb = m.spectrum.count
        let bars = nb * 2
        ctx.setLineCap(.round)
        for i in 0..<bars {
            let b = i < nb ? i : bars - 1 - i
            let v = CGFloat(m.spectrum[b])
            let a = Double(i) / Double(bars) * 2 * .pi + .pi / 2 + m.beat * 0.02
            let len = h * 0.02 + h * 0.22 * v * v * (0.5 + 0.5 * m.intensity)
            let p0 = CGPoint(x: c.x + cos(a) * (r * 1.06), y: c.y + sin(a) * (r * 1.06))
            let p1 = CGPoint(x: c.x + cos(a) * (r * 1.06 + len), y: c.y + sin(a) * (r * 1.06 + len))
            ctx.setStrokeColor(color(m.hue + Double(b) / Double(nb) * 0.2, 0.75, 1, 0.45 + 0.5 * v))
            ctx.setLineWidth(max(2, 2 * .pi * r / CGFloat(bars) * 0.55))
            ctx.move(to: p0); ctx.addLine(to: p1); ctx.strokePath()
        }
    }

    private func disc(_ ctx: CGContext, center c: CGPoint, radius r: CGFloat, _ m: Moment) {
        let rect = CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)
        ctx.saveGState()
        ctx.addEllipse(in: rect)
        ctx.clip()
        if !tracks.isEmpty, let img = tracks[m.main].artwork {
            drawFill(ctx, img, in: rect)
        } else {
            let g = CGGradient(colorsSpace: space, colors: [color(m.hue, 0.6, 0.9), color(m.hue2, 0.8, 0.35)] as CFArray, locations: [0, 1])!
            ctx.drawLinearGradient(g, start: CGPoint(x: rect.minX, y: rect.maxY), end: CGPoint(x: rect.maxX, y: rect.minY), options: [])
        }
        if let k = m.incoming, let img = tracks[k].artwork {
            let a = tracks[k].start, b = max(a + 0.01, tracks[k].landing)
            ctx.setAlpha(CGFloat(min(1, max(0, (m.t - a) / (b - a)))))
            drawFill(ctx, img, in: rect)
            ctx.setAlpha(1)
        }
        ctx.restoreGState()
        ctx.setStrokeColor(color(m.hue, 0.5, 1, 0.9))
        ctx.setLineWidth(h * 0.006)
        ctx.strokeEllipse(in: rect)
    }

    private func drawFill(_ ctx: CGContext, _ img: CGImage, in rect: CGRect) {
        let iw = CGFloat(img.width), ih = CGFloat(img.height)
        let s = max(rect.width / iw, rect.height / ih)
        let dw = iw * s, dh = ih * s
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: rect.midX - dw / 2, y: rect.midY - dh / 2, width: dw, height: dh))
    }

    private func tunnel(_ ctx: CGContext, _ m: Moment) {
        let c = CGPoint(x: w / 2, y: h / 2)
        // Faster in drops, drifting in breakdowns, accelerating through a build-up.
        let speed = m.kind == .drop ? 1.0 : (m.build > 0 ? 0.5 + 1.5 * Double(m.build) : 0.25)
        let travel = m.beat * speed
        let phase = travel - floor(travel)
        let n = 16
        let bar = floor(m.beat / 4)
        let sides = m.phrase % 2 == 0 ? 4 : 6
        for k in (0..<n).reversed() {
            let depth = (Double(k) + phase) / Double(n)
            let size = CGFloat(pow(depth, 2.2)) * max(w, h) * 1.3
            guard size > 4 else { continue }
            let rot = CGFloat(m.beat * 0.06 + Double(k) * 0.1 + bar * 0.35) * (m.phrase % 2 == 0 ? 1 : -1)
            let band = m.spectrum[min(m.spectrum.count - 1, k * m.spectrum.count / n)]
            let path = CGMutablePath()
            for s in 0...sides {
                let a = CGFloat(s) / CGFloat(sides) * 2 * .pi + rot
                let p = CGPoint(x: c.x + cos(a) * size / 2, y: c.y + sin(a) * size / 2)
                if s == 0 { path.move(to: p) } else { path.addLine(to: p) }
            }
            ctx.addPath(path)
            ctx.setStrokeColor(color(m.hue + Double(k) * 0.025, 0.8, 1, CGFloat(depth) * (0.2 + 0.8 * CGFloat(band)) * (0.4 + 0.6 * m.intensity)))
            ctx.setLineWidth(h * 0.004 + h * 0.018 * CGFloat(depth) * (0.3 + m.kick * m.intensity))
            ctx.strokePath()
        }
        let g = CGGradient(colorsSpace: space, colors: [color(m.hue2, 0.4, 1, 0.45 * m.kick * m.intensity + 0.08), color(m.hue2, 0.4, 1, 0)] as CFArray, locations: [0, 1])!
        ctx.drawRadialGradient(g, startCenter: c, startRadius: 0, endCenter: c, endRadius: h * 0.35, options: [])
    }

    private func lasers(_ ctx: CGContext, _ m: Moment) {
        let origins = [CGPoint(x: w * 0.5, y: -h * 0.05), CGPoint(x: w * 0.08, y: -h * 0.05), CGPoint(x: w * 0.92, y: -h * 0.05)]
        let barPhase = (m.beat / 4) - floor(m.beat / 4)
        // More beams the harder it goes.
        let beams = 3 + Int((m.intensity * 6).rounded())
        for (oi, o0) in origins.enumerated() {
            if m.intensity < 0.5 && oi > 0 { continue }
            for b in 0..<beams {
                let spread = 0.55 + 0.25 * sin(m.beat * .pi / 4 + Double(oi))
                let base = (Double(b) - Double(beams - 1) / 2) / Double(beams) * spread * 2
                let sweep = sin(barPhase * 2 * .pi + Double(oi) * 2.1) * 0.35
                let a = .pi / 2 + base + sweep * (oi == 0 ? 1 : -1)
                let len = max(w, h) * 1.4
                let end = CGPoint(x: o0.x + CGFloat(cos(a)) * len, y: o0.y + CGFloat(sin(a)) * len)
                let band = CGFloat(m.spectrum[min(m.spectrum.count - 1, (b * 5 + oi * 9) % m.spectrum.count)])
                let alpha = (0.1 + 0.6 * band * (0.4 + m.high)) * (0.4 + 0.6 * m.intensity)
                let hue = oi == 0 ? m.hue : m.hue2
                for (wdt, al) in [(h * 0.024, alpha * 0.22), (h * 0.005, alpha)] {
                    ctx.setStrokeColor(color(hue, 0.85, 1, al))
                    ctx.setLineWidth(wdt)
                    ctx.move(to: o0); ctx.addLine(to: end); ctx.strokePath()
                }
            }
        }
    }

    private func spectrumBars(_ ctx: CGContext, _ m: Moment) {
        let nb = m.spectrum.count
        let left = w * 0.08, right = w * 0.92
        let baseY = h * 0.3
        let bw = (right - left) / CGFloat(nb)
        for b in 0..<nb {
            let v = CGFloat(m.spectrum[b])
            let bh = h * 0.02 + h * 0.42 * v * v
            let x = left + CGFloat(b) * bw
            let rect = CGRect(x: x + bw * 0.12, y: baseY, width: bw * 0.76, height: bh)
            ctx.setFillColor(color(m.hue + Double(b) / Double(nb) * 0.3, 0.75, 1, 0.9))
            ctx.fill(rect)
            ctx.setFillColor(color(m.hue + Double(b) / Double(nb) * 0.3, 0.75, 1, 0.16))
            ctx.fill(CGRect(x: rect.minX, y: baseY - bh * 0.35 - h * 0.01, width: rect.width, height: bh * 0.35))
        }
        let beatInBar = Int(floor(m.beat).truncatingRemainder(dividingBy: 4) + 4) % 4
        for k in 0..<4 {
            let r = h * 0.008
            let x = w / 2 + CGFloat(k - 2) * h * 0.04 + h * 0.02
            ctx.setFillColor(color(m.hue, 0.5, 1, k == beatInBar ? 1 : 0.25))
            ctx.fillEllipse(in: CGRect(x: x - r, y: h * 0.18 - r, width: r * 2, height: r * 2))
        }
    }

    // MARK: Text

    private func font(_ size: CGFloat, bold: Bool) -> CTFont {
        CTFontCreateUIFontForLanguage(bold ? .emphasizedSystem : .system, size, nil)
            ?? CTFontCreateWithName("Helvetica" as CFString, size, nil)
    }

    private func line(_ s: String, size: CGFloat, bold: Bool, alpha: CGFloat, maxWidth: CGFloat) -> CTLine {
        var text = s
        var l = makeLine(text, size, bold, alpha)
        while CTLineGetTypographicBounds(l, nil, nil, nil) > Double(maxWidth), text.count > 4 {
            text = String(text.dropLast(2)) + "…"
            l = makeLine(text, size, bold, alpha)
        }
        return l
    }

    private func makeLine(_ s: String, _ size: CGFloat, _ bold: Bool, _ alpha: CGFloat) -> CTLine {
        let attrs: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key(kCTFontAttributeName as String): font(size, bold: bold),
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(colorSpace: space, components: [1, 1, 1, alpha])!,
        ]
        return CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: attrs))
    }

    private func title(_ ctx: CGContext, _ s: String, alpha: CGFloat) {
        guard alpha > 0 else { return }
        let l = line(s, size: h * 0.06, bold: true, alpha: alpha, maxWidth: w * 0.8)
        let tw = CGFloat(CTLineGetTypographicBounds(l, nil, nil, nil))
        ctx.textPosition = CGPoint(x: (w - tw) / 2, y: h * 0.82)
        CTLineDraw(l, ctx)
    }

    /// A card with artwork, title and artist sliding in when a track takes over; afterwards a small "now playing".
    private func trackInfo(_ ctx: CGContext, _ m: Moment) {
        guard !tracks.isEmpty else { return }
        let tr = tracks[m.main]
        let since = m.t - tr.landing
        let pad = h * 0.035
        if since >= 0 && since < 9 {
            let inT = min(1, since / 0.6), outT = max(0, (since - 8.2) / 0.8)
            let ease = 1 - pow(1 - inT, 3)
            let a = CGFloat(min(1, inT * 2) * (1 - outT))
            guard a > 0 else { return }
            let art = h * 0.14
            let textW = w * 0.42
            let cardW = art + pad * 1.5 + textW
            let cardH = art + pad
            let slide = (1 - CGFloat(ease)) * -(cardW + pad)
            let rect = CGRect(x: pad + slide, y: pad, width: cardW, height: cardH)
            ctx.setFillColor(CGColor(colorSpace: space, components: [0, 0, 0, 0.6 * a])!)
            ctx.addPath(CGPath(roundedRect: rect, cornerWidth: h * 0.015, cornerHeight: h * 0.015, transform: nil))
            ctx.fillPath()
            // A stripe in the track's colour.
            ctx.setFillColor(color(m.hue, 0.8, 1, a))
            ctx.fill(CGRect(x: rect.minX, y: rect.minY + h * 0.012, width: h * 0.006, height: rect.height - h * 0.024))
            let artRect = CGRect(x: rect.minX + pad / 2, y: rect.minY + pad / 2, width: art, height: art)
            ctx.saveGState()
            ctx.setAlpha(a)
            ctx.addPath(CGPath(roundedRect: artRect, cornerWidth: h * 0.01, cornerHeight: h * 0.01, transform: nil))
            ctx.clip()
            if let img = tr.artwork { drawFill(ctx, img, in: artRect) } else { ctx.setFillColor(color(tr.hue, 0.6, 0.8)); ctx.fill(artRect) }
            ctx.restoreGState()
            let tx = artRect.maxX + pad / 2
            let t1 = line(tr.title, size: h * 0.04, bold: true, alpha: a, maxWidth: textW)
            ctx.textPosition = CGPoint(x: tx, y: artRect.minY + art * 0.55)
            CTLineDraw(t1, ctx)
            if !tr.artist.isEmpty {
                let t2 = line(tr.artist, size: h * 0.028, bold: false, alpha: a * 0.8, maxWidth: textW)
                ctx.textPosition = CGPoint(x: tx, y: artRect.minY + art * 0.2)
                CTLineDraw(t2, ctx)
            }
        } else if since >= 9 {
            let s = tr.artist.isEmpty ? tr.title : "\(tr.artist) – \(tr.title)"
            let l = line(s, size: h * 0.022, bold: false, alpha: 0.6, maxWidth: w * 0.6)
            ctx.textPosition = CGPoint(x: pad, y: pad)
            CTLineDraw(l, ctx)
        }
    }

    // MARK: Building the track list

    /// The main colours of an artwork (up to two hues), from a small copy of it.
    static func palette(_ img: CGImage?) -> [Double] {
        guard let img else { return [] }
        let n = 24
        let sp = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(data: nil, width: n, height: n, bitsPerComponent: 8, bytesPerRow: n * 4, space: sp,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let data = ctx.data else { return [] }
        ctx.interpolationQuality = .medium
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: n, height: n))
        let px = data.bindMemory(to: UInt8.self, capacity: n * n * 4)
        var bins = [Double](repeating: 0, count: 12)
        for i in 0..<(n * n) {
            let r = Double(px[i * 4]) / 255, g = Double(px[i * 4 + 1]) / 255, b = Double(px[i * 4 + 2]) / 255
            let mx = max(r, g, b), mn = min(r, g, b)
            let sat = mx > 0 ? (mx - mn) / mx : 0
            guard sat > 0.25, mx > 0.2 else { continue }
            var hue: Double
            let d = mx - mn
            if mx == r { hue = (g - b) / d } else if mx == g { hue = 2 + (b - r) / d } else { hue = 4 + (r - g) / d }
            hue = (hue / 6 + 1).truncatingRemainder(dividingBy: 1)
            bins[Int(hue * 12) % 12] += sat * mx
        }
        let order = bins.indices.sorted { bins[$0] > bins[$1] }
        guard let first = order.first, bins[first] > 2 else { return [] }
        var out = [(Double(first) + 0.5) / 12]
        if let second = order.dropFirst().first(where: { bins[$0] > bins[first] * 0.25 && min(abs($0 - first), 12 - abs($0 - first)) >= 2 }) {
            out.append((Double(second) + 0.5) / 12)
        }
        return out
    }

    /// A track's sections on the mix's clock, with the last 8 bars before each drop marked as the build-up.
    static func sections(clip c: Clip, structure s: TrackStructure?, master: Double, tempo: TempoMap) -> [VisualSection] {
        guard let s else { return [] }
        var out: [VisualSection] = []
        func real(_ bar: Int) -> Double { tempo.real(c.timelineTime(source: s.time(ofBar: Double(bar)), master: master)) }
        for (k, sec) in s.sections.enumerated() {
            let a = real(sec.start), b = real(sec.end)
            guard b > a else { continue }
            let nextIsDrop = k + 1 < s.sections.count && s.sections[k + 1].kind == .drop && sec.kind != .drop
            if nextIsDrop && sec.end - sec.start > 8 {
                let cut = real(sec.end - 8)
                out.append(VisualSection(start: a, end: cut, kind: sec.kind))
                out.append(VisualSection(start: cut, end: b, kind: sec.kind, build: true))
            } else {
                out.append(VisualSection(start: a, end: b, kind: sec.kind, build: nextIsDrop))
            }
        }
        return out
    }
}
