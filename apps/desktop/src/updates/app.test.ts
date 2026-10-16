import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ native: true, label: 'main', supported: true, extensionId: 'test',
  version: vi.fn(async () => '0.2.5'), manual: vi.fn(async () => null), desktop: { start: vi.fn() } }));
vi.mock('../capabilities', () => ({ tauriAvailable: () => fixture.native }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: fixture.label }) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: fixture.version }));
vi.mock('../../extension/ext-api', () => ({ ext: { runtime: {
  get id() { return fixture.extensionId; }, getManifest: () => ({ version: '0.2.5' }),
} } }));
vi.mock('./desktop', () => ({ desktopUpdater: fixture.desktop, desktopUpdatesSupported: async () => fixture.supported }));
vi.mock('./manual', () => ({ checkManualUpdate: fixture.manual, MANUAL_UPDATE_MESSAGE: '手动更新' }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  fixture.native = true; fixture.label = 'main'; fixture.supported = true; fixture.extensionId = 'test';
  vi.stubGlobal('__PLATFORM__', 'desktop');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('update runtime selection', () => {
  it('shares the native updater in supported desktop main windows', async () => {
    const { getAppUpdater } = await import('./app');
    expect(await getAppUpdater()).toBe(fixture.desktop);
    expect(await getAppUpdater()).toBe(fixture.desktop);
  });
  it.each(['desktop', 'mobile', 'extension'])('provides manual checking for %s when native installation is unavailable', async (platform) => {
    vi.stubGlobal('__PLATFORM__', platform); fixture.supported = false;
    const { getAppUpdater } = await import('./app');
    const updater = (await getAppUpdater())!;
    updater.start();
    await vi.advanceTimersByTimeAsync(platform === 'extension' ? 0 : 10_000);
    expect(fixture.manual).toHaveBeenCalledWith('0.2.5', expect.any(String));
    updater.dispose();
  });
  it.each(['preview', 'quick', 'extension-preview'])('does not start in %s', async (surface) => {
    if (surface === 'preview') fixture.native = false;
    if (surface === 'quick') fixture.label = 'quick';
    if (surface === 'extension-preview') { vi.stubGlobal('__PLATFORM__', 'extension'); fixture.extensionId = ''; }
    const { getAppUpdater } = await import('./app');
    expect(await getAppUpdater()).toBeNull();
    expect(fixture.manual).not.toHaveBeenCalled();
  });
});
