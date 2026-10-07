import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppUpdater, type AppUpdate, type DownloadEvent, type UpdateBackend } from './controller';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function backend(overrides: Partial<UpdateBackend> = {}): UpdateBackend {
  return { currentVersion: vi.fn(async () => '0.1.0'), check: vi.fn(async () => null),
    restart: vi.fn(async () => {}), ...overrides };
}
function update(overrides: Partial<AppUpdate> = {}): AppUpdate {
  return { version: '0.2.0', downloadAndInstall: vi.fn(async () => {}), close: vi.fn(async () => {}), ...overrides };
}
afterEach(() => { vi.useRealTimers(); });

describe('desktop app update controller', () => {
  it('checks after a startup delay and every six hours, and releases its timers on disposal', async () => {
    vi.useFakeTimers();
    const service = backend();
    const updater = createAppUpdater(service);
    updater.start(); updater.start();
    await vi.advanceTimersByTimeAsync(9999);
    expect(service.check).not.toHaveBeenCalled();
    expect(updater.getSnapshot().currentVersion).toBe('0.1.0');
    await vi.advanceTimersByTimeAsync(1);
    expect(service.check).toHaveBeenCalledTimes(1);
    expect(updater.getSnapshot()).toMatchObject({ phase: 'idle', error: null });
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(service.check).toHaveBeenCalledTimes(2);
    updater.dispose();
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
    expect(service.check).toHaveBeenCalledTimes(2);
  });

  it('shares concurrent manual and scheduled checks rather than starting duplicate network work', async () => {
    const pending = deferred<AppUpdate | null>();
    const service = backend({ check: vi.fn(() => pending.promise) });
    const updater = createAppUpdater(service);
    const first = updater.check();
    const second = updater.check();
    expect(second).toBe(first);
    pending.resolve(null); await first;
    expect(service.check).toHaveBeenCalledTimes(1);
    expect(updater.getSnapshot()).toMatchObject({ phase: 'idle', currentVersion: '0.1.0', targetVersion: null, error: null });
    expect(updater.getSnapshot().checkedAt).not.toBeNull();
    updater.dispose();
  });

  it('keeps download-finished separate from installation-ready and never restarts automatically', async () => {
    vi.useFakeTimers();
    const installation = deferred<void>();
    const started = deferred<void>();
    let progress!: (event: DownloadEvent) => void;
    const release = update({ downloadAndInstall: vi.fn((listener) => {
      progress = listener; started.resolve(); return installation.promise;
    }) });
    const service = backend({ check: vi.fn(async () => release) });
    const updater = createAppUpdater(service); updater.start();
    const checking = updater.check(); await started.promise;
    progress({ event: 'Started', data: { contentLength: 100 } });
    progress({ event: 'Progress', data: { chunkLength: 30 } });
    expect(updater.getSnapshot()).toMatchObject({ phase: 'downloading', downloadedBytes: 30, totalBytes: 100, targetVersion: '0.2.0' });
    progress({ event: 'Finished' });
    expect(updater.getSnapshot().phase).toBe('installing');
    progress({ event: 'Progress', data: { chunkLength: 500 } });
    expect(updater.getSnapshot().downloadedBytes).toBe(30);
    installation.resolve(); await checking;
    expect(updater.getSnapshot()).toMatchObject({ phase: 'ready', currentVersion: '0.1.0', targetVersion: '0.2.0', error: null });
    expect(service.restart).not.toHaveBeenCalled();
    expect(release.close).toHaveBeenCalledTimes(1);
    await updater.check(); await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
    expect(service.check).toHaveBeenCalledTimes(1);
    expect(release.downloadAndInstall).toHaveBeenCalledTimes(1);
    progress({ event: 'Started', data: { contentLength: 500 } });
    expect(updater.getSnapshot()).toMatchObject({ phase: 'ready', totalBytes: 100 });
    updater.dispose();
  });

  it('tracks unknown download sizes without inventing a percentage or accepting invalid byte counts', async () => {
    const installation = deferred<void>();
    const started = deferred<void>();
    let progress!: (event: DownloadEvent) => void;
    const service = backend({ check: vi.fn(async () => update({ downloadAndInstall: async (listener) => {
      progress = listener; started.resolve(); await installation.promise;
    } })) });
    const updater = createAppUpdater(service);
    const checking = updater.check(); await started.promise;
    progress({ event: 'Started', data: {} });
    progress({ event: 'Progress', data: { chunkLength: 20 } });
    progress({ event: 'Progress', data: { chunkLength: Number.NaN } });
    progress({ event: 'Progress', data: { chunkLength: -10 } });
    expect(updater.getSnapshot()).toMatchObject({ phase: 'downloading', downloadedBytes: 20, totalBytes: null });
    progress({ event: 'Started', data: { contentLength: 0 } });
    expect(updater.getSnapshot().totalBytes).toBeNull();
    installation.resolve(); await checking; updater.dispose();
  });

  it('reports a failed check and permits a later successful retry without an update', async () => {
    const check = vi.fn().mockRejectedValueOnce(new Error('synthetic unavailable endpoint')).mockResolvedValueOnce(null);
    const updater = createAppUpdater(backend({ check }));
    await updater.check();
    expect(updater.getSnapshot().phase).toBe('error');
    expect(updater.getSnapshot().error).toBeTruthy();
    await updater.check();
    expect(updater.getSnapshot()).toMatchObject({ phase: 'idle', error: null, targetVersion: null });
    expect(check).toHaveBeenCalledTimes(2); updater.dispose();
  });

  it('does not advertise an installed bundle when verification fails after download, and closes each retry resource', async () => {
    let staleProgress!: (event: DownloadEvent) => void;
    const failed = update({ downloadAndInstall: vi.fn(async (listener) => {
      staleProgress = listener; listener({ event: 'Finished' }); throw Error('synthetic rejected bundle');
    }) });
    const secondInstall = deferred<void>();
    const secondStarted = deferred<void>();
    const good = update({ downloadAndInstall: vi.fn(async (listener) => {
      listener({ event: 'Started', data: { contentLength: 80 } }); secondStarted.resolve(); await secondInstall.promise;
    }) });
    const service = backend({ check: vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(good) });
    const updater = createAppUpdater(service); await updater.check();
    expect(updater.getSnapshot().phase).toBe('error');
    expect(failed.close).toHaveBeenCalledTimes(1);
    const retry = updater.check(); await secondStarted.promise;
    staleProgress({ event: 'Progress', data: { chunkLength: 500 } });
    expect(updater.getSnapshot()).toMatchObject({ phase: 'downloading', downloadedBytes: 0, totalBytes: 80, error: null });
    secondInstall.resolve(); await retry;
    expect(updater.getSnapshot().phase).toBe('ready');
    expect(good.close).toHaveBeenCalledTimes(1);
    expect(service.restart).not.toHaveBeenCalled(); updater.dispose();
  });

  it('discards and closes an update discovered after its owner is disposed', async () => {
    const pending = deferred<AppUpdate | null>();
    const entered = deferred<void>();
    const service = backend({ check: vi.fn(() => { entered.resolve(); return pending.promise; }) });
    const updater = createAppUpdater(service); const listener = vi.fn(); updater.subscribe(listener);
    const checking = updater.check(); await entered.promise;
    updater.dispose(); const before = updater.getSnapshot(); const notifications = listener.mock.calls.length;
    const release = update(); pending.resolve(release); await checking;
    expect(release.downloadAndInstall).not.toHaveBeenCalled();
    expect(release.close).toHaveBeenCalledTimes(1);
    expect(updater.getSnapshot()).toBe(before);
    expect(listener).toHaveBeenCalledTimes(notifications);
    await updater.check(); expect(service.check).toHaveBeenCalledTimes(1);
  });

  it('restarts only after the explicit ready action, deduplicates it and preserves the ready action after restart failure', async () => {
    const pending = deferred<void>();
    const service = backend({ check: vi.fn(async () => update()), restart: vi.fn(() => pending.promise) });
    const updater = createAppUpdater(service);
    await updater.restart(); expect(service.restart).not.toHaveBeenCalled();
    await updater.check(); expect(service.restart).not.toHaveBeenCalled();
    const first = updater.restart(); const second = updater.restart();
    expect(first).toBe(second);
    expect(updater.getSnapshot().phase).toBe('restarting');
    expect(service.restart).toHaveBeenCalledTimes(1);
    pending.reject(new Error('synthetic restart failure')); await first;
    expect(updater.getSnapshot()).toMatchObject({ phase: 'ready', targetVersion: '0.2.0' });
    expect(updater.getSnapshot().error).toBeTruthy();
    vi.mocked(service.restart).mockResolvedValueOnce(); await updater.restart();
    expect(service.restart).toHaveBeenCalledTimes(2); updater.dispose();
  });

  it('can retry reading the installed app version after a temporary native failure', async () => {
    const currentVersion = vi.fn().mockRejectedValueOnce(Error('synthetic native failure')).mockResolvedValueOnce('0.1.0');
    const service = backend({ currentVersion }); const updater = createAppUpdater(service);
    await updater.check(); expect(updater.getSnapshot().phase).toBe('error');
    expect(service.check).not.toHaveBeenCalled();
    await updater.check();
    expect(updater.getSnapshot()).toMatchObject({ phase: 'idle', currentVersion: '0.1.0', error: null });
    expect(service.check).toHaveBeenCalledTimes(1); updater.dispose();
  });
});
