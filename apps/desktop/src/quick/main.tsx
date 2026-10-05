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
import { iconStoreFor } from '../icon-store';
import { initPlatform } from '../platform';
import { installDesktopHost } from '../host-impl';
import { initNativeFeel } from '../native';
import { initTheme } from '../theme';
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
  /**
   * 站点图标的缓存。
   *
   * `iconStoreFor` 是模块级单例（按服务端地址），所以面板反复显示/隐藏
   * 不会让缓存失效 —— 图标只抓一次。服务端地址由主窗口随结果带过来。
   */
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  /** 只认最新一次查询的结果 —— 用户打字很快，早发的会晚回 */
  const latestSeq = useRef(0);

  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    void onResults((r) => {
      if (r.seq < latestSeq.current) return;   // 过期结果，丢掉
      setItems(r.items);
      setLocked(r.locked);
      setBusy(false);
      setServerUrl(r.serverUrl);
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
      icons={serverUrl === null ? null : iconStoreFor(serverUrl)}
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

/*
 * ⚠️ 这是一个**独立的窗口**，但主题是同一个应用的主题。
 *
 * 忘了这一句的症状很难被发现：用户在设置里选了暗色，主窗口是暗的，
 * 而按 ⌘⇧\ 调出来的快速面板还是亮的 —— 两个窗口像两个产品。
 * 两个窗口同源，localStorage 是同一份，所以读的就是同一个选择。
 */
initTheme();
// 这个窗口是 decorations: false，没有红绿灯要躲；但两个入口初始化的是
// **同一套**状态，少调一个就会在别处漏出来（上次主题就是这么漏的）
initPlatform();
initNativeFeel();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Quick />
  </StrictMode>,
);
