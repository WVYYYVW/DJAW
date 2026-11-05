import SwiftUI
import AppKit

/// Bridges the AppKit timeline into SwiftUI. Passing the changing values as
/// properties makes SwiftUI call `updateNSView` whenever they change.
struct TimelineHost: View {
    @Environment(MixStore.self) private var store

    var body: some View {
        TimelineRepresentable(store: store,
                              revision: store.revision,
                              playhead: store.playhead,
                              pixelsPerSecond: store.pixelsPerSecond,
                              fitRequest: store.fitRequest,
                              scrollRequest: store.scrollRequest,
                              isPlaying: store.isPlaying,
                              snap: store.snap)
    }
}

private struct TimelineRepresentable: NSViewRepresentable {
    let store: MixStore
    let revision: Int
    let playhead: Double
    let pixelsPerSecond: Double
    let fitRequest: Int
    let scrollRequest: ScrollRequest?
    let isPlaying: Bool
    let snap: SnapUnit

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.hasHorizontalScroller = true
        scrollView.hasVerticalScroller = false
        scrollView.autohidesScrollers = false
        scrollView.scrollerStyle = .overlay
        scrollView.horizontalScrollElasticity = .allowed
        scrollView.verticalScrollElasticity = .none
        scrollView.drawsBackground = true
        scrollView.backgroundColor = Theme.timelineBG
        let timeline = TimelineNSView(store: store)
        scrollView.documentView = timeline
        DispatchQueue.main.async { timeline.sync() }
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        (scrollView.documentView as? TimelineNSView)?.sync()
    }
}
