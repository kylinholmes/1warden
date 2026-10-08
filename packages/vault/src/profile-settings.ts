import type { VaultItem } from './model';
import { buildProfileItem, parseProfile } from './profile';

export interface ProfilePreferences { mode: 'system' | 'light' | 'dark'; palette: string; showTypes: boolean }
export interface ProfileDeviceInput {
  id: string;
  name: string;
  platform: 'windows' | 'macos' | 'linux' | 'ios' | 'android' | 'other';
  client: 'desktop' | 'extension' | 'mobile';
}
export interface ProfileDevice extends ProfileDeviceInput { firstSeen: number; lastSeen: number }
export interface ProfileSettings { preferences: ProfilePreferences | null; devices: ProfileDevice[] }
export const DEFAULT_PROFILE_PREFERENCES: ProfilePreferences = { mode: 'system', palette: 'original', showTypes: true };
export const MAX_PROFILE_DEVICES = 10;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (): never => { throw new Error('同步设置或设备记录格式无效，请更新 1Warden 或检查个人资料记录'); };

/** Allow-list only. Never let arbitrary note fields enter a presentation cache. */
export function validatePreferences(value: unknown): ProfilePreferences {
  if (!object(value) || typeof value['mode'] !== 'string' || !['system', 'light', 'dark'].includes(value['mode'])
    || typeof value['palette'] !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(value['palette'])
    || typeof value['showTypes'] !== 'boolean') return fail();
  return { mode: value['mode'] as ProfilePreferences['mode'], palette: value['palette'], showTypes: value['showTypes'] };
}
export function validateDevice(value: unknown): ProfileDeviceInput {
  if (!object(value) || typeof value['id'] !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(value['id'])
    || typeof value['name'] !== 'string' || !value['name'].trim() || value['name'].length > 48
    || /[\u0000-\u001f\u007f]/.test(value['name'])
    || typeof value['platform'] !== 'string' || !['windows', 'macos', 'linux', 'ios', 'android', 'other'].includes(value['platform'])
    || typeof value['client'] !== 'string' || !['desktop', 'extension', 'mobile'].includes(value['client'])) return fail();
  return { id: value['id'], name: value['name'].trim(), platform: value['platform'] as ProfileDeviceInput['platform'], client: value['client'] as ProfileDeviceInput['client'] };
}
function document(old?: VaultItem): { item: VaultItem; doc: Record<string, unknown>; settings: Record<string, unknown> } {
  const item = old ? buildProfileItem(parseProfile(old), old) : buildProfileItem({ displayName: '', avatarDataUrl: null });
  const doc = JSON.parse(item.notes!) as Record<string, unknown>;
  const settings = doc['settings'] ?? { version: 1 };
  if (!object(settings) || settings['version'] !== 1) throw new Error('同步设置版本暂不支持，请更新 1Warden 后重试');
  return { item, doc, settings };
}
export function parseProfileSettings(old: VaultItem): ProfileSettings {
  const { settings } = document(old);
  const preferences = settings['preferences'] == null ? null : validatePreferences(settings['preferences']);
  const raw = settings['devices'] ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_PROFILE_DEVICES) return fail();
  const devices = raw.map((entry): ProfileDevice => {
    const device = validateDevice(entry);
    const { firstSeen, lastSeen } = entry as Record<string, unknown>;
    if (typeof firstSeen !== 'number' || !Number.isSafeInteger(firstSeen) || firstSeen < 0
      || typeof lastSeen !== 'number' || !Number.isSafeInteger(lastSeen) || lastSeen < firstSeen || lastSeen > 8_640_000_000_000_000) return fail();
    return { ...device, firstSeen, lastSeen };
  });
  if (new Set(devices.map(d => d.id)).size !== devices.length) return fail();
  return { preferences, devices: devices.sort((a, b) => b.lastSeen - a.lastSeen || a.id.localeCompare(b.id)) };
}
export function buildPreferencesItem(value: ProfilePreferences, old?: VaultItem): VaultItem {
  const existing = old ? parseProfileSettings(old) : null;
  const { item, doc, settings } = document(old);
  const previous = object(settings['preferences']) ? settings['preferences'] : {};
  const updated: Record<string, unknown> = { ...settings, preferences: { ...previous, ...validatePreferences(value) } };
  if (existing?.devices.length) {
    updated['devices'] = existing.devices.map(d => (settings['devices'] as Record<string, unknown>[]).find(raw => raw['id'] === d.id)!);
  }
  while (true) {
    const notes = JSON.stringify({ ...doc, settings: updated });
    const devices = updated['devices'] as unknown[] | undefined;
    if (new TextEncoder().encode(notes).length <= 7000 || !devices || devices.length <= 1) return buildProfileItem(parseProfile(item), { ...item, notes });
    devices.pop();
  }
}

/** Device history is self-reported usage, not an authoritative session/revocation API. */
export function buildDeviceItem(value: ProfileDeviceInput, now: number, old?: VaultItem): VaultItem | undefined {
  const device = validateDevice(value);
  const previous = old ? parseProfileSettings(old).devices : [];
  const existing = previous.find(d => d.id === device.id);
  if (!Number.isSafeInteger(now) || now < 0) return fail();
  if (existing && now < existing.lastSeen + 60 * 60 * 1000
    && device.name === existing.name && device.platform === existing.platform && device.client === existing.client) return;
  const { item, doc, settings } = document(old);
  // Retain unknown per-device fields for forwards-compatible clients.
  const raw = (settings['devices'] ?? []) as Record<string, unknown>[];
  const devices = [
    { ...raw.find(d => d['id'] === device.id), ...device, firstSeen: existing?.firstSeen ?? now, lastSeen: Math.max(now, existing?.lastSeen ?? 0) },
    ...previous.filter(d => d.id !== device.id).map(d => raw.find(r => r['id'] === d.id)!),
  ].slice(0, MAX_PROFILE_DEVICES);
  // A legacy large avatar may leave room for fewer devices. Evict oldest history only;
  // never truncate the avatar, settings or unknown account fields to make room.
  while (true) {
    const notes = JSON.stringify({ ...doc, settings: { ...settings, devices } });
    if (new TextEncoder().encode(notes).length <= 7000 || devices.length <= 1) {
      return buildProfileItem(parseProfile(item), { ...item, notes });
    }
    devices.pop();
  }
}
