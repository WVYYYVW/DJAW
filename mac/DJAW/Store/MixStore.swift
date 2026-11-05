import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct PendingTrack: Identifiable {
    let id = UUID()
    let url: URL
    var name: String { url.deletingPathExtension().lastPathComponent }
}

struct CueEditorTarget: Identifiable, Equatable {
    let id: UUID
}

/// A copied transition (style, length, curve and hand-drawn lanes).
struct TransitionClip {
    var style: TransitionStyle
    var bars: Double
    var shape: TransitionShape?
    var lanes: TransitionLanes?
}

struct ScrollRequest: Equatable {
    var id: Int
    var time: Double
}

enum ExportPhase: Equatable {
    case idle
    case rendering(Double)
    case done(URL)
    case failed(String)
}

/// Single source of truth for the mix, selection, playback and undo.
@Observable
final class MixStore {
    // MARK: Document
    var clips: [Clip] = [] { didSet { revision &+= 1; mixInputsChanged() } }
    /// Tracks that were added but are not in the mix yet.
    var library: [Clip] = [] { didSet { revision &+= 1 } }
    var waveforms: [URL: Waveform] = [:] { didSet { revision &+= 1 } }
    /// Intro / drop / outro, phrase grid and key per audio file (recomputed when a mix is opened).
    var structures: [URL: TrackStructure] = [:] { didSet { revision &+= 1 } }
    /// Plausible tempo readings per file (the detected one first) and the raw band energies
    /// needed to re-analyse the structure for another reading.
    @ObservationIgnored var tempoReadings: [URL: [TempoOption]] = [:]
    /// Identifies this mix across saves (folder name for unpacked audio).
    var projectID = UUID().uuidString
    /// Store the audio inside the .djaw so the file works on its own.
    var embedMedia: Bool = UserDefaults.standard.object(forKey: "DJAW.embedMedia") as? Bool ?? true {
        didSet { UserDefaults.standard.set(embedMedia, forKey: "DJAW.embedMedia") }
    }
    @ObservationIgnored var bandEnergies: [URL: BandEnergies] = [:]
    /// Neural beats / downbeats / cue suggestions per file.
    var neuralResults: [URL: NeuralResult] = [:]
    /// Genre detection per file (Discogs-EffNet + tag).
    var genreResults: [URL: GenreResult] = [:]
    var masterBPM: Double = 124 { didSet { revision &+= 1; mixInputsChanged() } }
    var gridOffset: Double = 0 { didSet { revision &+= 1; mixInputsChanged() } }
    var snap: SnapUnit = .phrase
    var defaultTransitionBars: Int = 16
    var defaultTransitionStyle: TransitionStyle = .bassSwap
    var documentURL: URL?
    var isDirty = false { didSet { if isDirty { scheduleAutosave() } } }
    /// Free-form notes saved in the project.
    var notes: String = "" { didSet { if notes != oldValue { isDirty = true } } }
    var recentDocuments: [URL] = NSDocumentController.shared.recentDocumentURLs
    var missingFiles: Set<URL> = [] { didSet { revision &+= 1; mixInputsChanged() } }

    // MARK: UI
    var language: AppLanguage = AppLanguage.saved {
        didSet {
            Lang.isEnglish = language.isEnglish
            UserDefaults.standard.set(language.rawValue, forKey: AppLanguage.defaultsKey)
            revision &+= 1
            // The UI is rebuilt for the new language; keep the timeline where it was.
            if language != oldValue {
                requestScroll(to: (visibleRange.lowerBound + visibleRange.upperBound) / 2)
            }
        }
    }
    var pending: [PendingTrack] = [] { didSet { revision &+= 1 } }
    var selectedClipID: UUID? {
        didSet {
            guard selectedClipID != oldValue else { return }
            revision &+= 1
            // Selecting something outside the multi-selection ends it.
            if !librarySelection.isEmpty, selectedClipID.map({ !librarySelection.contains($0) }) ?? true {
                librarySelection = []
            }
        }
    }
    /// Library tracks selected together (⌘ / ⇧ click). Empty or one item = normal single selection.
    var librarySelection: Set<UUID> = []
    /// Library tracks in list order that are part of the current multi-selection.
    var selectedLibraryIDs: [UUID] { library.map(\.id).filter { librarySelection.contains($0) } }
    var isMultiSelecting: Bool { librarySelection.count > 1 }
    /// Tracks to tick when the auto-arrange sheet opens (nil = everything).
    var autoArrangePreselect: Set<UUID>?
    var playhead: Double = 0
    var isPlaying = false
    var followPlayhead = true
    var pixelsPerSecond: Double = 8
    var visibleRange: ClosedRange<Double> = 0...120
    var fitRequest = 0
    var scrollRequest: ScrollRequest?
    var showInspector = true
    var showDecks: Bool = UserDefaults.standard.object(forKey: "DJAW.showDecks") as? Bool ?? true {
        didSet { UserDefaults.standard.set(showDecks, forKey: "DJAW.showDecks") }
    }
    /// The virtual mixer between the two turntables (only shown with the decks).
    var showMixer: Bool = UserDefaults.standard.object(forKey: "DJAW.showMixer") as? Bool ?? true {
        didSet { UserDefaults.standard.set(showMixer, forKey: "DJAW.showMixer") }
    }
    var showExport = false
    var showPerformanceGuide = false
    var cueEditorTarget: CueEditorTarget?
    /// Track whose profile (title, artist, artwork, …) is being edited.
    var profileEditorTarget: CueEditorTarget?
    /// Artwork per track file (.some(nil) = none), and a counter views watch to redraw when one arrives.
    @ObservationIgnored var artworkCache: [URL: CGImage?] = [:]
    @ObservationIgnored var artworkLoading: Set<URL> = []
    var artworkRevision = 0
    /// Stem separations running (track file → progress 0…1), and a counter that changes when one finishes.
    var stemProgress: [URL: Double] = [:]
    var stemRevision = 0
    var showShortcuts = false
    /// "Auto-arrange" sheet: pick tracks, let DJAW order and mix them.
    var showAutoArrange = false
    /// Which page of the track inspector is showing.
    var inspectorTab: InspectorTab = .transition
    /// Effect region expanded in the FX page.
    var focusedFX: UUID?
    /// Browser for the Music app library (purchased / imported songs).
    var showMusicLibrary = false
    /// Copied transition settings (⌥⌘C / ⌥⌘V).
    var transitionClipboard: TransitionClip?
    var transitionEditorTarget: CueEditorTarget?
    /// User-made transitions, shared by all mixes.
    var customTransitions: [CustomTransition] = MixStore.loadCustomTransitions() {
        didSet { MixStore.saveCustomTransitions(customTransitions) }
    }
    var openCueEditorOnAdd: Bool = UserDefaults.standard.object(forKey: "DJAW.openCueEditorOnAdd") as? Bool ?? true {
        didSet { UserDefaults.standard.set(openCueEditorOnAdd, forKey: "DJAW.openCueEditorOnAdd") }
    }
    var exportPhase: ExportPhase = .idle
    /// When the running export started (for the time-remaining estimate).
    @ObservationIgnored var exportStartedAt: Date?
    /// Where the steady part of the export began (progress, time): the audio render for an audio export, the
    /// drawing of the frames for a video (its audio and analysis before that run at a very different speed).
    @ObservationIgnored var exportSteadyMark: (progress: Double, at: Date)?
    /// Progress from which the export runs at a steady pace (0 = audio, 0.4 = video frames).
    @ObservationIgnored var exportSteadyFrom = 0.0
    /// Export settings (remembered; the mix waveform is rendered with the same ones).
    var exportSampleRate: Double = UserDefaults.standard.object(forKey: "DJAW.exportSampleRate") as? Double ?? 44_100 {
        didSet { UserDefaults.standard.set(exportSampleRate, forKey: "DJAW.exportSampleRate"); mixInputsChanged() }
    }
    var exportNormalize: Bool = UserDefaults.standard.object(forKey: "DJAW.exportNormalize") as? Bool ?? true {
        didSet { UserDefaults.standard.set(exportNormalize, forKey: "DJAW.exportNormalize"); revision &+= 1 }
    }

    /// Look of the visuals preview / video export (kept between launches).
    var visualStyle: VisualStyle = VisualStyle(rawValue: UserDefaults.standard.string(forKey: "DJAW.visualStyle") ?? "") ?? .pulse {
        didSet { UserDefaults.standard.set(visualStyle.rawValue, forKey: "DJAW.visualStyle") }
    }
    var visualShowInfo: Bool = UserDefaults.standard.object(forKey: "DJAW.visualShowInfo") as? Bool ?? true {
        didSet { UserDefaults.standard.set(visualShowInfo, forKey: "DJAW.visualShowInfo") }
    }

    /// How much of each track the auto-mix plays (kept between launches).
    var trackUse: TrackUse = TrackUse(rawValue: UserDefaults.standard.string(forKey: "DJAW.trackUse") ?? "") ?? .auto {
        didSet { UserDefaults.standard.set(trackUse.rawValue, forKey: "DJAW.trackUse") }
    }

    /// Loudness normalization of this mix.
    var loudnessMode: LoudnessMode = .off {
        didSet {
            guard loudnessMode != oldValue else { return }
            isDirty = true
            applyLoudness()
        }
    }
    @ObservationIgnored var loudnessSegments: [URL: [Float]] = [:]
    @ObservationIgnored var loudnessInFlight: Set<URL> = []

    // MARK: Mix waveform (the final mix, rendered exactly like an export)

