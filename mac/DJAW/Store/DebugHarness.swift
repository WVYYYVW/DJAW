#if DEBUG
import Foundation
import AVFoundation

/// Development-only test harness (not in release builds).
/// If ~/Downloads/DJAW_DEBUG_SCRIPT.txt exists at launch, its lines are run once and the file is renamed:
///   add <file or folder>     — add to the library and wait for the analysis
///   arrange                  — auto-arrange every library track (order + transitions)
///   automix                  — auto-mix the current mix
///   report <json path>       — write analysis + plan details for comparison with ground truth
///   mix <file>               — append a track to the mix (keeps the script's order)
///   reset                    — empty the mix and the library
///   mark / restore           — remember the mix and go back to it (fast repeated auto-mixes)
///   verify on|off            — render check after auto-mix
///   profile <json> | none    — auto-mix settings to try (MixScore tune-prepare)
///   variations / checkvariations — list (and render-check) the variations of every transition
///   pattern <n>              — switch to auto-mix pattern n
///   genre <name part> = <g>  — set the genre of matching tracks (MixGenre raw value, or "none")
///   genredump <file> | <dir> — dump the genre model's input / output for comparison with Python
nonisolated(unsafe) private var debugMark: ([Clip], [Clip], Double, Double, [URL: TrackStructure])?
nonisolated(unsafe) private var debugRunning = false
nonisolated(unsafe) private var debugWatcher: Timer?

