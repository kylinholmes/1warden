import { useLocalStore, useStoreField } from '@1warden/state/react';
import { useEffect } from 'react';
import { host } from './host';

/**
 * **记住的账户** —— 两端共用这一份。
 *
 * ## 它解决什么
 *
 * 这是个**自托管**客户端，一个人手上常常不止一个地址（自己的机器、公司的、
 * 朋友的）。每次都把 URL 和邮箱从头敲一遍没有道理 —— 它们不是秘密，
 * 而且敲错服务器地址只会得到一句「连不上」，很难查。
 *
 * ## ⚠️ 存进去的**只有服务器地址和邮箱**
 *
 * 永远不存主密码、不存任何密钥。那两样只活在内存里，锁定就没了
 * （spec 不变量 S1）。这个文件里没有任何一行会碰到它们。
 *
 * ## ⚠️ 为什么走 `host().storage` 而不是直接读 `localStorage`
 *
 * 桌面端原来是直接读 `localStorage` 的 —— 它**曾经是这个仓库里唯一一条
 * 绕过宿主接口的存储路径**（同步缓存、KDF 缓存、图标缓存都已经走宿生了）。
 * 一处绕过去，那个「平台的差异只有两处」的说法就不成立了。
 *
 * 而扩展端**根本没有**这个功能：弹窗每次打开都要重新敲服务器地址和邮箱。
 * 桌面端能「点一下 + 敲密码」。同一件事两边不一样，而没有任何东西会报错 ——
 * 这是这个仓库里反复出现的那一族，这是第 10 件。
 *
 * ## ⚠️ 异步带来的一个真问题
 *
 * `host().storage` 是异步的（`chrome.storage.local` 没有同步读）。
 * 而桌面端原来是**同步**读取本机账户的。
 * 换过来之后**首帧拿不到账户** —— 有记住账户的人会先看到完整表单、
 * 再跳成账户列表，读起来就是「咦，怎么又要我填服务器地址」。
 *
 * 所以下面那个 hook 在加载中回 **`null`**，和「一个都没存」的 `[]`
 * 区分开。调用方在 `null` 时渲染占位，**不要**先渲染表单。
 */

export interface SavedAccount {
  serverUrl: string;
  email: string;
}

/*
 * 键名沿用桌面端原来的 —— 改键名等于让所有老用户「我明明记住过」
 * 的那一份凭空消失。
 */
const ACCOUNTS_KEY = '1warden.accounts';
const LEGACY_URL_KEY = '1warden.serverUrl';
const LEGACY_EMAIL_KEY = '1warden.email';

/** 列表上限。存的是「常去的几台」，不是历史记录 */
const MAX_ACCOUNTS = 5;

function isSaved(v: unknown): v is SavedAccount {
  return typeof v === 'object' && v !== null
    && typeof (v as SavedAccount).serverUrl === 'string' && (v as SavedAccount).serverUrl.length > 0
    && typeof (v as SavedAccount).email === 'string' && (v as SavedAccount).email.length > 0;
}

export async function readAccounts(): Promise<SavedAccount[]> {
  try {
    const raw = await host().storage.get(ACCOUNTS_KEY);
    if (raw) {
      const list: unknown = JSON.parse(raw);
      if (Array.isArray(list)) return list.filter(isSaved).slice(0, MAX_ACCOUNTS);
    }
    /*
     * 旧版本只存了一个槽位（`1warden.serverUrl` / `1warden.email`）——
     * 把它迁移成列表的第一项，用户升级后不会觉得「我明明记住过」。
     */
    const serverUrl = await host().storage.get(LEGACY_URL_KEY);
    const email = await host().storage.get(LEGACY_EMAIL_KEY);
    if (serverUrl && email) return [{ serverUrl, email }];
  } catch {
    // 存储被禁用或内容坏了 —— 当作没记住过，不值得打断连接流程
  }
  return [];
}

/**
 * 记住一个账户（最近用的排最前）。
 *
 * ⚠️ 失败**不抛**：记住账户是便利功能，不能因为它失败就挡住连接。
 */
export async function rememberAccount(a: SavedAccount): Promise<void> {
  try {
    const rest = (await readAccounts()).filter(
      (x) => !(x.serverUrl === a.serverUrl && x.email === a.email),
    );
    await host().storage.set(ACCOUNTS_KEY, JSON.stringify([a, ...rest].slice(0, MAX_ACCOUNTS)));
    /*
     * 顺带写一份旧键：万一用户回退到上一版，仍然读得到。
     * 这两行在「旧结构会被当成新结构用」那类问题上是**相反**方向的安全网
     * （`sync-cache.ts` 里注释讲的是相反的情况）—— 这里旧结构是它的真子集。
     */
    await host().storage.set(LEGACY_URL_KEY, a.serverUrl);
    await host().storage.set(LEGACY_EMAIL_KEY, a.email);
  } catch {
    // 存不下就算了 —— 见上
  }
}

/**
 * 读记住的账户。**加载中返回 `null`**（不是 `[]`）。
 *
 * ⚠️ 这个区别是整个 hook 存在的理由：`[]` 意味着「没存过，请填完整表单」，
 * `null` 意味着「还不知道」。混成一个的话，有记住账户的人会先看到一张
 * 要填服务器地址的表单，然后它跳成账户列表 —— 用户会以为自己的东西丢了。
 *
 * 只在挂载时读一次：连接成功之前不需要跟着存储变，跟着变反而会在
 * 用户正在打字时把他选好的账户换掉。
 */
export function useAccounts(): SavedAccount[] | null {
  const viewStore = useLocalStore(() => {
    const accounts = (null) as SavedAccount[] | null;
    return { accounts };
  });
  const [accounts, setAccounts] = useStoreField(viewStore, 'accounts');
  useEffect(() => {
    let alive = true;
    void readAccounts().then((a) => { if (alive) setAccounts(a); });
    return () => { alive = false; };
  }, []);
  return accounts;
}
