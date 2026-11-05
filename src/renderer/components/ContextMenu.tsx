import React, { useEffect, useState } from 'react';

export interface MenuItem {
  label?: string;
  action?: () => void;
  enabled?: boolean;
  checked?: boolean;
  submenu?: MenuItem[];
  separator?: boolean;
}

type Open = { x: number; y: number; items: MenuItem[] } | null;
let setOpenGlobal: ((o: Open) => void) | null = null;

/** Shows a context menu at the mouse position. */
export function showContextMenu(e: { clientX: number; clientY: number }, items: MenuItem[]) {
  setOpenGlobal?.({ x: e.clientX, y: e.clientY, items });
}

function Items({ items, close }: { items: MenuItem[]; close: () => void }) {
  const [sub, setSub] = useState<number | null>(null);
  return (
    <>
      {items.map((it, k) => it.separator ? <div key={k} className="cm-sep" /> : (
        <div key={k}
          className={'cm-item' + (it.enabled === false ? ' disabled' : '') + (it.submenu ? ' has-sub' : '')}
          onMouseEnter={() => setSub(it.submenu ? k : null)}
          onClick={() => { if (it.enabled === false || it.submenu) return; close(); it.action?.(); }}>
          <span className="cm-check">{it.checked ? '✓' : ''}</span>
          <span className="cm-label">{it.label}</span>
          {it.submenu && <span className="cm-arrow">›</span>}
          {it.submenu && sub === k && <div className="cm-menu cm-submenu"><Items items={it.submenu} close={close} /></div>}
        </div>
      ))}
    </>
  );
}

export function ContextMenuHost() {
  const [open, setOpen] = useState<Open>(null);
  useEffect(() => { setOpenGlobal = setOpen; return () => { setOpenGlobal = null; }; }, []);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', key);
    window.addEventListener('blur', close);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('blur', close); };
  }, [open]);
  if (!open) return null;
  const maxX = window.innerWidth - 280, maxY = window.innerHeight - Math.min(window.innerHeight * 0.8, open.items.length * 26 + 12);
  return (
    <div className="cm-backdrop" onMouseDown={() => setOpen(null)} onContextMenu={e => { e.preventDefault(); setOpen(null); }}>
      <div className="cm-menu" style={{ left: Math.min(open.x, maxX), top: Math.max(4, Math.min(open.y, maxY)) }} onMouseDown={e => e.stopPropagation()}>
        <Items items={open.items} close={() => setOpen(null)} />
      </div>
    </div>
  );
}
