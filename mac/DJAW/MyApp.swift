import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var store: MixStore?
    private var pendingURLs: [URL] = []

    /// Connects the store once the window exists; handles files opened before that.
    func attach(_ store: MixStore) {
        guard self.store == nil else { return }
        self.store = store
        // Let the window finish appearing before running a modal alert.
        DispatchQueue.main.async { [weak self] in
            guard let self, let store = self.store else { return }
            store.offerRecoveryIfNeeded()
            for url in self.pendingURLs { store.openExternal(url) }
            self.pendingURLs = []
            #if DEBUG
            store.runDebugScriptIfPresent()
            store.watchDebugScript()
            #endif
        }
    }

    /// Finder double-click / Open With / drop on the Dock icon.
    func application(_ application: NSApplication, open urls: [URL]) {
        if let store {
            for url in urls { store.openExternal(url) }
        } else {
            pendingURLs += urls
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        (store?.shouldTerminate() ?? true) ? .terminateNow : .terminateCancel
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct DJAWApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store = MixStore()

    var body: some Scene {
        Window("DJAW", id: "main") {
            ContentView()
                .environment(store)
                .frame(minWidth: 1000, minHeight: 600)
                .onAppear { appDelegate.attach(store) }
        }
        .defaultSize(width: 1440, height: 860)
        .commands {
            AppCommands(store: store)
        }

        Window(L("映像プレビュー", "Visuals Preview"), id: "visuals") {
            VisualPreviewView()
                .environment(store)
        }
        .defaultSize(width: 960, height: 600)

        Settings {
            SettingsView()
                .environment(store)
        }
    }
}

struct SettingsView: View {
    @Environment(MixStore.self) private var store

    var body: some View {
        @Bindable var store = store
        Form {
            Picker(L("言語", "Language"), selection: $store.language) {
                ForEach(AppLanguage.allCases) { lang in
                    Text(lang.title).tag(lang)
                }
            }
            .pickerStyle(.radioGroup)
            Text(L("メニューの一部はアプリの再起動後に切り替わります。", "Some menu items switch after relaunching the app."))
                .font(.caption)
                .foregroundStyle(.secondary)
            Toggle(L("曲を追加したら CUE エディタを開く", "Open the CUE editor after adding tracks"), isOn: $store.openCueEditorOnAdd)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(20)
        .frame(width: 380)
        .id(store.language)
    }
}

struct AppCommands: Commands {
    let store: MixStore
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        let _ = store.language
        CommandGroup(replacing: .newItem) {
            Button(L("新規ミックス", "New Mix")) { store.newProject() }
                .keyboardShortcut("n")
            Button(L("開く…", "Open…")) { store.openProject() }
                .keyboardShortcut("o")
            Menu(L("最近使ったミックスを開く", "Open Recent")) {
                ForEach(store.recentDocuments, id: \.self) { url in
                    Button(url.deletingPathExtension().lastPathComponent) { store.openRecent(url) }
                }
                if !store.recentDocuments.isEmpty {
                    Divider()
                    Button(L("履歴を消去", "Clear Menu")) {
                        NSDocumentController.shared.clearRecentDocuments(nil)
                        store.recentDocuments = []
                    }
                }
            }
            Divider()
            Button(L("曲を追加…", "Add Tracks…")) { store.presentAddFiles() }
                .keyboardShortcut("i", modifiers: [.command, .shift])
            Button(L("ミュージックから追加…", "Add from Music…")) { store.showMusicLibrary = true }
                .keyboardShortcut("i", modifiers: [.command, .shift, .option])
        }
        CommandGroup(replacing: .saveItem) {
            Button(L("保存", "Save")) { _ = store.save() }
                .keyboardShortcut("s")
            Button(L("別名で保存…", "Save As…")) { _ = store.save(as: true) }
                .keyboardShortcut("s", modifiers: [.command, .shift])
            Toggle(L("曲の音声をファイルに含めて保存", "Include Audio When Saving"), isOn: Binding(
                get: { store.embedMedia }, set: { store.embedMedia = $0 }))
            Divider()
            Button(L("書き出し…", "Export…")) { store.showExport = true }
                .keyboardShortcut("e")
                .disabled(store.clips.isEmpty)
            Button(L("演奏手順と曲リスト…", "How to Play & Track List…")) { store.showPerformanceGuide = true }
                .disabled(store.clips.isEmpty)
            Button(L("曲リストをコピー（SoundCloud 用）", "Copy Track List (for SoundCloud)")) { store.copyTrackList() }
                .keyboardShortcut("c", modifiers: [.command, .option])
                .disabled(store.clips.isEmpty)
        }
        CommandGroup(replacing: .undoRedo) {
            Button(L("取り消す", "Undo")) { store.undo() }
                .keyboardShortcut("z")
                .disabled(!store.canUndo)
            Button(L("やり直す", "Redo")) { store.redo() }
                .keyboardShortcut("z", modifiers: [.command, .shift])
                .disabled(!store.canRedo)
        }
        CommandGroup(after: .pasteboard) {
            Divider()
            Button(L("選択した曲を削除", "Delete Selected Track")) { store.deleteSelected() }
                .disabled(store.selectedClipID == nil)
            Button(L("CUE（IN / OUT）を編集…", "Edit Cues (IN / OUT)…")) {
                if let id = store.selectedClipID { store.openCueEditor(id) }
            }
            .keyboardShortcut("k")
            .disabled(store.selectedClipID == nil)
            Button(L("曲を解析して全体を自動ミックス", "Analyse & Auto-Mix Everything")) { store.autoMixAll() }
                .keyboardShortcut("m", modifiers: [.command, .shift])
                .disabled(store.clips.count < 2)
            Button(L("おまかせミックス（曲順も自動）…", "Auto-Arrange (Order Too)…")) { store.showAutoArrange = true }
                .keyboardShortcut("a", modifiers: [.command, .shift])
                .disabled(store.clips.count + store.library.count < 2)
            Button(L("すべての曲の拍・小節を AI 解析に合わせる", "Match All Beat Grids to the AI Analysis")) { store.alignAllGridsToAI() }
                .disabled(store.aiGridMismatches == 0)
        }
        CommandMenu(L("再生", "Playback")) {
            Button(store.isPlaying ? L("一時停止（Space）", "Pause (Space)") : L("再生（Space）", "Play (Space)")) { store.togglePlay() }
                .disabled(store.clips.isEmpty)
            Button(L("先頭へ戻る", "Go to Start")) {
                store.seek(0)
                store.requestScroll(to: 0)
            }
            if let id = store.selectedClipID, (store.index(of: id) ?? 0) > 0 {
                Button(L("選択した曲のつなぎを試聴", "Preview Selected Transition")) { store.previewTransition(id) }
                    .keyboardShortcut("p", modifiers: [.command])
            }
            Divider()
            Toggle(L("再生位置に追従", "Follow Playhead"), isOn: Binding(get: { store.followPlayhead },
                                              set: { store.followPlayhead = $0 }))
        }
        CommandMenu(L("曲", "Track")) {
            Button(L("前の曲を選択", "Select Previous Track")) { store.selectAdjacent(-1) }
                .keyboardShortcut(.upArrow, modifiers: .command)
            Button(L("次の曲を選択", "Select Next Track")) { store.selectAdjacent(1) }
                .keyboardShortcut(.downArrow, modifiers: .command)
            Divider()
            Button(L("曲順を前へ", "Move Earlier")) { store.moveSelectedInOrder(-1) }
                .keyboardShortcut("[", modifiers: .command)
                .disabled(store.selectedIndex == nil)
            Button(L("曲順を後ろへ", "Move Later")) { store.moveSelectedInOrder(1) }
                .keyboardShortcut("]", modifiers: .command)
                .disabled(store.selectedIndex == nil)
            Divider()
            Button(L("つなぎエディタを開く…", "Open Transition Editor…")) {
                if let id = store.selectedClipID { store.openTransitionEditor(id) }
            }
            .keyboardShortcut("t")
            .disabled((store.selectedIndex ?? 0) < 1)
            Button(L("つなぎ方をコピー", "Copy Transition")) { store.copyTransition() }
                .keyboardShortcut("c", modifiers: [.command, .option])
                .disabled((store.selectedIndex ?? 0) < 1)
            Button(L("つなぎ方をペースト", "Paste Transition")) { store.pasteTransition() }
                .keyboardShortcut("v", modifiers: [.command, .option])
                .disabled((store.selectedIndex ?? 0) < 1 || store.transitionClipboard == nil)
            Divider()
            Button(store.isMultiSelecting ? L("選んだ\(store.librarySelection.count)曲をミックスに入れる", "Add \(store.librarySelection.count) Tracks to Mix") : L("ミックスに入れる", "Add to Mix")) {
                if store.isMultiSelecting { store.addToMix(store.selectedLibraryIDs) }
                else if let id = store.selectedClipID { store.addToMix(id) }
            }
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(!store.isMultiSelecting && (store.selectedClipID.map { store.libraryIndex(of: $0) == nil } ?? true))
            Button(L("ライブラリの曲をすべて選択", "Select All Library Tracks")) { store.selectAllLibrary() }
                .keyboardShortcut("a", modifiers: [.command, .option])
                .disabled(store.library.count < 2)
            Button(L("ライブラリに戻す", "Move Back to Library")) {
                if let id = store.selectedClipID { store.removeFromMix(id) }
            }
            .keyboardShortcut(.delete, modifiers: [.command, .shift])
            .disabled(store.selectedIndex == nil)
        }
        CommandGroup(replacing: .printItem) {}
        CommandGroup(replacing: .help) {
            Button(L("キーボードショートカット一覧", "Keyboard Shortcuts")) { store.showShortcuts = true }
                .keyboardShortcut("/", modifiers: .command)
        }
        CommandGroup(after: .toolbar) {
            Button(L("映像プレビュー", "Visuals Preview")) { openWindow(id: "visuals") }
                .keyboardShortcut("v", modifiers: [.command, .option])
            Divider()
            Button(L("拡大", "Zoom In")) { store.zoom(by: 1.4) }
                .keyboardShortcut("+")
            Button(L("縮小", "Zoom Out")) { store.zoom(by: 1 / 1.4) }
                .keyboardShortcut("-")
            Button(L("全体を表示", "Show Whole Mix")) { store.zoomToFit() }
                .keyboardShortcut("0")
            Divider()
            Button(store.showInspector ? L("インスペクタを隠す", "Hide Inspector") : L("インスペクタを表示", "Show Inspector")) {
                store.showInspector.toggle()
            }
            .keyboardShortcut("i", modifiers: [.command, .option])
            Button(store.showDecks ? L("デッキを隠す", "Hide Decks") : L("デッキを表示", "Show Decks")) {
                store.showDecks.toggle()
            }
            .keyboardShortcut("d", modifiers: [.command, .shift])
            Button(store.showMixer ? L("ミキサーを隠す", "Hide Mixer") : L("ミキサーを表示", "Show Mixer")) {
                if !store.showDecks {
                    // Showing the mixer only makes sense with the decks visible.
                    store.showDecks = true
                    store.showMixer = true
                } else {
                    store.showMixer.toggle()
                }
            }
            .keyboardShortcut("x", modifiers: [.command, .shift])
        }
    }
}
