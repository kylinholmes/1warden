import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function errorDetails(error, depth = 0) {
  if (!error || depth > 4) return String(error);
  return [error.code, error.message ?? String(error), error.cause && `cause: ${errorDetails(error.cause, depth + 1)}`].filter(Boolean).join(': ');
}

/** Keep both native suites' 10-second budget, retaining the error at the failing boundary. */
export async function connectNativeBrowser({ app, connect, browserURL, timeoutMs = 10000, retryMs = 100 }) {
  console.log(`Native startup: pid=${app.pid ?? 'unavailable'} endpoint=${browserURL}`);
  for (const [name, stream] of [['stdout', app.stdout], ['stderr', app.stderr]]) {
    stream?.on('data', chunk => console.log(`native ${name}:`, chunk.toString()));
  }
  let spawnError, lastError, abandoned = false;
  const ended = new Promise(resolve => {
    app.once('error', error => { spawnError = error; resolve({ failure: 'spawn failed' }); });
    app.once('exit', (code, signal) => {
      console.log('native exit:', { code, signal, at: new Date().toISOString() });
      resolve({ failure: `exited with code=${code} signal=${signal}` });
    });
  });
  const deadline = Date.now() + timeoutMs;
  let timer;
  const expired = new Promise(resolve => { timer = setTimeout(() => resolve({ failure: `timed out after ${timeoutMs} ms` }), timeoutMs); });
  let reason = `timed out after ${timeoutMs} ms`;
  try {
    while (Date.now() < deadline) {
      if (app.exitCode !== null || app.signalCode !== null) { reason = `exited with code=${app.exitCode} signal=${app.signalCode}`; break; }
      const attempt = Promise.resolve().then(() => connect({ browserURL, defaultViewport: null, protocolTimeout: Math.max(1, deadline - Date.now()) }))
        .then(browser => {
          // A connection resolving after timeout must not keep the owned WebView attached.
          if (abandoned) Promise.resolve(browser.disconnect()).catch(() => {});
          return { browser };
        }, error => ({ error }));
      const result = await Promise.race([attempt, ended, expired]);
      if (result.browser) { console.log('Native DevTools connected'); return result.browser; }
      if (result.failure) { reason = result.failure; break; }
      lastError = result.error;
      const wait = await Promise.race([pause(retryMs), ended, expired]);
      if (wait?.failure) { reason = wait.failure; break; }
    }
    abandoned = true;
    if (process.platform === 'win32' && app.pid) {
      const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
        fileURLToPath(new URL('./windows-native-startup-probe.ps1', import.meta.url)), '-AppProcessId', String(app.pid)],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      console.log('Native startup process diagnostics:', probe.stdout?.trim() || probe.stderr?.trim() || errorDetails(probe.error));
    }
    const status = spawnError ? `spawn failed: ${errorDetails(spawnError)}`
      : app.exitCode === null && app.signalCode === null ? 'alive' : `exited code=${app.exitCode} signal=${app.signalCode}`;
    throw Error(`Native WebView ${reason}; pid=${app.pid ?? 'unavailable'} ${status}; endpoint=${browserURL}; last CDP error: ${lastError ? errorDetails(lastError) : 'connection attempt did not settle'}`);
  } finally {
    clearTimeout(timer);
  }
}
