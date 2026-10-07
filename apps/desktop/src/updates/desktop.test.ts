import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ desktop: true, native: true, label: 'main', supported: true,
  version: vi.fn(async () => '0.1.0'), check: vi.fn(async (): Promise<unknown> => null), invoke: vi.fn() }));
vi.mock('@coffer/ui', () => ({ get IS_DESKTOP() { return fixture.desktop; } }));
vi.mock('../capabilities', () => ({ tauriAvailable: () => fixture.native }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: fixture.label }) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: fixture.version }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: fixture.check }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.invoke }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  fixture.desktop = true; fixture.native = true; fixture.label = 'main'; fixture.supported = true;
  fixture.invoke.mockImplementation(async (command: string) => command === 'app_updates_supported' ? fixture.supported : undefined);
});
afterEach(() => { vi.useRealTimers(); });

describe('native updater boundary', () => {
  it.each([
    ['browser build', { desktop: false }],
    ['browser preview', { native: false }],
    ['quick window', { label: 'quick' }],
    ['unsupported native platform', { supported: false }],
  ])('does not read versions or call the updater in a %s', async (_label, settings) => {
    Object.assign(fixture, settings);
    const { desktopUpdater, startDesktopUpdater } = await import('./desktop');
    expect(await startDesktopUpdater()).toBe(false);
    await desktopUpdater.check();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(fixture.version).not.toHaveBeenCalled();
    expect(fixture.check).not.toHaveBeenCalled();
    expect(fixture.invoke).not.toHaveBeenCalledWith('restart_app');
    desktopUpdater.dispose();
  });

  it('uses the actual native support command once and starts only one main-window schedule', async () => {
    const { desktopUpdater, startDesktopUpdater } = await import('./desktop');
    expect(await Promise.all([startDesktopUpdater(), startDesktopUpdater()])).toEqual([true, true]);
    expect(fixture.invoke.mock.calls.filter(([command]) => command === 'app_updates_supported')).toEqual([['app_updates_supported']]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.check).toHaveBeenCalledTimes(1);
    expect(fixture.version).toHaveBeenCalledTimes(1);
    await desktopUpdater.restart();
    expect(fixture.invoke).not.toHaveBeenCalledWith('restart_app');
    desktopUpdater.dispose();
  });

  it('bounds both manifest and archive network requests while leaving native installation unbounded', async () => {
    const release = { version: '0.2.0', downloadAndInstall: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    fixture.check.mockResolvedValueOnce(release);
    const { desktopUpdater, startDesktopUpdater } = await import('./desktop');
    await startDesktopUpdater(); await desktopUpdater.check();
    expect(fixture.check).toHaveBeenCalledWith({ timeout: 15_000 });
    expect(release.downloadAndInstall).toHaveBeenCalledWith(expect.any(Function), { timeout: 300_000 });
    expect(release.close).toHaveBeenCalledTimes(1);
    expect(desktopUpdater.getSnapshot().phase).toBe('ready');
    desktopUpdater.dispose();
  });
});
