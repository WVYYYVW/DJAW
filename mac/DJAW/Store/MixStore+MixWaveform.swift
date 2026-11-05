import Foundation

/// The mix lane: the final mixed-down waveform, rendered by the export's own engine pass with the export settings,
/// so it is sample-for-sample what "Export" writes (WAV). Rendered again in the background whenever the mix changes.
extension MixStore {
    /// Identifies everything the rendered audio depends on.
    func mixSignature(sampleRate: Double? = nil) -> Int {
        var h = Hasher()
        // Saved transition takes and colours don't change the sound.
        h.combine(clips.filter { !missingFiles.contains($0.url) }.map { c -> Clip in var c = c; c.takes = nil; c.colorIndex = 0; return c })
        h.combine(masterBPM)
        h.combine(gridOffset)
        h.combine(sampleRate ?? exportSampleRate)
        h.combine(stemSignature)
        return h.finalize()
    }

    /// The lane shows an older render (or nothing) while a new one is running.
    var mixWaveformIsRendering: Bool { mixRenderingSignature != nil }

    func startMixRender() {
        guard showMixWaveform else { return }
        let sig = mixSignature()
        if sig == mixPeaksSignature {
            mixRenderCancel?.cancel()
            mixRenderingSignature = nil
            mixPeaksPartial = nil
            mixStaleRange = nil
            return
        }
        if sig == mixRenderingSignature { return }
        // A partial update is running: let it finish (it is short), then update from its result.
        if mixRenderingSignature != nil, mixStaleRange != nil {
            mixRerunPending = true
            return
        }
        mixRenderCancel?.cancel()
        mixExactWork?.cancel()
        let snap = clips.filter { !missingFiles.contains($0.url) }
        guard !snap.isEmpty else {
            mixPeaks = nil
            mixPeaksSignature = nil
            mixPeaksInputs = nil
            mixRenderingSignature = nil
            return
        }
        let inputs = MixWaveformInputs(clips: snap, master: masterBPM, tempo: tempoMap, gridOffset: gridOffset, sampleRate: exportSampleRate,
                                       stems: stemSignature)
        // Only part of the mix changed: re-render that stretch and move the rest along.
        if let old = mixPeaks, let before = mixPeaksInputs, mixPeaksPartial == nil,
           let change = MixWaveformInputs.change(from: before, to: inputs),
           let provisional = change.provisional(from: old, inputs: inputs) {
            renderChangedPart(change, provisional: provisional, inputs: inputs, sig: sig)
            return
        }
        renderWholeMix(inputs, sig: sig)
    }

    private func renderWholeMix(_ inputs: MixWaveformInputs, sig: Int) {
        let flag = CancelFlag()
        mixRenderCancel = flag
        mixRenderingSignature = sig
        mixPeaksPartial = nil
        mixStaleRange = nil
        Task.detached(priority: .utility) { [weak self] in
            let result = try? OfflineRenderer.renderPeaks(clips: inputs.clips, master: inputs.master, tempo: inputs.tempo,
                                                         gridOffset: inputs.gridOffset, sampleRate: inputs.sampleRate,
                                                         cancel: flag) { partial in
                Task { @MainActor in
                    guard let self, !flag.isCancelled, self.mixRenderingSignature == sig else { return }
                    self.mixPeaksPartial = partial
                }
            }
            await MainActor.run {
                guard let self, !flag.isCancelled, self.mixRenderingSignature == sig else { return }
                if let result {
                    self.mixPeaks = result
                    self.mixPeaksSignature = sig
                    self.mixPeaksInputs = inputs
                }
                self.mixPeaksPartial = nil
                self.mixRenderingSignature = nil
            }
        }
    }

