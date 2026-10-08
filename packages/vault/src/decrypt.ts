import { decryptString, decryptBytes, DecryptError, sha256, utf8Encode, toBase64Url } from '@1warden/crypto';
import type { SymmetricKey } from '@1warden/crypto';
import type { CipherDto, FolderDto, CipherFieldDto } from '@1warden/api';
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

/** Stable across resource-only saves; changes when the underlying row changes.
 * Only an opaque digest crosses the draft boundary, never ciphertext or keys.
 */
async function rowId(kind: string, raw: unknown, index: number): Promise<string> {
  return `${kind}:${toBase64Url(await sha256(utf8Encode(JSON.stringify(raw))))}:${index}`;
}

interface DecodeContext {
  read(enc: unknown): Promise<Decrypted>;
  failures: string[];
}

function rows<T>(raw: T[] | null | undefined, ctx: DecodeContext): T[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) { ctx.failures.push('列表结构无法读取'); return []; }
  return raw.filter((row) => {
    if (row !== null && typeof row === 'object' && !Array.isArray(row)) return true;
    ctx.failures.push('列表字段无法读取');
    return false;
  });
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
async function decryptPasskeyKeyValue(raw: unknown, ctx: DecodeContext): Promise<string | null> {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!ENC_STRING.test(raw)) return raw;
  return (await ctx.read(raw)).value;
}

/**
 * 读出条目上的 passkey 列表。
 *
 * Unreadable credentials are omitted from usable views, retained in owner-only raw
 * state, and cause saves to fail. Reading one broken row never destroys it.
 */
async function decryptPasskeys(raw: unknown, ctx: DecodeContext): Promise<StoredPasskey[]> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) { ctx.failures.push('列表结构无法读取'); return []; }
  const out: StoredPasskey[] = [];
  for (const c of raw) {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) { ctx.failures.push('凭据无法读取'); continue; }
    const r = { ...c } as Record<string, unknown>;
    // Native Bitwarden encrypts metadata too. Accept our historical plaintext rows,
    // but a broken EncString must never be treated as a plaintext credential.
    for (const field of ['credentialId', 'keyType', 'keyAlgorithm', 'keyCurve', 'rpId', 'rpName',
      'userHandle', 'userName', 'userDisplayName', 'counter', 'discoverable']) {
      if (typeof r[field] === 'string' && ENC_STRING.test(r[field] as string)) {
        r[field] = (await ctx.read(r[field])).value;
      }
    }

    const credentialId = str(r.credentialId);
    if (credentialId === null) { ctx.failures.push('凭据 ID 无法读取'); continue; }
    const keyValue = await decryptPasskeyKeyValue(r.keyValue, ctx);
    if (keyValue === null) { ctx.failures.push('凭据密钥无法读取'); continue; }

    const p: StoredPasskey = {
      sourceId: await rowId('passkey', c, raw.indexOf(c)),
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

async function decryptLogin(raw: NonNullable<CipherDto['login']>, ctx: DecodeContext): Promise<LoginFields> {
  const out = emptyLogin();
  out.fido2Credentials = await decryptPasskeys(raw.fido2Credentials, ctx);
  out.username = (await ctx.read(raw.username)).value;
  out.password = (await ctx.read(raw.password)).value;
  out.totp = (await ctx.read(raw.totp)).value;
  // passwordRevisionDate 是**明文**（见 bitwarden-api-notes.md §2.2）
  out.passwordRevisionDate = raw.passwordRevisionDate ?? null;
  out.autofillOnPageLoad = raw.autofillOnPageLoad ?? null;

  const uris = rows(raw.uris, ctx);
  for (const u of uris) {
    const uri = (await ctx.read(u.uri)).value;
    out.uris.push({ sourceId: await rowId('uri', u, uris.indexOf(u)), uri: uri ?? '', match: typeof u.match === 'number' ? u.match : null });
  }
  return out;
}

/**
 * SSH 密钥的三个字段。
 *
 * ⚠️ 单独一个字段解不开**不该让整条条目打不开** —— 用户至少有公钥和指纹能用，
 * 而整条打不开他连「有这么一条」都看不见。所以逐个降级成 null。
 */
async function decryptSshKey(raw: NonNullable<CipherDto['sshKey']>, ctx: DecodeContext): Promise<SshKeyFields> {
  const out = emptySshKey();
  for (const f of ['privateKey', 'publicKey', 'fingerprint'] as const) {
    out[f] = (await ctx.read(raw[f])).value;
  }
  return out;
}

async function decryptCard(raw: NonNullable<CipherDto['card']>, ctx: DecodeContext): Promise<CardFields> {
  const out = emptyCard();
  for (const f of ['cardholderName', 'brand', 'number', 'expMonth', 'expYear', 'code'] as const) {
    out[f] = (await ctx.read(raw[f])).value;
  }
  return out;
}

async function decryptIdentity(raw: NonNullable<CipherDto['identity']>, ctx: DecodeContext): Promise<IdentityFields> {
  const out = emptyIdentity();
  for (const f of Object.keys(out) as Array<keyof IdentityFields>) {
    out[f] = (await ctx.read(raw[f])).value;
  }
  return out;
}

async function decryptFields(raw: CipherDto['fields'], ctx: DecodeContext): Promise<CustomField[]> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) { ctx.failures.push('列表结构无法读取'); return []; }
  const out: CustomField[] = [];
  for (const f of rows(raw as CipherFieldDto[], ctx)) {
    const name = (await ctx.read(f.name)).value;
    const value = (await ctx.read(f.value)).value;
    // 服务端在 type 缺失或不可解析时回退到 1（Hidden）—— 我们跟随，
    // 避免把本该隐藏的字段意外显示出来
    const type = (f.type === 0 || f.type === 1 || f.type === 2 || f.type === 3) ? f.type : 1;
    out.push({ sourceId: await rowId('field', f, raw.indexOf(f)), name: name ?? '', value: value ?? '', type, linkedId: f.linkedId ?? null, ...(f.type === type ? {} : { unsupportedType: f.type }) });
  }
  return out;
}

