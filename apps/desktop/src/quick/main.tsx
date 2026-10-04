/**
 * 快速面板窗口 —— 按 ⌘⇧\ 调出来的那个。
 *
 * 它自己**不持有任何会话**：数据向主窗口要，动作也由主窗口执行。
 * 理由见 quick-bridge.ts 顶部（核心是「明文密码不跨 IPC 序列化」）。
 */
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { QuickAccess } from '../screens/QuickAccess';
import {
  askMain, askInitial, askAction, onResults, onActionResult,
  type QuickItem,
} from '../quick-bridge';
import '../styles.css';

function Quick() {
  const [items, setItems] = useState<QuickItem[]>([]);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** 只认最新一次查询的结果 —— 用户打字很快，早发的会晚回 */
  const latestSeq = useRef(0);

  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    void onResults((r) => {
      if (r.seq < latestSeq.current) return;   // 过期结果，丢掉
      setItems(r.items);
      setLocked(r.locked);
      setBusy(false);
    }).then((un) => unlisteners.push(un));

    void onActionResult((r) => {
      setNotice(r.message);
      // 成功了就把面板收起来 —— 用户拿到东西了，没有理由继续占着屏幕
      // 收起面板走 Rust 命令 —— 前端的 window.hide() 需要 ACL 授权，
      // 而默认权限里没有它
      if (r.ok) setTimeout(() => { void invoke('quick_hide'); }, 350);
    }).then((un) => unlisteners.push(un));

    // 面板显示出来时才去要初始结果。窗口是复用的（隐藏而非销毁），
    // 所以每次显示都得重新拉一次 —— 期间保险库可能已经锁了或改了
    void askInitial(latestSeq.current);

    return () => { for (const un of unlisteners) un(); };
  }, []);

  // 重新显示时刷新一次。
  //
  // 面板是**隐藏而非销毁**，所以「重新显示」不会重跑 useEffect ——
  // 期间保险库可能已经锁了、条目也变了。用窗口重新获得焦点作为信号。
  useEffect(() => {
    let un: (() => void) | undefined;
    void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      latestSeq.current += 1;
      void askInitial(latestSeq.current);
    }).then((u) => { un = u; });
    return () => un?.();
  }, []);

  return (
    <QuickAccess
      items={items}
      locked={locked}
      busy={busy}
      notice={notice}
      onQueryChange={(q, seq) => {
        latestSeq.current = seq;
        setBusy(true);
        void askMain(q, seq);
      }}
      onPick={(item) => {
        setNotice(null);
        void askAction(item.id, 'copy-password');
      }}
      onClose={() => { void invoke('quick_hide'); }}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Quick />
  </StrictMode>,
);
