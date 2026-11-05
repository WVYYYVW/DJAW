import SwiftUI

struct ContentView: View {
    @Environment(MixStore.self) private var store
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 400)
        } detail: {
            GeometryReader { geo in
                // The timeline is the workspace and takes the remaining height;
                // the decks get a bounded share so waveforms stay compact but usable.
                let deckHeight = DeckPanel.height(forAvailable: geo.size.height - 56, mixer: store.showMixer)
                VStack(spacing: 0) {
                    TimelineHost()
                        .frame(minHeight: 200, maxHeight: .infinity)
                        .layoutPriority(1)
                    if store.showDecks {
                        Divider()
                        DeckPanel()
                            .frame(height: deckHeight)
                    }
                    Divider()
                    OverviewStrip()
                        .frame(height: 54)
                }
                .frame(width: geo.size.width, height: geo.size.height)
            }
            .background(Theme.background)
            .toolbar { toolbarContent }
            .inspector(isPresented: $store.showInspector) {
                InspectorView()
                    .inspectorColumnWidth(min: 300, ideal: 340, max: 460)
            }
        }
        .navigationTitle(store.documentTitle)
        .navigationSubtitle(store.isDirty ? L("編集済み", "Edited") : "")
        .sheet(isPresented: $store.showExport) {
            ExportSheet()
        }
        .sheet(isPresented: $store.showPerformanceGuide) {
            PerformanceGuideView()
        }
        .sheet(item: $store.profileEditorTarget) { target in
            TrackProfileSheet(clipID: target.id)
        }
        .sheet(item: $store.cueEditorTarget) { target in
            CueEditorView(clipID: target.id)
                .background(UndoShortcuts())
        }
        .sheet(item: $store.transitionEditorTarget) { target in
            TransitionEditorView(clipID: target.id)
                .background(UndoShortcuts())
        }
        .sheet(isPresented: $store.showAutoArrange) {
            AutoArrangeSheet()
        }
        .sheet(isPresented: $store.showMusicLibrary) {
            MusicLibrarySheet()
        }
        .sheet(isPresented: $store.showShortcuts) {
            ShortcutsView()
        }
        .alert("DJAW", isPresented: Binding(get: { store.alertMessage != nil },
                                            set: { if !$0 { store.alertMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.alertMessage ?? "")
        }
        .onAppear { store.installKeyMonitor() }
        .preferredColorScheme(.dark)
        .id(store.language)
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Button {
                store.presentAddFiles()
            } label: {
                Label(L("曲を追加", "Add Tracks"), systemImage: "plus")
            }
            .help(L("曲を追加（⇧⌘I）— ファイルやフォルダをドロップしても追加できます", "Add tracks (⇧⌘I) — you can also drop files or folders"))
        }
        ToolbarItem(placement: .principal) {
            TransportBar()
        }
        ToolbarItemGroup(placement: .primaryAction) {
            SnapPicker()
            ControlGroup {
                Button { store.zoom(by: 1 / 1.4) } label: { Label(L("縮小", "Zoom Out"), systemImage: "minus.magnifyingglass") }
                    .help(L("縮小（⌘−）", "Zoom out (⌘−)"))
                Button { store.zoomToFit() } label: { Label(L("全体", "Fit"), systemImage: "arrow.left.and.right") }
                    .help(L("全体を表示（⌘0）", "Show whole mix (⌘0)"))
                Button { store.zoom(by: 1.4) } label: { Label(L("拡大", "Zoom In"), systemImage: "plus.magnifyingglass") }
                    .help(L("拡大（⌘+）", "Zoom in (⌘+)"))
            }
            Toggle(isOn: Binding(get: { store.showDecks }, set: { store.showDecks = $0 })) {
                Label(L("デッキ", "Decks"), systemImage: "opticaldisc")
            }
            .help(L("ターンテーブルとミキサーの表示（つなぎに合わせて自動で動きます）", "Show turntables and mixer (they move with your transitions)"))
            Toggle(isOn: Binding(get: { store.showMixer }, set: { store.showMixer = $0 })) {
                Label(L("ミキサー", "Mixer"), systemImage: "slider.vertical.3")
            }
            .disabled(!store.showDecks)
            .help(L("デッキの間のミキサーの表示 / 非表示", "Show or hide the mixer between the decks"))
            Toggle(isOn: Binding(get: { store.followPlayhead }, set: { store.followPlayhead = $0 })) {
                Label(L("追従", "Follow"), systemImage: "arrow.right.to.line")
            }
            .help(L("再生中に表示を再生位置に追従させる", "Keep the playhead in view while playing"))
            Button {
                openWindow(id: "visuals")
            } label: {
                Label(L("映像", "Visuals"), systemImage: "sparkles.tv")
            }
            .help(L("映像プレビュー：書き出す映像を、再生に合わせてその場で確認（⌥⌘V）", "Visuals preview: see the video visuals live with playback (⌥⌘V)"))
            Button {
                store.showPerformanceGuide = true
            } label: {
                Label(L("演奏手順", "How to Play"), systemImage: "list.bullet.rectangle")
            }
            .disabled(store.clips.isEmpty)
            .help(L("このセットを DJ 機材で実際に演奏する手順と、曲リスト（SoundCloud の概要用）", "Steps to play this set live on DJ gear, and the track list (for SoundCloud descriptions)"))
            Button {
                store.showExport = true
            } label: {
                Label(L("書き出し", "Export"), systemImage: "square.and.arrow.up")
            }
            .disabled(store.clips.isEmpty)
            .help(L("ミックスを書き出し（⌘E）", "Export the mix (⌘E)"))
            Button {
                store.showInspector.toggle()
            } label: {
                Label(L("インスペクタ", "Inspector"), systemImage: "sidebar.trailing")
            }
            .help(L("インスペクタの表示切替（⌥⌘I）", "Show or hide the inspector (⌥⌘I)"))
        }
    }
}

/// Invisible buttons so ⌘Z / ⇧⌘Z also work while an editor sheet has focus.
struct UndoShortcuts: View {
    @Environment(MixStore.self) private var store

    var body: some View {
        ZStack {
            Button("") { store.undo() }
                .keyboardShortcut("z", modifiers: .command)
            Button("") { store.redo() }
                .keyboardShortcut("z", modifiers: [.command, .shift])
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }
}

#Preview {
    ContentView()
        .environment(MixStore())
        .frame(width: 1200, height: 700)
}
