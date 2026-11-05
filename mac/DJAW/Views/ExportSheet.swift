import SwiftUI
import AppKit

struct ExportSheet: View {
    @Environment(MixStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var format: ExportFormat = .wav24
    @State private var withVideo = false
    @State private var style: VisualStyle = .pulse
    @State private var size = "1920x1080"
    @State private var showInfo = true
    @State private var showTitle = true
    private var sampleRate: Binding<Double> { Binding(get: { store.exportSampleRate }, set: { store.exportSampleRate = $0 }) }
    private var normalize: Binding<Bool> { Binding(get: { store.exportNormalize }, set: { store.exportNormalize = $0 }) }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                Image(systemName: "square.and.arrow.up.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("ミックスを書き出し", "Export Mix"))
                        .font(.title3.bold())
                    Text(L("\(store.clips.count)曲 · \(Fmt.duration(store.realMixDuration)) · \(Fmt.bpm(store.masterBPM)) BPM", "\(store.clips.count) tracks · \(Fmt.duration(store.realMixDuration)) · \(Fmt.bpm(store.masterBPM)) BPM"))
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }

            switch store.exportPhase {
            case .idle:
                settings
            case .rendering(let progress):
                VStack(alignment: .leading, spacing: 8) {
                    ProgressView(value: progress)
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        HStack {
                            Text(L("書き出し中… \(Int(progress * 100))%", "Exporting… \(Int(progress * 100))%"))
                            Spacer()
                            Text(remainingText(progress: progress, now: ctx.date))
                        }
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                    }
                }
            case .done(let url):
                Label(L("書き出しが完了しました：\(url.lastPathComponent)", "Export finished: \(url.lastPathComponent)"), systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            case .failed(let message):
                Label(message, systemImage: "xmark.octagon.fill")
                    .foregroundStyle(.red)
            }

            HStack {
                Spacer()
                buttons
            }
        }
        .padding(22)
        .frame(width: 520)
        .onDisappear {
            if case .rendering = store.exportPhase { return }
            store.exportPhase = .idle
        }
    }

    /// "残り 約3分20秒", from the pace of the steady part of the export only (for a video: the drawing of the
    /// frames, which takes most of the time — its audio and analysis before it run much faster and would make an
    /// early estimate far too short).
    private func remainingText(progress p: Double, now: Date) -> String {
        guard let start = store.exportStartedAt else { return "" }
        let elapsed = now.timeIntervalSince(start)
        let elapsedText = L("経過 \(Self.duration(elapsed))", "elapsed \(Self.duration(elapsed))")
        guard let mark = store.exportSteadyMark else {
            return elapsedText + (store.exportSteadyFrom > 0 ? L("・準備中（残り時間は映像を描き始めてから）", " · preparing (estimate once the frames start)")
                                                             : L("・準備中…", " · preparing…"))
        }
        let dp = p - mark.progress, dt = now.timeIntervalSince(mark.at)
        guard dp > 0.01, dt > 5 else { return elapsedText + L("・残り時間を計算中…", " · estimating…") }
        var remaining = max(0, (1 - p) * dt / dp)
        // Shown in steps (5 s, or 10 s above a minute) so it doesn't jitter.
        let step = remaining > 60 ? 10.0 : 5.0
        remaining = (remaining / step).rounded(.up) * step
        return elapsedText + L("・残り 約\(Self.duration(remaining))", " · about \(Self.duration(remaining)) left")
    }

    private static func duration(_ t: Double) -> String {
        let s = Int(t.rounded())
        if s < 60 { return L("\(s)秒", "\(s) s") }
        if s < 3600 { return L("\(s / 60)分\(s % 60)秒", "\(s / 60) min \(s % 60) s") }
        return L("\(s / 3600)時間\(s % 3600 / 60)分", "\(s / 3600) h \(s % 3600 / 60) min")
    }

    private var settings: some View {
        Form {
            Picker(L("書き出すもの", "Export"), selection: $withVideo) {
                Text(L("音声のみ", "Audio only")).tag(false)
                Text(L("映像付き（MP4）", "With visuals (MP4)")).tag(true)
            }
            .pickerStyle(.segmented)
            if withVideo {
                Picker(L("映像", "Visuals"), selection: $style) {
                    ForEach(VisualStyle.allCases) { s in Text(s.title).tag(s) }
                }
                Picker(L("サイズ", "Size"), selection: $size) {
                    Text("1920×1080（HD）").tag("1920x1080")
                    Text("1280×720").tag("1280x720")
                    Text(L("1080×1920（縦・SNS）", "1080×1920 (vertical)")).tag("1080x1920")
                }
                Toggle(L("曲が変わるたびにジャケット・曲名・アーティストを表示", "Show artwork, title and artist when each track starts"), isOn: $showInfo)
                Toggle(L("最初にミックス名を表示", "Show the mix name at the start"), isOn: $showTitle)
                Text(L("映像は曲の音（スペクトラム・低音のキック）とビートのグリッドに合わせて動き、色は各曲の色、中央やカードには「曲の情報」で設定したジャケットを使います。音声は AAC 320kbps で入ります。",
                       "The visuals follow the mix’s spectrum, kicks and beat grid, use each track’s colour, and show the artwork set in Track Info. Audio is AAC 320 kbps."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Picker(L("形式", "Format"), selection: $format) {
                    ForEach(ExportFormat.allCases) { f in Text(f.title).tag(f) }
                }
                .pickerStyle(.segmented)
            }
            Picker(L("サンプルレート", "Sample Rate"), selection: sampleRate) {
                Text("44.1 kHz").tag(44_100.0)
                Text("48 kHz").tag(48_000.0)
            }
            .pickerStyle(.segmented)
            Toggle(L("音割れ防止（ピークを −1 dB に正規化）", "Prevent clipping (normalize peaks to −1 dB)"), isOn: normalize)
            Text(L("正規化をオンにすると、音量の確認のため2回処理するので少し時間がかかります。", "With normalization on, the mix is rendered twice to measure the level, so it takes a little longer."))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .formStyle(.columns)
    }

    @ViewBuilder
    private var buttons: some View {
        switch store.exportPhase {
        case .idle:
            Button(L("キャンセル", "Cancel")) { dismiss() }
                .keyboardShortcut(.cancelAction)
            Button(L("書き出す…", "Export…")) {
                if withVideo {
                    let parts = size.split(separator: "x").compactMap { Int($0) }
                    var o = VideoExporter.Options(audio: .init(format: .wav24, sampleRate: store.exportSampleRate, normalize: store.exportNormalize))
                    o.width = parts.first ?? 1920
                    o.height = parts.count > 1 ? parts[1] : 1080
                    o.style = style
                    o.showTrackInfo = showInfo
                    o.mixTitle = showTitle ? store.documentTitle : ""
                    store.startVideoExport(o)
                } else {
                    store.startExport(format: format, sampleRate: store.exportSampleRate, normalize: store.exportNormalize)
                }
            }
            .keyboardShortcut(.defaultAction)
            .disabled(store.clips.isEmpty)
        case .rendering:
            Button(L("中止", "Stop")) { store.cancelExport() }
                .keyboardShortcut(.cancelAction)
        case .done(let url):
            Button(L("Finderで表示", "Show in Finder")) {
                NSWorkspace.shared.activateFileViewerSelecting([url])
            }
            Button(L("閉じる", "Close")) {
                store.exportPhase = .idle
                dismiss()
            }
            .keyboardShortcut(.defaultAction)
        case .failed:
            Button(L("閉じる", "Close")) {
                store.exportPhase = .idle
                dismiss()
            }
            .keyboardShortcut(.defaultAction)
        }
    }
}
