import { IS_DESKTOP } from '@1warden/ui';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { check } from '@tauri-apps/plugin-updater';
import { tauriAvailable } from '../capabilities';
import { createAppUpdater } from './controller';
import { checkManualUpdate } from './manual';
type UpdatePlatform = 'macos' | 'windows' | null;
let platform: Promise<UpdatePlatform> | null = null;

/** The native command confirms both the compiled OS and the calling window. */
function updatePlatform(): Promise<UpdatePlatform> {
  platform ??= (async () => {
    if (!IS_DESKTOP || !tauriAvailable() || getCurrentWindow().label !== 'main') return null;
    const value = await invoke<UpdatePlatform>('app_update_platform');
    return value === 'macos' || value === 'windows' ? value : null;
  })().catch(() => null);
  return platform;
}
export async function desktopUpdatesSupported(): Promise<boolean> {
  return (await updatePlatform()) !== null;
}
async function requireSupport(): Promise<Exclude<UpdatePlatform, null>> {
  const value = await updatePlatform();
  if (!value) throw Error('当前环境不支持应用更新');
  return value;
}

export const desktopUpdater = createAppUpdater({
  async currentVersion() { await requireSupport(); return getVersion(); },
  async check() {
    const nativePlatform = await requireSupport();
    let release;
    try { release = await check({ timeout: 15_000 }); } catch (error) {
      // An old manifest may not contain this platform yet. Still tell the user
      // about a newer release, without bypassing native signature verification.
      const manual = await checkManualUpdate(await getVersion());
      if (manual) return manual;
      throw error;
    }
    if (!release) return null;
    const deferredInstall = nativePlatform === 'windows';
    return {
      version: release.version,
      // The manifest timeout is not inherited by the archive download. This
      // timeout bounds its network request, not the subsequent native install.
      downloadAndInstall: (onEvent) => deferredInstall
        ? release.download(onEvent, { timeout: 300_000 })
        : release.downloadAndInstall(onEvent, { timeout: 300_000 }),
      ...(deferredInstall ? { installOnRestart: () => release.install({ restartAfterInstall: true }) } : {}),
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