    /// Shows the old waveform moved to the new layout at once, renders only the changed stretch, then splices it in.
    private func renderChangedPart(_ change: MixWaveformInputs.Change, provisional: OfflineRenderer.MixPeaks,
                                   inputs: MixWaveformInputs, sig: Int) {
        let flag = CancelFlag()
        mixRenderCancel = flag
        mixRenderingSignature = sig
        mixPeaks = provisional
        mixPeaksSignature = nil
        mixPeaksInputs = inputs
        mixStaleRange = change.fromReal...change.toReal
        Task.detached(priority: .utility) { [weak self] in
            let part = try? OfflineRenderer.renderPeakRange(clips: inputs.clips, master: inputs.master, tempo: inputs.tempo,
                                                            gridOffset: inputs.gridOffset, sampleRate: inputs.sampleRate,
                                                            binsPerSecond: provisional.binsPerSecond,
                                                            fromReal: change.fromReal, toReal: change.toReal, cancel: flag)
            await MainActor.run {
                guard let self, !flag.isCancelled, self.mixRenderingSignature == sig else { return }
                self.mixRenderingSignature = nil
                self.mixStaleRange = nil
                defer {
                    if self.mixRerunPending {
                        self.mixRerunPending = false
                        self.startMixRender()
                    }
                }
                guard let part, var peaks = self.mixPeaks else { self.mixPeaksInputs = nil; return }
                for k in 0..<part.mins.count {
                    let b = part.firstBin + k
                    guard b < peaks.mins.count else { break }
                    peaks.mins[b] = part.mins[k]; peaks.maxs[b] = part.maxs[k]; peaks.rms[b] = part.rms[k]
                }
                peaks.peak = zip(peaks.mins, peaks.maxs).reduce(Float(0)) { max($0, -$1.0, $1.1) }
                self.mixPeaks = peaks
                if change.exact {
                    // Nothing was moved by a fraction of a bin: this is exactly what a full render gives.
                    self.mixPeaksSignature = sig
                } else {
                    self.scheduleExactMixRender(sig: sig)
                }
            }
        }
    }

    /// After a partial update that moved the rest of the mix by a fraction of a bin, the waveform is re-rendered in
    /// full once editing has paused for a while (low priority), so it matches the export sample for sample again.
    private func scheduleExactMixRender(sig: Int) {
        mixExactWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.showMixWaveform, self.mixSignature() == sig, self.mixRenderingSignature == nil else { return }
                if self.isPlaying || self.isInteracting { self.scheduleExactMixRender(sig: sig); return }
                let snap = self.clips.filter { !self.missingFiles.contains($0.url) }
                let inputs = MixWaveformInputs(clips: snap, master: self.masterBPM, tempo: self.tempoMap,
                                               gridOffset: self.gridOffset, sampleRate: self.exportSampleRate, stems: self.stemSignature)
                self.renderExactQuietly(inputs, sig: sig)
            }
        }
        mixExactWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: work)
    }

    /// The full render, without dimming the lane (what is shown is already right to within a few milliseconds).
    private func renderExactQuietly(_ inputs: MixWaveformInputs, sig: Int) {
        let flag = CancelFlag()
        mixRenderCancel = flag
        Task.detached(priority: .background) { [weak self] in
            let result = try? OfflineRenderer.renderPeaks(clips: inputs.clips, master: inputs.master, tempo: inputs.tempo,
                                                         gridOffset: inputs.gridOffset, sampleRate: inputs.sampleRate,
                                                         cancel: flag) { _ in }
            await MainActor.run {
                guard let self, !flag.isCancelled, let result, self.mixSignature() == sig, self.mixRenderingSignature == nil else { return }
                self.mixPeaks = result
                self.mixPeaksSignature = sig
                self.mixPeaksInputs = inputs
            }
        }
    }
}

