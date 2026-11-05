import SwiftUI

/// Per-track analysis progress, like a music app's download ring:
/// a dashed circle while waiting in the queue, a filling ring while the track is analysed.
struct AnalysisRing: View {
    let status: AnalysisProgress.FileStatus
    var size: CGFloat = 16

    var body: some View {
        ZStack {
            if status.stage == nil && status.fraction <= 0 {
                Circle()
                    .stroke(Color.secondary.opacity(0.6), style: StrokeStyle(lineWidth: 1.5, dash: [2, 2.2]))
            } else {
                Circle()
                    .stroke(Color.secondary.opacity(0.25), lineWidth: 2)
                Circle()
                    .trim(from: 0, to: max(0.02, status.fraction))
                    .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.linear(duration: 0.4), value: status.fraction)
            }
        }
        .frame(width: size, height: size)
        .help(AnalysisCaption.text(status))
    }
}

/// "待機中・あと約 1 分" / "拍・小節を解析中・あと約 20 秒".
struct AnalysisCaption: View {
    let status: AnalysisProgress.FileStatus

    var body: some View {
        Text(Self.text(status))
            .font(.system(size: 10))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .monospacedDigit()
    }

    static func text(_ s: AnalysisProgress.FileStatus) -> String {
        let eta = s.finishIn < 5 ? L("まもなく完了", "almost done") : L("あと\(AnalysisProgress.format(s.finishIn))", "\(AnalysisProgress.format(s.finishIn)) left")
        if let stage = s.stage {
            return L("\(stage.title)を解析中・\(eta)", "Analysing \(stage.title) · \(eta)")
        }
        return L("待機中・\(eta)", "Waiting · \(eta)")
    }
}