    /// Show the lane with the mixed-down waveform under the A / B lanes.
    var showMixWaveform: Bool = UserDefaults.standard.object(forKey: "DJAW.showMixWaveform") as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(showMixWaveform, forKey: "DJAW.showMixWaveform")
            revision &+= 1
            if showMixWaveform { mixInputsChanged() } else { mixRenderCancel?.cancel(); mixRenderingSignature = nil; mixPeaksPartial = nil }
        }
    }
    /// Waveform of the current mix (nil before the first render).
    var mixPeaks: OfflineRenderer.MixPeaks? { didSet { revision &+= 1 } }
    /// While the mix is rendered again after a change: what is done so far.
    var mixPeaksPartial: OfflineRenderer.MixPeaks? { didSet { revision &+= 1 } }
    @ObservationIgnored var mixPeaksSignature: Int?
    /// What the shown mix waveform was rendered from (to update only the part an edit changed).
    @ObservationIgnored var mixPeaksInputs: MixWaveformInputs?
    /// While part of the waveform is being re-rendered: that stretch (real seconds); the rest is current.
    @ObservationIgnored var mixStaleRange: ClosedRange<Double>?
    /// Full, exact re-render scheduled for when editing pauses (after a quick partial update).
    @ObservationIgnored var mixExactWork: DispatchWorkItem?
    @ObservationIgnored var mixRerunPending = false
    @ObservationIgnored var tickRevision = -1
    /// The smoothed playback clock: timeline time at a moment (CACurrentMediaTime).
    @ObservationIgnored var playClock: (t: Double, at: CFTimeInterval)?
    @ObservationIgnored var tempoMapCache: (revision: Int, map: TempoMap)?
    @ObservationIgnored var simplifyCache: (revision: Int, list: [(id: UUID, s: TransitionSimplification)])?
    @ObservationIgnored var mixRenderingSignature: Int?
    @ObservationIgnored var mixRenderCancel: CancelFlag?
    @ObservationIgnored private var mixRenderWork: DispatchWorkItem?

    /// The mix (or the export settings) changed: render the mix waveform again once edits pause.
    func mixInputsChanged() {
        guard showMixWaveform else { return }
        mixRenderWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.startMixRender() }
        }
        mixRenderWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (isInteracting ? 2.0 : 1.0), execute: work)
    }
    var alertMessage: String?
    private(set) var revision = 0

    private var undoStack: [Snapshot] = []
    private var redoStack: [Snapshot] = []

    let engine = StreamingPlayback()
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var keyMonitor: Any?
    @ObservationIgnored private var restartWork: DispatchWorkItem?
    @ObservationIgnored private var exportCancel: CancelFlag?
    @ObservationIgnored private var wasPlayingBeforeScrub = false
    @ObservationIgnored private var colorCounter = 0
    @ObservationIgnored private var autosaveWork: DispatchWorkItem?
    @ObservationIgnored private var restoreScrollTime: Double?
    /// True while the user drags on the timeline; playback restarts once at the end.
    @ObservationIgnored var isInteracting = false

    static let audioExtensions: Set<String> = ["mp3", "wav", "wave", "aif", "aiff", "aifc", "m4a", "aac", "flac", "caf", "mp4"]
    /// Declared in Info.plist (UTExportedTypeDeclarations) so Finder knows "DJAW Mix" files.
    static let projectType = UTType(exportedAs: "com.djaw.mix", conformingTo: .json)

    // MARK: - Derived

    var grid: Grid { Grid(bpm: masterBPM, offset: gridOffset) }
    var beatLength: Double { 60 / masterBPM }
    var barLength: Double { 240 / masterBPM }
    var mixDuration: Double { clips.map { $0.end(master: masterBPM) }.max() ?? 0 }
    /// Mix tempo over the timeline (tracks with their own tempo change it).
    var tempoMap: TempoMap {
        // Built once per change of the mix (it is read many times per frame while playing).
        if let c = tempoMapCache, c.revision == revision { return c.map }
        let m = TempoMap.build(clips: clips, master: masterBPM)
        tempoMapCache = (revision, m)
        return m
    }
    /// Heard length of the mix (tempo changes included).
    var realMixDuration: Double { tempoMap.real(mixDuration) }
    /// Brake / backspin endings, per outgoing track.
    var outros: [UUID: OutroFX] {
        var out: [UUID: OutroFX] = [:]
        for (i, c) in clips.enumerated() where i + 1 < clips.count {
            if let o = c.outro(next: clips[i + 1]) { out[c.id] = o }
        }
        return out
    }
    var canUndo: Bool { !undoStack.isEmpty }
    /// How many steps can be undone (used to roll back a whole auto-arrange session).
    var undoDepth: Int { undoSerial }
    /// Counts pushes minus undos (unaffected by the history limit).
    private var undoSerial = 0
    var canRedo: Bool { !redoStack.isEmpty }
    var documentTitle: String { documentURL?.deletingPathExtension().lastPathComponent ?? L("新規ミックス", "New Mix") }

    var selectedIndex: Int? {
        guard let id = selectedClipID else { return nil }
        return clips.firstIndex { $0.id == id }
    }

    var selectedClip: Clip? { selectedIndex.map { clips[$0] } }

    func index(of id: UUID) -> Int? { clips.firstIndex { $0.id == id } }
    func clip(_ id: UUID) -> Clip? { clips.first { $0.id == id } ?? library.first { $0.id == id } }
    func isInMix(_ id: UUID) -> Bool { index(of: id) != nil }
    func libraryIndex(of id: UUID) -> Int? { library.firstIndex { $0.id == id } }

    /// Every track in browsing order: the mix first, then the library.
    var allTrackIDs: [UUID] { clips.map(\.id) + library.map(\.id) }

    /// Overlap with the previous clip in seconds (negative means a gap).
    func incomingOverlap(at i: Int) -> Double? {
        guard i > 0, i < clips.count else { return nil }
        let prev = clips[i - 1]
        let cur = clips[i]
        return min(prev.end(master: masterBPM), cur.end(master: masterBPM)) - cur.start
    }

    func transitionSummary(at i: Int) -> String? {
        guard let overlap = incomingOverlap(at: i), overlap > 0.01 else { return nil }
        return "\(Fmt.bars(overlap / barLength)) · \(clips[i].transition.title)"
    }

    // MARK: - Undo

    fileprivate struct Snapshot {
        var clips: [Clip]
        var library: [Clip]
        var masterBPM: Double
        var gridOffset: Double
    }

    private func snapshot() -> Snapshot {
        Snapshot(clips: clips, library: library, masterBPM: masterBPM, gridOffset: gridOffset)
    }

    func pushUndo() {
        undoSerial += 1
        undoStack.append(snapshot())
        if undoStack.count > 300 { undoStack.removeFirst() }
        redoStack.removeAll()
        isDirty = true
    }

    func undo() {
        guard let s = undoStack.popLast() else { return }
        undoSerial -= 1
        redoStack.append(snapshot())
        restore(s)
    }

    func redo() {
        guard let s = redoStack.popLast() else { return }
        undoSerial += 1
        undoStack.append(snapshot())
        restore(s)
    }

    private func restore(_ s: Snapshot) {
        let tempoChanged = abs(s.masterBPM - masterBPM) > 0.0001
        clips = s.clips
        library = s.library
        masterBPM = s.masterBPM
        gridOffset = s.gridOffset
        if let id = selectedClipID, clip(id) == nil { selectedClipID = nil }
        isDirty = true
        if tempoChanged { restartPlayback(at: playhead) } else { timingChanged() }
    }

    // MARK: - Editing primitives

    func updateClip(_ id: UUID, undoable: Bool = true, _ change: (inout Clip) -> Void) {
        if let i = index(of: id) {
            if undoable { pushUndo() } else { isDirty = true }
            change(&clips[i])
        } else if let i = libraryIndex(of: id) {
            if undoable { pushUndo() } else { isDirty = true }
            change(&library[i])
        }
    }

    /// Call after any edit that changes the arrangement.
    func finishTimingEdit() {
        separateNeighbourColors()
        pruneLocks()
        updateCutNudges()
        layout()
        applyLoudness()
        timingChanged()
    }

    /// Tracks that play next to each other never share a colour (or two very similar ones): when they would,
    /// the later one gets the colour that stands out most from its neighbours. Other tracks keep their colour.
    func separateNeighbourColors() {
        guard clips.count > 1 else { return }
        let n = ClipPalette.hues.count
        for i in 1..<clips.count {
            let prev = clips[i - 1].colorIndex
            let next = i + 1 < clips.count ? clips[i + 1].colorIndex : nil
            let cur = clips[i].colorIndex
            guard ClipPalette.distance(cur, prev) < ClipPalette.minNeighbourDistance else { continue }
            var best = cur, bestScore = -Double.infinity
            for k in 0..<n {
                var score = ClipPalette.distance(k, prev)
                if let next { score = min(score, ClipPalette.distance(k, next)) }
                // Also keep away from the track two before (it is still on screen nearby), a little.
                if i >= 2 { score += 0.3 * min(0.15, ClipPalette.distance(k, clips[i - 2].colorIndex)) }
                if score > bestScore { bestScore = score; best = k }
            }
            if best != cur { clips[i].colorIndex = best }
        }
    }

    private func timingChanged() {
        guard isPlaying, !isInteracting else { return }
        restartWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            MainActor.assumeIsolated { self.restartPlayback(at: nil) }
        }
        restartWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06, execute: work)
    }

    // MARK: - Chain layout

    /// Derives timeline placement from the musical mix points.
    /// Each track's mix-in point is played exactly at the previous track's mix-out point,
    /// so every transition starts and ends on a bar line.
    /// Puts every cut-in exactly on the attacks: the outgoing track stops right before its next kick / snare
    /// and the incoming one starts right before its own, so the two never flam or leave a gap.
    func updateCutNudges() {
        guard clips.count > 1 else { return }
        var c = clips
        func local(_ k: Clip, line t: Double, before: Bool) -> Double? {
            guard let e = bandEnergies[k.url], k.bpm > 1 else { return nil }
            let beat = 60 / k.bpm
            let key = "\(k.url.path)|\(Int((k.bpm * 1000).rounded()))|\(Int((k.firstBeat * 10000).rounded()))|\(Int((t * 1000).rounded()))|\(before)"
            if let v = nudgeCache[key] { return v }
            let v = before ? e.onsetOffset(bpm: k.bpm, firstBeat: k.firstBeat, from: t - 6 * beat, to: t + 0.03, minCount: 3)
                           : e.onsetOffset(bpm: k.bpm, firstBeat: k.firstBeat, from: t - 0.03, to: t + 6 * beat, minCount: 3)
            nudgeCache[key] = v ?? 0
            return v
        }
        for i in c.indices {
            let into = i > 0 ? c[i].transition : .crossfade
            let abrupt = i > 0 && (into.isCutLike || into == .echoOut || c[i].transitionBars < 0.01)
            let nextAbrupt = i + 1 < c.count && (c[i + 1].transition.isCutLike || c[i + 1].transition == .echoOut || c[i + 1].transitionBars < 0.01)
            let inN = abrupt ? local(c[i], line: c[i].sourceTime(bar: c[i].mixInBar), before: false) : nil
            let outN = nextAbrupt ? local(c[i], line: c[i].sourceTime(bar: c[i].mixOutBar), before: true) : nil
            c[i].inNudge = inN.flatMap { abs($0) > 0.0005 ? $0 : nil }
            c[i].outNudge = outN.flatMap { abs($0) > 0.0005 ? $0 : nil }
        }
        if c != clips { clips = c }
    }
    @ObservationIgnored private var nudgeCache: [String: Double] = [:]

    func layout() {
        guard !clips.isEmpty else { return }
        let m = masterBPM
        var c = clips
        var anchor = 0.0
        var firstAnchor = 0.0
        for i in c.indices {
            let rate = c[i].rate(master: m)
            let minIn = c[i].bar(atSource: 0) - 64
            let maxIn = c[i].lastBar - 1
            c[i].mixInBar = min(max(c[i].mixInBar, minIn), maxIn)
            let sourceIn = c[i].sourceTime(bar: c[i].mixInBar) + (i > 0 ? (c[i].inNudge ?? 0) : 0)
            let trimStart = min(max(0, sourceIn), max(0, c[i].duration - 0.5))
            c[i].trimStart = trimStart
            c[i].start = max(0, anchor + (trimStart - sourceIn) / rate)
            if i == 0 { firstAnchor = c[i].start + (sourceIn - trimStart) / rate }

            var sourceEnd: Double
            if i + 1 < c.count {
                c[i].mixOutBar = min(max(c[i].mixOutBar, c[i].mixInBar + 1), max(c[i].mixInBar + 1, c[i].lastBar - 0.25))
                c[i + 1].transitionBars = max(0, c[i + 1].transitionBars)
                sourceEnd = c[i].sourceTime(bar: c[i].mixOutBar + c[i + 1].transitionBars) + (c[i].outNudge ?? 0)
                if c[i + 1].transitionBars < 0.01 {
                    // Cut: keep a few milliseconds of overlap so the switch is click-free
                    // (short, because the cut now sits right before the next attack).
                    sourceEnd += 0.005 * rate
                }
            } else if let endBar = c[i].endBar {
                sourceEnd = c[i].sourceTime(bar: max(endBar, c[i].mixInBar + 1))
            } else {
                sourceEnd = c[i].duration
            }
            c[i].trimEnd = min(c[i].duration, max(trimStart + 0.5, sourceEnd))

            if c[i].hasEdits {
                // Loops / jumps: measure in played time, so a loop before the mix-out pushes the
                // next track back and the overlap still lasts exactly the transition length.
                let raw = c[i].rawSegments()
                let total = raw.reduce(0) { $0 + ($1.to - $1.from) }
                var play: Double
                if i + 1 < c.count {
                    let eOut = Clip.elapsed(ofSource: c[i].sourceTime(bar: c[i].mixOutBar) + (c[i].outNudge ?? 0), in: raw, trimStart: trimStart)
                    play = eOut + c[i + 1].transitionBars * c[i].barSource
                    if c[i + 1].transitionBars < 0.01 { play += 0.005 * rate }
                    anchor = c[i].start + eOut / rate
                } else if let endBar = c[i].endBar {
                    play = Clip.elapsed(ofSource: c[i].sourceTime(bar: max(endBar, c[i].mixInBar + 1)), in: raw, trimStart: trimStart)
                } else {
                    play = total
                }
                play = min(total, max(0.5, play))
                c[i].playLength = play
                c[i].trimEnd = min(c[i].duration, Clip.source(atElapsed: play, segs: raw, trimStart: trimStart))
            } else if i + 1 < c.count {
                let sourceOut = c[i].sourceTime(bar: c[i].mixOutBar) + (c[i].outNudge ?? 0)
                anchor = c[i].start + (sourceOut - trimStart) / rate
            }
        }
        gridOffset = Mathx.posMod(firstAnchor, barLength)
        if c != clips { clips = c }
    }

    /// Phrase-aligned (8-bar) exit point so a transition of `bars` finishes before the music ends.
    func suggestedMixOut(for clip: Clip, transitionBars bars: Double) -> Double {
        let musicEnd = waveforms[clip.url]?.lastSoundTime() ?? clip.duration
        let lastBar = clip.bar(atSource: min(musicEnd, clip.duration))
        var candidate = floor((lastBar - bars - clip.mixInBar) / 8) * 8 + clip.mixInBar
        if candidate < clip.mixInBar + 8 {
            candidate = floor(lastBar - bars)
        }
        return max(clip.mixInBar + 1, candidate)
    }

    // MARK: - Adding tracks

    static func expandAudioURLs(_ urls: [URL]) -> [URL] {
        var result: [URL] = []
        let fm = FileManager.default
        for url in urls {
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue {
                let items = (try? fm.contentsOfDirectory(at: url, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])) ?? []
                result += items
                    .filter { audioExtensions.contains($0.pathExtension.lowercased()) }
                    .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
            } else if audioExtensions.contains(url.pathExtension.lowercased()) {
                result.append(url)
            }
        }
        return result
    }

    func presentAddFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowedContentTypes = [.audio, .folder]
        panel.message = L("ミックスに追加する曲（またはフォルダ）を選択してください", "Choose tracks (or folders) to add to the mix")
        panel.prompt = L("追加", "Add")
        if panel.runModal() == .OK { addFiles(panel.urls, to: .library) }
    }

    /// Mix position (index) a drop at timeline time `t` would insert at.
    func insertionIndex(forTime t: Double) -> Int {
        clips.firstIndex { $0.start > t } ?? clips.count
    }

    enum AddDestination {
        /// Into the library; the mix is not touched.
        case library
        /// Straight into the mix at this position (nil = end), with neutral mix points.
        case mix(Int?)
    }

    /// Analyzes and adds files. Nothing is mixed automatically:
    /// library tracks wait for the user, and tracks dropped on the timeline
    /// play in full and connect directly until the user sets cues and a transition.
    func addFiles(_ urls: [URL], to destination: AddDestination = .library) {
        let found = Self.expandAudioURLs(urls)
        guard !found.isEmpty else {
            alertMessage = L("対応している音声ファイルが見つかりませんでした。\nMP3・WAV・AIFF・M4A・FLAC などを追加できます。", "No supported audio files were found.\nYou can add MP3, WAV, AIFF, M4A, FLAC and more.")
            return
        }
        // The same song is never loaded twice: first by its file (also twice in one drop, or a folder plus a
        // file in it), then — off the main thread — by its content (a copy of the same file elsewhere).
        let loaded = clips.map(\.url) + library.map(\.url) + pending.map(\.url)
        var byPath: [String: URL] = [:]
        for u in loaded { byPath[Self.pathKey(u)] = u }
        var files: [URL] = []
        var sameFile: [(new: URL, existing: URL?)] = []
        var batch = Set<String>()
        for f in found {
            let k = Self.pathKey(f)
            if let e = byPath[k] { sameFile.append((f, e)) }
            else if !batch.insert(k).inserted { sameFile.append((f, nil)) }
            else { files.append(f) }
        }
        let items = files.map { PendingTrack(url: $0) }
        pending.append(contentsOf: items)
        pollAnalysisProgress()
        let wasEmpty = clips.isEmpty

        Task {
            let candidates = items.map(\.url)
            let (keepURLs, sameContent) = await Task.detached(priority: .userInitiated) {
                Self.dropSameContent(candidates, loaded: loaded)
            }.value
            let keep = Set(keepURLs)
            let skipped = items.filter { !keep.contains($0.url) }
            pending.removeAll { p in skipped.contains { $0.id == p.id } }
            let toAnalyze = items.filter { keep.contains($0.url) }
            AnalysisProgress.shared.expect(toAnalyze.map(\.url))

            var position: Int? = nil
            if case .mix(let index) = destination { position = index }
            var pushed = false
            var added: [UUID] = []
            // Dropped on the timeline but already waiting in the library: move that one into the mix instead.
            let duplicates = sameFile + sameContent
            var notAdded: [String] = []
            for d in duplicates {
                if case .mix = destination, let e = d.existing, let li = library.firstIndex(where: { $0.url == e }) {
                    if !pushed { pushUndo(); pushed = true }
                    let clip = library.remove(at: li)
                    let at = placeInMix(clip, at: min(position ?? clips.count, clips.count))
                    position = at + 1
                    added.append(clip.id)
                } else {
                    notAdded.append(d.new.deletingPathExtension().lastPathComponent)
                }
            }

            let jobs = toAnalyze.map { item -> (PendingTrack, Task<TrackAnalysis, Error>) in
                let url = item.url
                return (item, Task.detached(priority: .userInitiated) {
                    try await AudioAnalyzer.analyze(url: url)
                })
            }
            var failed: [String] = []
            var analyzed: [UUID] = []
            for (item, job) in jobs {
                do {
                    let analysis = try await job.value
                    if !pushed {
                        pushUndo()
                        pushed = true
                    }
                    let clip = makeClip(analysis: analysis, url: item.url)
                    switch destination {
                    case .library:
                        library.append(clip)
                    case .mix:
                        let at = placeInMix(clip, at: min(position ?? clips.count, clips.count))
                        position = at + 1
                    }
                    added.append(clip.id)
                    analyzed.append(clip.id)
                } catch {
                    failed.append(item.name)
                }
                pending.removeAll { $0.id == item.id }
            }
            if let first = added.first {
                selectedClipID = first
                if openCueEditorOnAdd, cueEditorTarget == nil, let fresh = analyzed.first {
                    openCueEditor(fresh)
                }
            } else if let d = duplicates.first?.existing, let c = (clips + library).first(where: { $0.url == d }) {
                // Nothing new: point at the copy that is already there.
                selectedClipID = c.id
                if index(of: c.id) != nil { requestScroll(to: c.start) }
            }
            if wasEmpty && !clips.isEmpty { fitRequest += 1 }
            var messages: [String] = []
            if !notAdded.isEmpty {
                messages.append(L("同じ曲がすでに読み込まれているため、次の曲は追加しませんでした:\n", "These tracks are already loaded, so they were not added again:\n")
                                + notAdded.joined(separator: "\n"))
            }
            if !failed.isEmpty {
                messages.append(L("次のファイルを読み込めませんでした:\n", "These files could not be read:\n") + failed.joined(separator: "\n"))
            }
            if !messages.isEmpty { alertMessage = messages.joined(separator: "\n\n") }
        }
    }

    /// A file's identity by path (symlinks, "." and ".." and Unicode normalisation aside).
    nonisolated static func pathKey(_ url: URL) -> String {
        url.standardizedFileURL.resolvingSymlinksInPath().path.precomposedStringWithCanonicalMapping
    }

    /// Splits new files into those to load and those whose audio content is already loaded (or appears
    /// earlier in the same batch), with the loaded file each duplicate matches.
    nonisolated static func dropSameContent(_ urls: [URL], loaded: [URL]) -> (keep: [URL], same: [(new: URL, existing: URL?)]) {
        var known: [String: URL] = [:]
        for u in loaded { if let k = AnalysisCache.fingerprint(u), known[k] == nil { known[k] = u } }
        var seen = Set<String>()
        var keep: [URL] = []
        var same: [(new: URL, existing: URL?)] = []
        for u in urls {
            guard let k = AnalysisCache.fingerprint(u) else { keep.append(u); continue }
            if let e = known[k] { same.append((u, e)) }
            else if !seen.insert(k).inserted { same.append((u, nil)) }
            else { keep.append(u) }
        }
        return (keep, same)
    }

    private func makeClip(analysis a: TrackAnalysis, url: URL) -> Clip {
        var clip = Clip(url: url,
                        title: a.title,
                        artist: a.artist,
                        duration: a.duration,
                        bpm: a.bpm,
                        firstBeat: a.firstBeat,
                        trimEnd: a.duration)
        clip.colorIndex = colorCounter
        colorCounter += 1
        if let p = TrackProfiles.load(url) {
            clip.title = p.title
            clip.artist = p.artist
        }
        clip.transitionBars = 0
        clip.transition = defaultTransitionStyle
        clip.resetToWholeTrack()
        waveforms[url] = a.waveform
        structures[url] = a.structure
        rememberReadings(url, a)
        Self.logStructure(a.title, a.structure)
        return clip
    }

    @discardableResult
    private func placeInMix(_ clip: Clip, at index: Int) -> Int {
        if clips.isEmpty, clip.bpm > 0 {
            masterBPM = (clip.bpm * 100).rounded() / 100
        }
        var clip = clip
        clip.lockedPrevID = nil
        let at = lockSafeIndex(index)
        clips.insert(clip, at: at)
        finishTimingEdit()
        return at
    }

    /// Moves a library track into the mix (default: right after the selected mix track, else at the end).
    func addToMix(_ id: UUID, at index: Int? = nil) {
        guard let li = libraryIndex(of: id) else { return }
        pushUndo()
        let clip = library.remove(at: li)
        var target = clips.count
        if let index { target = index }
        else if let sel = selectedClipID, let si = self.index(of: sel) { target = si + 1 }
        let wasEmpty = clips.isEmpty
        placeInMix(clip, at: target)
        selectedClipID = clip.id
        if wasEmpty { fitRequest += 1 }
        requestScroll(to: self.clip(id)?.start ?? 0)
    }

    // MARK: Multi-selection (library)

    /// Sets the selection from the sidebar list. Only library tracks can be selected together.
    /// Only writes what actually changed: the list calls this on every update, and
    /// re-assigning equal values would make it update again and again.
    func setSidebarSelection(_ ids: Set<UUID>) {
        let libIDs = ids.filter { libraryIndex(of: $0) != nil }
        if ids.count > 1 && libIDs.count > 1 {
            if librarySelection != libIDs { librarySelection = libIDs }
            if selectedClipID.map({ !libIDs.contains($0) }) ?? true {
                let first = library.map(\.id).first { libIDs.contains($0) }
                if selectedClipID != first { selectedClipID = first }
            }
        } else {
            if !librarySelection.isEmpty { librarySelection = [] }
            let single = ids.count > 1 ? (libIDs.first ?? ids.first) : ids.first
            if selectedClipID != single { selectedClipID = single }
        }
    }

    func selectAllLibrary() {
        guard !library.isEmpty else { return }
        if library.count == 1 { setSidebarSelection([library[0].id]); return }
        setSidebarSelection(Set(library.map(\.id)))
    }

    /// Moves several library tracks into the mix, keeping their list order.
    func addToMix(_ ids: [UUID], at index: Int? = nil) {
        let ordered = library.map(\.id).filter { ids.contains($0) }
        guard !ordered.isEmpty else { return }
        pushUndo()
        let wasEmpty = clips.isEmpty
        var target = index ?? clips.count
        if index == nil, let sel = selectedClipID, let si = self.index(of: sel) { target = si + 1 }
        // Never between two tracks whose transition is locked.
        target = lockSafeIndex(target)
        for id in ordered {
            guard let li = libraryIndex(of: id) else { continue }
            var clip = library.remove(at: li)
            clip.lockedPrevID = nil
            if clips.isEmpty, clip.bpm > 0 { masterBPM = (clip.bpm * 100).rounded() / 100 }
            clips.insert(clip, at: min(target, clips.count))
            target += 1
        }
        librarySelection = []
        selectedClipID = ordered.last
        finishTimingEdit()
        if wasEmpty { fitRequest += 1 }
        if let first = ordered.first { requestScroll(to: clip(first)?.start ?? 0) }
    }

    func removeFromLibrary(_ ids: [UUID]) {
        let set = Set(ids)
        guard library.contains(where: { set.contains($0.id) }) else { return }
        pushUndo()
        let firstIndex = library.firstIndex { set.contains($0.id) } ?? 0
        library.removeAll { set.contains($0.id) }
        librarySelection = []
        selectedClipID = library.isEmpty ? nil : library[min(firstIndex, library.count - 1)].id
    }

    /// Opens the auto-arrange sheet with these tracks ticked.
    func autoArrange(preselecting ids: [UUID]) {
        autoArrangePreselect = Set(ids)
        showAutoArrange = true
    }

    /// Takes a track out of the mix and keeps it (with its cues) in the library.
    func removeFromMix(_ id: UUID) {
        guard let i = index(of: id) else { return }
        pushUndo()
        var clip = clips.remove(at: i)
        clip.lockedPrevID = nil
        library.insert(clip, at: 0)
        if clips.isEmpty { pause() } else { finishTimingEdit() }
    }

    // MARK: - Clip operations

    func deleteSelected() {
        if isMultiSelecting {
            removeFromLibrary(selectedLibraryIDs)
            return
        }
        if let i = selectedIndex {
            pushUndo()
            clips.remove(at: i)
            selectedClipID = clips.isEmpty ? nil : clips[min(i, clips.count - 1)].id
            if clips.isEmpty { pause() } else { finishTimingEdit() }
        } else if let id = selectedClipID, let li = libraryIndex(of: id) {
            pushUndo()
            library.remove(at: li)
            selectedClipID = library.isEmpty ? nil : library[min(li, library.count - 1)].id
        }
    }

    func deleteClip(_ id: UUID) {
        selectedClipID = id
        deleteSelected()
    }

    func setMasterBPM(_ value: Double) {
        let v = min(220, max(40, (value * 100).rounded() / 100))
        guard abs(v - masterBPM) > 0.0001 else { return }
        pushUndo()
        let ratio = masterBPM / v
        masterBPM = v
        layout()
        playhead *= ratio
        if isPlaying { restartPlayback(at: playhead) }
    }

    func setClipBPM(_ id: UUID, _ bpm: Double) {
        let v = min(300, max(30, bpm))
        updateClip(id) { $0.bpm = v }
        finishTimingEdit()
    }

    func scaleClipBPM(_ id: UUID, by factor: Double) {
        guard let c = clip(id) else { return }
        setClipBPM(id, c.bpm * factor)
    }

    // MARK: - Tempo changes

    /// Mix BPM in effect when track `i` plays (before any change it makes itself).
    func tempoBefore(_ i: Int) -> Double {
        var t = masterBPM
        for k in 1..<max(1, min(i, clips.count)) { if let v = clips[k].tempo { t = v } }
        return t
    }

    /// Mix BPM from track `id` on (nil = keep the previous tempo).
    func setTrackTempo(_ id: UUID, _ bpm: Double?) {
        guard let i = index(of: id) else { return }
        if i == 0 {
            if let bpm { setMasterBPM(bpm) }
            return
        }
        let v = bpm.map { min(220, max(40, ($0 * 100).rounded() / 100)) }
        let same = v.map { abs($0 - tempoBefore(i)) < 0.005 } ?? false
        updateClip(id) { $0.tempo = same ? nil : v }
        finishTimingEdit()
    }

    /// Edits the tempo of the section playing at `t` (the track that set it, else the base BPM).
    func setTempo(atTime t: Double, _ bpm: Double) {
        let owner = clips.indices.dropFirst().last { i in
            clips[i].tempo != nil && clips[i].timelineTime(bar: clips[i].mixInBar, master: masterBPM) <= t + 0.001
        }
        if let i = owner { setTrackTempo(clips[i].id, bpm) } else { setMasterBPM(bpm) }
    }

    func setTempoBars(_ id: UUID, _ bars: Double?) {
        updateClip(id) { $0.tempoBars = bars.map { max(0, $0) } }
        finishTimingEdit()
    }

    func setSpinBeats(_ id: UUID, _ beats: Double) {
        updateClip(id) { $0.spinBeats = beats }
        timingChanged()
    }

    // MARK: - Effects

    @discardableResult
    func addFX(_ id: UUID, kind: FXKind, atBar bar: Double? = nil, bars: Double? = nil) -> UUID? {
        guard let c = clip(id) else { return nil }
        let len = bars ?? kind.defaultBars
        var start = bar ?? (index(of: id).map { _ in c.mixOutBar - len } ?? c.mixInBar)
        // Inside the part of the track that plays, on a beat.
        start = (max(c.mixInBar, min(start, max(c.mixInBar, c.lastBar - len))) * 4).rounded() / 4
        let fx = ClipFX(kind: kind, bar: start, bars: len)
        updateClip(id) { $0.fx = ($0.fx ?? []) + [fx] }
        if kind == .reverb { timingChanged() }
        return fx.id
    }

    func updateFX(_ id: UUID, _ fxID: UUID, undoable: Bool = true, _ change: (inout ClipFX) -> Void) {
        updateClip(id, undoable: undoable) { c in
            guard var list = c.fx, let k = list.firstIndex(where: { $0.id == fxID }) else { return }
            change(&list[k])
            list[k].bars = max(0.25, list[k].bars)
            list[k].amount = min(1, max(0, list[k].amount))
            list[k].auto = nil
            c.fx = list
        }
    }

    func removeFX(_ id: UUID, _ fxID: UUID) {
        updateClip(id) { c in
            c.fx?.removeAll { $0.id == fxID }
            if c.fx?.isEmpty == true { c.fx = nil }
        }
    }

    func removeAllFX(_ id: UUID) {
        updateClip(id) { $0.fx = nil }
    }

    // MARK: - AI beat grid / cue suggestions

    /// The neural beat grid for a clip's file, at the clip's metrical level (e.g. 91.5 vs 183).
    /// `firstBeat` moved onto the actual attacks (kick / snare onsets) of the track, cached per grid.
    func attackAligned(_ url: URL, bpm: Double, firstBeat fb: Double, from t0: Double = 0, to t1: Double? = nil) -> Double {
        let key = "\(url.path)|\(Int((bpm * 1000).rounded()))|\(Int((fb * 10000).rounded()))|\(Int(t0))|\(Int(t1 ?? -1))"
        if let v = attackCache[key] { return v }
        let v = fb + (bandEnergies[url]?.onsetOffset(bpm: bpm, firstBeat: fb, from: t0, to: t1) ?? 0)
        attackCache[key] = v
        return v
    }
    @ObservationIgnored private var attackCache: [String: Double] = [:]

    func aiGrid(for c: Clip) -> (bpm: Double, firstBeat: Double, fit: Double, currentFit: Double, grid: NeuralGrid)? {
        guard let n = neuralResults[c.url], let g = n.grid else { return nil }
        var bpm = g.bpm
        for f in [2.0, 0.5, 4.0, 0.25] where abs(c.bpm / (g.bpm * f) - 1) < 0.03 { bpm = g.bpm * f }
        let fb = Mathx.posMod(attackAligned(c.url, bpm: bpm, firstBeat: g.firstBeat), 240 / bpm)
        return (bpm, fb,
                NeuralAnalyzer.beatHitRate(beats: n.beats, bpm: bpm, firstBeat: fb),
                NeuralAnalyzer.beatHitRate(beats: n.beats, bpm: c.bpm, firstBeat: c.firstBeat), g)
    }

    /// The clip's beat grid or bar line disagrees with what the neural tracker heard.
    func gridDiffersFromAI(_ c: Clip) -> Bool {
        guard let a = aiGrid(for: c) else { return false }
        if abs(a.bpm / c.bpm - 1) > 0.002 { return a.fit > a.currentFit - 0.01 }
        let bar = 240 / a.bpm
        let d = Mathx.posMod(a.firstBeat - c.firstBeat, bar)
        return min(d, bar - d) > 0.03
    }

    /// How many tracks (mix + library) disagree with the AI grid.
    var aiGridMismatches: Int { (clips + library).filter { gridDiffersFromAI($0) }.count }

    func applyAIGrid(_ id: UUID) {
        guard let c = clip(id), let a = aiGrid(for: c) else { return }
        updateClip(id) {
            $0.bpm = a.bpm
            $0.firstBeat = a.firstBeat
        }
        if let st = bandEnergies[c.url]?.structure(trustedBPM: a.bpm, firstBeat: a.firstBeat) { structures[c.url] = st }
        finishTimingEdit()
    }

    /// Moves the given tracks onto the AI beat grid where it disagrees (used before auto-mixing).
    func alignGridsToAI(_ ids: [UUID], undoable: Bool = true) {
        let targets = ids.compactMap { clip($0) }.filter { gridDiffersFromAI($0) }
        guard !targets.isEmpty else { return }
        if undoable { pushUndo() }
        for c in targets {
            guard let a = aiGrid(for: c) else { continue }
            updateClip(c.id, undoable: false) {
                $0.bpm = a.bpm
                $0.firstBeat = a.firstBeat
            }
            // Keep the AI bar lines as they are, so clip bars and analysis bars stay the same grid.
            if let st = bandEnergies[c.url]?.structure(trustedBPM: a.bpm, firstBeat: a.firstBeat) { structures[c.url] = st }
        }
        finishTimingEdit()
    }

    func alignAllGridsToAI() { alignGridsToAI((clips + library).map(\.id)) }

    /// CUE-DETR suggestions on the clip's own bar grid (snapped to the nearest beat).
    func aiCues(for c: Clip) -> [CueBar] {
        guard let n = neuralResults[c.url], c.bpm > 1 else { return [] }
        return n.cues.map { h in
            let b = c.bar(atSource: h.time)
            let snapped = abs(b - b.rounded()) < 0.15 ? b.rounded() : (b * 4).rounded() / 4
            return CueBar(bar: snapped, score: h.score)
        }
        .filter { $0.bar >= c.bar(atSource: 0) - 0.01 && $0.bar <= c.lastBar }
    }

    func setTempoSync(_ id: UUID, _ on: Bool) {
        updateClip(id) { $0.tempoSync = on }
        finishTimingEdit()
    }

    /// Moves the bar-1 marker by whole beats (fixes a wrong downbeat guess).
    func shiftDownbeat(_ id: UUID, beats: Int) {
        guard let c = clip(id), c.bpm > 0 else { return }
        let beat = 60 / c.bpm
        updateClip(id) { $0.firstBeat += Double(beats) * beat }
        finishTimingEdit()
    }

    /// Fine-tunes the beat grid; the audio moves so the beats stay locked to the mix.
    func nudgeGrid(_ id: UUID, milliseconds ms: Double) {
        updateClip(id) { $0.firstBeat += ms / 1000 }
        finishTimingEdit()
    }

    // CUE editing

    func openCueEditor(_ id: UUID) {
        guard clip(id) != nil else { return }
        pause()
        selectedClipID = id
        cueEditorTarget = CueEditorTarget(id: id)
    }

    /// Sets the mix-out (OUT cue) of a track itself.
    func setMixOut(_ id: UUID, bar: Double, undoable: Bool = true) {
        updateClip(id, undoable: undoable) {
            $0.mixOutBar = bar
            $0.cueDone = true
        }
        finishTimingEdit()
    }

    func useWholeTrack(_ id: UUID) {
        updateClip(id) { $0.resetToWholeTrack() }
        finishTimingEdit()
    }

    func addCue(_ id: UUID, bar: Double) {
        guard let c = clip(id) else { return }
        let n = (c.cues?.count ?? 0) + 1
        updateClip(id) {
            var list = $0.cues ?? []
            list.append(CuePoint(bar: bar, label: L("CUE \(n)", "Cue \(n)")))
            $0.cues = list
        }
    }

    func renameCue(_ id: UUID, cue: UUID, to label: String) {
        updateClip(id, undoable: false) {
            guard var list = $0.cues, let k = list.firstIndex(where: { $0.id == cue }) else { return }
            list[k].label = label
            $0.cues = list
        }
    }

    func removeCue(_ id: UUID, cue: UUID) {
        updateClip(id) { $0.cues?.removeAll { $0.id == cue } }
    }

    // Transition curve

    func setTransitionShape(_ id: UUID, undoable: Bool = true, _ change: (inout TransitionShape) -> Void) {
        guard let c = clip(id) else { return }
        var shape = c.transitionShape
        change(&shape)
        shape.inRise = min(1, max(0.001, shape.inRise))
        shape.outFadeStart = min(0.999, max(0, shape.outFadeStart))
        for band in EQBand.allCases {
            var b = shape.band(band)
            b.point = min(1, max(0, b.point))
            b.ramp = min(1 - b.point, max(0, b.ramp))
            shape.setBand(band, b)
        }
        updateClip(id, undoable: undoable) {
            $0.shape = shape
            $0.transitionDone = true
        }
    }

    func resetTransitionShape(_ id: UUID) {
        updateClip(id) { $0.shape = nil }
    }

    // Mix points

    func setMixIn(_ id: UUID, bar: Double, undoable: Bool = true) {
        updateClip(id, undoable: undoable) {
            $0.mixInBar = bar
            $0.landingLock = false
            $0.cueDone = true
        }
        finishTimingEdit()
    }

    /// Sets the bar of this track where the switch is complete (only this track plays).
    /// The mix-in is derived as landing − transition length.
    func setLandingBar(_ id: UUID, bar: Double, undoable: Bool = true) {
        updateClip(id, undoable: undoable) {
            $0.mixInBar = bar - $0.transitionBars
            $0.landingLock = true
            $0.cueDone = true
        }
        finishTimingEdit()
    }

    func setLandingLock(_ id: UUID, _ on: Bool) {
        updateClip(id) { $0.landingLock = on }
    }

    /// Trims the start of a track while its audio stays where it is on the timeline:
    /// the previous track hands over correspondingly later (or earlier).
    func slipMixIn(_ id: UUID, to bar: Double) {
        guard let i = index(of: id) else { return }
        let c = clips[i]
        let minIn = c.bar(atSource: 0) - 64
        let maxIn = c.mixOutBar - 1
        let newIn = min(max(bar, minIn), i + 1 < clips.count ? maxIn : c.lastBar - 1)
        let delta = newIn - c.mixInBar
        guard abs(delta) > 0.0001 else { return }
        isDirty = true
        if i > 0 {
            let prev = clips[i - 1]
            let prevOut = prev.mixOutBar + delta
            // The previous track must still have audio for the transition.
            guard prevOut > prev.mixInBar + 0.99,
                  prevOut + c.transitionBars <= prev.lastBar + 0.01 else { return }
            clips[i - 1].mixOutBar = prevOut
        }
        clips[i].mixInBar = newIn
        finishTimingEdit()
    }

    // MARK: Direct manipulation on the timeline (the audio under the mouse stays where it is)

    /// Dragging the left edge of a track that comes in over the previous one: the edge (where the overlap starts)
    /// follows the mouse, this track's audio stays where it is and the previous track still ends where it ended —
    /// so the overlap gets longer or shorter. Values are absolute, taken from the start of the drag.
    /// Returns the bars the edge actually moved (after the limits).
    @discardableResult
    func dragIncomingEdge(_ id: UUID, by delta: Double, origIn: Double, origPrevOut: Double, origBars: Double) -> Double {
        guard let i = index(of: id), i > 0 else { return 0 }
        let c = clips[i], prev = clips[i - 1]
        var d = delta
        d = max(d, ceil(c.bar(atSource: 0) * 4 - 0.001) / 4 - origIn)      // not before the start of the file
        d = max(d, prev.mixInBar + 1 - origPrevOut)                          // the previous track plays at least a bar
        d = min(d, origBars)                                                 // overlap down to zero (a straight cut)
        d = min(d, c.mixOutBar - 1 - origIn)
        isDirty = true
        clips[i].mixInBar = origIn + d
        clips[i - 1].mixOutBar = origPrevOut + d
        clips[i].transitionBars = max(0, origBars - d)
        finishTimingEdit()
        return d
    }

    /// Dragging the left edge of the first track: where it starts playing (never before the start of the file).
    /// Returns the bars it moved.
    @discardableResult
    func dragFirstStart(_ id: UUID, by delta: Double, origIn: Double) -> Double {
        guard let i = index(of: id), i == 0 else { return 0 }
        let c = clips[i]
        let lo = ceil(c.bar(atSource: 0) * 4 - 0.001) / 4
        let hi = (clips.count > 1 ? c.mixOutBar : (c.endBar ?? c.lastBar)) - 1
        let newIn = min(max(origIn + delta, lo), hi)
        isDirty = true
        clips[i].mixInBar = newIn
        finishTimingEdit()
        return newIn - origIn
    }

    /// ⌘-drag: slides the audio inside the track's box (its start, end and the transitions stay where they are).
    @discardableResult
    func slipContent(_ id: UUID, by delta: Double, origIn: Double, origOut: Double, origEnd: Double?) -> Double {
        guard let i = index(of: id) else { return 0 }
        let c = clips[i]
        var d = delta
        d = max(d, ceil(c.bar(atSource: 0) * 4 - 0.001) / 4 - origIn)
        if i + 1 < clips.count {
            d = min(d, c.lastBar - clips[i + 1].transitionBars - origOut)
        } else if let e = origEnd {
            d = min(d, c.lastBar - e)
        } else {
            d = min(d, 0)
        }
        isDirty = true
        clips[i].mixInBar = origIn + d
        clips[i].mixOutBar = origOut + d
        if let e = origEnd { clips[i].endBar = e + d }
        finishTimingEdit()
        return d
    }

    /// Sets where the *previous* track hands over to clip `id`.
    func setEntryPoint(_ id: UUID, previousMixOut bar: Double, undoable: Bool = true) {
        guard let i = index(of: id), i > 0 else { return }
        if undoable { pushUndo() } else { isDirty = true }
        clips[i - 1].mixOutBar = bar
        finishTimingEdit()
    }

    func moveEntry(_ id: UUID, byBars delta: Double) {
        guard let i = index(of: id), i > 0 else { return }
        setEntryPoint(id, previousMixOut: clips[i - 1].mixOutBar + delta)
    }

    /// - Parameter makeRoom: when the overlap would run past the end of the previous
    ///   track's music, move its exit earlier (to a phrase) instead of shortening the overlap.
    ///   Dragging on the timeline passes false so the edge follows the mouse.
    func setTransitionLength(_ id: UUID, bars: Double, undoable: Bool = true, makeRoom: Bool = true) {
        guard let i = index(of: id), i > 0 else { return }
        if undoable { pushUndo() } else { isDirty = true }
        if makeRoom { self.makeRoom(forTransitionInto: i, bars: bars) }
        let prev = clips[i - 1]
        let available = max(0, prev.lastBar - prev.mixOutBar)
        let v = min(max(0, bars), min(128, available))
        if clips[i].keepsLanding {
            let landing = clips[i].landingBar
            clips[i].transitionBars = v
            clips[i].mixInBar = landing - v
        } else {
            clips[i].transitionBars = v
        }
        finishTimingEdit()
    }

    /// Bar (on the clip's grid) where the clip's music ends.
    private func musicEndBar(_ c: Clip) -> Double {
        if let s = structures[c.url] { return min(c.lastBar, clipBar(c, s, s.musicEnd)) }
        if let t = waveforms[c.url]?.lastSoundTime() { return min(c.lastBar, (c.bar(atSource: t)).rounded()) }
        return floor(c.lastBar)
    }

    /// Moves the previous track's exit earlier when an overlap of `bars` would run past the
    /// end of its music, so choosing e.g. a 16-bar bass swap always gives 16 bars of overlap.
    private func makeRoom(forTransitionInto i: Int, bars: Double) {
        guard i > 0, i < clips.count, bars > 0.01 else { return }
        let prev = clips[i - 1]
        let end = musicEndBar(prev)
        guard prev.mixOutBar + bars > end + 0.01 else { return }
        var out = end - bars
        if let s = structures[prev.url] {
            // Latest phrase start (4-bar grid) that still fits.
            let target = Int(s.bar(atTime: prev.sourceTime(bar: out)).rounded(.down))
            if let g = s.gridBars(from: target - 8, to: target, step: 4).last {
                out = clipBar(prev, s, g)
            }
        } else {
            out = floor(out)
        }
        let lowest = (i - 1 == 0 ? prev.mixInBar : prev.landingBar) + 1
        clips[i - 1].mixOutBar = max(lowest, out)
    }

    func setEndBar(_ id: UUID, bar: Double?, undoable: Bool = true) {
        updateClip(id, undoable: undoable) { $0.endBar = bar }
        finishTimingEdit()
    }

    func setTransitionStyle(_ id: UUID, _ style: TransitionStyle) {
        guard let c = clip(id) else { return }
        var bars = c.transitionBars
        switch style {
        case .cut, .brake, .backspin:
            bars = 0
        case .echoOut:
            if bars < 0.99 || bars > 4.01 { bars = 2 }
        default:
            // Coming from a cut or an echo, start from the length this style is usually played with.
            if bars < 3.99 { bars = style == .bassSwap ? 16 : 8 }
        }
        applyTransition(id, style: style, bars: bars)
    }

    func applyPreset(_ id: UUID, _ preset: TransitionPreset) {
        applyTransition(id, style: preset.style, bars: preset.bars)
    }

    private func applyTransition(_ id: UUID, style: TransitionStyle, bars: Double, lanes: TransitionLanes? = nil) {
        guard let i = index(of: id), i > 0 else { return }
        pushUndo()
        makeRoom(forTransitionInto: i, bars: bars)
        let prev = clips[i - 1]
        let available = max(0, prev.lastBar - prev.mixOutBar)
        let landing = clips[i].landingBar
        if style == .custom {
            // Start from the hand-drawn lanes given, or what is heard right now.
            clips[i].lanes = lanes ?? clips[i].lanes ?? clips[i].effectiveLanes
        }
        clips[i].transition = style
        clips[i].transitionDone = true
        clips[i].shape = nil
        clips[i].transitionBars = min(max(0, bars), available)
        if clips[i].keepsLanding {
            clips[i].mixInBar = landing - clips[i].transitionBars
        }
        finishTimingEdit()
    }

    // MARK: Editing shortcuts

    /// Selects the previous / next track (mix first, then library).
    func selectAdjacent(_ delta: Int) {
        let order = allTrackIDs
        guard !order.isEmpty else { return }
        let current = selectedClipID.flatMap { order.firstIndex(of: $0) } ?? (delta > 0 ? -1 : order.count)
        let next = min(max(0, current + delta), order.count - 1)
        selectedClipID = order[next]
        if let c = clip(order[next]), isInMix(c.id) { requestScroll(to: c.start) }
    }

    /// Moves the selected mix track earlier / later in the running order.
    func moveSelectedInOrder(_ delta: Int) {
        guard let i = selectedIndex else { return }
        let target = i + delta
        guard target >= 0, target < clips.count else { return }
        moveClips(from: IndexSet(integer: i), to: delta > 0 ? target + 1 : target)
    }

    func copyTransition() {
        guard let i = selectedIndex, i > 0 else { return }
        let c = clips[i]
        transitionClipboard = TransitionClip(style: c.transition, bars: c.transitionBars, shape: c.shape, lanes: c.lanes)
    }

    func pasteTransition() {
        guard let id = selectedClipID, let i = index(of: id), i > 0, let t = transitionClipboard else { return }
        applyTransition(id, style: t.style, bars: t.bars, lanes: t.lanes)
        if let k = index(of: id) { clips[k].shape = t.shape }
    }

    /// Number keys 1–6 apply the built-in recipes to the selected transition.
    func applyPreset(number: Int) {
        guard let id = selectedClipID, let i = index(of: id), i > 0 else { return }
        let all = TransitionPreset.all
        guard number >= 1, number <= all.count else { return }
        applyPreset(id, all[number - 1])
    }

    // MARK: Hand-drawn transitions

    func openTransitionEditor(_ id: UUID) {
        guard let i = index(of: id), i > 0 else { return }
        selectedClipID = id
        transitionEditorTarget = CueEditorTarget(id: id)
    }

    /// Stores hand-drawn lanes; the transition becomes "custom".
    func setLanes(_ id: UUID, _ lanes: TransitionLanes, undoable: Bool = true) {
        updateClip(id, undoable: undoable) {
            $0.lanes = lanes
            $0.transition = .custom
            $0.transitionDone = true
        }
        // Vocal / instrumental lanes need the tracks' stems.
        if lanes.usesStemsIncoming || lanes.usesStemsOutgoing { prepareStemsIfNeeded() }
    }

    func applyCustomTransition(_ id: UUID, _ preset: CustomTransition) {
        applyTransition(id, style: .custom, bars: preset.bars, lanes: preset.lanes)
    }

    func saveCustomTransition(from id: UUID, name: String) {
        guard let c = clip(id) else { return }
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        let title = trimmed.isEmpty ? L("マイつなぎ \(customTransitions.count + 1)", "My Transition \(customTransitions.count + 1)") : trimmed
        customTransitions.append(CustomTransition(name: title, bars: max(1, c.transitionBars), lanes: c.effectiveLanes))
    }

    func deleteCustomTransition(_ presetID: UUID) {
        customTransitions.removeAll { $0.id == presetID }
    }

    func renameCustomTransition(_ presetID: UUID, to name: String) {
        guard let k = customTransitions.firstIndex(where: { $0.id == presetID }) else { return }
        customTransitions[k].name = name
    }

    private static let customKey = "DJAW.customTransitions"

    static func loadCustomTransitions() -> [CustomTransition] {
        guard let data = UserDefaults.standard.data(forKey: customKey),
              let list = try? JSONDecoder().decode([CustomTransition].self, from: data) else { return [] }
        return list
    }

    static func saveCustomTransitions(_ list: [CustomTransition]) {
        if let data = try? JSONEncoder().encode(list) {
            UserDefaults.standard.set(data, forKey: customKey)
        }
    }

    func applyPresetToAll(_ preset: TransitionPreset) {
        guard clips.count > 1 else { return }
        pushUndo()
        for i in clips.indices.dropFirst() {
            clips[i].transition = preset.style
            clips[i].transitionBars = preset.bars
        }
        finishTimingEdit()
    }

    func trimToFirstDownbeat(_ id: UUID) {
        setMixIn(id, bar: 0)
    }

    /// Plays the track from the very beginning of the file (bar-aligned).
    func resetTrim(_ id: UUID) {
        guard let c = clip(id) else { return }
        pushUndo()
        let barsBeforeOne = ceil(c.firstBeat / c.barSource - 0.001)
        if let i = index(of: id) {
            clips[i].mixInBar = -barsBeforeOne
            clips[i].endBar = nil
        }
        finishTimingEdit()
    }

    // MARK: - Track list

    /// Copies "0:00 Artist - Title" lines for the set (SoundCloud descriptions etc.).
    func copyTrackList() {
        let text = PerformanceGuide.trackList(clips: clips, master: masterBPM, tempo: tempoMap)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    // MARK: - Auto-mix (structure based)

    #if DEBUG
    static func logStructure(_ title: String, _ s: TrackStructure?) {
        guard let s else { print("[DJAW] \(title): no structure"); return }
        print("[DJAW] \(title): bpm=\(s.bpm) fb=\(String(format: "%.3f", s.firstBeat)) shift=\(s.downbeatShift) phrase=\(s.phraseOffset) bars=\(s.barCount) music=\(s.musicStart + 1)-\(s.musicEnd) firstDrop=\(s.firstDrop + 1) outro=\(s.lastDropEnd + 1) key=\(s.key.map { "\($0.name) \($0.camelot) r=\(String(format: "%.2f", $0.confidence))" } ?? "-")")
        print("[DJAW]    " + s.sections.map { "\($0.kind.rawValue)[\($0.start + 1)-\($0.end)]" }.joined(separator: " "))
    }
    #else
    static func logStructure(_ title: String, _ s: TrackStructure?) {}
    #endif

    /// A clip bar (on the clip's own grid) for a bar of the analysis grid.
    private func clipBar(_ c: Clip, _ s: TrackStructure, _ bar: Int) -> Double {
        let b = c.bar(atSource: s.time(ofBar: Double(bar)))
        return (b * 4).rounded() / 4
    }

    /// Analysis-grid bar for a clip bar.
    private func structureBar(_ c: Clip, _ s: TrackStructure, _ bar: Double) -> Int {
        Int(s.bar(atTime: c.sourceTime(bar: bar)).rounded())
    }

    private func keyClash(_ a: TrackStructure, _ b: TrackStructure) -> Bool {
        guard let ka = a.key, let kb = b.key, ka.confidence > 0.5, kb.confidence > 0.5 else { return false }
        return !ka.isCompatible(with: kb)
    }

    /// Plans the transition into clip `i` and applies it. Returns the incoming track's landing bar (analysis grid).
    @discardableResult
    private func applyAutoTransition(into i: Int, earliestOut: Int?, option: Int = 0, force: Bool = false) -> Int? {
        guard i > 0, i < clips.count else { return nil }
        if isLocked(i) && !force { return lockedLanding(i) }
        let a = clips[i - 1], b = clips[i]
        guard let sa = structures[a.url], let sb = structures[b.url] else {
            // Not analysed (yet): fall back to an 8-bar phrase exit with a 16-bar bass swap.
            clips[i].transition = .bassSwap
            clips[i].transitionBars = 16
            clips[i].shape = nil
            clips[i].lanes = nil
            clips[i].autoNote = nil
            clips[i - 1].mixOutBar = suggestedMixOut(for: clips[i - 1], transitionBars: 16)
            return nil
        }
        guard let ctx = planContext(into: i, earliestOut: earliestOut) else { return nil }
        let plans = AutoMixer.planOptions(sa, sb, earliestOut: ctx.aMin, keyClash: keyClash(sa, sb), tempoRatio: ctx.ratio,
                                          profile: ctx.profile, vocals: ctx.vocals, count: option + 1, landing: ctx.aLanding)
        guard plans.count > option else { return nil }
        return applyPlan(plans[option], into: i)
    }

    private struct PlanContext {
        var aMin: Int
        var aLanding: Int
        var ratio: Double
        var profile: MixProfile
        var vocals: AutoMixer.Vocals
    }

    private func planContext(into i: Int, earliestOut: Int?) -> PlanContext? {
        guard i > 0, i < clips.count else { return nil }
        let a = clips[i - 1], b = clips[i]
        guard let sa = structures[a.url], let sb = structures[b.url] else { return nil }
        let aLanding = structureBar(a, sa, i - 1 == 0 ? a.mixInBar : a.landingBar)
        return PlanContext(aMin: earliestOut ?? (aLanding + 8),
                           aLanding: aLanding,
                           ratio: max(sa.bpm, sb.bpm) / max(1, min(sa.bpm, sb.bpm)),
                           profile: profile(for: a, b),
                           vocals: AutoMixer.Vocals(a: vocalBars(a), b: vocalBars(b)))
    }

    /// Writes one planned transition into clips i-1 / i (mix points, style, shape, matching effects, explanation).
    @discardableResult
    private func applyPlan(_ plan: AutoMixPlan, into i: Int) -> Int? {
        guard i > 0, i < clips.count else { return nil }
        let a = clips[i - 1], b = clips[i]
        guard let sa = structures[a.url], let sb = structures[b.url] else { return nil }
        let ga = genre(for: a), gb = genre(for: b)
        let profile = profile(for: a, b)
        replannable.insert(b.id)
        clips[i - 1].mixOutBar = clipBar(a, sa, plan.outBar)
        clips[i].mixInBar = clipBar(b, sb, plan.inBar)
        clips[i].transitionBars = Double(plan.length)
        clips[i].transition = plan.style
        clips[i].shape = plan.shape
        clips[i].lanes = nil
        clips[i].landingLock = nil
        var reasons = plan.reasons
        if let line = genreLine(ga, gb) { reasons.insert(line, at: 0) }
        if let label = plan.label { reasons.insert(L("つなぎ方：\(label)", "Variation: \(label)"), at: 0) }
        // Effects that go with the chosen transition (replaced whenever it is planned again).
        clips[i - 1].fx?.removeAll { $0.auto == true }
        let out = clips[i - 1].mixOutBar
        let aFull = sa.hasBass(plan.outBar - 1)
        if plan.style == .bassSwap && plan.length >= 16 && profile.thinOut {
            let half = Double(plan.length) / 2
            addAutoFX(i - 1, ClipFX(kind: .highPass, bar: out + half, bars: half, amount: 0.5, shape: .rise, auto: true))
            reasons.append(L("後半は前の曲にハイパスをかけて軽くしながら抜く", "The previous track is thinned out with a high-pass in the second half"))
        } else if plan.style == .cut && aFull {
            var roll = ClipFX(kind: .roll, bar: out - 0.5, bars: 0.5, auto: true)
            roll.division = 0.25
            addAutoFX(i - 1, roll)
            reasons.append(L("切り替え直前の2拍をロールで刻んで次のドロップへ", "A short roll over the last two beats leads into the drop"))
        } else if plan.style == .echoOut || plan.style == .backspin {
            addAutoFX(i - 1, ClipFX(kind: .reverb, bar: out - 1, bars: 2, amount: 0.45, shape: .rise, auto: true))
        } else if profile.reverbTail && plan.style == .crossfade && plan.length >= 8 {
            let half = Double(plan.length) / 2
            addAutoFX(i - 1, ClipFX(kind: .reverb, bar: out + half, bars: half, amount: 0.4, shape: .rise, auto: true))
            reasons.append(L("前の曲はリバーブで余韻を残しながら消える", "The previous track fades into a reverb tail"))
        }
        if clips[i - 1].fx?.isEmpty == true { clips[i - 1].fx = nil }
        clips[i].autoNote = AutoMixNote(text: reasons.joined(separator: "\n"), style: plan.style,
                                        bars: Double(plan.length), inBar: clips[i].mixInBar)
        return plan.inBar + plan.length
    }

    /// Landing bar (analysis grid) of the locked transition into clip `i`, as it stands.
    private func lockedLanding(_ i: Int) -> Int? {
        guard let s = structures[clips[i].url] else { return nil }
        return structureBar(clips[i], s, clips[i].landingBar)
    }

    /// After planning: a track whose exit is locked must have landed (and played a little) before that exit.
    /// If its own entry was planned too late, it comes in earlier (the previous track's exit stays).
    private func fixLockedEntries() {
        for i in clips.indices where i + 1 < clips.count && isLocked(i + 1) {
            let exit = clips[i].mixOutBar
            let firstBar = ceil(clips[i].bar(atSource: 0))
            let latest = exit - 2
            guard clips[i].landingBar > latest else { continue }
            if i == 0 {
                clips[i].mixInBar = max(firstBar, floor(exit - 8))
            } else if isLocked(i) {
                // Both sides locked and they collide: shorten the incoming overlap.
                clips[i].transitionBars = max(0, latest - clips[i].mixInBar)
            } else {
                let inBar = max(firstBar, floor(latest - clips[i].transitionBars))
                clips[i].mixInBar = inBar
                if clips[i].landingBar > latest { clips[i].transitionBars = max(0, latest - inBar) }
            }
        }
    }

    private func addAutoFX(_ k: Int, _ fx: ClipFX) {
        clips[k].fx = (clips[k].fx ?? []) + [fx]
    }

    /// Lets the mix tempo follow the tracks: small differences are stretched, bigger ones change
    /// the mix BPM — gradually over a blend, instantly at a cut / brake / backspin.
    private func planTempos(from start: Int, through end: Int? = nil, instant: Bool = false) {
        guard !clips.isEmpty else { return }
        if start == 0, end == nil, clips[0].tempoSync, clips[0].bpm > 1, abs(clips[0].bpm / masterBPM - 1) > 0.04 {
            masterBPM = (clips[0].bpm * 100).rounded() / 100
        }
        var current = tempoBefore(max(1, start + 1))
        for i in clips.indices.dropFirst() where i > start && i <= (end ?? clips.count) {
            if isLocked(i) {
                if let t = clips[i].tempo { current = t }
                continue
            }
            clips[i].tempo = nil
            clips[i].tempoBars = nil
            let native = clips[i].bpm
            guard clips[i].tempoSync, native > 1 else { continue }
            let dev = abs(native / current - 1)
            // Cuts hide tempo jumps, so quick-cut mixes follow every track's own tempo.
            guard dev > (instant ? 0.015 : 0.04) else { continue }
            let target = (native * 100).rounded() / 100
            clips[i].tempo = target
            if instant { clips[i].tempoBars = 0 }
            // Short blends: let the pitch ride over at least 8 bars so the change stays unnoticeable.
            if !instant && !clips[i].transition.isCutLike && clips[i].transitionBars < 8 { clips[i].tempoBars = 8 }
            let line = clips[i].transition.isCutLike || instant
                ? L("BPM を \(Fmt.bpm(current)) → \(Fmt.bpm(target)) に切り替えと同時に変更（曲を無理に伸縮しない）", "Mix BPM switches \(Fmt.bpm(current)) → \(Fmt.bpm(target)) with the cut (no heavy stretching)")
                : L("BPM をつなぎの間に \(Fmt.bpm(current)) → \(Fmt.bpm(target)) へ徐々に変更", "Mix BPM moves \(Fmt.bpm(current)) → \(Fmt.bpm(target)) during the blend")
            if var note = clips[i].autoNote {
                note.text += "\n" + line
                clips[i].autoNote = note
            }
            current = target
        }
    }

    /// Analyses every track's structure and plans all transitions:
    /// phrase-aligned exits and entries, landing on drops, matching style per pair.
    func autoMixAll() {
        guard clips.count > 1 else { return }
        // Right after opening a mix the analysis is still running: plan once it is done.
        if analysesInFlight > 0, clips.contains(where: { structures[$0.url] == nil && !missingFiles.contains($0.url) }) {
            autoMixWhenReady = true
            return
        }
        pushUndo()
        alignGridsToAI(clips.indices.filter { !isLockMember($0) }.map { clips[$0].id }, undoable: false)
        harmonizeTempos()
        plan(from: 0)
    }

    /// How the auto-mix connects `a` into `b`: the genres' usual style, with the chosen track use on top.
    func profile(for a: Clip, _ b: Clip) -> MixProfile {
        var p = MixProfile.pair(genre(for: a), genre(for: b))
        switch trackUse {
        case .auto: break
        case .full:
            p.pacing = nil
            p.dropToDrop = 0
        case .energetic:
            p.pacing = p.pacing ?? 150
            p.dropToDrop = max(p.dropToDrop, 0.8)
        }
        return p
    }

    // MARK: Genre

    /// Genre the auto-mix uses for a track: the user's choice, else the tag, else the model.
    func genre(for c: Clip) -> MixGenre? {
        c.genre ?? genreResults[c.url]?.best
    }

    /// Where the genre comes from (for the inspector).
    func genreSource(for c: Clip) -> String? {
        if c.genre != nil { return L("手動で指定", "Set by you") }
        guard let r = genreResults[c.url] else { return nil }
        if let t = r.tag, r.tagFamily != nil { return L("ファイルのジャンルタグ「\(t)」", "File genre tag “\(t)”") }
        if r.detected != nil { return L("AI のジャンル判定", "AI genre detection") }
        return nil
    }

    /// Vocal probability per analysis-grid bar (nil until the genre / vocal analysis is done).
    func vocalBars(_ c: Clip) -> [Float]? {
        guard let s = structures[c.url], let r = genreResults[c.url], r.voice != nil else { return nil }
        return (0..<s.barCount).map { b in r.vocal(from: s.time(ofBar: Double(b)), to: s.time(ofBar: Double(b + 1))) ?? 0 }
    }

    /// 0…1-ish energy of a track: party / aggressive / danceable feel plus how loud its drops are.
    func energyLevel(_ c: Clip) -> Double? {
        guard let t = genreResults[c.url]?.traits, t.count == 4 else { return nil }
        var e = 0.4 * t[1] + 0.35 * t[2] + 0.25 * t[3]
        if let s = structures[c.url] {
            let drops = s.sections.filter { $0.kind == .drop }
            let bars = drops.flatMap { Array($0.start..<$0.end) }
            if !bars.isEmpty {
                let db = bars.reduce(0.0) { $0 + max(-20, s.energy($1)) } / Double(bars.count)
                e = 0.75 * e + 0.25 * min(1, max(0, (db + 20) / 20))
            }
        }
        e += 0.1 * min(1, max(0, (c.bpm - 100) / 80))
        return e
    }

    /// Genres in the mix, most common first.
    var genreSummary: [(genre: MixGenre, count: Int)] {
        var n: [MixGenre: Int] = [:]
        for c in clips { if let g = genre(for: c) { n[g, default: 0] += 1 } }
        return n.map { ($0.key, $0.value) }.sorted { $0.count > $1.count || ($0.count == $1.count && $0.genre.rawValue < $1.genre.rawValue) }
    }

    func setGenre(_ id: UUID, _ g: MixGenre?) {
        updateClip(id) { $0.genre = g }
    }

    private func genreLine(_ a: MixGenre?, _ b: MixGenre?) -> String? {
        switch (a, b) {
        case (_?, let y?) where a == b:
            return L("ジャンル：\(y.title) → \(y.mixSummary)", "Genre: \(y.title) → \(y.mixSummary)")
        case (let x?, let y?) where x.isNeighbor(of: y):
            return L("ジャンル：\(x.title) → \(y.title)（近いジャンルなので両方の流儀の中間でつなぐ）", "Genre: \(x.title) → \(y.title) (related, so a mix of both styles)")
        case (let x?, let y?):
            return L("ジャンル：\(x.title) → \(y.title)（大きく変わるので短めのつなぎ・カットイン寄り）", "Genre: \(x.title) → \(y.title) (a big change: shorter blend or a cut)")
        case (nil, let y?):
            return L("ジャンル：\(y.title) → \(y.mixSummary)", "Genre: \(y.title) → \(y.mixSummary)")
        default:
            return nil
        }
    }

    // MARK: Quick-cut style (Dariacore / mashups)

    /// Energy curve the running order follows (remembered between launches).
    var setArc: SetArc = SetArc(rawValue: UserDefaults.standard.string(forKey: "DJAW.setArc") ?? "") ?? .none {
        didSet { UserDefaults.standard.set(setArc.rawValue, forKey: "DJAW.setArc") }
    }

    /// Check every planned transition by rendering it (and fall back to the next plan when it fails).
    var verifyTransitions: Bool = UserDefaults.standard.object(forKey: "DJAW.verifyTransitions") as? Bool ?? true {
        didSet { UserDefaults.standard.set(verifyTransitions, forKey: "DJAW.verifyTransitions") }
    }

    /// Style the auto-mix uses (remembered between launches).
    var mixStyle: MixStyle = MixStyle(rawValue: UserDefaults.standard.string(forKey: "DJAW.mixStyle") ?? "") ?? .auto {
        didSet { UserDefaults.standard.set(mixStyle.rawValue, forKey: "DJAW.mixStyle") }
    }

    /// Whether a track would be mixed with quick cuts in "auto" style.
    func looksQuick(_ c: Clip) -> Bool {
        guard let s = structures[c.url] else { return false }
        return AutoMixer.looksQuick(s, tempoVaries: neuralResults[c.url]?.grid?.tempoVaries ?? false)
    }

    /// `mixStyle`, with "auto" decided by the tracks: quick cuts when at least half of them change fast.
    /// `.auto` is returned for a mixed set: quick-cut tracks get cut-ins, the others are blended.
    func resolvedStyle<S: Sequence>(_ indices: S) -> MixStyle where S.Element == Int {
        guard mixStyle == .auto else { return mixStyle }
        let tracks = indices.map { clips[$0] }.filter { structures[$0.url] != nil }
        guard !tracks.isEmpty else { return .long }
        let quick = tracks.filter { isQuickTrack($0) }.count
        if quick == 0 { return .long }
        if quick == tracks.count { return .quick }
        return .auto
    }

    /// A track that is better played as a short highlight with cut-ins (fast-changing, tempo-switching, breakcore / Dariacore).
    func isQuickTrack(_ c: Clip) -> Bool {
        let g = genre(for: c)
        if g == .breakcore { return true }
        if c.genre != nil { return false }   // the user chose a genre that is blended
        // Steady-groove genres (swing can lower the grid fit) only count as quick when the tempo really moves.
        if let g, [.house, .techno, .trance, .ukg, .dnb, .chill].contains(g) {
            return neuralResults[c.url]?.grid?.tempoVaries ?? false
        }
        return looksQuick(c)
    }

    /// What the auto-mix will do, in words (inspector).
    func styleSummary<S: Sequence>(_ indices: S) -> String where S.Element == Int {
        switch resolvedStyle(indices) {
        case .auto: return L("カットイン向きの曲はカットイン、それ以外はジャンルに合わせてブレンド", "cut-ins for fast-changing tracks, genre-style blends for the rest")
        case let s: return s.title
        }
    }

    private func plan(from start: Int) {
        if resolvedStyle(clips.indices) == .quick || clips.count < 2 {
            mixPatterns = []
            currentPatternID = nil
            planOnly(from: start)
        } else {
            planPatterns(from: start)
        }
        computeReplannable()
        finishTimingEdit()
        startVerification(from: start)
    }

    private func planOnly(from start: Int) {
        replannable.removeAll()
        switch resolvedStyle(clips.indices) {
        case .quick: planTransitionsQuick(from: start)
        case .auto: planTransitionsMixed(from: start)
        case .long: planTransitions(from: start)
        }
        fixLockedEntries()
        layout()
    }

    // MARK: Variations of one transition

    /// One way to connect two tracks, offered for comparison in the inspector.
    struct TransitionVariation: Identifiable {
        let id = UUID()
        let plan: AutoMixPlan
        var label: String { plan.label ?? "" }
        /// Result of rendering it (nil = not checked yet).
        var problems: [String]?
    }

    /// Variations for the transition into `id`, recomputed when the inspector asks.
    var variations: [UUID: [TransitionVariation]] = [:]
    /// The previous track each variation list was made for (a list is stale once the order changes).
    @ObservationIgnored private var variationPrev: [UUID: UUID] = [:]

    /// The variations into `id`, or nil when there are none for the track that now comes before it.
    func variationList(into id: UUID) -> [TransitionVariation]? {
        guard let i = index(of: id), i > 0, let v = variations[id], variationPrev[id] == clips[i - 1].id else { return nil }
        return v
    }

    func computeVariations(into id: UUID) {
        guard let i = index(of: id), i > 0, let sa = structures[clips[i - 1].url], let sb = structures[clips[i].url],
              let ctx = planContext(into: i, earliestOut: nil) else { variations[id] = []; variationPrev[id] = nil; return }
        let plans = AutoMixer.planVariations(sa, sb, earliestOut: ctx.aMin, keyClash: keyClash(sa, sb), tempoRatio: ctx.ratio,
                                             profile: ctx.profile, vocals: ctx.vocals, landing: ctx.aLanding)
        variationPrev[id] = clips[i - 1].id
        variations[id] = plans.map { TransitionVariation(plan: $0, problems: nil) }
    }

    /// Uses variation `k` for the transition into `id` (undoable); later exits are moved if they no longer fit.
    func applyVariation(into id: UUID, _ k: Int) {
        guard let i = index(of: id), i > 0, let v = variationList(into: id), k < v.count else { return }
        pushUndo()
        preserveTransitionBeforeReplacing(into: i)
        applyPlan(v[k].plan, into: i)
        refitFollowing(after: i)
        planTempos(from: i - 1, through: min(clips.count - 1, i + 1))
        finishTimingEdit()
    }

    /// Applies variation `k` and plays from 4 bars before it (undo returns to the previous one).
    func previewVariation(into id: UUID, _ k: Int) {
        applyVariation(into: id, k)
        previewTransition(id)
    }

    /// Whether the transition into `id` currently is variation `k`.
    func isCurrentVariation(into id: UUID, _ k: Int) -> Bool {
        guard let i = index(of: id), i > 0, let v = variationList(into: id), k < v.count, let s = structures[clips[i].url],
              let sa = structures[clips[i - 1].url] else { return false }
        let p = v[k].plan
        return clips[i].transition == p.style && Int(clips[i].transitionBars.rounded()) == p.length
            && structureBar(clips[i], s, clips[i].mixInBar) == p.inBar
            && structureBar(clips[i - 1], sa, clips[i - 1].mixOutBar) == p.outBar
    }

    /// Renders and checks every variation of the transition into `id` (in the background, one at a time).
    func checkVariations(into id: UUID) async {
        guard let list = variationList(into: id), !list.isEmpty else { return }
        for k in list.indices {
            guard let i = index(of: id), i > 0, let v = variationList(into: id), k < v.count, v[k].id == list[k].id else { return }
            // Try the variation on a copy of the mix.
            let saved = clips
            applyPlan(v[k].plan, into: i)
            refitFollowing(after: i)
            layout()
            let snap = clips, m = masterBPM, tm = tempoMap, g = gridOffset
            clips = saved
            layout()
            let r = await Task.detached(priority: .utility) {
                TransitionCheck.check(clips: snap, index: i, master: m, tempo: tm, gridOffset: g)
            }.value
            guard var cur = variations[id], k < cur.count, cur[k].id == list[k].id else { return }
            cur[k].problems = r?.problems ?? []
            variations[id] = cur
        }
    }

    // MARK: Whole-mix patterns

    /// A complete auto-mix plan the user can switch to.
    struct MixPattern: Identifiable {
        let id = UUID()
        let title: String
        let detail: String
        fileprivate var state: Snapshot
        fileprivate var structures: [URL: TrackStructure]
        let blends: Int
        let cuts: Int
        let averageBars: Double
        let duration: Double
    }

    /// Patterns made by the last auto-mix (first = the one in use after auto-mix).
    var mixPatterns: [MixPattern] = []
    var currentPatternID: UUID?

    private struct PatternRecipe { let title: String; let detail: String; let params: MixTuning.Params }

    private var patternRecipes: [PatternRecipe] {
        [PatternRecipe(title: L("おすすめ", "Recommended"), detail: L("ジャンルと曲の構成から選んだ標準の案", "The standard plan for these genres and structures"),
                       params: .init()),
         PatternRecipe(title: L("じっくり長め", "Long & Smooth"), detail: L("16〜32小節の長いブレンド中心", "Mostly 16–32-bar blends"),
                       params: .init(len32: 0.8, len16: 0.4, len8: -0.3, len4: -0.7, switchBias: -0.8, echoBias: -0.3, spinBias: -0.6, maxBars: 32)),
         PatternRecipe(title: L("テンポよく短め", "Short & Snappy"), detail: L("4〜8小節の短いつなぎとエコーアウト", "4–8-bar mixes and echo-outs"),
                       params: .init(len32: -1.2, len16: -0.4, len8: 0.5, len4: 0.6, switchBias: 0.6, echoBias: 0.5)),
         PatternRecipe(title: L("カットイン多め", "Cut-Heavy"), detail: L("ドロップ頭のカットイン・バックスピン中心", "Mostly cut-ins on the drop and backspins"),
                       params: .init(len32: -1, len16: -0.5, switchBias: 1.8, echoBias: 0.4, spinBias: 0.6))]
    }

    /// Plans every pattern from the current (aligned, tempo-harmonised) state, keeps them, and leaves the first in place.
    private func planPatterns(from start: Int) {
        let base = snapshot(), baseStructures = structures
        let savedTuning = MixTuning.current
        var made: [MixPattern] = []
        for r in patternRecipes {
            restoreQuietly(base, baseStructures)
            var t = savedTuning
            var star = t.params["*"] ?? MixTuning.Params()
            func add(_ x: inout Double?, _ y: Double?) { if let y { x = (x ?? 0) + y } }
            add(&star.len32, r.params.len32); add(&star.len16, r.params.len16); add(&star.len8, r.params.len8); add(&star.len4, r.params.len4)
            add(&star.switchBias, r.params.switchBias); add(&star.echoBias, r.params.echoBias); add(&star.spinBias, r.params.spinBias)
            if let mb = r.params.maxBars { star.maxBars = mb }
            t.params["*"] = star
            MixTuning.current = t
            planOnly(from: start)
            MixTuning.current = savedTuning
            let tr = clips.dropFirst()
            let blends = tr.filter { !$0.transition.isCutLike && $0.transitionBars >= 1 }
            let pattern = MixPattern(title: r.title, detail: r.detail, state: snapshot(), structures: structures,
                                     blends: blends.count, cuts: tr.count - blends.count,
                                     averageBars: blends.isEmpty ? 0 : blends.map(\.transitionBars).reduce(0, +) / Double(blends.count),
                                     duration: realMixDuration)
            // Skip patterns that came out the same as an earlier one.
            if !made.contains(where: { $0.state.clips.map(\.mixInBar) == pattern.state.clips.map(\.mixInBar)
                                     && $0.state.clips.map(\.transition) == pattern.state.clips.map(\.transition) }) {
                made.append(pattern)
            }
        }
        mixPatterns = made
        if let first = made.first {
            restoreQuietly(first.state, first.structures)
            currentPatternID = first.id
        }
    }

    /// Blends between two ordinarily-mixed tracks may be re-planned by the checker (cut-in material keeps its cuts).
    private func computeReplannable() {
        replannable.removeAll()
        guard resolvedStyle(clips.indices) != .quick else { return }
        for i in clips.indices.dropFirst() where !clips[i].transition.isCutLike && clips[i].transition != .echoOut
            && !isQuickTrack(clips[i]) && !isQuickTrack(clips[i - 1]) && !isLocked(i) {
            replannable.insert(clips[i].id)
        }
    }

    private func restoreQuietly(_ s: Snapshot, _ st: [URL: TrackStructure]) {
        clips = s.clips
        library = s.library
        masterBPM = s.masterBPM
        gridOffset = s.gridOffset
        structures = st
        layout()
    }

    /// Switches the mix to another pattern (undoable) and checks its transitions.
    func usePattern(_ id: UUID) {
        guard let p = mixPatterns.first(where: { $0.id == id }), id != currentPatternID else { return }
        pushUndo()
        restoreQuietly(p.state, p.structures)
        currentPatternID = id
        computeReplannable()
        finishTimingEdit()
        startVerification(from: 0)
    }

    // MARK: Render check (verify, fall back to the next plan)

    /// Transitions (by incoming clip id) planned as blends that may be re-planned with another option.
    @ObservationIgnored private var replannable = Set<UUID>()
    @ObservationIgnored private var verifyTask: Task<Void, Never>?
    /// "i / n" while the planned transitions are being rendered and checked.
    var verifyProgress: (done: Int, total: Int)?

    private func startVerification(from start: Int) {
        verifyTask?.cancel()
        guard verifyTransitions, clips.count > 1 else { verifyProgress = nil; return }
        verifyTask = Task { [weak self] in await self?.verifyAndRepair(from: start) }
    }

    /// Renders each planned transition and checks it; a failing blend is re-planned with the next-best option
    /// (up to 3 more). Stops as soon as the user edits the mix.
    func verifyAndRepair(from start: Int) async {
        let serial = undoSerial
        let first = max(1, start + 1)
        guard first < clips.count else { return }
        verifyProgress = (0, clips.count - first)
        defer { verifyProgress = nil }
        var i = first
        while i < clips.count {
            if Task.isCancelled || undoSerial != serial { return }
            if isLocked(i) {
                verifyProgress = (i - first + 1, clips.count - first)
                i += 1
                continue
            }
            let id = clips[i].id
            var tried: [(option: Int, problems: [String])] = []
            for option in 0..<4 {
                if option > 0 {
                    guard replannable.contains(id), applyAutoTransition(into: i, earliestOut: nil, option: option) != nil else { break }
                    refitFollowing(after: i)
                    planTempos(from: i - 1, through: min(clips.count - 1, i + 1))
                    finishTimingEdit()
                }
                let snap = clips, m = masterBPM, tm = tempoMap, g = gridOffset, k = i
                let r = await Task.detached(priority: .utility) {
                    TransitionCheck.check(clips: snap, index: k, master: m, tempo: tm, gridOffset: g)
                }.value
                if Task.isCancelled || undoSerial != serial { return }
                guard let r else { break }
                tried.append((option, r.problems))
                if r.ok || !replannable.contains(id) { break }
            }
            noteCheck(i, tried)
            verifyProgress = (i - first + 1, clips.count - first)
            i += 1
        }
        // Keep the checked / repaired version when switching patterns back and forth.
        if let k = mixPatterns.firstIndex(where: { $0.id == currentPatternID }) {
            mixPatterns[k].state = snapshot()
            mixPatterns[k].structures = structures
        }
    }

    /// After re-planning transition i, the next exit must still come after this track has landed.
    func refitFollowing(after i: Int) {
        var j = i + 1
        while j < clips.count, let s = structures[clips[j - 1].url], replannable.contains(clips[j].id) {
            let land = structureBar(clips[j - 1], s, clips[j - 1].landingBar)
            guard structureBar(clips[j - 1], s, clips[j - 1].mixOutBar) < land + 8 else { break }
            _ = applyAutoTransition(into: j, earliestOut: land + 8)
            j += 1
        }
        fixLockedEntries()
    }

    private func noteCheck(_ i: Int, _ tried: [(option: Int, problems: [String])]) {
        guard let last = tried.last, var note = clips[i].autoNote else { return }
        var lines: [String] = []
        if tried.count == 1 && last.problems.isEmpty {
            lines.append(L("書き出して確認：問題なし", "Rendered and checked: no problems"))
        } else if last.problems.isEmpty {
            let first = tried[0].problems.joined(separator: "、")
            lines.append(L("書き出して確認：最初の案は「\(first)」ため、\(last.option + 1)番目の案に変更", "Rendered and checked: the first plan had problems (\(first)), so option \(last.option + 1) is used"))
        } else if tried.count > 1, let best = tried.min(by: { $0.problems.count < $1.problems.count }) {
            if best.option != last.option, replannable.contains(clips[i].id) {
                _ = applyAutoTransition(into: i, earliestOut: nil, option: best.option)
                refitFollowing(after: i)
                finishTimingEdit()
                note = clips[i].autoNote ?? note
            }
            lines.append(L("書き出して確認：どの案にも気になる点あり（\(best.problems.joined(separator: "、"))）。手で調整すると良くなるかもしれません",
                           "Rendered and checked: every option has an issue (\(best.problems.joined(separator: ", "))); a manual touch-up may help"))
        } else {
            lines.append(L("書き出して確認：\(last.problems.joined(separator: "、"))", "Rendered and checked: \(last.problems.joined(separator: ", "))"))
        }
        note.text += "\n" + lines.joined(separator: "\n")
        clips[i].autoNote = note
    }

    /// Mixed sets: highlights + cut-ins around quick-cut tracks, genre-style blends between the other tracks.
    private func planTransitionsMixed(from start: Int) {
        guard !clips.isEmpty else { return }
        var windows: [Int: AutoMixer.Highlight] = [:]
        for i in clips.indices where i >= start && isQuickTrack(clips[i]) {
            if isLockMember(i) {
                // Keep the grid of tracks with a locked transition (their mix points are in it).
                if let s = structures[clips[i].url], let h = AutoMixer.highlight(s, lengths: AutoMixer.quickWindowBars(s)) { windows[i] = h }
                continue
            }
            guard let pick = quickHighlight(for: clips[i]) else { continue }
            if abs(pick.bpm - clips[i].bpm) > 0.005 || abs(pick.firstBeat - clips[i].firstBeat) > 0.001 {
                clips[i].bpm = pick.bpm
                clips[i].firstBeat = pick.firstBeat
                structures[clips[i].url] = pick.structure
            }
            windows[i] = pick.highlight
        }
        if start == 0, let s = structures[clips[0].url] {
            clips[0].mixInBar = clipBar(clips[0], s, windows[0]?.start ?? s.musicStart)
        }
        var earliest: Int? = start == 0 ? structures[clips[0].url].map { windows[0]?.end ?? ($0.musicStart + 8) } : nil
        if clips.count > start + 1 {
            for i in (start + 1)..<clips.count {
                if isLocked(i) {
                    earliest = lockedLanding(i).map { $0 + 8 }
                    continue
                }
                let a = clips[i - 1], b = clips[i]
                clips[i - 1].fx?.removeAll { $0.auto == true }
                if windows[i - 1] == nil && windows[i] == nil {
                    earliest = applyAutoTransition(into: i, earliestOut: earliest).map { $0 + 8 }
                    continue
                }
                guard let sa = structures[a.url], let sb = structures[b.url] else { earliest = nil; continue }
                // Outgoing: end of its highlight, or a phrase exit after it has played a while.
                let out: Int
                if let h = windows[i - 1] {
                    out = h.end
                } else {
                    let floor = earliest ?? (structureBar(a, sa, a.landingBar) + 16)
                    let exits = [sa.lastDropEnd, sa.musicEnd] + sa.gridBars(from: floor, to: sa.musicEnd, step: 8)
                    out = exits.filter { $0 >= floor }.min() ?? sa.musicEnd
                }
                // Incoming: its highlight, or straight into its first drop.
                let inBar = windows[i]?.start ?? sb.firstDrop
                clips[i - 1].mixOutBar = clipBar(a, sa, out)
                clips[i - 1].endBar = nil
                clips[i].mixInBar = clipBar(b, sb, inBar)
                let t = AutoMixer.quickTransition(from: sa, out: out, to: sb, index: i)
                clips[i].transition = t.style
                clips[i].transitionBars = t.bars
                clips[i].shape = nil
                clips[i].lanes = nil
                clips[i].landingLock = nil
                clips[i].spinBeats = nil
                if t.roll {
                    var roll = ClipFX(kind: .roll, bar: clips[i - 1].mixOutBar - 0.5, bars: 0.5, auto: true)
                    roll.division = 0.25
                    clips[i - 1].fx = (clips[i - 1].fx ?? []) + [roll]
                }
                if clips[i - 1].fx?.isEmpty == true { clips[i - 1].fx = nil }
                var lines: [String] = []
                if let g = genreLine(genre(for: a), genre(for: b)) { lines.append(g) }
                if let h = windows[i] {
                    lines.append(L("展開の速い曲なので \(h.end - h.start) 小節だけ使う", "A fast-changing track: \(h.end - h.start) bars of it are used"))
                    lines += h.reasons
                } else {
                    lines.append(L("カットイン向きの曲の後なので、次の曲はドロップ頭（\(inBar + 1)小節目）から入る", "After a quick-cut track, the next one comes in on its drop (bar \(inBar + 1))"))
                }
                lines += t.reasons
                clips[i].autoNote = AutoMixNote(text: lines.joined(separator: "\n"), style: t.style, bars: t.bars, inBar: clips[i].mixInBar)
                earliest = windows[i]?.end ?? (inBar + 16)
            }
        }
        let last = clips.count - 1
        if let s = structures[clips[last].url] {
            if let h = windows[last] {
                clips[last].endBar = clipBar(clips[last], s, min(s.musicEnd, h.end + 8))
                clips[last].fadeOutBeats = 16
            } else {
                clips[last].endBar = clipBar(clips[last], s, s.musicEnd)
            }
        }
        planTempos(from: start)
        finishTimingEdit()
    }

    /// The best highlight over the whole-track grid and every steady-tempo stretch the neural tracker found.
    private func quickHighlight(for c: Clip) -> (highlight: AutoMixer.Highlight, bpm: Double, firstBeat: Double, structure: TrackStructure)? {
        guard let base = structures[c.url] else { return nil }
        var best: (highlight: AutoMixer.Highlight, bpm: Double, firstBeat: Double, structure: TrackStructure)?
        if let h = AutoMixer.highlight(base, lengths: AutoMixer.quickWindowBars(base)) {
            best = (h, c.bpm, c.firstBeat, base)
        }
        guard let n = neuralResults[c.url], let energies = bandEnergies[c.url] else { return best }
        for r in NeuralAnalyzer.tempoRegions(beats: n.beats, downbeats: n.downbeats) {
            // Same octave as the track's current reading where possible.
            var bpm = r.grid.bpm
            for f in [2.0, 0.5] where abs(c.bpm / (r.grid.bpm * f) - 1) < 0.06 { bpm = r.grid.bpm * f }
            // Local grid on the attacks of this stretch (cuts land on the kick, not 20–40 ms off it).
            let fb = Mathx.posMod(attackAligned(c.url, bpm: bpm, firstBeat: r.grid.firstBeat, from: r.start, to: r.end), 240 / bpm)
            guard let st = energies.structure(trustedBPM: bpm, firstBeat: fb) else { continue }
            let a = Int(ceil(st.bar(atTime: r.start) - 0.05)), b = Int(floor(st.bar(atTime: r.end) + 0.05))
            guard b - a >= 8, let h = AutoMixer.highlight(st, lengths: AutoMixer.quickWindowBars(st), within: a...b) else { continue }
            if best == nil || h.score > best!.highlight.score + 0.2 { best = (h, bpm, fb, st) }
        }
        return best
    }

    /// Plays only each track's best stretch and switches on the downbeat (cut / backspin / brake / echo),
    /// changing the mix tempo with every cut instead of stretching tracks.
    private func planTransitionsQuick(from start: Int) {
        guard !clips.isEmpty else { return }
        var windows: [Int: AutoMixer.Highlight] = [:]
        for i in clips.indices where i >= start {
            if isLockMember(i) {
                if let s = structures[clips[i].url], let h = AutoMixer.highlight(s, lengths: AutoMixer.quickWindowBars(s)) { windows[i] = h }
                continue
            }
            guard let pick = quickHighlight(for: clips[i]) else { continue }
            // Play the stretch on its own steady grid (tempo-switching tracks get the local tempo there).
            if abs(pick.bpm - clips[i].bpm) > 0.005 || abs(pick.firstBeat - clips[i].firstBeat) > 0.001 {
                clips[i].bpm = pick.bpm
                clips[i].firstBeat = pick.firstBeat
                structures[clips[i].url] = pick.structure
            }
            windows[i] = pick.highlight
        }
        for i in clips.indices where i >= start {
            let c = clips[i]
            guard let st = structures[c.url], let h = windows[i] else { continue }
            let outLocked = isLocked(i + 1)
            if !outLocked { clips[i].fx?.removeAll { $0.auto == true } }
            if (i > start || start == 0) && !isLocked(i) { clips[i].mixInBar = clipBar(c, st, h.start) }
            if i + 1 < clips.count {
                if !outLocked {
                    clips[i].mixOutBar = clipBar(c, st, h.end)
                    clips[i].endBar = nil
                }
            } else {
                // The last track keeps playing a little past its highlight and fades out.
                clips[i].endBar = clipBar(c, st, min(st.musicEnd, h.end + 8))
                clips[i].fadeOutBeats = 16
            }
            guard i > 0, !isLocked(i), let pst = structures[clips[i - 1].url], let ph = windows[i - 1] ?? (i - 1 < start ? AutoMixer.Highlight(start: 0, end: structureBar(clips[i - 1], pst, clips[i - 1].mixOutBar), score: 0, reasons: []) : nil) else { continue }
            let t = AutoMixer.quickTransition(from: pst, out: ph.end, to: st, index: i)
            clips[i].transition = t.style
            clips[i].transitionBars = t.bars
            clips[i].shape = nil
            clips[i].lanes = nil
            clips[i].landingLock = nil
            clips[i].spinBeats = nil
            if t.roll {
                var roll = ClipFX(kind: .roll, bar: clips[i - 1].mixOutBar - 0.5, bars: 0.5, auto: true)
                roll.division = 0.25
                clips[i - 1].fx = (clips[i - 1].fx ?? []) + [roll]
            }
            if clips[i - 1].fx?.isEmpty == true { clips[i - 1].fx = nil }
            let lead = L("カットイン主体のミックス（Dariacore・マッシュアップ向け）：この曲は \(h.end - h.start) 小節だけ使う",
                         "Quick-cut mix (Dariacore / mashups): \(h.end - h.start) bars of this track")
            clips[i].autoNote = AutoMixNote(text: ([lead] + h.reasons + t.reasons).joined(separator: "\n"), style: t.style,
                                            bars: t.bars, inBar: clips[i].mixInBar)
        }
        planTempos(from: start, instant: true)
        finishTimingEdit()
    }

    // MARK: DJ operations (loops, beat jumps, key)

    /// This track's bar under timeline time t (nil if t is outside the track).
    func sourceBar(_ id: UUID, atTimeline t: Double) -> Double? {
        guard let c = clip(id), index(of: id) != nil, t >= c.start, t < c.end(master: masterBPM) else { return nil }
        return c.bar(atSource: c.sourceTime(timeline: t, master: masterBPM))
    }

    /// Loop `bars` bars starting at `bar` (snapped like a controller's quantize), playing it `repeats` extra times.
    /// Overlapping loops / jumps are replaced.
    func addLoop(_ id: UUID, atBar bar: Double, bars: Double, repeats: Int) {
        let unit = min(bars, 1)
        let start = (bar / unit).rounded(.down) * unit
        addEdit(id, ClipEdit(kind: .loop, bar: start, bars: bars, repeats: max(1, repeats)))
    }

    /// Skip `bars` bars at `bar` (beat jump), snapped to the beat.
    func addJump(_ id: UUID, atBar bar: Double, bars: Double) {
        addEdit(id, ClipEdit(kind: .jump, bar: (bar * 4).rounded() / 4, bars: bars))
    }

    private func addEdit(_ id: UUID, _ edit: ClipEdit) {
        guard let c = clip(id), edit.bar >= c.bar(atSource: 0) - 0.01, edit.end <= c.lastBar + 0.01 else {
            alertMessage = L("曲の範囲外にはループ／ジャンプを置けません。", "Loops and jumps must be inside the track.")
            return
        }
        updateClip(id) { c in
            var list = (c.edits ?? []).filter { $0.end <= edit.bar + 0.001 || $0.bar >= edit.end - 0.001 }
            list.append(edit)
            list.sort { $0.bar < $1.bar }
            c.edits = list
        }
        finishTimingEdit()
    }

    func removeEdit(_ id: UUID, _ editID: UUID) {
        updateClip(id) { c in
            c.edits = (c.edits ?? []).filter { $0.id != editID }
            if c.edits?.isEmpty == true { c.edits = nil; c.playLength = nil }
        }
        finishTimingEdit()
    }

    func removeAllEdits(_ id: UUID) {
        updateClip(id) { $0.edits = nil; $0.playLength = nil }
        finishTimingEdit()
    }

    func setEditRepeats(_ id: UUID, _ editID: UUID, _ repeats: Int) {
        updateClip(id) { c in
            guard var list = c.edits, let k = list.firstIndex(where: { $0.id == editID }) else { return }
            list[k].repeats = min(32, max(1, repeats))
            c.edits = list
        }
        finishTimingEdit()
    }

    func setKeyLock(_ id: UUID, _ on: Bool) {
        updateClip(id) { $0.keyLock = on ? nil : false }
        timingChanged()
    }

    func setKeyShift(_ id: UUID, _ semitones: Int) {
        let v = min(6, max(-6, semitones))
        updateClip(id) { $0.keyShift = v == 0 ? nil : v }
        timingChanged()
    }

    /// The key a track is heard in (detected key + key shift; vinyl tempo changes ignored).
    func playedKey(_ c: Clip) -> MusicalKey? {
        structures[c.url]?.key.map { $0.shifted(by: c.semitoneShift) }
    }

    /// Smallest key shift that makes this track harmonically compatible with the previous one.
    func suggestedKeyShift(for id: UUID) -> Int? {
        guard let i = index(of: id), i > 0, let mine = structures[clips[i].url]?.key,
              let theirs = playedKey(clips[i - 1]) else { return nil }
        for d in [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6] where mine.shifted(by: d).isCompatible(with: theirs) {
            return d
        }
        return nil
    }

    func matchKeyToPrevious(_ id: UUID) {
        guard let d = suggestedKeyShift(for: id) else { return }
        setKeyShift(id, d)
    }

    // MARK: Tempo readings

    func rememberReadings(_ url: URL, _ a: TrackAnalysis) {
        tempoReadings[url] = [TempoOption(bpm: a.bpm, firstBeat: a.firstBeat, fit: 1)] + a.tempoOptions
        bandEnergies[url] = a.energies
        if let n = a.neural { neuralResults[url] = n }
        if let g = a.genre { genreResults[url] = g }
    }

    /// All tempo readings that are worth considering for a clip, with a small cost for
    /// moving away from the one it currently uses.
    private func readings(for c: Clip) -> [(bpm: Double, firstBeat: Double, penalty: Double)] {
        var out: [(bpm: Double, firstBeat: Double, penalty: Double)] = [(c.bpm, c.firstBeat, 0)]
        for t in tempoReadings[c.url] ?? [] where abs(t.bpm - c.bpm) > 0.5 {
            out.append((t.bpm, t.firstBeat, 0.03 + 0.1 * max(0, 1 - t.fit)))
        }
        // A reading outside the genre's usual tempo (e.g. UKG read as 92 instead of 138) is unlikely to be right.
        if let range = genre(for: c)?.tempoRange, out.contains(where: { range.contains($0.bpm) }) {
            for k in out.indices where !range.contains(out[k].bpm) { out[k].penalty += 0.5 }
        }
        return out
    }

    /// Chooses each track's tempo reading (e.g. 122 ↔ 91.5 for a 3:4 groove) and the master
    /// tempo so that no track has to be stretched far from its natural speed.
    private func harmonizeTempos() {
        guard !clips.isEmpty else { return }
        let opts = clips.indices.map { i -> [(bpm: Double, firstBeat: Double, penalty: Double)] in
            let r = readings(for: clips[i])
            // Tracks with a locked transition keep their grid (the locked mix points are in it).
            return isLockMember(i) ? Array(r.prefix(1)) : r
        }
        var masters = Set(opts.flatMap { $0.map(\.bpm) })
        masters.insert(masterBPM)
        func cost(_ o: (bpm: Double, firstBeat: Double, penalty: Double), _ m: Double) -> Double {
            abs(log(o.bpm / m)) + o.penalty
        }
        var best: (m: Double, cost: Double, pick: [Int])?
        for m in [masterBPM] + masters.sorted() where m > 1 {
            var total = 0.0
            var pick: [Int] = []
            for o in opts {
                let k = o.indices.min { cost(o[$0], m) < cost(o[$1], m) } ?? 0
                total += cost(o[k], m)
                pick.append(k)
            }
            if best == nil || total < best!.cost - 1e-6 { best = (m, total, pick) }
        }
        guard let b = best else { return }
        for (i, k) in b.pick.enumerated() where k > 0 {
            let o = opts[i][k]
            let url = clips[i].url
            clips[i].bpm = o.bpm
            let fbA = attackAligned(url, bpm: o.bpm, firstBeat: o.firstBeat)
            if let st = bandEnergies[url]?.structure(bpm: o.bpm, firstBeat: fbA) {
                structures[url] = st
                clips[i].firstBeat = st.firstBeat
            } else {
                clips[i].firstBeat = fbA
            }
            clips[i].resetToWholeTrack()
        }
        masterBPM = (b.m * 100).rounded() / 100
    }

    // MARK: Auto-arrange (order + mix a selection)

    func orderItem(for c: Clip) -> AutoMixer.OrderItem {
        let s = structures[c.url]
        return AutoMixer.OrderItem(bpm: c.bpm, bpmOptions: readings(for: c).map(\.bpm), key: s?.key,
                                   introBars: s.map { max(0, $0.firstDrop - $0.musicStart) } ?? 0,
                                   outroBars: s.map { max(0, $0.musicEnd - $0.lastDropEnd) } ?? 0,
                                   genre: genre(for: c), energy: energyLevel(c))
    }

    /// Suggested running order for the given tracks (ids from the mix or the library).
    func suggestedOrder(_ ids: [UUID]) -> [UUID] {
        // Tracks with locked transitions stay together: each run is ordered as one unit
        // (coming in like its first track, going out like its last).
        let units = lockUnits(ids.filter { clip($0) != nil })
        let items = units.map { u -> AutoMixer.OrderItem in
            var item = orderItem(for: clip(u[0])!)
            if u.count > 1, let last = clip(u[u.count - 1]) {
                let tail = orderItem(for: last)
                item.outroBars = tail.outroBars
                let es = u.compactMap { clip($0).flatMap(energyLevel) }
                if !es.isEmpty { item.energy = es.reduce(0, +) / Double(es.count) }
            }
            return item
        }
        let order = AutoMixer.bestOrder(items, arc: setArc)
        return order.flatMap { units[$0] }
    }

    /// Builds a mix from the chosen tracks: optionally finds the order, then plans every transition.
    /// - Parameter replace: true = the chosen tracks become the mix (other mix tracks go to the library);
    ///   false = they are appended after the current mix.
    func autoArrange(_ ids: [UUID], reorder: Bool, replace: Bool) {
        guard !ids.isEmpty else { return }
        pushUndo()
        let members = Set(clips.indices.filter { isLockMember($0) }.map { clips[$0].id })
        alignGridsToAI(ids.filter { !members.contains($0) }, undoable: false)
        let chosen = reorder ? suggestedOrder(ids) : ids
        var picked: [Clip] = []
        for id in chosen {
            if let i = index(of: id) { picked.append(clips[i]) }
            else if let i = libraryIndex(of: id) { picked.append(library[i]) }
        }
        let chosenSet = Set(chosen)
        let keptInMix = clips.filter { !chosenSet.contains($0.id) }
        library.removeAll { chosenSet.contains($0.id) }
        for i in picked.indices where !members.contains(picked[i].id) {
            picked[i].resetToWholeTrack()
            picked[i].autoNote = nil
        }
        let startIndex: Int
        if replace {
            library.insert(contentsOf: keptInMix, at: 0)
            clips = picked
            startIndex = 0
        } else {
            clips = keptInMix + picked
            startIndex = max(0, keptInMix.count - 1)
        }
        harmonizeTempos()
        plan(from: startIndex)
        selectedClipID = nil
        fitRequest += 1
    }

    /// Plans every transition from clip `start` on (used by auto-mix and auto-arrange).
    private func planTransitions(from start: Int) {
        guard !clips.isEmpty else { return }
        if start == 0, let s = structures[clips[0].url] {
            clips[0].mixInBar = clipBar(clips[0], s, s.musicStart)
        }
        var earliest: Int? = start == 0 ? structures[clips[0].url].map { $0.musicStart + 8 } : nil
        if clips.count > start + 1 {
            for i in (start + 1)..<clips.count {
                if let landing = applyAutoTransition(into: i, earliestOut: earliest) {
                    earliest = landing + 8
                } else {
                    earliest = nil
                }
            }
        }
        let last = clips.count - 1
        if let s = structures[clips[last].url] {
            clips[last].endBar = clipBar(clips[last], s, s.musicEnd)
        }
        planTempos(from: start)
        finishTimingEdit()
    }

    /// Re-plans only the transition into `id` (and the following ones if they no longer fit).
    func autoMixTransition(into id: UUID) {
        guard let i = index(of: id), i > 0 else { return }
        pushUndo()
        preserveTransitionBeforeReplacing(into: i)
        var landing = applyAutoTransition(into: i, earliestOut: nil, force: true)
        var j = i + 1
        // The next exit must come after this track has landed.
        while j < clips.count, let land = landing, let s = structures[clips[j - 1].url],
              structureBar(clips[j - 1], s, clips[j - 1].mixOutBar) < land + 8 {
            landing = applyAutoTransition(into: j, earliestOut: land + 8)
            j += 1
        }
        fixLockedEntries()
        planTempos(from: i - 1, through: j - 1)
        finishTimingEdit()
    }

    /// Whether the auto-mix explanation still describes the clip's current transition.
    func autoNote(for c: Clip) -> String? {
        guard let n = c.autoNote, n.style == c.transition, abs(n.bars - c.transitionBars) < 0.01,
              abs(n.inBar - c.mixInBar) < 0.01 else { return nil }
        return n.text
    }

    func moveClips(from source: IndexSet, to destination: Int) {
        // Tracks with a locked transition move together, and nothing is dropped between them.
        let groups = lockRanges(clips)
        let moving = IndexSet(source.compactMap { k in groups.firstIndex { $0.contains(k) } })
        let to = groups.filter { $0.lowerBound < destination }.count
        var g = groups
        g.move(fromOffsets: moving, toOffset: to)
        let order = g.flatMap { clips[$0] }
        guard order.map(\.id) != clips.map(\.id) else { return }
        pushUndo()
        clips = order
        finishTimingEdit()
    }

    /// Plain-language description of the transition into clip `i`.
    func transitionSentence(at i: Int) -> String? {
        guard i > 0, i < clips.count else { return nil }
        let prev = clips[i - 1]
        let cur = clips[i]
        let out = L("「\(prev.title)」の \(Clip.barLabel(prev.mixOutBar))小節目", "bar \(Clip.barLabel(prev.mixOutBar)) of “\(prev.title)”")
        let inn = L("「\(cur.title)」の \(Clip.barLabel(cur.mixInBar))小節目", "bar \(Clip.barLabel(cur.mixInBar)) of “\(cur.title)”")
        switch cur.transition {
        case .cut:
            return L("\(out)で、\(inn)にカットインします。", "At \(out), cut in to \(inn).")
        case .brake, .backspin:
            let beats = Int(cur.spinBeats ?? cur.transition.defaultSpinBeats)
            let what = cur.transition == .brake ? L("ブレーキで止め", "brake to a stop") : L("バックスピンさせ", "spin back")
            return L("\(out)の手前 \(beats) 拍で前の曲を\(what)、\(inn)を落とします。", "Over the \(beats) beats before \(out), \(what) the previous track, then drop \(inn).")
        case .echoOut:
            return L("\(out)で前の曲をエコーアウトし、同時に\(inn)からカットインします（残響 \(Fmt.bars(cur.transitionBars))）。", "At \(out), echo the previous track out and cut in from \(inn) (echo tail: \(Fmt.bars(cur.transitionBars))).")
        default:
            if cur.transitionBars < 0.01 {
                return L("\(out)で、\(inn)に直接つなぎます。", "At \(out), go straight into \(inn).")
            }
            return L("\(out)から\(inn)を重ね、\(Fmt.bars(cur.transitionBars))かけて\(cur.transition.title)で切り替えます。", "From \(out), bring in \(inn) and \(cur.transition.title.lowercased()) over \(Fmt.bars(cur.transitionBars)).")
        }
    }

    func reanalyze(_ id: UUID) {
        guard let c = clip(id) else { return }
        let url = c.url
        pending.append(PendingTrack(url: url))
        pollAnalysisProgress()
        let marker = pending.last?.id
        Task {
            defer { pending.removeAll { $0.id == marker } }
            do {
                let a = try await Task.detached(priority: .userInitiated) {
                    try await AudioAnalyzer.analyze(url: url, fresh: true)
                }.value
                guard clip(id) != nil else { return }
                updateClip(id) {
                    $0.bpm = a.bpm
                    $0.firstBeat = a.firstBeat
                }
                waveforms[url] = a.waveform
                structures[url] = a.structure
                rememberReadings(url, a)
                finishTimingEdit()
            } catch {
                alertMessage = error.localizedDescription
            }
        }
    }

    /// Plays from 4 bars before the transition into `id`.
    func previewTransition(_ id: UUID) {
        guard let c = clip(id) else { return }
        seek(max(0, c.start - 4 * barLength))
        requestScroll(to: c.start)
        if !isPlaying { play() }
    }

    func revealInFinder(_ id: UUID) {
        guard let c = clip(id) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([c.url])
    }

    // MARK: - Playback

    func togglePlay() {
        isPlaying ? pause() : play()
    }

    func play() {
        guard !clips.isEmpty else { return }
        if playhead >= mixDuration - 0.05 { playhead = 0 }
        do {
            try engine.start(clips: playableClips, master: masterBPM, tempo: tempoMap, gridOffset: gridOffset, from: playhead, sampleRate: exportSampleRate)
            engine.applyAutomation(clips: playableClips, master: masterBPM, gridOffset: gridOffset, time: playhead)
            isPlaying = true
            startTimer()
        } catch {
            alertMessage = L("再生を開始できませんでした: \(error.localizedDescription)", "Could not start playback: \(error.localizedDescription)")
        }
    }

    func pause() {
        guard isPlaying else { return }
        let t = engine.currentTime
        engine.stop()
        isPlaying = false
        stopTimer()
        playClock = nil
        playhead = min(max(0, t), max(mixDuration, 0))
    }

    func seek(_ t: Double) {
        let v = max(0, t)
        playhead = v
        if isPlaying { restartPlayback(at: v) }
    }

    func beginScrub() {
        wasPlayingBeforeScrub = isPlaying
        if isPlaying { pause() }
    }

    func scrub(to t: Double) {
        playhead = max(0, t)
    }

    func endScrub(at t: Double) {
        playhead = max(0, t)
        if wasPlayingBeforeScrub { play() }
        wasPlayingBeforeScrub = false
    }

    private var playableClips: [Clip] {
        clips.filter { !missingFiles.contains($0.url) }
    }

    func restartPlayback(at t: Double?) {
        guard isPlaying else { return }
        let time = t ?? engine.currentTime
        if let c = playClock, abs(c.t - time) > 0.05 { playClock = nil }   // a jump: don't glide from the old place
        do {
            try engine.start(clips: playableClips, master: masterBPM, tempo: tempoMap, gridOffset: gridOffset, from: time, sampleRate: exportSampleRate)
            playhead = time
            engine.applyAutomation(clips: playableClips, master: masterBPM, gridOffset: gridOffset, time: time)
        } catch {
            pause()
            alertMessage = error.localizedDescription
        }
    }

    /// The playhead for a display frame: extrapolated from the smoothed clock between timer ticks.
    func smoothPlayhead(at now: CFTimeInterval = CACurrentMediaTime()) -> Double {
        guard isPlaying, let c = playClock, now >= c.at, now - c.at < 0.25 else { return playhead }
        return c.t + (now - c.at) * tempoMap.bpm(at: c.t) / max(1, masterBPM)
    }

    private func startTimer() {
        stopTimer()
        playClock = nil
        let t = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            MainActor.assumeIsolated { self.tick() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    private func tick() {
        guard isPlaying else { return }
        // The audio clock moves in steps (one per audio buffer) and the timer fires a little unevenly: follow it
        // with a steadily running clock, corrected gently towards it, so everything that moves looks smooth.
        let measured = engine.currentTime
        let now = CACurrentMediaTime()
        var t = measured
        if let c = playClock, now - c.at < 0.5 {
            let predicted = c.t + (now - c.at) * tempoMap.bpm(at: c.t) / max(1, masterBPM)
            let err = measured - predicted
            t = abs(err) > 0.05 ? measured : predicted + err * 0.15
        }
        playClock = (t, now)
        playhead = t
        // Level / EQ / effect changes go straight into the running preview; a change in timing starts it again here.
        // (Only looked at when the mix changed — comparing every track 60 times a second added up in big mixes.)
        if revision != tickRevision {
            tickRevision = revision
            if engine.applyAutomation(clips: playableClips, master: masterBPM, gridOffset: gridOffset, time: t), !isInteracting {
                restartPlayback(at: t)
                return
            }
        }
        if t > mixDuration + 0.3 {
            pause()
            playhead = mixDuration
        }
    }

    // MARK: - View helpers

    func zoom(by factor: Double) {
        pixelsPerSecond = min(400, max(1, pixelsPerSecond * factor))
    }

    func zoomToFit() { fitRequest += 1 }

    func requestScroll(to t: Double) {
        scrollRequest = ScrollRequest(id: (scrollRequest?.id ?? 0) + 1, time: t)
    }

    // MARK: - Keyboard

    func installKeyMonitor() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            let handled = MainActor.assumeIsolated { self.handleKey(event) }
            return handled ? nil : event
        }
    }

    private func handleKey(_ event: NSEvent) -> Bool {
        guard let window = event.window, window.attachedSheet == nil, !showExport else { return false }
        if window.firstResponder is NSText { return false }
        let mods = event.modifierFlags.intersection([.command, .control, .option])
        guard mods.isEmpty else { return false }
        // Inside a sheet the keys belong to that sheet (the CUE editor has its own
        // preview player, Delete removes curve points, …). Only Space in the
        // transition editor is shared, because it previews on the main transport.
        if window.sheetParent != nil || cueEditorTarget != nil || transitionEditorTarget != nil || showShortcuts || showAutoArrange {
            guard event.keyCode == 49, cueEditorTarget == nil, let id = transitionEditorTarget?.id,
                  let c = clip(id) else { return false }
            if isPlaying {
                pause()
            } else if playhead >= c.start - 4 * barLength,
                      playhead < c.start + c.transitionBars * barLength + 2 * barLength {
                play()
            } else {
                previewTransition(id)
            }
            return true
        }
        switch event.keyCode {
        case 49: // space
            togglePlay()
            return true
        case 51, 117: // delete / forward delete
            guard selectedClipID != nil else { return false }
            deleteSelected()
            return true
        case 115: // home
            seek(0)
            requestScroll(to: 0)
            return true
        case 119: // end
            seek(mixDuration)
            requestScroll(to: mixDuration)
            return true
        case 18, 19, 20, 21, 23, 22: // number keys 1–6
            let map: [UInt16: Int] = [18: 1, 19: 2, 20: 3, 21: 4, 23: 5, 22: 6]
            guard let n = map[event.keyCode], let id = selectedClipID, (index(of: id) ?? 0) > 0 else { return false }
            applyPreset(number: n)
            return true
        default:
            return false
        }
    }

    // MARK: - Document

    func newProject() {
        guard confirmDiscard() else { return }
        pause()
        projectID = UUID().uuidString
        clips = []
        library = []
        notes = ""
        loudnessMode = .off
        removeAutosave()
        waveforms = [:]
        structures = [:]
        masterBPM = 124
        gridOffset = 0
        documentURL = nil
        undoStack = []
        redoStack = []
        selectedClipID = nil
        playhead = 0
        missingFiles = []
        colorCounter = 0
        isDirty = false
    }

    func openProject() {
        guard confirmDiscard() else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [Self.projectType, .json]
        panel.allowsMultipleSelection = false
        panel.message = L("DJAW ミックス（.djaw）を開く", "Open a DJAW mix (.djaw)")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        load(from: url)
    }

    /// Opens a file handed over by Finder (double-click / Open With / Dock).
    func openExternal(_ url: URL) {
        guard url.pathExtension.lowercased() == "djaw" else {
            addFiles([url], to: .library)
            return
        }
        guard confirmDiscard() else { return }
        load(from: url)
    }

    func openRecent(_ url: URL) {
        guard confirmDiscard() else { return }
        load(from: url)
    }

    func load(from url: URL, asRecovery: Bool = false) {
        do {
            let opened = try ProjectContainer.read(url)
            let file = opened.file
            if let format = file.format, format != ProjectFile.formatID {
                alertMessage = L("DJAW のミックスファイルではありません。", "This is not a DJAW mix file.")
                return
            }
            pause()
            masterBPM = file.masterBPM
            gridOffset = file.gridOffset
            snap = file.snap
            defaultTransitionBars = file.defaultTransitionBars
            defaultTransitionStyle = file.defaultTransitionStyle ?? .bassSwap
            let base = asRecovery ? file.originalPath.map { URL(fileURLWithPath: $0) } : url
            if let id = file.projectID { projectID = id } else if !asRecovery { projectID = UUID().uuidString }
            // Original files first; if they are gone, use the copy stored in the .djaw.
            let media = Dictionary((file.media ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            var unpackFailed = 0
            let pid = projectID
            let unpack: (Clip) -> Clip = { clip in
                var c = Self.relink(clip, projectURL: base)
                guard !FileManager.default.fileExists(atPath: c.url.path),
                      let blob = opened.blobStart, let id = c.mediaID, let m = media[id] else { return c }
                let dest = ProjectContainer.mediaFolder(projectID: pid).appendingPathComponent("\(id)-\(m.fileName)")
                do {
                    try ProjectContainer.extract(m, from: url, blobStart: blob, to: dest)
                    c.url = dest
                } catch {
                    unpackFailed += 1
                }
                return c
            }
            clips = file.clips.map(unpack)
            library = (file.library ?? []).map(unpack)
            if unpackFailed > 0 {
                alertMessage = L("\(unpackFailed)曲の音声をファイルから取り出せませんでした。", "Could not unpack the audio of \(unpackFailed) track(s).")
            }
            layout()
            notes = file.notes ?? ""
            loudnessMode = file.loudnessMode.flatMap(LoudnessMode.init(rawValue:)) ?? .off
            applyLoudness()
            // Bring in My Transitions that this mix uses but this Mac does not have yet.
            for preset in file.customTransitions ?? [] where !customTransitions.contains(where: { $0.id == preset.id }) {
                customTransitions.append(preset)
            }
            colorCounter = ((clips + library).map(\.colorIndex).max() ?? -1) + 1
            documentURL = asRecovery ? base : url
            undoStack = []
            redoStack = []
            missingFiles = Set((clips + library).map(\.url).filter { !FileManager.default.fileExists(atPath: $0.path) })
            // Analyses saved in the file: the tracks need not be analysed again.
            if let stored = file.analyses, !stored.isEmpty { AnalysisCache.importBlobs(stored) }
            if let stored = file.profiles, !stored.isEmpty { TrackProfiles.importBlobs(stored) }
            applySavedProfiles()
            prepareStemsIfNeeded()
            waveforms = [:]
        structures = [:]
            loadWaveforms()
            if let ui = file.ui {
                playhead = ui.playhead
                selectedClipID = ui.selectedClipID.flatMap { id in clip(id) != nil ? id : nil }
                showDecks = ui.showDecks
                if let mixer = ui.showMixer { showMixer = mixer }
                showInspector = ui.showInspector
                pixelsPerSecond = ui.pixelsPerSecond
                requestScroll(to: ui.scrollTime)
            } else {
                selectedClipID = nil
                playhead = 0
                fitRequest += 1
            }
            isDirty = asRecovery
            if !asRecovery {
                NSDocumentController.shared.noteNewRecentDocumentURL(url)
                recentDocuments = NSDocumentController.shared.recentDocumentURLs
            }
            if !missingFiles.isEmpty {
                alertMessage = L("\(missingFiles.count)個の音声ファイルが見つかりません。移動または削除された可能性があります。", "\(missingFiles.count) audio file(s) could not be found. They may have been moved or deleted.")
            }
        } catch {
            alertMessage = L("ミックスを開けませんでした: \(error.localizedDescription)", "Could not open the mix: \(error.localizedDescription)")
        }
    }

    /// If the audio file moved together with the project folder, find it again via the relative path.
    private static func relink(_ clip: Clip, projectURL: URL?) -> Clip {
        var c = clip
        guard !FileManager.default.fileExists(atPath: c.url.path),
              let rel = c.relativePath, let projectURL else { return c }
        let candidate = URL(fileURLWithPath: rel, relativeTo: projectURL.deletingLastPathComponent()).standardizedFileURL
        if FileManager.default.fileExists(atPath: candidate.path) { c.url = candidate }
        return c
    }

    /// Progress / remaining time of the background analysis (nil when idle).
    var analysisSummary: AnalysisProgress.Summary?
    /// Per-file analysis progress (for the rings next to each track).
    var analysisStatus: [URL: AnalysisProgress.FileStatus] = [:]
    @ObservationIgnored private var progressPoll: Task<Void, Never>?

    /// Refreshes `analysisSummary` a few times a second while tracks are being analysed.
    func pollAnalysisProgress() {
        guard progressPoll == nil else { return }
        progressPoll = Task { [weak self] in
            var idle = 0
            while !Task.isCancelled {
                let s = AnalysisProgress.shared.summary()
                let st = AnalysisProgress.shared.statuses()
                guard let self else { return }
                if self.analysisSummary != s { self.analysisSummary = s }
                if self.analysisStatus != st { self.analysisStatus = st }
                if s == nil && self.pending.isEmpty && self.analyzingCount == 0 {
                    idle += 1
                    if idle > 4 { break }
                } else {
                    idle = 0
                }
                try? await Task.sleep(nanoseconds: 400_000_000)
            }
            self?.analysisSummary = nil
            self?.analysisStatus = [:]
            self?.progressPoll = nil
        }
    }

    @ObservationIgnored private var analysesInFlight = 0 { didSet { analyzingCount = analysesInFlight } }
    /// Tracks being analysed in the background (shown in the inspector).
    var analyzingCount = 0
    @ObservationIgnored private var autoMixWhenReady = false

    private func loadWaveforms() {
        var seen = Set<URL>()
        let urls = (clips + library).map(\.url).filter { !missingFiles.contains($0) && waveforms[$0] == nil && seen.insert($0).inserted }
        AnalysisProgress.shared.expect(urls)
        for url in urls {
            analysesInFlight += 1
            pollAnalysisProgress()
            Task {
                defer {
                    analysesInFlight -= 1
                    if analysesInFlight == 0 && autoMixWhenReady {
                        autoMixWhenReady = false
                        autoMixAll()
                    }
                }
                let result = try? await Task.detached(priority: .utility) {
                    try await AudioAnalyzer.analyze(url: url)
                }.value
                if let result {
                    waveforms[url] = result.waveform
                    rememberReadings(url, result)
                    // The saved tempo / grid wins; rebuild the structure on that grid.
                    if let c = (clips + library).first(where: { $0.url == url }), abs(c.bpm - result.bpm) > 0.01,
                       let st = result.energies?.structure(bpm: c.bpm, firstBeat: c.firstBeat) {
                        structures[url] = st
                    } else {
                        structures[url] = result.structure
                    }
                }
            }
        }
    }

    /// Visible timeline position, reported by the timeline (for saving the work state).
    var currentScrollTime: Double { visibleRange.lowerBound }

    private func makeProjectFile(for url: URL?, originalPath: String? = nil) -> ProjectFile {
        let dir = url?.deletingLastPathComponent()
        func withRelative(_ c: Clip) -> Clip {
            var c = c
            if let dir { c.relativePath = Self.relativePath(from: dir, to: c.url) }
            return c
        }
        let usedPresets = customTransitions.filter { preset in clips.contains { $0.transition == .custom && $0.lanes == preset.lanes } }
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return ProjectFile(format: ProjectFile.formatID,
                           version: ProjectFile.currentVersion,
                           savedAt: Date(),
                           appVersion: version,
                           originalPath: originalPath,
                           notes: notes,
                           ui: ProjectUIState(playhead: playhead,
                                              pixelsPerSecond: pixelsPerSecond,
                                              scrollTime: currentScrollTime,
                                              selectedClipID: selectedClipID,
                                              showDecks: showDecks,
                                              showMixer: showMixer,
                                              showInspector: showInspector),
                           customTransitions: usedPresets,
                           masterBPM: masterBPM,
                           gridOffset: gridOffset,
                           defaultTransitionBars: defaultTransitionBars,
                           defaultTransitionStyle: defaultTransitionStyle,
                           library: library.map(withRelative),
                           snap: snap,
                           clips: clips.map(withRelative),
                           projectID: projectID,
                           loudnessMode: loudnessMode.rawValue)
    }

    /// The finished analyses of every track in the mix and library, for saving inside the .djaw.
    private func storedAnalyses() -> [String: Data]? {
        var out: [String: Data] = [:]
        for url in Set((clips + library).map(\.url)) {
            if let b = AnalysisCache.blob(for: url) { out[b.key] = b.data }
        }
        return out.isEmpty ? nil : out
    }

    private static func relativePath(from dir: URL, to file: URL) -> String {
        let base = dir.standardizedFileURL.pathComponents
        let target = file.standardizedFileURL.pathComponents
        var i = 0
        while i < min(base.count, target.count) && base[i] == target[i] { i += 1 }
        let ups = Array(repeating: "..", count: base.count - i)
        return (ups + target[i...]).joined(separator: "/")
    }

    @discardableResult
    func save(as saveAs: Bool = false) -> Bool {
        var target = documentURL
        if saveAs || target == nil {
            let panel = NSSavePanel()
            panel.allowedContentTypes = [Self.projectType]
            panel.nameFieldStringValue = (documentURL?.deletingPathExtension().lastPathComponent ?? "My Mix") + ".djaw"
            panel.canCreateDirectories = true
            panel.message = embedMedia
                ? L("ミックスを DJAW Mix 形式で保存（曲の音声も含むので、この1ファイルだけで開けます）", "Save as a DJAW Mix (includes the audio, so this one file is all you need)")
                : L("ミックスを DJAW Mix 形式で保存（音声は含みません。曲ファイルは元の場所から読み込みます）", "Save as a DJAW Mix (without audio; tracks are read from their original files)")
            guard panel.runModal() == .OK, let url = panel.url else { return false }
            target = url
        }
        guard let url = target else { return false }
        do {
            if embedMedia {
                // Give every audio file an id and store it inside the .djaw.
                var ids: [URL: String] = [:]
                for c in clips + library { if let id = c.mediaID { ids[c.url] = id } }
                for i in clips.indices where clips[i].mediaID == nil || ids[clips[i].url] != clips[i].mediaID {
                    clips[i].mediaID = ids[clips[i].url] ?? String(UUID().uuidString.prefix(8))
                    ids[clips[i].url] = clips[i].mediaID
                }
                for i in library.indices where library[i].mediaID == nil || ids[library[i].url] != library[i].mediaID {
                    library[i].mediaID = ids[library[i].url] ?? String(UUID().uuidString.prefix(8))
                    ids[library[i].url] = library[i].mediaID
                }
                let media = ids.filter { FileManager.default.fileExists(atPath: $0.key.path) }
                    .map { (id: $0.value, url: $0.key) }
                    .sorted { $0.id < $1.id }
                var project = makeProjectFile(for: url)
                project.analyses = storedAnalyses()
                project.profiles = TrackProfiles.blobs(for: (clips + library).map(\.url))
                try ProjectContainer.write(project, embedding: media, to: url)
            } else {
                var project = makeProjectFile(for: url)
                project.analyses = storedAnalyses()
                project.profiles = TrackProfiles.blobs(for: (clips + library).map(\.url))
                try JSONEncoder.djaw.encode(project).write(to: url, options: .atomic)
            }
            documentURL = url
            isDirty = false
            removeAutosave()
            NSDocumentController.shared.noteNewRecentDocumentURL(url)
            recentDocuments = NSDocumentController.shared.recentDocumentURLs
            return true
        } catch {
            alertMessage = L("保存できませんでした: \(error.localizedDescription)", "Could not save: \(error.localizedDescription)")
            return false
        }
    }

    // MARK: - Autosave / recovery

    static var autosaveURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DJAW", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("Autosave.djaw")
    }

    /// Writes a recovery copy a little while after the last change.
    private func scheduleAutosave() {
        autosaveWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            MainActor.assumeIsolated { self.writeAutosave() }
        }
        autosaveWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: work)
    }

    private func writeAutosave() {
        guard isDirty, !(clips.isEmpty && library.isEmpty) else { return }
        let file = makeProjectFile(for: documentURL, originalPath: documentURL?.path)
        do {
            try JSONEncoder.djaw.encode(file).write(to: Self.autosaveURL, options: .atomic)
        } catch {
            print("[DJAW] autosave failed: \(error)")
        }
    }

    func removeAutosave() {
        autosaveWork?.cancel()
        try? FileManager.default.removeItem(at: Self.autosaveURL)
    }

    /// Called once at launch: offers to restore unsaved work from a crash or forced quit.
    func offerRecoveryIfNeeded() {
        let url = Self.autosaveURL
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        let alert = NSAlert()
        alert.icon = NSApp.applicationIconImage
        alert.messageText = L("保存されていない作業が見つかりました", "Unsaved work was found")
        alert.informativeText = L("前回 DJAW が終了した時に保存されていなかったミックスがあります。復元しますか？", "A mix was not saved when DJAW last quit. Restore it?")
        alert.addButton(withTitle: L("復元", "Restore"))
        alert.addButton(withTitle: L("破棄", "Discard"))
        if alert.runModal() == .alertFirstButtonReturn {
            load(from: url, asRecovery: true)
        }
        // Keep a copy for a while (recovered work can still be lost by mistake right after restoring).
        let backups = url.deletingLastPathComponent().appendingPathComponent("Recovered", isDirectory: true)
        try? FileManager.default.createDirectory(at: backups, withIntermediateDirectories: true)
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        try? FileManager.default.copyItem(at: url, to: backups.appendingPathComponent("Recovered-\(stamp).djaw"))
        try? FileManager.default.removeItem(at: url)
    }

    /// For the app delegate: ask to save before quitting.
    func shouldTerminate() -> Bool {
        let ok = confirmDiscard()
        if ok { removeAutosave() }
        return ok
    }

    // MARK: - Progress

    var progressSummary: (cues: Int, cueTotal: Int, transitions: Int, transitionTotal: Int) {
        let all = clips + library
        let cues = all.filter { $0.cueDone == true }.count
        let transitions = clips.dropFirst().filter { $0.transitionDone == true }.count
        return (cues, all.count, transitions, max(0, clips.count - 1))
    }

    func setProgress(_ id: UUID, cue: Bool? = nil, transition: Bool? = nil) {
        updateClip(id, undoable: false) {
            if let cue { $0.cueDone = cue }
            if let transition { $0.transitionDone = transition }
        }
    }

    func confirmDiscard() -> Bool {
        guard isDirty, !(clips.isEmpty && library.isEmpty) else { return true }
        let alert = NSAlert()
        alert.icon = NSApp.applicationIconImage
        alert.messageText = L("現在のミックスへの変更を保存しますか？", "Save changes to the current mix?")
        alert.informativeText = L("保存しない場合、変更は失われます。", "Your changes will be lost if you don’t save them.")
        alert.addButton(withTitle: L("保存", "Save"))
        alert.addButton(withTitle: L("保存しない", "Don’t Save"))
        alert.addButton(withTitle: L("キャンセル", "Cancel"))
        switch alert.runModal() {
        case .alertFirstButtonReturn: return save()
        case .alertSecondButtonReturn: return true
        default: return false
        }
    }

    // MARK: - Export

    func startExport(format: ExportFormat, sampleRate: Double, normalize: Bool) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [format.contentType]
        panel.nameFieldStringValue = documentTitle + "." + format.fileExtension
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }

        pause()
        let flag = CancelFlag()
        exportCancel = flag
        exportPhase = .rendering(0)
        exportStartedAt = Date()
        exportSteadyMark = nil
        exportSteadyFrom = 0
        let clips = playableClips
        let master = masterBPM
        let tempo = tempoMap
        let offset = gridOffset
        let options = OfflineRenderer.Options(format: format, sampleRate: sampleRate, normalize: normalize)
        // The mix waveform rendered this very mix: reuse its peak, so the gain (and every sample) is the same.
        let knownPeak = mixPeaksSignature == mixSignature(sampleRate: sampleRate) ? mixPeaks?.peak : nil

        let needStems = StemSeparator.isAvailable ? tracksNeedingStems.filter { !missingFiles.contains($0) } : []
        Task.detached(priority: .userInitiated) { [self] in
            // Tracks whose vocal lanes are used must be separated first (done once, then kept).
            for u in needStems { _ = try? StemSeparator.separate(u, cancel: flag) }
            do {
                try OfflineRenderer.render(clips: clips, master: master, tempo: tempo, gridOffset: offset, to: url, options: options, cancel: flag,
                                           knownPeak: knownPeak) { p in
                    Task { @MainActor in
                        if case .rendering = self.exportPhase {
                            self.exportPhase = .rendering(p)
                            if self.exportSteadyMark == nil, p > self.exportSteadyFrom { self.exportSteadyMark = (p, Date()) }
                        }
                    }
                }
                await MainActor.run { self.exportPhase = .done(url) }
            } catch OfflineRenderer.RenderError.cancelled {
                try? FileManager.default.removeItem(at: url)
                await MainActor.run { self.exportPhase = .idle }
            } catch {
                await MainActor.run { self.exportPhase = .failed(error.localizedDescription) }
            }
        }
    }

    /// Exports the mix as an MP4 with visuals that follow the music (and the tracks' artwork and names).
    func startVideoExport(_ options: VideoExporter.Options) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.mpeg4Movie]
        panel.nameFieldStringValue = documentTitle + ".mp4"
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }

        pause()
        let flag = CancelFlag()
        exportCancel = flag
        exportPhase = .rendering(0)
        exportStartedAt = Date()
        exportSteadyMark = nil
        exportSteadyFrom = 0.4
        let clips = playableClips
        let master = masterBPM
        let tempo = tempoMap
        let offset = gridOffset
        let knownPeak = mixPeaksSignature == mixSignature(sampleRate: options.audio.sampleRate) ? mixPeaks?.peak : nil
        // Where each track comes in, takes over (judged from the transition curves) and ends, with its structure.
        let structs = structures
        let infos: [(url: URL, title: String, artist: String, hue: Double, start: Double, landing: Double, end: Double, sections: [VisualSection])] =
            clips.enumerated().map { i, c in
                let start = tempo.real(c.start)
                let landing = tempo.real(Automation.switchTime(clips: clips, index: i, master: master))
                return (c.url, c.title, c.artist, ClipPalette.hue(c.colorIndex), start, max(start, landing), tempo.real(c.end(master: master)),
                        VisualPainter.sections(clip: c, structure: structs[c.url], master: master, tempo: tempo))
            }

        let needStems = StemSeparator.isAvailable ? tracksNeedingStems.filter { !missingFiles.contains($0) } : []
        Task.detached(priority: .userInitiated) { [self] in
            for u in needStems { _ = try? StemSeparator.separate(u, cancel: flag) }
            var tracks: [VideoExporter.TrackVisual] = []
            for t in infos {
                let art = await MixStore.loadArtwork(t.url)
                tracks.append(VideoExporter.TrackVisual(title: t.title, artist: t.artist, artwork: art, hue: t.hue,
                                                        start: t.start, landing: t.landing, end: t.end,
                                                        sections: t.sections, palette: VisualPainter.palette(art)))
            }
            do {
                try VideoExporter.export(clips: clips, master: master, tempo: tempo, gridOffset: offset, tracks: tracks, to: url,
                                         options: options, cancel: flag, knownPeak: knownPeak) { p in
                    Task { @MainActor in
                        if case .rendering = self.exportPhase {
                            self.exportPhase = .rendering(p)
                            if self.exportSteadyMark == nil, p > self.exportSteadyFrom { self.exportSteadyMark = (p, Date()) }
                        }
                    }
                }
                await MainActor.run { self.exportPhase = .done(url) }
            } catch OfflineRenderer.RenderError.cancelled {
                try? FileManager.default.removeItem(at: url)
                await MainActor.run { self.exportPhase = .idle }
            } catch {
                await MainActor.run { self.exportPhase = .failed(error.localizedDescription) }
            }
        }
    }

    func cancelExport() {
        exportCancel?.cancel()
    }
}


extension JSONEncoder {
    /// Encoder for .djaw files (readable, stable key order, ISO dates).
    static var djaw: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        e.dateEncodingStrategy = .iso8601
        return e
    }
}

extension JSONDecoder {
    static var djaw: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}

enum InspectorTab: String, CaseIterable, Identifiable {
    case transition, deck, fx, mixer

    var id: String { rawValue }

    var title: String {
        switch self {
        case .transition: return L("つなぎ", "Mix")
        case .deck: return L("デッキ", "Deck")
        case .fx: return "FX"
        case .mixer: return L("ミキサー", "Mixer")
        }
    }

    var symbol: String {
        switch self {
        case .transition: return "arrow.left.arrow.right"
        case .deck: return "opticaldisc"
        case .fx: return "sparkles"
        case .mixer: return "slider.vertical.3"
        }
    }
}
