/**
 * 扩展侧的会话存储。
 *
 * ## 为什么需要它
 *
 * MV3 的 service worker 会在约 30 秒空闲后被浏览器杀掉。把解锁会话放在
 * 模块变量里，用户每半分钟就要重新解锁一次 —— 不可用。
 *
 * ## 为什么是 `ext.storage.session`
 *
 * 三个候选，只有一个合格：
 *
 * | API | 存在哪里 | 能用吗 |
 * |---|---|---|
 * | 模块变量 | service worker 内存 | ❌ worker 一被杀就没了 |
 * | `storage.local` | **磁盘** | ❌ 明文与密钥落盘，违反不变量 S1 |
 * | `storage.session` | 内存，浏览器重启即清 | ✅ |
 *
 * 而且 `storage.session` **默认对 content script 不可见**（只有受信任上下文
 * 能读）—— 页面里的脚本拿不到密钥。
 *
 * ⚠️ 这个模块**只**通过注入的 `StorageArea` 读写，不直接碰 `ext.*`。
 * 这样它能在 node 里测，也让「用的是哪个存储区」变成一个显式、可审查的选择，
 * 而不是散落在代码里的一行 `ext.storage.local`。
 */
import { ext } from './ext-api';
import { fromBase64, toBase64, type SymmetricKey } from '@coffer/crypto';
import type { AccountInfo, VaultFolder, VaultItem, VaultClientState } from '@coffer/vault';

/** 存储键。带前缀，避免与其他扩展数据撞名 */
const KEY = 'coffer.session';

/** `ext.storage` 里用得到的那几个方法 */
export interface StorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
}

/**
 * ⚠️ 存的是**恢复一个客户端所需要的全部东西**，不只是会话。
 *
 * 早先这里只有 `{account, userKey, items, folders}`，于是恢复出来的客户端
 * 缺了传输层（baseUrl + token）—— 读操作一切正常，**写操作全部失败**，
 * 还报「连不上服务器」这种让人去查网络的错。
 *
 * 形状直接复用 `VaultClientState`，而不是在这里再抄一份字段列表：
 * 抄一份就多一个会漂移的地方，而漂移的表现正是上面那种「一半能用」。
 */
export type UnlockedSession = VaultClientState;

/** 落进存储区的形状 —— 密钥是 base64 字符串，token 原样 */
interface StoredShape extends Omit<VaultClientState, 'userKey'> {
  userKey: { encKey: string; macKey: string };
}

const KEY_BYTES = 32;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 把存储里的记录还原成会话。任何一处不对就返回 null。
 *
 * ⚠️ **不抛异常**。存储里的东西可能是旧版本写的、也可能被改坏；在 service
 * worker 里抛出未捕获异常会让整个后台失效，而且极难排查。当作「没登录」
 * 让用户重新解锁，是唯一合理的降级。
 */
function revive(raw: unknown): UnlockedSession | null {
  if (!isObject(raw)) return null;

  const account = raw['account'];
  if (!isObject(account) || typeof account['serverUrl'] !== 'string' || typeof account['email'] !== 'string') {
    return null;
  }

  const userKey = raw['userKey'];
  if (!isObject(userKey) || typeof userKey['encKey'] !== 'string' || typeof userKey['macKey'] !== 'string') {
    return null;
  }

  let encKey: Uint8Array;
  let macKey: Uint8Array;
  try {
    encKey = fromBase64(userKey['encKey']);
    macKey = fromBase64(userKey['macKey']);
  } catch {
    return null;
  }
  // 长度不对说明数据被改过或版本不兼容 —— 拿它去解密只会得到
  // 一句语焉不详的失败，不如当作没登录
  if (encKey.length !== KEY_BYTES || macKey.length !== KEY_BYTES) return null;

  const items = raw['items'];
  const folders = raw['folders'];
  if (!Array.isArray(items) || !Array.isArray(folders)) return null;

  return {
    account: account as unknown as AccountInfo,
    userKey: { encKey, macKey },
    items: items as VaultItem[],
    folders: folders as VaultFolder[],
    // ⚠️ token 读不出来**不算致命** —— 装作没登录（返回 null）比整个会话作废好：
    // 用户重新解锁一次即可，而作废会让他连密码都看不到
    token: reviveToken(raw['token']),
  };
}

/** 令牌的宽松还原：认不出来就当没有。它只是个凭据，丢了重新解锁即可 */
function reviveToken(raw: unknown): VaultClientState['token'] {
  if (!isObject(raw)) return null;
  if (typeof raw['accessToken'] !== 'string' || raw['accessToken'].length === 0) return null;
  return raw as unknown as VaultClientState['token'];
}

export class SessionStore {
  constructor(private readonly area: StorageArea) {}

  async save(session: UnlockedSession): Promise<void> {
    const stored: StoredShape = {
      account: session.account,
      userKey: {
        encKey: toBase64(session.userKey.encKey),
        macKey: toBase64(session.userKey.macKey),
      },
      items: session.items,
      folders: session.folders,
      // ⚠️ 必须一起存。少了它，恢复出来的客户端读得了、**写不了**
      token: session.token,
    };
    await this.area.set({ [KEY]: stored });
  }

  async load(): Promise<UnlockedSession | null> {
    let got: Record<string, unknown>;
    try {
      got = await this.area.get(KEY);
    } catch {
      return null;
    }
    return revive(got[KEY]);
  }

  /** 锁定。存储区里不该再留下密钥的任何一段。 */
  async clear(): Promise<void> {
    try {
      await this.area.remove(KEY);
    } catch {
      // 存储坏了也要让「锁定」这个动作成功 —— 锁不上比清不掉严重得多
    }
  }
}
