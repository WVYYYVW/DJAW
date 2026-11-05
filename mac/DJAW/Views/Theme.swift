import AppKit
import SwiftUI

enum Theme {
    static let timelineBG = NSColor(calibratedRed: 0.071, green: 0.074, blue: 0.086, alpha: 1)
    static let laneBG = NSColor(calibratedRed: 0.098, green: 0.102, blue: 0.118, alpha: 1)
    static let rulerBG = NSColor(calibratedRed: 0.118, green: 0.122, blue: 0.141, alpha: 1)
    static let chipBG = NSColor(calibratedRed: 0.17, green: 0.175, blue: 0.2, alpha: 1)
    static let playhead = NSColor(calibratedRed: 1.0, green: 0.36, blue: 0.32, alpha: 1)

    static var panel: Color { Color(nsColor: rulerBG) }
    static var background: Color { Color(nsColor: timelineBG) }
}

/// One type scale for the whole app, so numbers, labels and titles feel like one instrument.
/// - display: large tempo / position numbers — light weight, tabular digits
/// - readout: values that change (bars, times, BPM) — monospaced, medium
/// - label: small hardware-style captions (DECK, HIGH, KILL…) — semibold, slightly tracked
/// - title: track names and headings — semibold system
enum Typo {
    static func display(_ size: CGFloat) -> Font { .system(size: size, weight: .light).monospacedDigit() }
    static func readout(_ size: CGFloat, _ weight: Font.Weight = .medium) -> Font { .system(size: size, weight: weight, design: .monospaced) }
    static func label(_ size: CGFloat = 9) -> Font { .system(size: size, weight: .semibold) }
    static func title(_ size: CGFloat = 13) -> Font { .system(size: size, weight: .semibold) }
    static func body(_ size: CGFloat = 11) -> Font { .system(size: size, weight: .regular) }

    static let labelTracking: CGFloat = 0.6

    // AppKit equivalents for the timeline
    static func nsTitle(_ size: CGFloat) -> NSFont { .systemFont(ofSize: size, weight: .semibold) }
    static func nsLabel(_ size: CGFloat) -> NSFont { .systemFont(ofSize: size, weight: .semibold) }
    static func nsReadout(_ size: CGFloat, _ weight: NSFont.Weight = .medium) -> NSFont { .monospacedDigitSystemFont(ofSize: size, weight: weight) }
}

extension NSColor {
    /// Track colour palette, cycled by index.
    static func clip(_ index: Int) -> NSColor {
        NSColor(calibratedHue: CGFloat(ClipPalette.hue(index)), saturation: 0.62, brightness: 0.96, alpha: 1)
    }
}

extension Color {
    static func clip(_ index: Int) -> Color { Color(nsColor: .clip(index)) }
}

enum Fmt {
    /// 1:05.2
    static func time(_ t: Double) -> String {
        let s = max(0, t)
        let m = Int(s) / 60
        return String(format: "%d:%04.1f", m, s - Double(m * 60))
    }

    /// 1:05.23
    static func clock(_ t: Double) -> String {
        let s = max(0, t)
        let m = Int(s) / 60
        return String(format: "%d:%05.2f", m, s - Double(m * 60))
    }

    /// 5:32
    static func duration(_ t: Double) -> String {
        let s = Int(max(0, t).rounded())
        if s >= 3600 {
            return String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60)
        }
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    static func bpm(_ b: Double) -> String {
        guard b > 0 else { return "—" }
        if abs(b - b.rounded()) < 0.005 { return String(format: "%.0f", b) }
        return String(format: "%.2f", b)
    }

    static func db(_ d: Double) -> String {
        abs(d) < 0.05 ? "0 dB" : String(format: "%+.1f dB", d)
    }

    static func bars(_ bars: Double) -> String {
        if abs(bars - bars.rounded()) < 0.05 {
            let n = Int(bars.rounded())
            return L("\(n)小節", n == 1 ? "1 bar" : "\(n) bars")
        }
        return L(String(format: "%.1f小節", bars), String(format: "%.1f bars", bars))
    }

    /// "97小節目" / "bar 97"
    static func barOrdinal(_ bar: Double) -> String {
        L("\(Clip.barLabel(bar))小節目", "bar \(Clip.barLabel(bar))")
    }

    static func beats(_ beats: Double) -> String {
        if beats < 0.01 { return L("なし", "off") }
        if abs(beats / 4 - (beats / 4).rounded()) < 0.01 { return bars(beats / 4) }
        if abs(beats - beats.rounded()) < 0.01 {
            let n = Int(beats.rounded())
            return L("\(n)拍", n == 1 ? "1 beat" : "\(n) beats")
        }
        return L(String(format: "%.1f拍", beats), String(format: "%.1f beats", beats))
    }

    static func ratePercent(_ rate: Double) -> String {
        let p = (rate - 1) * 100
        if abs(p) < 0.05 { return "±0%" }
        return String(format: "%+.1f%%", p)
    }
}
