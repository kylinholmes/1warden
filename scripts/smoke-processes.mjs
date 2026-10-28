import { spawnSync } from 'node:child_process';

// Track handles returned by our own spawn/launch calls, never image names or user PIDs.
const owned = new Set();
let installed = false;
export function ownSmokeProcess(child) {
  if (!child?.pid || owned.has(child)) return child;
  owned.add(child);
  child.once('exit', () => owned.delete(child));
  child.once('error', () => owned.delete(child));
  if (!installed) {
    installed = true;
    const cleanup = () => {
      for (const app of [...owned]) {
        try { stopSmokeProcess(app); }
        catch (error) { console.error(error); process.exitCode = 1; }
      }
    };
    process.once('exit', cleanup);
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
      process.once(signal, () => { cleanup(); process.exit(code); });
    }
  }
  return child;
}

export function stopSmokeProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Kill the tree while its root still exists, including hidden WebView/Edge windows.
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    if (result.status !== 0) {
      try { process.kill(child.pid, 0); } catch { return; }
      throw Error(`Could not clean owned smoke process ${child.pid}`);
    }
  } else child.kill('SIGKILL');
  owned.delete(child);
}

export async function launchSmokeBrowser(puppeteer, options) {
  const browser = await puppeteer.launch(options);
  ownSmokeProcess(browser.process());
  return browser;
}

export async function closeSmokeBrowser(browser, timeoutMs = 5000) {
  if (!browser) return;
  const child = browser.process();
  let timer;
  try {
    // Disposable Windows test profiles need no persistence at shutdown. Stop
    // the tree before CDP close can let its root exit ahead of hidden children.
    if (process.platform === 'win32') stopSmokeProcess(child);
    await Promise.race([
      Promise.resolve().then(() => child ? browser.close() : browser.disconnect()).catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    stopSmokeProcess(child);
    // Let Node reap a terminated Unix child before the runner returns.
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const done = () => { clearTimeout(wait); child.removeListener('exit', done); resolve(); };
        const wait = setTimeout(done, 1000); child.once('exit', done);
      });
    }
  }
}