extension MixStore {
    /// Also picks up a script dropped in later (checked every 3 s), so tests need no relaunch.
    func watchDebugScript() {
        guard debugWatcher == nil else { return }
        debugWatcher = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !debugRunning else { return }
                self.runDebugScriptIfPresent()
            }
        }
    }

    func runDebugScriptIfPresent() {
        let fm = FileManager.default
        let script = fm.homeDirectoryForCurrentUser.appendingPathComponent("Downloads/DJAW_DEBUG_SCRIPT.txt")
        guard !debugRunning, let text = try? String(contentsOf: script, encoding: .utf8) else { return }
        debugRunning = true
        let done = script.appendingPathExtension("done")
        try? fm.removeItem(at: done)
        try? fm.moveItem(at: script, to: done)
        let lines = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && !$0.hasPrefix("#") }
        Task { @MainActor in
            let savedVerify = verifyTransitions
            defer { verifyTransitions = savedVerify; debugRunning = false }
            var replacedMix = false
            for line in lines {
                let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
                let arg = parts.count > 1 ? (parts[1] as NSString).expandingTildeInPath : ""
                switch parts[0] {
                case "add":
                    addFiles([URL(fileURLWithPath: arg)], to: .library)
                    await waitForAnalysis()
                case "open":
                    // Never throw away the user's unsaved work for a test.
                    if isDirty {
                        print("[DJAW] debug script: not opening \(arg) — the current mix has unsaved changes")
                        return
                    }
                    load(from: URL(fileURLWithPath: arg))
                    await waitForAnalysis()
                case "arrange":
                    autoArrange(library.map(\.id), reorder: true, replace: true)
                    await waitForAnalysis()
                case "automix":
                    autoMixAll()
                    await waitForAnalysis()
                case "profile":
                    // profile <MixTuning.json> | none — settings to try (MixScore tune)
                    MixTuning.current = arg == "none" ? (MixTuning.load(from: MixTuning.installedURL) ?? MixTuning())
                        : (MixTuning.load(from: URL(fileURLWithPath: arg)) ?? MixTuning())
                case "variations":
                    for c in clips.dropFirst() { computeVariations(into: c.id) }
                case "checkvariations":
                    for c in clips.dropFirst() { await checkVariations(into: c.id) }
                case "pattern":
                    // pattern <n>: switch to the n-th auto-mix pattern
                    if let n = Int(arg), n < mixPatterns.count {
                        usePattern(mixPatterns[n].id)
                        await waitForAnalysis()
                    }
                case "verify":
                    verifyTransitions = arg != "off"
                case "mark":
                    debugMark = (clips, library, masterBPM, gridOffset, structures)
                case "restore":
                    if let m = debugMark {
                        clips = m.0; library = m.1; masterBPM = m.2; gridOffset = m.3; structures = m.4
                        finishTimingEdit()
                    }
                case "style":
                    mixStyle = MixStyle(rawValue: arg) ?? .auto
                case "arc":
                    setArc = SetArc(rawValue: arg) ?? .none
                case "export":
                    // export <wav path>: offline render of the whole mix
                    let snap = clips, m = masterBPM, tm = tempoMap, g = gridOffset, url = URL(fileURLWithPath: arg)
                    _ = try? await Task.detached {
                        try OfflineRenderer.render(clips: snap, master: m, tempo: tm, gridOffset: g, to: url,
                                                   options: .init(format: .wav24, sampleRate: 44100, normalize: false),
                                                   cancel: CancelFlag(), progress: { _ in })
                    }.value
                case "cutgap":
                    // cutgap <json path>: level around every cut-in (2 ms windows), to catch dropouts
                    var rows: [[String: Any]] = []
                    for i in clips.indices.dropFirst() where clips[i].transition == .cut {
                        let t = clips[i].start
                        guard let y = TransitionCheck.render(clips: clips, indices: [i - 1, i], master: masterBPM, tempo: tempoMap,
                                                             gridOffset: gridOffset, from: max(0, t - 0.3), to: t + 0.3) else { continue }
                        let sr = TransitionCheck.sampleRate, w = Int(0.002 * sr)
                        var db: [Double] = []
                        var k = 0
                        while k + w <= y.count {
                            var e: Float = 0
                            for j in k..<(k + w) { e += y[j] * y[j] }
                            db.append(10 * log10(max(1e-12, Double(e) / Double(w))))
                            k += w
                        }
                        let c = Int(min(t, 0.3) / 0.002)
                        let near = db[max(0, c - 10)..<min(db.count, c + 10)]
                        let around = (db[..<max(0, c - 25)] + db[min(db.count, c + 25)...]).sorted()
                        rows.append(["into": clips[i].url.lastPathComponent, "minNearCut": near.min() ?? -120,
                                     "medianAround": around.isEmpty ? -120 : around[around.count / 2]])
                    }
                    if let data = try? JSONSerialization.data(withJSONObject: rows, options: .prettyPrinted) {
                        try? data.write(to: URL(fileURLWithPath: arg))
                    }
                case "startgap":
                    // startgap <json path>: how long each track stays silent after it starts (solo render, 1 ms steps)
                    var rows: [[String: Any]] = []
                    for i in clips.indices {
                        let c = clips[i], t = c.start
                        let sr = TransitionCheck.sampleRate
                        func firstSound(_ idx: [Int]) -> Double? {
                            guard let y = TransitionCheck.render(clips: clips, indices: idx, master: masterBPM, tempo: tempoMap,
                                                                 gridOffset: gridOffset, from: t, to: t + 2.5) else { return nil }
                            guard let k = y.firstIndex(where: { abs($0) > 0.001 }) else { return 99 }
                            return Double(k) / sr
                        }
                        rows.append(["file": c.url.lastPathComponent, "index": i, "start": t, "rate": c.rate(master: masterBPM),
                                     "trimStart": c.trimStart, "inNudge": c.inNudge ?? 0, "transition": c.transition.rawValue,
                                     "fadeInBeats": c.fadeInBeats, "keyLock": c.keyLock ?? NSNull(), "keyShift": c.keyShift ?? 0,
                                     "tempo": c.tempo ?? NSNull(), "mixTempo": tempoMap.bpm(at: t + 0.01),
                                     "soloFirstSound": firstSound([i]) ?? NSNull()])
                    }
                    if let data = try? JSONSerialization.data(withJSONObject: rows, options: .prettyPrinted) {
                        try? data.write(to: URL(fileURLWithPath: arg))
                    }
                case "cuttest":
                    // cuttest <file A> | <A out bar> | <file B> | <B in bar> | <json>: cut A → B in a scratch mix
                    // (restored afterwards), at A's tempo (B stretched) and at B's tempo (A stretched);
                    // reports how long the output stays silent around the switch.
                    let p = arg.components(separatedBy: " | ").map { ($0 as NSString).expandingTildeInPath }
                    // optional 6th field: A's mix-in bar (so the cut comes later in the render)
                    guard p.count >= 5, let outBar = Double(p[1]), let inBar = Double(p[3]),
                          let ra = try? await AudioAnalyzer.analyze(url: URL(fileURLWithPath: p[0])),
                          let rb = try? await AudioAnalyzer.analyze(url: URL(fileURLWithPath: p[2])) else { break }
                    func mk(_ r: TrackAnalysis, _ path: String) -> Clip {
                        var c = Clip(url: URL(fileURLWithPath: path), title: r.title, artist: r.artist, duration: r.duration,
                                     bpm: r.bpm, firstBeat: r.firstBeat, trimEnd: r.duration)
                        c.resetToWholeTrack()
                        return c
                    }
                    let saved = (clips, library, masterBPM, gridOffset)
                    var rows: [[String: Any]] = []
                    for (label, m) in [("A tempo", ra.bpm), ("B tempo", rb.bpm), ("between", (ra.bpm + rb.bpm) / 2)] {
                        var a = mk(ra, p[0]), b = mk(rb, p[2])
                        if p.count > 5, let ain = Double(p[5]) { a.mixInBar = ain }
                        a.mixOutBar = outBar
                        b.mixInBar = inBar
                        b.transition = .cut
                        b.transitionBars = 0
                        clips = [a, b]
                        masterBPM = m
                        layout()
                        let t = clips[1].start
                        let sr = TransitionCheck.sampleRate
                        var row: [String: Any] = ["case": label, "master": m, "rateA": clips[0].rate(master: m), "rateB": clips[1].rate(master: m),
                                                  "cutAt": t]
                        if let y = TransitionCheck.render(clips: clips, indices: [0, 1], master: m, tempo: tempoMap, gridOffset: gridOffset,
                                                          from: t - 0.5, to: t + 2) {
                            let c = Int(0.5 * sr)
                            var a0 = c; while a0 > 0 && abs(y[a0 - 1]) < 0.001 { a0 -= 1 }
                            var b0 = c; while b0 < y.count && abs(y[b0]) < 0.001 { b0 += 1 }
                            row["silentBeforeMs"] = Double(c - a0) / sr * 1000
                            row["silentAfterMs"] = Double(b0 - c) / sr * 1000
                        }
                        if let y = TransitionCheck.render(clips: clips, indices: [1], master: m, tempo: tempoMap, gridOffset: gridOffset,
                                                          from: t, to: t + 2) {
                            row["soloBFirstSoundMs"] = Double(y.firstIndex { abs($0) > 0.001 } ?? y.count) / sr * 1000
                        }
                        // The same through the render check from the very start, and through the real export.
                        if let y = TransitionCheck.render(clips: clips, indices: [0, 1], master: m, tempo: tempoMap, gridOffset: gridOffset,
                                                          from: 0, to: t + 2) {
                            let c = Int(tempoMap.real(t) * sr)
                            var b0 = c; while b0 < y.count && abs(y[b0]) < 0.001 { b0 += 1 }
                            row["fromZeroSilentAfterMs"] = Double(b0 - c) / sr * 1000
                        }
                        let wav = URL(fileURLWithPath: p[4]).deletingPathExtension().path + "-\(rows.count).wav"
                        let snap = clips, tm = tempoMap, g = gridOffset
                        _ = try? await Task.detached {
                            try OfflineRenderer.render(clips: snap, master: m, tempo: tm, gridOffset: g, to: URL(fileURLWithPath: wav),
                                                       options: .init(format: .wav24, sampleRate: 44100, normalize: false),
                                                       cancel: CancelFlag(), progress: { _ in })
                        }.value
                        row["exportWav"] = wav
                        row["cutAtReal"] = tempoMap.real(t)
                        rows.append(row)
                    }
                    clips = saved.0; library = saved.1; masterBPM = saved.2; gridOffset = saved.3
                    layout()
                    if let data = try? JSONSerialization.data(withJSONObject: rows, options: .prettyPrinted) {
                        try? data.write(to: URL(fileURLWithPath: p[4]))
                    }
                case "capture":
                    // capture <from> <seconds> <wav>: plays the mix silently (speakers muted) and records what the
                    // preview produces, starting at timeline time <from> — compare with an export of the same mix.
                    let f = arg.split(separator: " ", maxSplits: 2).map(String.init)
                    guard f.count == 3, let from = Double(f[0]), let secs = Double(f[1]) else { break }
                    pause()
                    engine.debugMuted = true
                    seek(from)
                    engine.captureArmed = true
                    play()
                    try? await Task.sleep(nanoseconds: UInt64((secs + 0.3) * 1e9))
                    let r = engine.finishCapture()
                    pause()
                    engine.debugMuted = false
                    if let r, let fmt = AVAudioFormat(standardFormatWithSampleRate: r.sampleRate, channels: 1),
                       let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(r.samples.count)),
                       let file = try? AVAudioFile(forWriting: URL(fileURLWithPath: (f[2] as NSString).expandingTildeInPath),
                                                   settings: fmt.settings, commonFormat: .pcmFormatFloat32, interleaved: false) {
                        buf.frameLength = AVAudioFrameCount(r.samples.count)
                        r.samples.withUnsafeBufferPointer { buf.floatChannelData![0].update(from: $0.baseAddress!, count: r.samples.count) }
                        try? file.write(from: buf)
                    }
                case "set":
                    // set <clip index> key=value ... (mixInBar, mixOutBar, transitionBars, transition, bpm, firstBeat, tempo, gainDB)
                    let f = arg.split(separator: " ").map(String.init)
                    if let i = f.first.flatMap(Int.init), i < clips.count {
                        for kv in f.dropFirst() {
                            let q = kv.split(separator: "=", maxSplits: 1).map(String.init)
                            guard q.count == 2 else { continue }
                            let v = Double(q[1])
                            switch q[0] {
                            case "mixInBar": if let v { clips[i].mixInBar = v }
                            case "mixOutBar": if let v { clips[i].mixOutBar = v }
                            case "transitionBars": if let v { clips[i].transitionBars = v }
                            case "transition": if let s = TransitionStyle(rawValue: q[1]) { clips[i].transition = s }
                            case "bpm": if let v { clips[i].bpm = v }
                            case "firstBeat": if let v { clips[i].firstBeat = v }
                            case "tempo": clips[i].tempo = v
                            case "gainDB": if let v { clips[i].gainDB = v }
                            default: break
                            }
                        }
                        finishTimingEdit()
                    }
                case "offsettest":
                    // offsettest <click wav> | <json>: where the clicks of a click track (120 BPM, beats at 0.25 + 0.5 k s)
                    // come out against where the timeline puts them — several rates and sample rates, rendered from the
                    // start (as in an export) and from inside the clip (as when the preview starts there).
                    let p = arg.components(separatedBy: " | ").map { ($0 as NSString).expandingTildeInPath }
                    guard p.count >= 2 else { break }
                    let src = URL(fileURLWithPath: p[0]), out = URL(fileURLWithPath: p[1])
                    await Task.detached { MixStore.offsetTest(click: src, to: out) }.value
                case "stemcheck":
                    // stemcheck <audio file> | <json>: separate again (fresh) and report the figures; also writes
                    // 30 s of each stem next to the json (…-vocals.wav / …-inst.wav) for listening / analysis.
                    let p = arg.components(separatedBy: " | ").map { ($0 as NSString).expandingTildeInPath }
                    guard p.count >= 2 else { break }
                    let src = URL(fileURLWithPath: p[0]), out = URL(fileURLWithPath: p[1])
                    await Task.detached {
                        var report: [String: Any] = [:]
                        StemSeparator.removeStems(for: src)
                        do {
                            let st = try StemSeparator.separate(src)
                            report["stems"] = [st.vocals.path, st.instrumental.path]
                            for (name, u) in [("vocals", st.vocals), ("inst", st.instrumental)] {
                                if let f = try? AVAudioFile(forReading: u) {
                                    f.framePosition = min(f.length - 1, AVAudioFramePosition(60 * f.processingFormat.sampleRate))
                                    let n = AVAudioFrameCount(min(Double(f.length - f.framePosition), 30 * f.processingFormat.sampleRate))
                                    if let b = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: n), (try? f.read(into: b, frameCount: n)) != nil,
                                       let w = try? AVAudioFile(forWriting: out.deletingLastPathComponent()
                                            .appendingPathComponent(out.deletingPathExtension().lastPathComponent + "-\(name).wav"),
                                                                settings: f.processingFormat.settings) {
                                        try? w.write(from: b)
                                    }
                                }
                            }
                        } catch {
                            report["error"] = error.localizedDescription
                        }
                        report["stats"] = StemSeparator.lastStats
                        if let d = try? JSONSerialization.data(withJSONObject: report, options: .prettyPrinted) { try? d.write(to: out) }
                    }.value
                case "master":
                    if let v = Double(arg) { masterBPM = v; finishTimingEdit() }
                case "renderwav":
                    // renderwav <from> <to> <wav>: the mix between two timeline times (22.05 kHz mono)
                    let f = arg.split(separator: " ", maxSplits: 2).map(String.init)
                    if f.count == 3, let a = Double(f[0]), let b = Double(f[1]),
                       let y = TransitionCheck.render(clips: clips, indices: Array(clips.indices), master: masterBPM, tempo: tempoMap,
                                                      gridOffset: gridOffset, from: a, to: b),
                       let fmt = AVAudioFormat(standardFormatWithSampleRate: TransitionCheck.sampleRate, channels: 1),
                       let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(y.count)),
                       let file = try? AVAudioFile(forWriting: URL(fileURLWithPath: (f[2] as NSString).expandingTildeInPath),
                                                   settings: fmt.settings, commonFormat: .pcmFormatFloat32, interleaved: false) {
                        buf.frameLength = AVAudioFrameCount(y.count)
                        y.withUnsafeBufferPointer { buf.floatChannelData![0].update(from: $0.baseAddress!, count: y.count) }
                        try? file.write(from: buf)
                    }
                case "dumpclips":
                    // dumpclips <json>: every clip's placement fields
                    let rows: [[String: Any]] = clips.map { c in
                        ["file": c.url.lastPathComponent, "start": c.start, "trimStart": c.trimStart, "trimEnd": c.trimEnd,
                         "mixInBar": c.mixInBar, "mixOutBar": c.mixOutBar, "transition": c.transition.rawValue,
                         "transitionBars": c.transitionBars, "bpm": c.bpm, "firstBeat": c.firstBeat, "rate": c.rate(master: masterBPM),
                         "inNudge": c.inNudge ?? 0, "outNudge": c.outNudge ?? 0, "playLength": c.playLength ?? NSNull(),
                         "edits": (c.edits ?? []).count, "fx": (c.fx ?? []).map { "\($0.kind.rawValue)@\($0.bar)+\($0.bars)" },
                         "tempo": c.tempo ?? NSNull(), "fadeInBeats": c.fadeInBeats, "fadeOutBeats": c.fadeOutBeats,
                         "keyLock": c.keyLock ?? NSNull(), "keyShift": c.keyShift ?? 0, "tempoSync": c.tempoSync,
                         "end": c.end(master: masterBPM)]
                    }
                    if let data = try? JSONSerialization.data(withJSONObject: ["master": masterBPM, "gridOffset": gridOffset, "clips": rows,
                                                                                "tempo": tempoMap.points.map { ["t": $0.t, "bpm": $0.bpm] }],
                                                              options: .prettyPrinted) {
                        try? data.write(to: URL(fileURLWithPath: arg))
                    }
                case "refresh":
                    // wait for the analysis, then recompute the layout (cut alignment etc.) of the current mix
                    await waitForAnalysis()
                    finishTimingEdit()
                case "reset":
                    replacedMix = true
                    clips = []
                    library = []
                case "genre":
                    // genre <file name part> = <family | none>
                    let kv = parts.count > 1 ? parts[1].components(separatedBy: " = ") : []
                    if kv.count == 2 {
                        let g = MixGenre(rawValue: kv[1].trimmingCharacters(in: .whitespaces))
                        for c in clips + library where c.url.lastPathComponent.contains(kv[0]) {
                            updateClip(c.id, undoable: false) { $0.genre = g }
                        }
                    }
                case "genredump":
                    let parts2 = arg.components(separatedBy: " | ")
                    if parts2.count == 2 {
                        GenreAnalyzer.debugDump(url: URL(fileURLWithPath: parts2[0]), to: URL(fileURLWithPath: (parts2[1] as NSString).expandingTildeInPath))
                    }
                case "report":
                    writeDebugReport(to: URL(fileURLWithPath: arg))
                case "mix":
                    // Append to the mix (in script order) and wait for the analysis.
                    addFiles([URL(fileURLWithPath: arg)], to: .mix(clips.count))
                    await waitForAnalysis()
                default:
                    break
                }
            }
            // Test mixes are throw-away: don't offer to "restore" them at the next launch
            // (only when the script replaced the mix — never for the user's own work).
            if replacedMix {
                isDirty = false
                removeAutosave()
            }
        }
    }

    /// The mix from timeline time `from`, `seconds` long, through a MixRenderSession (mono).
    nonisolated static func debugRender(clips: [Clip], master: Double, tempo: TempoMap, from: Double, seconds: Double,
                                        wait: Bool, sampleRate sr: Double) -> [Float] {
        guard let s = try? MixRenderSession(clips: clips, master: master, tempo: tempo, gridOffset: 0, sampleRate: sr,
                                            from: from, waitForCalibration: wait) else { return [] }
        defer { s.stop() }
        var y: [Float] = []
        let total = Int(seconds * sr)
        y.reserveCapacity(total)
        while y.count < total {
            guard let b = try? s.renderNext(), let d = b.floatChannelData else { break }
            for i in 0..<Int(b.frameLength) { y.append((d[0][i] + d[1][i]) / 2) }
        }
        return y
    }

    /// First sample around `center` (±`half`) where |y| reaches 0.3 of the peak there, in samples (nil if silent).
    nonisolated static func debugOnset(_ y: [Float], around center: Int, half: Int) -> Double? {
        let a = max(0, center - half), b = min(y.count, center + half)
        guard b > a else { return nil }
        var peak: Float = 0
        for i in a..<b { peak = max(peak, abs(y[i])) }
        guard peak > 0.02 else { return nil }
        for i in a..<b where abs(y[i]) >= 0.3 * peak { return Double(i) }
        return nil
    }

    nonisolated static func offsetTest(click: URL, to out: URL) {
        var report: [String: Any] = [:]
        defer {
            if let data = try? JSONSerialization.data(withJSONObject: report, options: .prettyPrinted) { try? data.write(to: out) }
        }
        guard let f = try? AVAudioFile(forReading: click),
              let buf = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: AVAudioFrameCount(f.length)),
              (try? f.read(into: buf)) != nil, let d = buf.floatChannelData else { report["error"] = "cannot read \(click.path)"; return }
        let ssr = f.processingFormat.sampleRate
        let src = Array(UnsafeBufferPointer(start: d[0], count: Int(buf.frameLength)))
        let dur = Double(src.count) / ssr
        // Where each click starts in the source (same detector as for the renders).
        var srcOnsets: [Double] = []
        var k = 0
        while 0.25 + 0.5 * Double(k) + 0.1 < dur {
            let c = Int((0.25 + 0.5 * Double(k)) * ssr)
            if let o = debugOnset(src, around: c, half: Int(0.08 * ssr)) { srcOnsets.append(o / ssr) }
            k += 1
        }
        report["sourceClicks"] = srcOnsets.count
        var rows: [[String: Any]] = []
        for sr in [44_100.0, 48_000.0] {
            for (rate, wait) in [(1.00001, true), (0.97288, true), (1.09749, true), (0.97311, false)] {
                let m = 120 * rate
                var c = Clip(url: click, title: "click", artist: "", duration: dur, bpm: 120, firstBeat: 0.25, trimEnd: dur)
                c.resetToWholeTrack()
                c.trimStart = 0.005
                c.start = 30.1234
                c.transition = .cut
                let tm = TempoMap(reference: m)
                for (name, from, secs) in [("zero", 0.0, 80.1234), ("mid", 60.1234, 20.0)] {
                    let y = debugRender(clips: [c], master: m, tempo: tm, from: from, seconds: secs, wait: wait, sampleRate: sr)
                    var ts: [Double] = [], ms: [Double] = []
                    for s in srcOnsets where s >= c.trimStart {
                        let t = c.start + (s - c.trimStart) / c.rate(master: m)
                        let idx = Int(((t - from) * sr).rounded())
                        guard idx > Int(0.1 * sr), idx < y.count - Int(0.1 * sr),
                              let o = debugOnset(y, around: idx, half: Int(0.08 * sr)) else { continue }
                        ts.append(t)
                        ms.append((o / sr - (t - from)) * 1000)
                    }
                    rows.append(["sr": sr, "rate": rate, "wait": wait, "path": name, "from": from, "samples": y.count,
                                 "t": ts, "ms": ms])
                }
            }
        }
        report["rows"] = rows
    }

    private func waitForAnalysis() async {
        try? await Task.sleep(nanoseconds: 500_000_000)
        while !pending.isEmpty || analyzingCount > 0 || verifyProgress != nil {
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
    }

    func writeDebugReport(to url: URL) {
        func j(_ v: Double?) -> Any { v ?? NSNull() }
        func js(_ v: String?) -> Any { v ?? NSNull() }
        func clipInfo(_ c: Clip) -> [String: Any] {
            var d: [String: Any] = ["file": c.url.lastPathComponent, "bpm": c.bpm, "firstBeat": c.firstBeat,
                                    "mixInBar": c.mixInBar, "mixOutBar": c.mixOutBar, "transitionBars": c.transitionBars,
                                    "transition": c.transition.rawValue, "tempo": j(c.tempo), "tempoBars": j(c.tempoBars),
                                    "start": c.start, "landingBar": c.landingBar,
                                    "fx": (c.fx ?? []).map { ["kind": $0.kind.rawValue, "bar": $0.bar, "bars": $0.bars] },
                                    "autoNote": js(c.autoNote?.text)]
            if let s = structures[c.url] {
                d["structure"] = ["bpm": s.bpm, "firstBeat": s.firstBeat, "barCount": s.barCount, "phraseOffset": s.phraseOffset,
                                  "musicStart": s.musicStart, "musicEnd": s.musicEnd, "firstDrop": s.firstDrop, "lastDropEnd": s.lastDropEnd,
                                  "downbeatShift": s.downbeatShift,
                                  "sections": s.sections.map { ["kind": $0.kind.rawValue, "start": $0.start, "end": $0.end, "bass": $0.bass, "energy": $0.energy] },
                                  "cueBars": s.cueBars.map { ["bar": $0.bar, "score": $0.score] },
                                  "key": js(s.key?.camelot),
                                  "gridFit": s.gridFit.map { Double($0) },
                                  "looksQuick": looksQuick(c)]
            }
            if let n = neuralResults[c.url] {
                d["neural"] = ["beats": n.beats.count, "downbeats": n.downbeats.count,
                               "gridBPM": j(n.grid?.bpm), "gridFirstBeat": j(n.grid?.firstBeat),
                               "coherence": j(n.grid?.coherence), "downbeatConfidence": j(n.grid?.downbeatConfidence),
                               "cues": n.cues.map { ["time": $0.time, "score": $0.score] }]
            }
            if let g = genreResults[c.url] {
                d["genre"] = ["tag": js(g.tag), "tagFamily": js(g.tagFamily?.rawValue), "detected": js(g.detected?.rawValue),
                              "families": g.families, "styles": g.styles.map { ["label": $0.label, "score": $0.score] },
                              "traits": g.traits ?? [], "voicePatches": g.voice?.count ?? 0]
            }
            d["genreUsed"] = js(genre(for: c)?.rawValue)
            if let readings = tempoReadings[c.url] {
                d["readings"] = readings.map { ["bpm": $0.bpm, "firstBeat": $0.firstBeat, "fit": $0.fit] }
            }
            return d
        }
        let patterns: [[String: Any]] = mixPatterns.map { ["title": $0.title, "blends": $0.blends, "cuts": $0.cuts,
                                                           "averageBars": $0.averageBars, "duration": $0.duration,
                                                           "current": $0.id == currentPatternID] }
        var vars: [String: Any] = [:]
        for c in clips where variations[c.id] != nil {
            vars[c.url.lastPathComponent] = (variations[c.id] ?? []).map { v -> [String: Any] in
                ["label": v.label, "style": v.plan.style.rawValue, "bars": v.plan.length, "out": v.plan.outBar, "in": v.plan.inBar,
                 "score": v.plan.score, "problems": v.problems ?? NSNull()]
            }
        }
        let report: [String: Any] = ["masterBPM": masterBPM, "style": mixStyle.rawValue, "patterns": patterns, "variations": vars,
                                     "setArc": setArc.rawValue,
                                     "energy": clips.map { energyLevel($0) ?? -1 },
                                     "resolvedStyle": resolvedStyle(clips.indices).rawValue,
                                     "mix": clips.map(clipInfo), "library": library.map(clipInfo),
                                     "tempoPoints": tempoMap.points.map { ["t": $0.t, "bpm": $0.bpm] }]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: url)
        }
    }
}
#endif
