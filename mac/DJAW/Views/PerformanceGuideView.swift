import SwiftUI
import AppKit
import UniformTypeIdentifiers

/// How to play the current set live (decks, mixer moves step by step) and the track list for SoundCloud etc.
struct PerformanceGuideView: View {
    @Environment(MixStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var tab = 0
    @State private var numbered = false
    @State private var copied: String?

    private var guide: PerformanceGuide.Guide {
        PerformanceGuide.build(clips: store.clips, master: store.masterBPM, tempo: store.tempoMap)
    }

    private var trackList: String {
        PerformanceGuide.trackList(clips: store.clips, master: store.masterBPM, tempo: store.tempoMap, numbered: numbered)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("", selection: $tab) {
                    Text(L("演奏手順", "How to Play")).tag(0)
                    Text(L("曲リスト", "Track List")).tag(1)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 260)
                Spacer()
                if let copied {
                    Text(copied).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(12)
            Divider()
            if tab == 0 { guideBody } else { listBody }
            Divider()
            HStack {
                if tab == 0 {
                    Button(L("手順をコピー", "Copy Steps")) { copy(PerformanceGuide.text(guide), L("手順をコピーしました", "Steps copied")) }
                    Button(L("テキストで保存…", "Save as Text…")) { save() }
                } else {
                    Toggle(L("番号を付ける", "Numbered"), isOn: $numbered)
                    Button(L("曲リストをコピー", "Copy Track List")) { copy(trackList, L("曲リストをコピーしました", "Track list copied")) }
                        .keyboardShortcut("c", modifiers: [.command, .shift])
                }
                Spacer()
                Button(L("閉じる", "Close")) { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(12)
        }
        .frame(minWidth: 760, idealWidth: 860, minHeight: 520, idealHeight: 680)
    }

    private var guideBody: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(guide.overview, id: \.self) { line in
                        Text("・" + line).font(.callout).foregroundStyle(.secondary)
                    }
                }
                ForEach(guide.tracks) { t in
                    GuideTrackSection(track: t)
                    Divider()
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var listBody: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L("SoundCloud などの概要欄にそのまま貼り付けられる形です（時刻は、つなぎの線から判定した、前の曲から切り替わる位置）。",
                   "Ready to paste into a SoundCloud description (times are where each track takes over, read from the transition curves)."))
                .font(.callout).foregroundStyle(.secondary)
            ScrollView {
                Text(trackList)
                    .font(.body.monospacedDigit())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.2)))
        }
        .padding(16)
    }

    private func copy(_ s: String, _ message: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
        copied = message
    }

    private func save() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.plainText]
        panel.nameFieldStringValue = store.documentTitle + L(" 演奏手順.txt", " - how to play.txt")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let text = PerformanceGuide.text(guide) + "\n\n" + L("■ 曲リスト", "■ Track list") + "\n" + trackList
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            store.alertMessage = error.localizedDescription
        }
    }
}

/// One track of the playing guide: deck, setup and the timed steps.
private struct GuideTrackSection: View {
    let track: PerformanceGuide.Track

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("\(track.number)")
                    .font(.headline.monospacedDigit())
                    .frame(width: 26, height: 26)
                    .background(Circle().fill(deckColor))
                Text(L("デッキ\(track.deck)", "Deck \(track.deck)")).font(.headline)
                Text(track.title).font(.headline).lineLimit(1).truncationMode(.middle)
            }
            ForEach(Array(track.setup.enumerated()), id: \.offset) { item in
                Text("・" + item.element).font(.callout).padding(.leading, 34)
            }
            SwiftUI.Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 5) {
                ForEach(track.steps) { step in
                    GuideStepRow(step: step)
                }
            }
            .padding(.leading, 34)
        }
    }

    private var deckColor: Color {
        track.deck == "A" ? Color.blue.opacity(0.35) : Color.orange.opacity(0.35)
    }
}

private struct GuideStepRow: View {
    let step: PerformanceGuide.Step

    var body: some View {
        SwiftUI.GridRow {
            Text(PerformanceGuide.timeText(step.time))
                .font(.callout.monospacedDigit())
                .foregroundStyle(Color.secondary)
            Text(step.position)
                .font(.callout.monospacedDigit())
                .foregroundStyle(Color.secondary)
            Text((step.isPrep ? L("（準備）", "(prep) ") : "") + step.text)
                .font(.callout)
                .foregroundStyle(step.isPrep ? Color.secondary : Color.primary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }
}
