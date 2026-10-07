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
  searchItems, totpCode, summaryOf, iconDomainOf, avatarOf,
  type VaultClient, type VaultItem,
} from '@coffer/vault';
import { QUICK_WINDOW, type QuickItem, type QuickAction } from './quick-bridge';
import { copyWithAutoClear } from '@coffer/ui';

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

export function useQuickBridge(source: VaultClient | (() => VaultClient), subscribeActive?: (listener: () => void) => () => void): void {
  useEffect(() => {
    const unlisteners: (() => void)[] = [];
    const getClient = typeof source === 'function' ? source : () => source;
    let disposed = false;
    let selection = 0;
    let query = { query: '', seq: 0 };
    const rememberUnlisten = (unlisten: () => void) => {
      if (disposed) unlisten(); else unlisteners.push(unlisten);
    };

    function sendResults() {
      const session = getClient().getSession();
      const locked = !session.isUnlocked();

      const items = locked ? [] : searchItems(session.items, session.folders, query.query)
        .map((h) => h.item)
        .slice(0, MAX_RESULTS);

      void emitTo(QUICK_WINDOW, 'coffer:results', {
        seq: query.seq,
        locked,
        items: items.map(summarise),
        serverUrl: session.account?.serverUrl ?? null,
      });
    }
    if (subscribeActive) unlisteners.push(subscribeActive(() => { selection++; sendResults(); }));

    // ── 面板要搜索结果 ──
    void listen<{ query: string; seq: number }>('coffer:query', (e) => {
      query = e.payload; sendResults();
    }).then(rememberUnlisten);

    // ── 面板要执行动作 ──
    void listen<{ itemId: string; action: QuickAction }>('coffer:action', (e) => {
      void (async () => {
        const reply = async (ok: boolean, message: string): Promise<void> => {
          await emitTo(QUICK_WINDOW, 'coffer:action-result', { ok, message });
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
              await copyWithAutoClear(item.login.password);
              await reply(true, '密码已复制，30 秒后清空');
              return;
            }
            case 'copy-username': {
              if (item.login.username === null) { await reply(false, '这条记录没有用户名'); return; }
              await copyWithAutoClear(item.login.username);
              await reply(true, '用户名已复制，30 秒后清空');
              return;
            }
            case 'copy-totp': {
              const code = await totpCode(item);
              if (!stillSelected()) { await reply(false, '账户已切换或保险库已锁定'); return; }
              if (code === null) { await reply(false, '这条记录没有验证码'); return; }
              await copyWithAutoClear(code.code);
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
  }, [source, subscribeActive]);
}
