import { host } from '@1warden/ui';
import type { AppUpdate } from './controller';

export const RELEASES_URL = 'https://github.com/kylinholmes/1warden/releases/latest';
export const MANIFEST_URL = `${RELEASES_URL}/download/latest.json`;
export const MANUAL_UPDATE_MESSAGE = '请下载新版本并按原安装方式更新。';

// Releases use stable x.y.z versions. Reject malformed data, compare numerically,
// and never turn a downgrade or an unknown version into an update prompt.
export function isNewerVersion(latest: unknown, installed: string): boolean {
  const parse = (value: unknown) => {
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw Error('Invalid release version');
    const parts = value.split('.').map(Number);
    if (!parts.every(Number.isSafeInteger)) throw Error('Invalid release version');
    return parts;
  };
  const next = parse(latest); const current = parse(installed);
  for (let i = 0; i < 3; i++) {
    if (next[i] !== current[i]) return next[i]! > current[i]!;
  }
  return false;
}

/** Public metadata only; this path never downloads or executes an update package. */
export async function checkManualUpdate(installed: string, message = MANUAL_UPDATE_MESSAGE): Promise<AppUpdate | null> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15_000);
  try {
    const response = await host().fetch(MANIFEST_URL, {
      signal: abort.signal, credentials: 'omit', cache: 'no-store',
    });
    if (!response.ok) throw Error('Update manifest unavailable');
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !('version' in data)) throw Error('Invalid update manifest');
    if (!isNewerVersion(data.version, installed)) return null;
    return { version: data.version as string, manual: message,
      downloadAndInstall: async () => { throw Error('Manual update required'); }, close: async () => {} };
  } finally { clearTimeout(timeout); }
}
