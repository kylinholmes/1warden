import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectNativeBrowser } from './native-smoke-startup.mjs';

const children: ChildProcess[] = [];
const start = (source = 'setInterval(() => {}, 1000)') => {
  const child = spawn(process.execPath, ['-e', source], { windowsHide: true });
  children.push(child); return child;
};
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
});
const endpoint = 'http://127.0.0.1:54321';

describe('native smoke startup', () => {
  it('retains the connection error and owned process state when startup expires', async () => {
    const app = start();
    const error = Object.assign(new Error('fetch failed', { cause: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }) }), { code: 'CDP_CONNECT' });
    await expect(connectNativeBrowser({ app, browserURL: endpoint, timeoutMs: 40, retryMs: 5,
      connect: async () => { throw error; } })).rejects.toThrow(/pid=.*alive.*54321.*CDP_CONNECT.*ECONNREFUSED/s);
  });
  it('reports an app exit while a connection attempt is still pending', async () => {
    const app = start('process.exit(23)');
    await expect(connectNativeBrowser({ app, browserURL: endpoint, timeoutMs: 3000,
      connect: () => new Promise(() => {}) })).rejects.toThrow(/exited.*23/);
  });
  it('reports spawn failure without an unhandled child error', async () => {
    const app = spawn('onewarden-nonexistent-smoke-fixture', [], { windowsHide: true }); children.push(app);
    await expect(connectNativeBrowser({ app, browserURL: endpoint, timeoutMs: 3000,
      connect: () => new Promise(() => {}) })).rejects.toThrow(/ENOENT/);
  });
  it('enforces the startup deadline even if the CDP attempt never settles', async () => {
    const app = start();
    await expect(connectNativeBrowser({ app, browserURL: endpoint, timeoutMs: 40,
      connect: () => new Promise(() => {}) })).rejects.toThrow(/timed out/);
  });
  it('accepts a ready WebView after a transient connection failure', async () => {
    const app = start(); const browser = { disconnect() {} }; let attempts = 0;
    const result = await connectNativeBrowser({ app, browserURL: endpoint, timeoutMs: 3000, retryMs: 5,
      connect: async ({ browserURL, defaultViewport }: any) => {
        if (browserURL !== endpoint || defaultViewport !== null) throw Error('wrong connection options');
        if (++attempts === 1) throw Error('not listening yet');
        return browser;
      } });
    expect(result).toBe(browser);
  });
  it('does not turn the startup deadline into a lifetime CDP timeout', async () => {
    const app = start(); const options: unknown[] = [];
    await connectNativeBrowser({ app, browserURL: endpoint, timeoutMs: 3000,
      connect: async (value: unknown) => { options.push(value); return { disconnect() {} }; } });
    expect(options).toEqual([{ browserURL: endpoint, defaultViewport: null }]);
  });
  it('observes a late WebView in explicit diagnostic mode and reports its elapsed time', async () => {
    vi.stubEnv('ONEWARDEN_NATIVE_STARTUP_PROBE', '1'); vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const app = start(); const browser = { disconnect() {} }; let outcome: unknown;
    const pending = connectNativeBrowser({ app, browserURL: endpoint,
      connect: () => new Promise(resolve => setTimeout(() => resolve(browser), 12000)) })
      .then(value => { outcome = value; }, error => { outcome = error; });
    await vi.advanceTimersByTimeAsync(10000);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000); await pending;
    expect(outcome).toBe(browser);
    expect(log.mock.calls.flat().join(' ')).toMatch(/Native startup pending.*elapsedMs=10000.*attempts=1/s);
    expect(log.mock.calls.flat().join(' ')).toMatch(/Native DevTools connected.*elapsedMs=12000.*attempts=1/s);
  });
  it.each([
    { mode: '0', limit: 10000 },
    { mode: '1', limit: 60000 },
  ])('keeps startup bounded with diagnostic mode $mode', async ({ mode, limit }) => {
    vi.stubEnv('ONEWARDEN_NATIVE_STARTUP_PROBE', mode); vi.useFakeTimers();
    const app = start(); let failure: string | undefined;
    const pending = connectNativeBrowser({ app, browserURL: endpoint, connect: () => new Promise(() => {}) })
      .catch(error => { failure = error.message; });
    await vi.advanceTimersByTimeAsync(limit - 1);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(failure).toContain(`timed out after ${limit} ms`);
  });
});
