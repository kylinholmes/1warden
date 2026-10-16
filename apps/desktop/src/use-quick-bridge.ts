/**
 * 主窗口这一侧的快速面板桥。
 *
 * 主窗口是**唯一持有会话的地方**，所以面板的查询和动作都由这里响应。
 * 面板拿到的条目摘要**不含密码与验证码** —— 要复制什么，由这边取、这边写
 * 剪贴板（见 quick-bridge.ts 顶部对这条边界的说明）。
 */
import { useEffect } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import {
  searchItems, totpCode, summaryOf, iconDomainOf, avatarOf, isProfileItem,
  type VaultClient, type VaultItem,
} from '@1warden/vault';
import { QUICK_WINDOW, type QuickItem, type QuickAction, type QuickAccount } from './quick-bridge';
import { copyQuickValue } from './quick-copy';
import type { QuickAccountNavigation } from './quick-accounts';

/** 面板一次最多列这么多 —— 再多就得靠搜索了，列满反而看不清 */
const MAX_RESULTS = 8;

/**
 * 把条目压成面板要的那几个字段。
 *
 * ⚠️ 显示相关的那几个（摘要、徽标）在这里就算好，不留给面板去算。
 * 面板是**另一个窗口**，拿不到 `VaultItem` —— 让它自己算就等于把
 * `summaryOf` / `avatarOf` 的规则在两个窗口里各写一遍，而它们迟早不一致。
 */
function summarise(i: VaultItem): QuickItem {
  const avatar = avatarOf(i);
  return {
    id: i.id,
    name: i.nameFailed ? '无法解密' : i.name,
    username: i.login?.username ?? null,
    hasPassword: i.login?.password != null,
    hasTotp: i.login?.totp != null,
    type: i.type,
    summary: summaryOf(i),
    iconDomain: iconDomainOf(i),
    avatarText: avatar.text,
    avatarHue: avatar.hue,
  };
}

