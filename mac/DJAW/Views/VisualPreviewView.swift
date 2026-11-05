import SwiftUI
import AppKit

/// Live preview of the video visuals, following playback — the same drawing as the video export, without exporting.
/// Opens in its own window so it can go on a second screen.
struct VisualPreviewView: View {
    @Environment(MixStore.self) private var store
    @State private var live = LiveFeatures()
    @State private var painter: VideoExporter.Painter?
    @State private var painterKey = 0

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                let _ = context.date
                let img = frameImage()
                ZStack {
                    Color.black
                    if let img {
                        Image(decorative: img, scale: 1)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                    }
                }
            }
            HStack(spacing: 12) {
                Picker(L("映像", "Visuals"), selection: $store.visualStyle) {
                    ForEach(VisualStyle.allCases) { s in Text(s.title).tag(s) }
                }
                .frame(maxWidth: 380)
                Toggle(L("曲名カード", "Track cards"), isOn: $store.visualShowInfo)
                Spacer()
                if !store.isPlaying {
                    Text(L("再生すると音に合わせて動きます", "Plays along when you press Play"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Button {
                    store.togglePlay()
                } label: {
                    Image(systemName: store.isPlaying ? "pause.fill" : "play.fill")
                }
            }
            .padding(10)
        }
        .background(Color.black)
        .frame(minWidth: 480, minHeight: 320)
        .onAppear { store.engine.liveFeatures = live }
        .onDisappear { if store.engine.liveFeatures === live { store.engine.liveFeatures = nil } }
    }

    /// Draws the frame for the moment being heard (a fresh painter whenever the mix or the settings change).
    private func frameImage() -> CGImage? {
        let _ = store.artworkRevision
        // Rebuilt only when the mix itself or the settings change (not on every redraw of the mix waveform),
        // so the trails and the Auto VJ scenes carry on smoothly.
        var h = Hasher()
        h.combine(MixRenderSession.structureKey(store.clips, master: store.masterBPM))
        for c in store.clips { h.combine(c.title); h.combine(c.artist); h.combine(c.colorIndex); h.combine(c.lanes); h.combine(c.transition) }
        h.combine(store.gridOffset)
        h.combine(store.visualStyle)
        h.combine(store.visualShowInfo)
        h.combine(store.artworkRevision)
        h.combine(store.structures.count)
        let key = h.finalize()
        let tempo = store.tempoMap
        if painter == nil || painterKey != key {
            var o = VideoExporter.Options(audio: .init(format: .wav24, sampleRate: store.exportSampleRate, normalize: false))
            o.width = 960
            o.height = 540
            o.style = store.visualStyle
            o.showTrackInfo = store.visualShowInfo
            let p = VideoExporter.Painter(options: o, tracks: store.previewTrackVisuals(), features: live, tempo: tempo,
                                          gridOffset: store.gridOffset, master: store.masterBPM)
            // Created while drawing: keep it for the next frames without re-entering the view update.
            DispatchQueue.main.async {
                painter = p
                painterKey = key
            }
            return p.image(frame: Int(tempo.real(store.playhead) * 30))
        }
        return painter?.image(frame: Int(tempo.real(store.playhead) * 30))
    }
}