async function decryptHistory(
  raw: CipherDto['passwordHistory'], ctx: DecodeContext,
): Promise<PasswordHistoryEntry[]> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) { ctx.failures.push('列表结构无法读取'); return []; }
  const out: PasswordHistoryEntry[] = [];
  for (const h of rows(raw, ctx)) {
    const password = (await ctx.read(h.password)).value;
    // History passwords are required. A null/missing password is not an empty
    // valid history entry: dropping it without a failure would compact baseline
    // indexes and allow a subsequent save to select the wrong original row.
    if (password === null) {
      ctx.failures.push('历史密码无法读取');
      continue;
    }
    out.push({ sourceId: await rowId('history', h, raw.indexOf(h)), lastUsedDate: h.lastUsedDate, password });
  }
  return out;
}

async function decryptAttachments(raw: CipherDto['attachments'], ctx: DecodeContext): Promise<Attachment[]> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) { ctx.failures.push('列表结构无法读取'); return []; }
  const out: Attachment[] = [];
  for (const a of rows(raw, ctx)) {
    const fileName = await ctx.read(a.fileName);
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
  const failures: string[] = [];
  const ctx: DecodeContext = {
    failures,
    async read(enc) {
      const result = await tryDecrypt(enc, key);
      if (result.failed) failures.push('字段无法解密');
      return result;
    },
  };

  for (const field of ['login', 'card', 'identity', 'secureNote', 'sshKey'] as const) {
    const value = dto[field];
    if (value != null && (typeof value !== 'object' || Array.isArray(value))) failures.push(`${field} 无法读取`);
  }
  const name = await ctx.read(dto.name);
  const notes = await ctx.read(dto.notes);

  const item: VaultItem = {
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

    login: dto.login ? await decryptLogin(dto.login, ctx) : null,
    card: dto.card ? await decryptCard(dto.card, ctx) : null,
    identity: dto.identity ? await decryptIdentity(dto.identity, ctx) : null,
    secureNote: dto.secureNote ? { type: dto.secureNote.type ?? 0 } : null,
    sshKey: dto.sshKey ? await decryptSshKey(dto.sshKey, ctx) : null,

    customFields: await decryptFields(dto.fields, ctx),
    passwordHistory: await decryptHistory(dto.passwordHistory, ctx),
    attachments: await decryptAttachments(dto.attachments, ctx),
  };
  item.preservation = { source: structuredClone(dto), baseline: structuredClone(item), failures };
  return item;
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
