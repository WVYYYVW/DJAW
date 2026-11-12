// Paths of files dropped on the window. Electron 32+ removed File.path; webUtils.getPathForFile replaces it.
import { webUtils } from 'electron';

export function droppedPaths(dt: DataTransfer | null | undefined): string[] {
  if (!dt) return [];
  return [...dt.files].map(f => {
    try { return webUtils.getPathForFile(f); } catch { return (f as File & { path?: string }).path ?? ''; }
  }).filter(Boolean);
}
