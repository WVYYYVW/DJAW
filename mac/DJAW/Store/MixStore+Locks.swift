import Foundation

/// Locked transitions: a pair of tracks whose transition came out well stays together.
/// Adding tracks never puts one between them, reordering moves them as one, and auto-mix,
/// patterns and the render check leave that transition as it is (only the user changes it).
extension MixStore {
    /// The transition into `clips[i]` is locked (and the locked predecessor still comes right before it).
    func isLocked(_ i: Int) -> Bool {
        i > 0 && i < clips.count && clips[i].lockedPrevID != nil && clips[i].lockedPrevID == clips[i - 1].id
    }

    /// The track at `i` is part of a locked pair (on either side).
    func isLockMember(_ i: Int) -> Bool { isLocked(i) || isLocked(i + 1) }

    func isTransitionLocked(into id: UUID) -> Bool {
        guard let i = index(of: id) else { return false }
        return isLocked(i)
    }

    /// Locks / unlocks the transition into `id` (undoable).
    func setTransitionLocked(into id: UUID, _ on: Bool) {
        guard let i = index(of: id), i > 0, isLocked(i) != on else { return }
        let prev = clips[i - 1].id
        updateClip(id) { $0.lockedPrevID = on ? prev : nil }
    }

    func toggleTransitionLock(into id: UUID) {
        setTransitionLocked(into: id, !isTransitionLocked(into: id))
    }

    /// Number of locked transitions in the mix.
    var lockedCount: Int { clips.indices.filter { isLocked($0) }.count }

    /// Where a track can go when asked for `index`: never between two locked tracks (moves past the locked run).
    func lockSafeIndex(_ index: Int) -> Int {
        var t = min(max(0, index), clips.count)
        while t > 0 && t < clips.count && isLocked(t) { t += 1 }
        return t
    }

    /// The mix split into runs joined by locked transitions (single tracks are runs of one).
    func lockRanges(_ arr: [Clip]) -> [Range<Int>] {
        guard !arr.isEmpty else { return [] }
        var out: [Range<Int>] = []
        var s = 0
        for i in 1...arr.count where i == arr.count || arr[i].lockedPrevID == nil || arr[i].lockedPrevID != arr[i - 1].id {
            out.append(s..<i)
            s = i
        }
        return out
    }

    /// `ids` grouped into units that must stay together (locked runs of mix tracks, all of them in `ids`),
    /// in the order the ids came in.
    func lockUnits(_ ids: [UUID]) -> [[UUID]] {
        let set = Set(ids)
        var used = Set<UUID>()
        var units: [[UUID]] = []
        for id in ids where !used.contains(id) {
            guard let i = index(of: id) else {
                units.append([id]); used.insert(id); continue
            }
            var a = i
            while isLocked(a) && set.contains(clips[a - 1].id) && !used.contains(clips[a - 1].id) { a -= 1 }
            var b = i
            while b + 1 < clips.count && isLocked(b + 1) && set.contains(clips[b + 1].id) { b += 1 }
            let u = (a...b).map { clips[$0].id }.filter { !used.contains($0) }
            units.append(u)
            used.formUnion(u)
        }
        return units
    }

    /// Forgets locks whose tracks are no longer next to each other (a track was removed or moved away).
    func pruneLocks() {
        for i in clips.indices where clips[i].lockedPrevID != nil && !isLocked(i) {
            clips[i].lockedPrevID = nil
        }
        for i in library.indices where library[i].lockedPrevID != nil {
            library[i].lockedPrevID = nil
        }
    }
}
