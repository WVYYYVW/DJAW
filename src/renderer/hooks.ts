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
  useEffect(() => store.onClock(v => {
    const now = performance.now();
    if (now - last.current >= throttleMs) { last.current = now; setT(v); }
  }), [throttleMs]);
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
