import type { ProfileDeviceInput } from '@1warden/vault';
import type { ApplicationCapabilities } from './application/types';

/** Coarse, self-reported client information. No hardware fingerprint, IP or auth token. */
export function describeDevice(id: string, capabilities: ApplicationCapabilities, ua: string, touchPoints = 0): ProfileDeviceInput {
  const platform: ProfileDeviceInput['platform'] = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1) ? 'ios'
    : /Android/.test(ua) ? 'android' : /Windows/.test(ua) ? 'windows' : /Mac/.test(ua) ? 'macos' : /Linux/.test(ua) ? 'linux' : 'other';
  const client = capabilities.browser ? 'extension' : capabilities.native ? 'desktop' : 'mobile';
  const osName = { windows: 'Windows', macos: 'macOS', linux: 'Linux', ios: 'iOS / iPadOS', android: 'Android', other: '其他系统' }[platform];
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox / Zen' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '浏览器';
  return { id, platform, client, name: `${osName} · ${client === 'extension' ? browser : client === 'desktop' ? '桌面端' : '移动端'}` };
}
export function deviceIdentity(storage: Pick<Storage, 'getItem' | 'setItem'>, randomId: () => string): string {
  const key = '1warden.installation.v1';
  const saved = storage.getItem(key);
  if (saved && /^[a-zA-Z0-9-]{1,64}$/.test(saved)) return saved;
  const id = randomId(); storage.setItem(key, id); return id;
}
