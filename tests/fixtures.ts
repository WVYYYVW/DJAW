// Test data that is too big for git: set DJAW_FIXTURES to a folder with hyperflip.djaw etc. (tests skip without it).
import fs from 'node:fs';
import path from 'node:path';

export const fixtures = process.env.DJAW_FIXTURES ?? '/mnt/user-data/uploads';
export const fixture = (name: string) => {
  const p = path.join(fixtures, name);
  return fs.existsSync(p) ? p : null;
};
