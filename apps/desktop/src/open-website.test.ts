import { afterEach, expect, it, vi } from 'vitest';
import { openWebsite } from './open-website';

const mocks = vi.hoisted(() => ({ native: true, invoke: vi.fn(), open: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('./capabilities', () => ({ tauriAvailable: () => mocks.native }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); mocks.native = true; });

it('opens a website with the native browser, never navigating the vault WebView', async () => {
  await openWebsite('https://example.com/security?passkeys=1');
  expect(mocks.invoke).toHaveBeenCalledWith('open_website', { url: 'https://example.com/security?passkeys=1' });
});

it.each(['javascript:alert(1)', 'file:///tmp/item', 'https://user:password@example.com', '--args', 'data:text/html,test'])(
  'rejects a non-website target %s before calling the system', async value => {
    await expect(openWebsite(value)).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  },
);

it('uses a separate browser tab without an opener in the extension', async () => {
  mocks.native = false; vi.stubGlobal('window', { open: mocks.open });
  await openWebsite('https://example.com');
  expect(mocks.open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
});

it('reports native launch failures', async () => {
  mocks.invoke.mockRejectedValueOnce(new Error('browser unavailable'));
  await expect(openWebsite('https://example.com')).rejects.toThrow('browser unavailable');
});
