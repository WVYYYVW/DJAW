import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { store } from './store/store';

/** Re-renders whenever the store changes. */
export function useStore() {
  useSyncExternalStore(store.subscribe, store.getRevision);
  return store;
}

/** The playhead, updated every display frame while playing (without re-rendering the rest). */
export function usePlayhead(throttleMs = 0) {
  const [t, setT] = useState(store.playhead);
  const last = useRef(0);
  useEffect(() => {
    // Throttled, but the last value always arrives (a seek right after another update would otherwise be dropped
    // and the readout would keep showing the old position until playback moves it).
    let pending: ReturnType<typeof setTimeout> | null = null, latest = store.playhead;
    const off = store.onClock(v => {
      latest = v;
      const now = performance.now(), wait = throttleMs - (now - last.current);
      if (wait <= 0) { last.current = now; setT(v); return; }
      if (!pending) pending = setTimeout(() => { pending = null; last.current = performance.now(); setT(latest); }, wait);
    });
    return () => { off(); if (pending) clearTimeout(pending); };
  }, [throttleMs]);
  return t;
}

/** Element size (ResizeObserver). */
export function useSize<T extends HTMLElement>() {
  // A callback ref, so a new element (the window's content is rebuilt when the language changes) is measured too.
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, [el]);
  return [setEl, size] as const;
}
