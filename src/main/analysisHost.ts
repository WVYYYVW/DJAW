// Starts the analysis processes (workers/analysis.child.ts) from the main process and connects each one to the
// renderer through a MessagePort.
//
// They are Node child processes (this app's executable with ELECTRON_RUN_AS_NODE). Started from the renderer, such a
// process crashes at once on the Mac (SIGTRAP: the renderer's helper app is no place to start one from); started from
// here it runs the same everywhere. (Electron's utility processes were tried too: they ignore the script they are
// given whenever the app was started with a file argument, such as a .djaw opened from the Explorer.)
//
// The renderer asks for a process by lane ('analysis' / 'stems') and a serial number; the port and the end of the
// process are reported back with that serial, so a late message about an old process is ignored.
import { app, ipcMain, MessageChannelMain, WebContents } from 'electron';
import { ChildProcess, fork } from 'node:child_process';
import path from 'node:path';

const procs = new Map<string, ChildProcess>();

export function setUpAnalysisHost() {
  ipcMain.on('analysis:spawn', (e, req: { lane: string; serial: number }) => {
    const sender: WebContents = e.sender;
    procs.get(req.lane)?.kill();
    const child = fork(path.join(__dirname, 'analysis.child.js'), [], {
      execPath: process.execPath,
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const forward = (stream: 'out' | 'err') => (d: Buffer) => {
      if (!sender.isDestroyed()) sender.send('analysis:log', { lane: req.lane, stream, text: String(d) });
    };
    child.stdout?.on('data', forward('out'));
    child.stderr?.on('data', forward('err'));
    // Renderer ⇄ port1 … port2 ⇄ this process ⇄ the child's IPC channel.
    const { port1, port2 } = new MessageChannelMain();
    port2.on('message', m => { if (child.connected) child.send(m.data as never); });
    port2.start();
    child.on('message', m => port2.postMessage(m));
    sender.postMessage('analysis:port', req, [port1]);
    let reported = false;
    const end = (why: string) => {
      if (reported) return;
      reported = true;
      port2.close();
      if (procs.get(req.lane) === child) procs.delete(req.lane);
      if (!sender.isDestroyed()) sender.send('analysis:exit', { ...req, code: why });
    };
    child.on('exit', (code, signal) => end(String(code ?? signal)));
    child.on('error', err => end(err.message));
    procs.set(req.lane, child);
  });
  ipcMain.on('analysis:kill', (_e, lane: string) => procs.get(lane)?.kill());
  app.on('will-quit', () => { for (const p of procs.values()) p.kill(); procs.clear(); });
}
