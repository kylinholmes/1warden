import { decryptString, decryptBytes, DecryptError } from '@coffer/crypto';
import type { SymmetricKey } from '@coffer/crypto';
import type { CipherDto, FolderDto, CipherFieldDto } from '@coffer/api';
import { cipherTypeToItemType, emptyLogin, emptyCard, emptyIdentity } from './model';
import type {
  VaultItem, VaultFolder, LoginFields, CardFields, IdentityFields,
  CustomField, PasswordHistoryEntry, Attachment,
} from './model';

interface Decrypted { value: string | null; failed: boolean }

/**
 * 解一个字段。**失败不抛错** —— 返回 null 并标记失败。
 *
 * ⚠️ 按字段降级是刻意的：用户的密码可能还好好的，只是某个自定义字段坏了。
 * 一个字段解不开就让整条条目（甚至整个保险库）不可用，是比坏字段更糟的结果。
 *
 * 区分三种「空」：
 *   null / undefined  → 值不存在（failed=false）
 *   ''                → 合法的空串（failed=false）
 *   解不开 / 畸形      → failed=true
 */
async function tryDecrypt(enc: unknown, key: SymmetricKey): Promise<Decrypted> {
  if (enc === null || enc === undefined) return { value: null, failed: false };
  if (typeof enc !== 'string') return { value: null, failed: true };
  if (enc.length === 0) return { value: '', failed: false };
  try {
    return { value: await decryptString(enc, key), failed: false };
  } catch (e) {
    if (e instanceof DecryptError) return { value: null, failed: true };
    throw e;
  }
}

/**
 * 取出该条目应该使用的密钥。
 *
 * ⚠️ `cipher.key` 存在时，它是一条**用用户密钥包装过的独立 64 字节密钥**，
 * 该条目的**所有**字段都用它解密 —— 不是用用户密钥。
 * 用错了表现为「整条条目解不开」，而且只有带独立密钥的条目才会触发。
 *
 * 64 字节 = 32 enc + 32 mac，布局与用户密钥一致。
 */
export async function resolveItemKey(
  dto: CipherDto, userKey: SymmetricKey,
): Promise<{ key: SymmetricKey; hasItemKey: boolean }> {
  if (dto.key === null || dto.key === undefined || dto.key === '') {
    return { key: userKey, hasItemKey: false };
  }
  const raw = await decryptBytes(dto.key, userKey);
  if (raw.length !== 64) {
    throw new DecryptError('malformed', `条目密钥长度应为 64，实际 ${raw.length}`);
  }
  return {
    key: { encKey: raw.slice(0, 32), macKey: raw.slice(32, 64) },
    hasItemKey: true,
  };
}

async function decryptLogin(raw: NonNullable<CipherDto['login']>, key: SymmetricKey): Promise<LoginFields> {
  const out = emptyLogin();
  out.username = (await tryDecrypt(raw.username, key)).value;
  out.password = (await tryDecrypt(raw.password, key)).value;
  out.totp = (await tryDecrypt(raw.totp, key)).value;
  // passwordRevisionDate 是**明文**（见 bitwarden-api-notes.md §2.2）
  out.passwordRevisionDate = raw.passwordRevisionDate ?? null;

  const uris = Array.isArray(raw.uris) ? raw.uris : [];
  for (const u of uris) {
    const uri = (await tryDecrypt(u.uri, key)).value;
    out.uris.push({ uri: uri ?? '', match: typeof u.match === 'number' ? u.match : null });
  }
  return out;
}

async function decryptCard(raw: NonNullable<CipherDto['card']>, key: SymmetricKey): Promise<CardFields> {
  const out = emptyCard();
  for (const f of ['cardholderName', 'brand', 'number', 'expMonth', 'expYear', 'code'] as const) {
    out[f] = (await tryDecrypt(raw[f], key)).value;
  }
  return out;
}

