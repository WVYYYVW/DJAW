// Finding a track saved with a path relative to the mix file (a mix moved together with its tracks, or opened on
// another computer). Names are tried in both Unicode forms (the Mac writes decomposed names, Windows composed ones).
import fs from 'node:fs';
import path from 'node:path';

export function resolveRelative(dir: string, relativePath: string): string | null {
  for (const form of ['NFC', 'NFD'] as const) {
    const p = path.resolve(dir, relativePath.normalize(form).split('/').join(path.sep));
    if (fs.existsSync(p)) return p;
  }
  return null;
}
