import type { VaultItem } from './model';

/** Only these presentation preferences may be cached outside the unlocked vault. */
export interface UserProfile { displayName: string; avatarDataUrl: string | null }
export const PROFILE_AVATAR_MAX_CHARS = 5600;
const SCHEMA = '1warden.profile';
const MARKER = '1warden:record-type';
const MAX_NOTE_BYTES = 7000;

export function validateProfile(value: unknown): UserProfile {
  if (!value || typeof value !== 'object') throw new Error('个人资料格式无效');
  const p = value as Record<string, unknown>;
  if (typeof p['displayName'] !== 'string' || p['displayName'].length > 80) throw new Error('显示名称不能超过 80 个字符');
  const avatar = p['avatarDataUrl'];
  if (avatar !== null && (typeof avatar !== 'string' || avatar.length > PROFILE_AVATAR_MAX_CHARS
    || !/^data:image\/(?:jpeg|png|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(avatar)
    || avatar.slice(avatar.indexOf(',') + 1).length < 4)) throw new Error('头像格式无效或图片过大，请重新选择图片');
  return { displayName: p['displayName'].trim(), avatarDataUrl: avatar as string | null };
}

export function isProfileItem(item: VaultItem): boolean {
  return item.type === 'secureNote' && item.customFields.some((f) => f.name === MARKER && f.value === 'user-profile');
}

function documentOf(item: VaultItem): Record<string, unknown> {
  if (!isProfileItem(item) || item.notesFailed || item.nameFailed) throw new Error('个人资料无法解密，暂不能覆盖');
  let doc: unknown;
  try { doc = JSON.parse(item.notes ?? ''); } catch { throw new Error('个人资料内容损坏，暂不能覆盖'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('个人资料格式无效');
  const value = doc as Record<string, unknown>;
  if (value['schema'] !== SCHEMA || value['version'] !== 1) throw new Error('个人资料版本暂不支持，请更新 1Warden 后重试');
  return value;
}

export function parseProfile(item: VaultItem): UserProfile { return validateProfile(documentOf(item)); }
export function profileRevision(item: VaultItem | undefined): string | null {
  return item ? JSON.stringify([item.id, item.updatedAt]) : null;
}
export function selectProfileItem(items: readonly VaultItem[]): VaultItem | undefined {
  return items.filter((i) => isProfileItem(i) && !i.deletedAt && !i.archivedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))[0];
}

export function buildProfileItem(value: UserProfile, old?: VaultItem): VaultItem {
  const profile = validateProfile(value);
  const previous = old ? documentOf(old) : {};
  if (old) validateProfile(previous);
  const notes = JSON.stringify({ ...previous, schema: SCHEMA, version: 1, ...profile });
  if (new TextEncoder().encode(notes).length > MAX_NOTE_BYTES) throw new Error('个人资料内容过大，请使用更小的头像');
  if (old) return { ...old, notes };
  return {
    id: '', type: 'secureNote', rawType: 2, name: '1Warden · Profile', nameFailed: false,
    notes, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: null, card: null, identity: null, secureNote: { type: 0 }, sshKey: null,
    customFields: [{ name: MARKER, value: 'user-profile', type: 0, linkedId: null }],
    passwordHistory: [], attachments: [],
  };
}