async function decryptIdentity(raw: NonNullable<CipherDto['identity']>, key: SymmetricKey): Promise<IdentityFields> {
  const out = emptyIdentity();
  for (const f of Object.keys(out) as Array<keyof IdentityFields>) {
    out[f] = (await tryDecrypt(raw[f], key)).value;
  }
  return out;
}

async function decryptFields(raw: CipherDto['fields'], key: SymmetricKey): Promise<CustomField[]> {
  if (!Array.isArray(raw)) return [];
  const out: CustomField[] = [];
  for (const f of raw as CipherFieldDto[]) {
    const name = (await tryDecrypt(f.name, key)).value;
    const value = (await tryDecrypt(f.value, key)).value;
    // 服务端在 type 缺失或不可解析时回退到 1（Hidden）—— 我们跟随，
    // 避免把本该隐藏的字段意外显示出来
    const type = (f.type === 0 || f.type === 1 || f.type === 2 || f.type === 3) ? f.type : 1;
    out.push({ name: name ?? '', value: value ?? '', type, linkedId: f.linkedId ?? null });
  }
  return out;
}

async function decryptHistory(
  raw: CipherDto['passwordHistory'], key: SymmetricKey,
): Promise<PasswordHistoryEntry[]> {
  if (!Array.isArray(raw)) return [];
  const out: PasswordHistoryEntry[] = [];
  for (const h of raw) {
    const password = (await tryDecrypt(h.password, key)).value;
    // 解不开的历史密码丢掉而不是留个空位 —— 空位对用户没有意义
    if (password !== null) out.push({ lastUsedDate: h.lastUsedDate, password });
  }
  return out;
}

async function decryptAttachments(raw: CipherDto['attachments'], key: SymmetricKey): Promise<Attachment[]> {
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const a of raw) {
    const fileName = await tryDecrypt(a.fileName, key);
    out.push({
      id: a.id,
      fileName: fileName.value ?? '',
      size: a.size,
      url: a.url,
      // 附件密钥保持**密文** —— 解密它需要单独的路径（附件的 64 字节密钥）
      key: a.key ?? null,
      failed: fileName.failed,
    });
  }
  return out;
}

/**
 * 把线上的 CipherDto 变成解密后的 VaultItem。
 *
 * 这条路径**永不抛错**（除非条目密钥本身坏了）—— 单个字段失败会降级并标记。
 */
export async function decryptCipher(dto: CipherDto, userKey: SymmetricKey): Promise<VaultItem> {
  const { key, hasItemKey } = await resolveItemKey(dto, userKey);

  const name = await tryDecrypt(dto.name, key);
  const notes = await tryDecrypt(dto.notes, key);

  return {
    id: dto.id,
    type: cipherTypeToItemType(dto.type),
    rawType: dto.type,
    name: name.value ?? '',
    nameFailed: name.failed,
    notes: notes.value,
    notesFailed: notes.failed,
    folderId: dto.folderId ?? null,
    favorite: dto.favorite === true,
    reprompt: typeof dto.reprompt === 'number' ? dto.reprompt : 0,
    createdAt: dto.creationDate,
    updatedAt: dto.revisionDate,
    deletedAt: dto.deletedDate ?? null,
    archivedAt: dto.archivedDate ?? null,
    hasItemKey,

    login: dto.login ? await decryptLogin(dto.login, key) : null,
    card: dto.card ? await decryptCard(dto.card, key) : null,
    identity: dto.identity ? await decryptIdentity(dto.identity, key) : null,
    secureNote: dto.secureNote ? { type: dto.secureNote.type ?? 0 } : null,

    customFields: await decryptFields(dto.fields, key),
    passwordHistory: await decryptHistory(dto.passwordHistory, key),
    attachments: await decryptAttachments(dto.attachments, key),
  };
}

export async function decryptFolder(dto: FolderDto, userKey: SymmetricKey): Promise<VaultFolder> {
  const name = await tryDecrypt(dto.name, userKey);
  return {
    id: dto.id,
    name: name.value ?? '',
    nameFailed: name.failed,
    updatedAt: dto.revisionDate,
  };
}
