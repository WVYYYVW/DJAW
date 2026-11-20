// Small line icons for the toolbar and panels (16 × 16, drawn with the current text colour).
import React from 'react';

const paths: Record<string, React.ReactNode> = {
  play: <path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none" />,
  pause: <><rect x="4.5" y="3.5" width="2.5" height="9" rx=".5" fill="currentColor" stroke="none" /><rect x="9" y="3.5" width="2.5" height="9" rx=".5" fill="currentColor" stroke="none" /></>,
  toStart: <><path d="M4 3.5v9" /><path d="M12.5 3.5v9L6 8z" fill="currentColor" stroke="none" /></>,
  plus: <path d="M8 3v10M3 8h10" />,
  export: <><path d="M8 10V2.5M5 5.5 8 2.5l3 3" /><path d="M3 9.5v3.5h10V9.5" /></>,
  film: <><rect x="2.5" y="3.5" width="11" height="9" rx="1.2" /><path d="M5 3.5v9M11 3.5v9M2.5 6.5H5M2.5 9.5H5M11 6.5h2.5M11 9.5h2.5" /></>,
  list: <path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01" />,
  pads: <><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></>,
  wave: <path d="M1.5 8h1.5M4.5 5v6M7 3v10M9.5 5.5v5M12 6.5v3M14.5 8h0" />,
  browser: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M6.2 2.5v11" /></>,
  panel: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 9.5h12" /></>,
  follow: <><path d="M3 8h8M8 5l3 3-3 3" /><path d="M13.5 3v10" /></>,
  zoomIn: <><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5M5 7h4M7 5v4" /></>,
  zoomOut: <><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5M5 7h4" /></>,
  fit: <path d="M2.5 8h11M5 5.5 2.5 8 5 10.5M11 5.5l2.5 2.5L11 10.5" />,
  folder: <path d="M2 4.5c0-.6.4-1 1-1h3l1.3 1.5H13c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" />,
  music: <><path d="M6 12V4l7-1.5V10" /><circle cx="4.5" cy="12" r="1.5" /><circle cx="11.5" cy="10.5" r="1.5" /></>,
  sparkle: <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  chevronDown: <path d="M4 6l4 4 4-4" />,
  chevronUp: <path d="M4 10l4-4 4 4" />,
  maximize: <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />,
  restore: <path d="M13 3 9.5 6.5M9.5 3v3.5H13M3 13l3.5-3.5M6.5 13V9.5H3" />,
  loop: <><path d="M3 8a4 4 0 0 1 4-4h5M10 2l2 2-2 2" /><path d="M13 8a4 4 0 0 1-4 4H4M6 14l-2-2 2-2" /></>,
  cue: <g transform="translate(0.75 0)"><path d="M4 2.5v11" /><path d="M4 3h7l-2 2.5L11 8H4" /></g>,
  fx: <path transform="translate(0.25 -0.5)" d="M3 13c2-6 3-9 5-9M3.5 7.5h5M8.5 8.5l4 4.5M12.5 8.5l-4 4.5" />,
  deck: <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="1.3" /></>,
  track: <><rect x="2.5" y="5" width="11" height="6" rx="1.2" /><path d="M5 8h1M7 7v2M9 6.5v3M11 7.5v1" /></>,
  transition: <path d="M2 11.5c3 0 4-7 6-7M8 11.5c2 0 3-7 6-7" />,
  mix: <path d="M3 3v10M8 3v10M13 3v10M1.5 6h3M6.5 10h3M11.5 7h3" />,
  rec: <circle cx="8" cy="8" r="4" fill="currentColor" stroke="none" />,
  undo: <path transform="translate(-1 0.25)" d="M5 6H10a3 3 0 0 1 0 6H6M5 6l2.5-2.5M5 6l2.5 2.5" />,
  redo: <path transform="translate(1 0.25)" d="M11 6H6a3 3 0 0 0 0 6h4M11 6 8.5 3.5M11 6 8.5 8.5" />,
  keyboard: <><rect x="1.5" y="4" width="13" height="8" rx="1.2" /><path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.5h6" /></>,
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={'icon' + (className ? ' ' + className : '')} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
