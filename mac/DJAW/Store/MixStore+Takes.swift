import Foundation

/// Several ways of connecting the same two tracks ("takes"): save the current transition, make another one,
/// listen to each and decide which to keep. Nothing is lost when a new transition replaces the current one —
/// a hand-made transition that is about to be replaced is kept as a take automatically.
extension MixStore {
    /// Takes saved for the transition into `id` that belong to its current previous track.
    func takes(into id: UUID) -> [TransitionTake] {
        guard let i = index(of: id), i > 0 else { return [] }
        let prevID = clips[i - 1].id
        return (clips[i].takes ?? []).filter { $0.prevID == prevID }
    }

    func currentSnapshot(into i: Int) -> TransitionTake.Snapshot? {
        guard i > 0, i < clips.count else { return nil }
        return TransitionTake.Snapshot(prev: clips[i - 1], clip: clips[i])
    }

    /// The saved take the transition currently matches (nil = the current one is not saved).
    func currentTakeID(into id: UUID) -> UUID? {
        guard let i = index(of: id), let now = currentSnapshot(into: i) else { return nil }
        return takes(into: id).first { $0.snapshot.sounds(like: now) }?.id
    }

    /// Saves the current transition as a take. Returns its id (the existing one if it is saved already).
    @discardableResult
    func saveTake(into id: UUID, name: String? = nil, undoable: Bool = true) -> UUID? {
        guard let i = index(of: id), i > 0, let now = currentSnapshot(into: i) else { return nil }
        if let existing = takes(into: id).first(where: { $0.snapshot.sounds(like: now) }) {
            if let name, !name.isEmpty { renameTake(into: id, existing.id, to: name) }
            return existing.id
        }
        if undoable { pushUndo() } else { isDirty = true }
        let n = takes(into: id).count + 1
        let take = TransitionTake(name: (name?.isEmpty == false ? name! : L("候補 \(n)", "Take \(n)")),
                                  prevID: clips[i - 1].id, snapshot: now)
        clips[i].takes = (clips[i].takes ?? []) + [take]
        return take.id
    }

    /// Before the transition into clip `i` is replaced: keep a hand-made one (or one marked as chosen) as a take.
    func preserveTransitionBeforeReplacing(into i: Int) {
        guard i > 0, i < clips.count else { return }
        let c = clips[i]
        guard c.transition == .custom || c.transitionDone == true || !(c.takes ?? []).isEmpty else { return }
        saveTake(into: c.id, name: nil, undoable: false)
    }

    /// Switches to a saved take (undoable). The current transition is kept as a take first if it is not saved.
    func useTake(into id: UUID, _ takeID: UUID) {
        guard let i = index(of: id), i > 0, let take = takes(into: id).first(where: { $0.id == takeID }) else { return }
        pushUndo()
        if currentTakeID(into: id) == nil {
            saveTake(into: id, name: L("前のつなぎ（自動保存）", "Previous (auto-saved)"), undoable: false)
        }
        var prev = clips[i - 1], clip = clips[i]
        take.snapshot.apply(prev: &prev, clip: &clip)
        clips[i - 1] = prev
        clips[i] = clip
        refitFollowing(after: i)
        finishTimingEdit()
    }

    /// Uses the take and plays from 4 bars before the transition (⌘Z returns).
    func previewTake(into id: UUID, _ takeID: UUID) {
        if currentTakeID(into: id) != takeID { useTake(into: id, takeID) }
        previewTransition(id)
    }

    func renameTake(into id: UUID, _ takeID: UUID, to name: String) {
        guard let i = index(of: id), let k = clips[i].takes?.firstIndex(where: { $0.id == takeID }) else { return }
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, clips[i].takes?[k].name != trimmed else { return }
        pushUndo()
        clips[i].takes?[k].name = trimmed
    }

    func deleteTake(into id: UUID, _ takeID: UUID) {
        guard let i = index(of: id), clips[i].takes?.contains(where: { $0.id == takeID }) == true else { return }
        pushUndo()
        clips[i].takes?.removeAll { $0.id == takeID }
        if clips[i].takes?.isEmpty == true { clips[i].takes = nil }
    }

    /// Saves the current transition as a take, then starts a new one from the recommended plan.
    func newTakeFromAuto(into id: UUID) {
        guard let i = index(of: id), i > 0 else { return }
        saveTake(into: id, undoable: true)
        autoMixTransition(into: id)
        _ = i
    }
}
