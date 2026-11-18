// Where the app keeps its data, passed from the main process (see main.ts: additionalArguments).
import path from 'node:path';

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);

export const env = {
  userData: arg('djaw-user-data') ?? path.join(process.cwd(), '.djaw-data'),
  appRoot: arg('djaw-app-root') ?? process.cwd(),
  locale: arg('djaw-locale') ?? 'ja',
  platform: process.platform,
  /** The main executable (DJAW.exe / DJAW.app/Contents/MacOS/DJAW), which can run Node with ELECTRON_RUN_AS_NODE. */
  exe: arg('djaw-exe') ?? process.execPath,
};

export const dataDir = (...p: string[]) => path.join(env.userData, ...p);
export const buildDir = (...p: string[]) => path.join(env.appRoot, 'build', ...p);
// Native code reads the models from disk, so in the packaged app they are in app.asar.unpacked.
export const modelPath = (name: string) => path.join(env.appRoot.replace(/app\.asar$/, 'app.asar.unpacked'), 'models', name);
