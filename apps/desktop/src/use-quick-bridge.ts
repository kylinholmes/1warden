/**
 * 主窗口这一侧的快速面板桥。
 *
 * 主窗口是**唯一持有会话的地方**，所以面板的查询和动作都由这里响应。
 * 面板拿到的条目摘要**不含密码与验证码** —— 要复制什么，由这边取、这边写
 * 剪贴板（见 quick-bridge.ts 顶部对这条边界的说明）。
 */
import { useEffect } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { searchItems, totpCode, type VaultClient, type VaultItem } from '@coffer/vault';
import { QUICK_WINDOW, type QuickItem, type QuickAction } from './quick-bridge';

/** 面板一次最多列这么多 —— 再多就得靠搜索了，列满反而看不清 */
const MAX_RESULTS = 8;

/** 剪贴板留存时长。与扩展和 CopyButton 保持一致。 */
const CLEAR_AFTER_MS = 30_000;

let clearTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 写剪贴板并安排 30 秒后清空。
 *
 * ⚠️ 只有剪贴板里**还是我们写进去的东西**时才清 —— 无条件清空会把用户后来
 * 复制的内容抹掉。
 */
async function copyToClipboard(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
  if (clearTimer !== null) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    clearTimer = null;
    void (async () => {
      try {
        if (await navigator.clipboard.readText() === value) {
          await navigator.clipboard.writeText('');
        }
      } catch { /* 读不了就不动它 */ }
    })();
  }, CLEAR_AFTER_MS);
}

function summarise(i: VaultItem): QuickItem {
  return {
    id: i.id,
    name: i.nameFailed ? '无法解密' : i.name,
    username: i.login?.username ?? null,
    hasPassword: i.login?.password != null,
    hasTotp: i.login?.totp != null,
  };
}

export function useQuickBridge(client: VaultClient): void {
  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    // ── 面板要搜索结果 ──
    void listen<{ query: string; seq: number }>('coffer:query', (e) => {
      const session = client.getSession();
      const locked = !session.isUnlocked();

      const items = locked ? [] : searchItems(session.items, session.folders, e.payload.query)
        .map((h) => h.item)
        .slice(0, MAX_RESULTS);

      void emitTo(QUICK_WINDOW, 'coffer:results', {
        seq: e.payload.seq,
        locked,
        items: items.map(summarise),
      });
    }).then((un) => unlisteners.push(un));

    // ── 面板要执行动作 ──
    void listen<{ itemId: string; action: QuickAction }>('coffer:action', (e) => {
      void (async () => {
        const reply = async (ok: boolean, message: string): Promise<void> => {
          await emitTo(QUICK_WINDOW, 'coffer-action-result', { ok, message });
        };

        const session = client.getSession();
        if (!session.isUnlocked()) { await reply(false, '保险库已锁定'); return; }

        const item = session.items.find((i) => i.id === e.payload.itemId);
        if (!item?.login) { await reply(false, '这条记录没有可复制的内容'); return; }

        try {
          switch (e.payload.action) {
            case 'copy-password': {
              if (item.login.password === null) { await reply(false, '这条记录没有密码'); return; }
              await copyToClipboard(item.login.password);
              await reply(true, '密码已复制，30 秒后清空');
              return;
            }
            case 'copy-username': {
              if (item.login.username === null) { await reply(false, '这条记录没有用户名'); return; }
              await copyToClipboard(item.login.username);
              await reply(true, '用户名已复制，30 秒后清空');
              return;
            }
            case 'copy-totp': {
              const code = await totpCode(item);
              if (code === null) { await reply(false, '这条记录没有验证码'); return; }
              await copyToClipboard(code.code);
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
    }).then((un) => unlisteners.push(un));

    return () => { for (const un of unlisteners) un(); };
  }, [client]);
}