export function useQuickBridge(source: VaultClient | (() => VaultClient), subscribeActive?: (listener: () => void) => () => void,
  accounts?: { load: () => Promise<QuickAccount[]>; open: QuickAccountNavigation }): void {
  useEffect(() => {
    const unlisteners: (() => void)[] = [];
    const getClient = typeof source === 'function' ? source : () => source;
    let disposed = false;
    let selection = 0;
    let query = { query: '', seq: 0, includeAccounts: false };
    let resultsVersion = 0;
    let openingAccount = false;
    let accountCards: QuickAccount[] = [];
    const rememberUnlisten = (unlisten: () => void) => {
      if (disposed) unlisten(); else unlisteners.push(unlisten);
    };

    function sendResults() {
      const version = ++resultsVersion;
      const session = getClient().getSession();
      const locked = !session.isUnlocked();

      const items = locked ? [] : searchItems(session.items.filter(item => !item.deletedAt && !item.archivedAt && !isProfileItem(item)), session.folders, query.query)
        .map((h) => h.item)
        .slice(0, MAX_RESULTS);

      const result = {
        seq: query.seq,
        locked,
        items: items.map(summarise),
        serverUrl: session.account?.serverUrl ?? null,
        accounts: accountCards,
        accountsLoading: (locked || query.includeAccounts) && Boolean(accounts),
        activeAccount: session.account ? { email: session.account.email, serverUrl: session.account.serverUrl } : null,
        syncing: session.syncing,
        syncError: getClient().syncError,
      };
      void emitTo(QUICK_WINDOW, '1warden:results', result);
      // Account cards are only shown while locked. Re-emitting an unlocked list
      // for metadata would clone its items over IPC and reset keyboard selection.
      if (accounts && (locked || query.includeAccounts)) void accounts.load().then(values => {
        if (disposed || version !== resultsVersion) return;
        // Explicit projection prevents future cache/provider fields becoming IPC data.
        accountCards = values.map(({ id, email, serverUrl, displayName, avatarDataUrl }) => ({ id, email, serverUrl, displayName, avatarDataUrl }));
        void emitTo(QUICK_WINDOW, '1warden:results', { ...result, accounts: accountCards, accountsLoading: false });
      }).catch(() => {
        if (!disposed && version === resultsVersion) void emitTo(QUICK_WINDOW, '1warden:results', { ...result, accountsLoading: false });
      });
    }
    if (subscribeActive) unlisteners.push(subscribeActive(() => { selection++; sendResults(); }));

    // ── 面板要搜索结果 ──
    void listen<{ query: string; seq: number; includeAccounts?: boolean; refresh?: boolean }>('1warden:query', (e) => {
      query = { ...e.payload, includeAccounts: e.payload.includeAccounts === true }; sendResults();
      if (e.payload.refresh && getClient().isUnlocked()) void getClient().refresh().catch(() => { if (!disposed) sendResults(); });
    }).then(rememberUnlisten);

    void listen<{ accountId: string | null; requestId?: number }>('1warden:open-account', e => {
      void (async () => {
        const reply = (ok: boolean, message: string) => emitTo(QUICK_WINDOW, '1warden:action-result', { ok, message, requestId: e.payload.requestId });
        if (!accounts || openingAccount) { await reply(false, '主窗口正在处理请求，请重试'); return; }
        const version = selection; const client = getClient();
        openingAccount = true;
        try {
          const available = await accounts.load();
          if (disposed || version !== selection || client !== getClient()) throw new Error('账户已切换，请重新选择');
          const account = e.payload.accountId === null ? null : available.find(value => value.id === e.payload.accountId);
          if (account === undefined) throw new Error('账户已移除，请重新选择');
          await accounts.open(account ? { serverUrl: account.serverUrl, email: account.email } : null);
          if (!disposed) await reply(true, '已打开主窗口');
        } catch (error) {
          if (!disposed) await reply(false, error instanceof Error ? error.message : '打开账户失败，请重试');
        } finally { openingAccount = false; }
      })();
    }).then(rememberUnlisten);

    // ── 面板要执行动作 ──
    void listen<{ itemId: string; action: QuickAction; requestId?: number }>('1warden:action', (e) => {
      void (async () => {
        const reply = async (ok: boolean, message: string): Promise<void> => {
          await emitTo(QUICK_WINDOW, '1warden:action-result', { ok, message, requestId: e.payload.requestId });
        };

        const client = getClient();
        const session = client.getSession();
        if (!session.isUnlocked()) { await reply(false, '保险库已锁定'); return; }
        const key = session.getKey();
        const version = selection;
        const stillSelected = () => !disposed && version === selection && getClient() === client
          && session.isUnlocked() && session.getKey() === key;

        const item = session.items.find((i) => i.id === e.payload.itemId);
        if (!item?.login) { await reply(false, '这条记录没有可复制的内容'); return; }

        try {
          switch (e.payload.action) {
            case 'copy-password': {
              if (item.login.password === null) { await reply(false, '这条记录没有密码'); return; }
              await copyQuickValue(item.login.password);
              await reply(true, '密码已复制，30 秒后清空');
              return;
            }
            case 'copy-username': {
              if (item.login.username === null) { await reply(false, '这条记录没有用户名'); return; }
              await copyQuickValue(item.login.username);
              await reply(true, '用户名已复制，30 秒后清空');
              return;
            }
            case 'copy-totp': {
              const code = await totpCode(item);
              if (!stillSelected()) { await reply(false, '账户已切换或保险库已锁定'); return; }
              if (code === null) { await reply(false, '这条记录没有验证码'); return; }
              await copyQuickValue(code.code);
              await reply(true, '验证码已复制');
              return;
            }
          }
        } catch (err) {
          // 剪贴板被拒、条目被删……都要有一句话回去。面板上什么都不显示
          // 会让用户以为是自己没点中
          await reply(false, err instanceof Error ? err.message : '操作失败');
        }
      })();
    }).then(rememberUnlisten);

    return () => { disposed = true; for (const un of unlisteners) un(); };
  }, [source, subscribeActive, accounts]);
}
