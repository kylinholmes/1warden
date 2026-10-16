import { tauriAvailable } from '../capabilities';
import { createAppUpdater, type AppUpdater } from './controller';
import { checkManualUpdate, MANUAL_UPDATE_MESSAGE } from './manual';

declare const __PLATFORM__: 'desktop' | 'extension' | 'mobile' | undefined;
let runtime: Promise<AppUpdater | null> | null = null;

/** Only real main-window / popup entries own this singleton; previews never check. */
export function getAppUpdater(): Promise<AppUpdater | null> {
  runtime ??= (async () => {
    let currentVersion: () => Promise<string>;
    let message = MANUAL_UPDATE_MESSAGE;
    let delay = 10_000;
    if (typeof __PLATFORM__ !== 'undefined' && __PLATFORM__ === 'extension') {
      const { ext } = await import('../../extension/ext-api');
      if (!ext?.runtime?.id) return null;
      currentVersion = async () => ext.runtime.getManifest().version;
      message = '请通过浏览器扩展管理页或原安装渠道更新。手动加载的扩展需下载新包并重新加载。';
      // Popups are often closed within seconds, so check as soon as they open.
      delay = 0;
    } else {
      if (!tauriAvailable()) return null;
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      if (getCurrentWindow().label !== 'main') return null;
      if (typeof __PLATFORM__ !== 'undefined' && __PLATFORM__ === 'desktop') {
        const { desktopUpdater, desktopUpdatesSupported } = await import('./desktop');
        if (await desktopUpdatesSupported()) return desktopUpdater;
      }
      const { getVersion } = await import('@tauri-apps/api/app');
      currentVersion = getVersion;
      if (typeof __PLATFORM__ !== 'undefined' && __PLATFORM__ === 'mobile') {
        message = '请通过原安装渠道（应用商店、测试分发或安装包）检查并更新移动端。';
      }
    }
    return createAppUpdater({ currentVersion,
      check: async () => checkManualUpdate(await currentVersion(), message),
      restart: async () => {},
    }, delay);
  })();
  return runtime;
}

if (import.meta.hot) import.meta.hot.dispose(() => { void runtime?.then((updater) => updater?.dispose()); });
