import SwiftUI

/// Keyboard shortcut reference (Help ▸ Keyboard Shortcuts, ⌘/).
struct ShortcutsView: View {
    @Environment(\.dismiss) private var dismiss

    private struct Item: Identifiable {
        let id = UUID()
        let keys: String
        let text: String
    }

    private var groups: [(String, [Item])] {
        [
            (L("再生", "Playback"), [
                Item(keys: "Space", text: L("再生 / 一時停止", "Play / pause")),
                Item(keys: "Home / End", text: L("先頭 / 最後へ", "Go to start / end")),
                Item(keys: "⌘P", text: L("選択した曲のつなぎを試聴", "Preview the selected transition")),
            ]),
            (L("編集", "Editing"), [
                Item(keys: "⌘Z", text: L("取り消す", "Undo")),
                Item(keys: "⇧⌘Z", text: L("やり直す", "Redo")),
                Item(keys: "⌫", text: L("選択した曲を削除", "Delete the selected track")),
                Item(keys: "⌥⌘C / ⌥⌘V", text: L("つなぎ方をコピー / ペースト", "Copy / paste a transition")),
                Item(keys: "1 – 6", text: L("つなぎ方を適用（カットイン〜ロングミックス）", "Apply a transition recipe (Cut In … Long Mix)")),
                Item(keys: "⇧⌘M", text: L("曲を解析して全体を自動ミックス", "Analyse & auto-mix everything")),
                Item(keys: "⇧⌘A", text: L("おまかせミックス（曲順も自動）", "Auto-arrange (order too)")),
            ]),
            (L("曲", "Tracks"), [
                Item(keys: "⌘↑ / ⌘↓", text: L("前 / 次の曲を選択", "Select previous / next track")),
                Item(keys: "⌘[ / ⌘]", text: L("曲順を前 / 後ろへ", "Move earlier / later in the mix")),
                Item(keys: "← / →", text: L("つなぐ位置を1小節移動（⇧で4小節、⌥で1拍）", "Move the entry 1 bar (⇧ 4 bars, ⌥ 1 beat)")),
                Item(keys: "⌘K", text: L("CUE（IN / OUT）を編集", "Edit cues (IN / OUT)")),
                Item(keys: "⌘T", text: L("つなぎエディタを開く", "Open the transition editor")),
                Item(keys: "⌘↩", text: L("ライブラリの曲をミックスに入れる（複数可）", "Add library track(s) to the mix")),
                Item(keys: L("⌘ / ⇧ + クリック", "⌘ / ⇧ + click"), text: L("ライブラリの曲を複数選択", "Select several library tracks")),
                Item(keys: "⌥⌘A", text: L("ライブラリの曲をすべて選択", "Select all library tracks")),
                Item(keys: "⇧⌘⌫", text: L("ミックスの曲をライブラリに戻す", "Move a mix track back to the library")),
            ]),
            (L("表示", "View"), [
                Item(keys: "⌘+ / ⌘− / ⌘0", text: L("拡大 / 縮小 / 全体表示", "Zoom in / out / fit")),
                Item(keys: L("⌘ + スクロール / ピンチ", "⌘ + scroll / pinch"), text: L("ズーム", "Zoom")),
                Item(keys: "⌥⌘I", text: L("インスペクタの表示切替", "Show / hide the inspector")),
                Item(keys: "⇧⌘D", text: L("デッキの表示切替", "Show / hide the decks")),
                Item(keys: "⇧⌘X", text: L("ミキサーの表示切替", "Show / hide the mixer")),
            ]),
            (L("ファイル", "File"), [
                Item(keys: "⌘N / ⌘O / ⌘S", text: L("新規 / 開く / 保存", "New / open / save")),
                Item(keys: "⇧⌘I", text: L("曲を追加", "Add tracks")),
                Item(keys: "⌥⇧⌘I", text: L("ミュージックから追加", "Add from Music")),
                Item(keys: "⌘E", text: L("書き出し", "Export")),
            ]),
            (L("CUE エディタ", "CUE editor"), [
                Item(keys: "I / L / O", text: L("入口 / 切替完了 / 出口をセット", "Set IN / switch / OUT")),
                Item(keys: "M", text: L("メモCUE", "Memo cue")),
                Item(keys: "← / →", text: L("1小節移動（⇧で4小節）", "Move 1 bar (⇧ 4 bars)")),
            ]),
            (L("つなぎエディタ", "Transition editor"), [
                Item(keys: L("◆をドラッグ", "Drag ◆"), text: L("曲線を曲げる（ダブルクリックで直線）", "Bend the curve (double-click to straighten)")),
                Item(keys: L("空いた所をクリック", "Click empty space"), text: L("点を追加", "Add a point")),
                Item(keys: L("点をダブルクリック / ⌫", "Double-click point / ⌫"), text: L("点を削除", "Delete a point")),
                Item(keys: L("⌥ + ドラッグ", "⌥ + drag"), text: L("スナップなしで動かす", "Move without snapping")),
            ]),
        ]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Label(L("キーボードショートカット", "Keyboard Shortcuts"), systemImage: "keyboard")
                    .font(.title3.bold())
                Spacer()
                Button(L("閉じる", "Close")) { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(20)
            Divider()
            ScrollView {
                // Two independent top-aligned columns (a grid would centre each row
                // and leave the shorter group floating in the middle).
                let all = groups
                HStack(alignment: .top, spacing: 28) {
                    ForEach(0..<2, id: \.self) { col in
                        VStack(alignment: .leading, spacing: 20) {
                            ForEach(Array(all.enumerated()).filter { $0.offset % 2 == col }, id: \.element.0) { _, group in
                                groupView(group)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                }
                .padding(20)
            }
        }
        .frame(width: 760, height: 620)
        .preferredColorScheme(.dark)
    }

    private func groupView(_ group: (String, [Item])) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(group.0).font(.headline)
            ForEach(group.1) { item in
                HStack(alignment: .firstTextBaseline) {
                    Text(item.text)
                    Spacer(minLength: 8)
                    Text(item.keys)
                        .font(.system(size: 12, weight: .semibold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(0.1)))
                }
                .font(.callout)
            }
        }
    }
}
