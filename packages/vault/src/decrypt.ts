import { decryptString, decryptBytes, DecryptError } from '@coffer/crypto';
import type { SymmetricKey } from '@coffer/crypto';
import type { CipherDto, FolderDto, CipherFieldDto } from '@coffer/api';
import { cipherTypeToItemType, emptyLogin, emptyCard, emptyIdentity, emptySshKey } from './model';
import type {
  VaultItem, VaultFolder, LoginFields, CardFields, IdentityFields, SshKeyFields,
  CustomField, PasswordHistoryEntry, Attachment,
} from './model';
import type { StoredPasskey } from './passkey';

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

/** EncString 一定形如 `2.…`；base64url 里不可能出现 `.`，所以这个判别没有歧义 */
const ENC_STRING = /^\d+\./;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * 一条 passkey 的私钥。
 *
 * ⚠️ **两种形态都要认。**
 *
 * `keyValue` 是不是 EncString，取决于写它的那个客户端。用户从别的客户端同步过来的
 * 数据里可能两种都有。只认加密形态的话，明文那种会表现为「这条 passkey 打不开」，
 * 而失败点在解密而不是在 WebAuthn，排查时很难想到。
 */
async function decryptPasskeyKeyValue(raw: unknown, key: SymmetricKey): Promise<string | null> {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!ENC_STRING.test(raw)) return raw;
  return (await tryDecrypt(raw, key)).value;
}

/**
 * 读出条目上的 passkey 列表。
 *
 * ⚠️ 读不出来的凭据**直接丢掉**，而不是留一条空壳。
 * 缺私钥的凭据是**死凭据**：RP 那边还认得它，我们这边永远签不出名，
 * 用户点它只会得到一句语焉不详的失败。丢掉它，「这个站点没有可用的 passkey」
 * 就成为一个明确的结论 —— 用户可以据此重新注册一个。
 */
async function decryptPasskeys(raw: unknown, key: SymmetricKey): Promise<StoredPasskey[]> {
  if (!Array.isArray(raw)) return [];
  const out: StoredPasskey[] = [];
  for (const c of raw) {
    if (c === null || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;

    const credentialId = str(r.credentialId);
    if (credentialId === null) continue;
    const keyValue = await decryptPasskeyKeyValue(r.keyValue, key);
    if (keyValue === null) continue;

    const p: StoredPasskey = {
      credentialId,
      keyType: 'public-key',
      keyAlgorithm: 'ECDSA',
      keyCurve: 'P-256',
      keyValue,
      rpId: str(r.rpId) ?? '',
      counter: str(r.counter) ?? '0',
      discoverable: str(r.discoverable) ?? 'true',
      creationDate: str(r.creationDate) ?? '',
    };
    // 只在有值时写入 —— exactOptionalPropertyTypes 下不能赋 undefined
    const rpName = str(r.rpName);
    if (rpName !== null) p.rpName = rpName;
    const userHandle = str(r.userHandle);
    if (userHandle !== null) p.userHandle = userHandle;
    const userName = str(r.userName);
    if (userName !== null) p.userName = userName;
    const userDisplayName = str(r.userDisplayName);
    if (userDisplayName !== null) p.userDisplayName = userDisplayName;

    out.push(p);
  }
  return out;
}

async function decryptLogin(raw: NonNullable<CipherDto['login']>, key: SymmetricKey): Promise<LoginFields> {
  const out = emptyLogin();
  out.fido2Credentials = await decryptPasskeys(raw.fido2Credentials, key);
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

/**
 * SSH 密钥的三个字段。
 *
 * ⚠️ 单独一个字段解不开**不该让整条条目打不开** —— 用户至少有公钥和指纹能用，
 * 而整条打不开他连「有这么一条」都看不见。所以逐个降级成 null。
 */
async function decryptSshKey(raw: NonNullable<CipherDto['sshKey']>, key: SymmetricKey): Promise<SshKeyFields> {
  const out = emptySshKey();
  for (const f of ['privateKey', 'publicKey', 'fingerprint'] as const) {
    out[f] = (await tryDecrypt(raw[f], key)).value;
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
      sizeName: typeof a.sizeName === 'string' ? a.sizeName : '',
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
  const { key } = await resolveItemKey(dto, userKey);

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
    wrappedKey: dto.key ?? null,

    login: dto.login ? await decryptLogin(dto.login, key) : null,
    card: dto.card ? await decryptCard(dto.card, key) : null,
    identity: dto.identity ? await decryptIdentity(dto.identity, key) : null,
    secureNote: dto.secureNote ? { type: dto.secureNote.type ?? 0 } : null,
    sshKey: dto.sshKey ? await decryptSshKey(dto.sshKey, key) : null,

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
