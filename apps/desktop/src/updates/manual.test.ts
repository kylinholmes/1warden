import { afterEach, describe, expect, it, vi } from 'vitest';
import { installHost, resetHost } from '@1warden/ui';
import { checkManualUpdate, isNewerVersion, MANIFEST_URL } from './manual';

afterEach(() => { resetHost(); vi.useRealTimers(); });
function transport(fetch: typeof globalThis.fetch) {
  installHost({ fetch, storage: { get: async () => null, set: async () => {}, remove: async () => {} } });
}

describe('cross-platform update notices', () => {
  it('compares stable versions numerically and rejects malformed metadata', () => {
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
    expect(isNewerVersion('0.2.5', '0.2.5')).toBe(false);
    expect(isNewerVersion('0.2.4', '0.2.5')).toBe(false);
    for (const value of [undefined, 123, 'v1.0.0', '1.0', '1.0.0-beta', '01.0.0', '99999999999999999999.0.0']) {
      expect(() => isNewerVersion(value, '0.1.0')).toThrow();
    }
  });

  it('reads anonymous public metadata and produces a notice with no executable download', async () => {
    const fetch = vi.fn(async () => Response.json({ version: '0.3.0', url: 'https://untrusted.test/setup.exe' }));
    transport(fetch);
    const update = await checkManualUpdate('0.2.5', '通过扩展管理页更新');
    expect(fetch).toHaveBeenCalledWith(MANIFEST_URL, expect.objectContaining({ credentials: 'omit', cache: 'no-store' }));
    expect(update).toMatchObject({ version: '0.3.0', manual: '通过扩展管理页更新' });
    await expect(update!.downloadAndInstall(() => {})).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not report equal or older releases as updates', async () => {
    transport(vi.fn(async () => Response.json({ version: '0.2.5' })));
    expect(await checkManualUpdate('0.2.5')).toBeNull();
    expect(await checkManualUpdate('0.3.0')).toBeNull();
  });

  it('reports errors instead of interpreting broken responses as up-to-date', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json({}));
    transport(fetch);
    await expect(checkManualUpdate('0.2.5')).rejects.toThrow();
    await expect(checkManualUpdate('0.2.5')).rejects.toThrow();
  });

  it('bounds a stalled metadata request', async () => {
    vi.useFakeTimers();
    transport(async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Error('timeout')), { once: true });
    }));
    const request = expect(checkManualUpdate('0.2.5')).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(15_000);
    await request;
    expect(vi.getTimerCount()).toBe(0);
  });
});
