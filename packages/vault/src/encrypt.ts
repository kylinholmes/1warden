import { encryptString } from '@coffer/crypto';
import type { SymmetricKey } from '@coffer/crypto';
import type { CipherWriteBody, CipherFido2CredentialDto } from '@coffer/api';
import type { StoredPasskey } from './passkey';
import type { VaultItem, ItemType } from './model';

export interface EncryptOptions {
  /** 条目独立密钥；`hasItemKey` 为 true 时必须提供，否则字段会用错密钥加密 */
  itemKey?: SymmetricKey;
  lastKnownRevisionDate?: string;
  /** 只在**确实要改归档状态**时才传 —— 见下方说明 */
  archivedDate?: string | null;
}

// ⚠️ 这里刻意**不处理** `encryptedFor`。
// 它由 @coffer/api 的 createCipher/updateCipher 从**已认证的 userId** 填入。
// 两层各司其职：vault 管加密，api 管身份。让这一层也加一份会造成重复，
// 而且可能填进一个与当前登录用户不符的值 —— 服务端会以 422 "Invalid user cipher"
// 拒绝，且很难看出为什么。

/** 领域类型 → 数字的 CipherType。unknown 用 -1 表示「不可保存」 */
const TYPE_TO_NUMBER: Record<ItemType, number> = {
  login: 1, secureNote: 2, card: 3, identity: 4, sshKey: 5, unknown: -1,
};

/** 只在值非 null 时加密 —— 保持「缺失」与「空串」的区别 */
async function enc(v: string | null | undefined, key: SymmetricKey): Promise<string | null> {
  if (v === null || v === undefined) return null;
  return encryptString(v, key);
}

/**
 * 一条 passkey → 线上形态。
 *
 * ⚠️ **只加密 `keyValue`**（PKCS#8 私钥），其余字段留明文。
 * 这是 Bitwarden 客户端的约定：元数据（rpId、用户名、计数）本来就不是秘密，
 * 整条一起加密的话官方客户端读不出来 —— 用户哪天换回官方客户端，passkey 就丢了。
 * 反过来一个都不加密，私钥就明文躺在服务器上。真正的秘密只有那把私钥。
 */
async function encryptPasskey(c: StoredPasskey, key: SymmetricKey): Promise<CipherFido2CredentialDto> {
  return {
    credentialId: c.credentialId,
    keyType: c.keyType,
    keyAlgorithm: c.keyAlgorithm,
    keyCurve: c.keyCurve,
    keyValue: await encryptString(c.keyValue, key),
    rpId: c.rpId,
    rpName: c.rpName ?? null,
    userHandle: c.userHandle ?? null,
    userName: c.userName ?? null,
    userDisplayName: c.userDisplayName ?? null,
    counter: c.counter,
    discoverable: c.discoverable,
    creationDate: c.creationDate,
  };
}

/**
 * 领域模型 → 写入用的 DTO。
 *
 * ⚠️ **两个必须遵守的约定**（写错会让用户丢数据，见 `bitwarden-api-notes.md` §3.3）：
 *   - `folderId` **必须总是发送**，省略会让服务端把条目移出文件夹
 *   - `archivedDate` **只在显式要求时发送** —— 它的语义是反的，`null` 意味着取消归档
 */
export async function encryptCipher(
  item: VaultItem, userKey: SymmetricKey, opts: EncryptOptions,
): Promise<CipherWriteBody> {
  // 名解不开的条目若原样保存，会把「无法解密」变成一个真实的密文，反而破坏数据。
  // 宁可拒绝保存并让调用方提示用户。
  if (item.nameFailed) {
    throw new Error('该条目的名称无法解密，拒绝保存以免写坏数据');
  }
  const numeric = TYPE_TO_NUMBER[item.type];
  if (numeric < 0) {
    throw new Error(`未知的条目类型（rawType=${item.rawType}），不支持编辑`);
  }

  const key = opts.itemKey ?? userKey;
  const body: CipherWriteBody = {
    type: numeric,
    name: await encryptString(item.name, key),
    notes: await enc(item.notes, key),
    // ⚠️ 必须总是发送：省略会让服务端把条目移出文件夹
    folderId: item.folderId,
    organizationId: null,
    favorite: item.favorite,
    reprompt: item.reprompt,
    fields: item.customFields.length === 0 ? null : await Promise.all(
      item.customFields.map(async (f) => ({
        name: await encryptString(f.name, key),
        value: await encryptString(f.value, key),
        type: f.type,
        linkedId: f.linkedId,
      })),
    ),
    passwordHistory: item.passwordHistory.length === 0 ? null : await Promise.all(
      item.passwordHistory.map(async (h) => ({
        lastUsedDate: h.lastUsedDate,
        password: await encryptString(h.password, key),
      })),
    ),
  };

  if (item.type === 'login' && item.login) {
    body.login = {
      username: await enc(item.login.username, key),
      password: await enc(item.login.password, key),
      totp: await enc(item.login.totp, key),
      passwordRevisionDate: item.login.passwordRevisionDate,
      uris: await Promise.all(item.login.uris.map(async (u) => ({
        uri: await encryptString(u.uri, key),
        match: u.match,
      }))),
      // ⚠️ **总是发送**，和 folderId 同理：用户删掉最后一条 passkey 时，
      // 不发这个字段就等于没删掉 —— 下次同步它会原样回来。
      fido2Credentials: await Promise.all(item.login.fido2Credentials.map((c) => encryptPasskey(c, key))),
    };
  } else if (item.type === 'card' && item.card) {
    body.card = {
      cardholderName: await enc(item.card.cardholderName, key),
      brand: await enc(item.card.brand, key),
      number: await enc(item.card.number, key),
      expMonth: await enc(item.card.expMonth, key),
      expYear: await enc(item.card.expYear, key),
      code: await enc(item.card.code, key),
    };
  } else if (item.type === 'identity' && item.identity) {
    const identity: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(item.identity)) identity[k] = await enc(v, key);
    body.identity = identity;
  } else if (item.type === 'secureNote') {
    // ⚠️ secureNote 只有 `{ type: 0 }` 一个合法值，而且**不被加密**
    body.secureNote = { type: item.secureNote?.type ?? 0 };
  }

  if (opts.lastKnownRevisionDate !== undefined) body.lastKnownRevisionDate = opts.lastKnownRevisionDate;
  // ⚠️ 只在显式要求时才带 archivedDate。语义是反的：Some(date) = 归档，
  // None = 取消归档。默认省略，否则普通保存会误把已归档条目恢复。
  if (opts.archivedDate !== undefined) body.archivedDate = opts.archivedDate;

  return body;
}
