import { IS_DESKTOP } from '@1warden/ui';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { check } from '@tauri-apps/plugin-updater';
import { tauriAvailable } from '../capabilities';
import { createAppUpdater } from './controller';

let supported: Promise<boolean> | null = null;

/** The native command confirms both the compiled OS and the calling window. */
export function desktopUpdatesSupported(): Promise<boolean> {
  supported ??= (async () => {
    if (!IS_DESKTOP || !tauriAvailable() || getCurrentWindow().label !== 'main') return false;
    return await invoke<boolean>('app_updates_supported');
  })().catch(() => false);
  return supported;
}
async function requireSupport(): Promise<void> {
  if (!await desktopUpdatesSupported()) throw Error('当前环境不支持应用更新');
}

export const desktopUpdater = createAppUpdater({
  async currentVersion() { await requireSupport(); return getVersion(); },
  async check() {
    await requireSupport();
    const release = await check({ timeout: 15_000 });
    if (!release) return null;
    return {
      version: release.version,
      // The manifest timeout is not inherited by the archive download. This
      // timeout bounds its network request, not the subsequent native install.
      downloadAndInstall: (onEvent) => release.downloadAndInstall(onEvent, { timeout: 300_000 }),
      close: () => release.close(),
    };
  },
  async restart() { await requireSupport(); await invoke('restart_app'); },
});

export async function startDesktopUpdater(): Promise<boolean> {
  if (!await desktopUpdatesSupported()) return false;
  desktopUpdater.start();
  return true;
}

if (import.meta.hot) import.meta.hot.dispose(() => desktopUpdater.dispose());