/// What a mix waveform render depends on, and which stretch of it an edit changes.
nonisolated struct MixWaveformInputs: Sendable {
    var clips: [Clip]
    var master: Double
    var tempo: TempoMap
    var gridOffset: Double
    var sampleRate: Double
    /// Which stems were ready (a track starting to play from its stems sounds different).
    var stems: Int = 0

    var endReal: Double { tempo.real(clips.map { $0.end(master: master) }.max() ?? 0) }

    /// A clip as far as the sound is concerned (names, colours, notes and saved takes don't matter).
    static func audible(_ c: Clip) -> Clip {
        var c = c
        c.takes = nil
        c.colorIndex = 0
        c.autoNote = nil
        c.cueDone = nil
        c.transitionDone = nil
        c.cues = nil
        c.genre = nil
        c.lufs = nil
        return c
    }

    struct Change: Sendable {
        /// Stretch to render again (real seconds of the new mix).
        var fromReal: Double
        var toReal: Double
        /// From `toReal` on, the new mix is the old one moved by this much (real seconds).
        var shiftReal: Double
        /// The move is a whole number of bins (the result needs no exact re-render afterwards).
        var exact: Bool

        /// The old waveform rearranged to the new layout (the changed stretch still shows the old one until it is rendered).
        func provisional(from old: OfflineRenderer.MixPeaks, inputs: MixWaveformInputs) -> OfflineRenderer.MixPeaks? {
            let bps = old.binsPerSecond
            let n = Int(((inputs.endReal + 0.3) * bps).rounded(.up)) + 1
            guard n > 0 else { return nil }
            var p = OfflineRenderer.MixPeaks(sampleRate: old.sampleRate, binsPerSecond: bps,
                                             mins: [Float](repeating: 0, count: n), maxs: [Float](repeating: 0, count: n),
                                             rms: [Float](repeating: 0, count: n), rendered: inputs.endReal + 0.3, peak: 0)
            let cut = Int(toReal * bps)
            let shift = Int((shiftReal * bps).rounded())
            for b in 0..<n {
                let src = b < cut ? b : b - shift
                guard src >= 0, src < old.mins.count else { continue }
                p.mins[b] = old.mins[src]; p.maxs[b] = old.maxs[src]
                if src < old.rms.count { p.rms[b] = old.rms[src] }
            }
            p.peak = zip(p.mins, p.maxs).reduce(Float(0)) { max($0, -$1.0, $1.1) }
            return p
        }
    }

    /// Which stretch of the mix differs between two renders' inputs; nil = render everything again.
    static func change(from a: MixWaveformInputs, to b: MixWaveformInputs) -> Change? {
        guard a.master == b.master, a.gridOffset == b.gridOffset, a.sampleRate == b.sampleRate, a.stems == b.stems else { return nil }
        let x = a.clips.map(audible), y = b.clips.map(audible)
        // Unchanged tracks at the start.
        var p = 0
        while p < x.count, p < y.count, x[p] == y[p] { p += 1 }
        if p == x.count && p == y.count { return nil }
        // Tracks at the end that are only moved in time (same track, same settings).
        func moved(_ c: Clip, by d: Double) -> Clip { var c = c; c.start += d; return c }
        var ia = x.count - 1, ib = y.count - 1
        var shiftRef: Double?
        while ia > p, ib > p, x[ia].id == y[ib].id {
            let d = y[ib].start - x[ia].start
            if let s = shiftRef, abs(s - d) > 1e-9 { break }
            guard moved(x[ia], by: d) == y[ib] else { break }
            shiftRef = d
            ia -= 1; ib -= 1
        }
        // The changed tracks: a…b (old ia, new ib). Where their sound starts and ends (with effect tails).
        let changedA = p <= ia ? Array(x[p...ia]) : []
        let changedB = p <= ib ? Array(y[p...ib]) : []
        let startRef = (changedA + changedB).map(\.start).min() ?? 0
        let fromReal = min(a.tempo.real(startRef), b.tempo.real(startRef))
        let tail = MixRenderSession.tail
        // With no moved tail, render to the end of the mix.
        guard let shift = shiftRef, ib + 1 < y.count else {
            return Change(fromReal: max(0, fromReal), toReal: b.endReal + 0.3, shiftReal: 0, exact: true)
        }
        // The moved part must also keep its tempo: same tempo curve from where it starts on.
        let firstMovedNew = y[ib + 1].start
        let endChangedNew = changedB.map { $0.end(master: b.master) }.max() ?? firstMovedNew
        let cutRef = max(firstMovedNew, endChangedNew) + tail * b.master / max(1, b.tempo.bpm(at: endChangedNew))
        var t = cutRef
        let last = y.map { $0.end(master: b.master) }.max() ?? cutRef
        while t <= last + 1 {
            if abs(b.tempo.bpm(at: t) - a.tempo.bpm(at: t - shift)) > 1e-6 { return Change(fromReal: max(0, fromReal), toReal: b.endReal + 0.3, shiftReal: 0, exact: true) }
            t += 1
        }
        let toReal = b.tempo.real(cutRef)
        let shiftReal = toReal - a.tempo.real(cutRef - shift)
        let bins = shiftReal * a.sampleRate / max(1, (a.sampleRate / 200).rounded())
        let exact = abs(bins - bins.rounded()) < 1e-6
        return Change(fromReal: max(0, fromReal), toReal: toReal, shiftReal: shiftReal, exact: exact)
    }
}
