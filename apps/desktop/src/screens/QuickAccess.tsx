import { useLocalStore, useStoreField } from '@1warden/state/react';
import { useEffect, useRef } from 'react';
import type { QuickItem } from '../quick-bridge';
import { IconLock, IconSearch } from '@1warden/ui';
import { quickShortcut } from '../platform';

import { ItemIcon } from '@1warden/ui';
import type { IconStore } from '@1warden/vault';

/**
 * 快速面板的界面 —— **纯展示**，不碰任何数据源。
 *
 * 这么分是为了能在预览里用假数据截图核对（原生壳的整窗截图依赖辅助功能
 * 授权，开发期经常失效）。数据怎么来、动作怎么执行，都在 `quick/main.tsx`。
 *
 * ⚠️ 只做「复制密码」，不做「输入到其他应用」。后者要先让出焦点再合成按键，
 * 那套倒计时流程主窗口里已经处理好了（见 AutotypeAction）—— 在面板里再实现
 * 一遍只会做出第二个半成品，而且面板这时候正占着焦点，最容易做错。
 *
 * ── 版面
 *
 * 这是个 620×400 上下的浮窗，浮在别人的窗口上面。
 * 所以它自己必须是一块**完整的表面**（overlay 层 + 浮层阴影 + 圆角），
 * 而不是主窗口那种三栏结构。窗口边缘那一圈圆角由外壳给（透明窗口），
 * 这里只负责内部。
 */
export function QuickAccess({ items, icons, locked, busy, notice, pinned = false, onTogglePin, onQueryChange, onPick, onClose }: {
  items: readonly QuickItem[];
  /** 站点图标的缓存。主窗口过桥传来服务端地址后建的；没有就只显示彩色徽标 */
  icons: IconStore | null;
  locked: boolean;
  busy: boolean;
  notice: string | null;
  pinned?: boolean;
  onTogglePin?: () => void;
  onQueryChange: (q: string, seq: number) => void;
  onPick: (item: QuickItem) => void;
  onClose: () => void;
}) {
  const viewStore = useLocalStore(() => {
    const query = '';
    const index = 0;
    return { query, index };
  });
  const [query, setQuery] = useStoreField(viewStore, 'query');
  const [index, setIndex] = useStoreField(viewStore, 'index');
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const seq = useRef(0);

  useEffect(() => { if (locked) panelRef.current?.focus(); else inputRef.current?.focus(); }, [locked]);

  // 结果变了就把选中项收回到第一条 —— 否则光标会停在一个已经不存在的下标上
  useEffect(() => { setIndex(0); }, [items]);
  useEffect(() => { selectedRef.current?.scrollIntoView({ block: 'nearest' }); }, [index, items]);

  function update(value: string) {
    setQuery(value);
    seq.current += 1;
    onQueryChange(value, seq.current);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.target !== inputRef.current) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, items.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[index];
      if (item?.hasPassword && !busy) onPick(item);
    }
  }

  return (
    /*
      表面（.panel）+ 顶栏/底栏（.panel-head / .panel-foot）和设置面板共用同一批
      样式类 —— 两个浮窗必须长得一样，用户眼里的「浮起来的一层」只有一个概念。

      逻辑上没有共用：这个面板跑在**另一个 OS 窗口**里，窗口边界本身就是它的
      遮罩，焦点也出不去，所以 FloatingPanel 里的焦点陷阱、点外部关闭对它
      没有意义。硬套只会多一层空转 —— 该共用的是视觉，不是那些钩子。
    */
    <div ref={panelRef} tabIndex={-1} className="panel quick-panel flex h-full flex-col overflow-hidden outline-none" onKeyDown={onKeyDown}>
      {/* 搜索就是这一屏的主角 —— 给它 --text-lg，比列表里的条目名还大一号，
          因为用户打开面板时脑子里想的是「我要找的那个东西叫什么」 */}
      <div className="panel-head quick-search-head gap-3 px-4 py-3.5">
        {locked
          ? <IconLock size={18} className="shrink-0 text-[var(--ink-tertiary)]" />
          : <IconSearch size={18} className="shrink-0 text-[var(--ink-tertiary)]" />}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => update(e.target.value)}
          placeholder={locked ? '保险库已锁定' : '搜索保险库…'}
          aria-label="搜索保险库"
          disabled={locked}
          className="quick-search-input min-w-0 flex-1 bg-transparent text-lg placeholder:text-[var(--ink-tertiary)] disabled:cursor-not-allowed"
        />
        {busy && <span className="shrink-0 text-xs text-[var(--ink-tertiary)]">…</span>}
        {onTogglePin && <button type="button" className="btn btn-ghost h-8 w-8 p-1.5" aria-label={pinned ? '取消固定快速搜索' : '固定快速搜索'}
          aria-pressed={pinned} title={pinned ? '已临时固定；Esc 仍可关闭' : '临时固定，点击外部不关闭'} onClick={onTogglePin}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 3h8l-1 7 3 3v2H6v-2l3-3-1-7Z" /><path d="M12 15v6" />
          </svg>
        </button>}
      </div>

      {locked ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
          <span className="mb-1 grid h-10 w-10 place-items-center rounded-full bg-[var(--surface-well)] text-[var(--ink-tertiary)]">
            <IconLock size={18} />
          </span>
          <p className="text-sm text-[var(--ink-secondary)]">保险库已锁定，无法搜索</p>
          <p className="text-xs text-[var(--ink-tertiary)]">
            打开 1Warden 解锁后按 {quickShortcut()}
          </p>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto p-2">
          {items.length === 0 ? (
            <li className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
              <p className="text-sm text-[var(--ink-secondary)]">
                {query ? `没有匹配「${query}」的条目` : '输入以搜索'}
              </p>
              {!query && (
                <p className="text-xs text-[var(--ink-tertiary)]">
                  名称、用户名、网址都能搜
                </p>
              )}
            </li>
          ) : items.map((it, i) => (
            <li key={it.id}>
              <button
                ref={i === index ? selectedRef : undefined}
                aria-current={i === index ? true : undefined}
                type="button"
                disabled={busy || !it.hasPassword}
                onMouseEnter={() => setIndex(i)}
                onClick={() => onPick(it)}
                className={`flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2.5 py-2 text-left transition-colors duration-[var(--dur-fast)] ${
                  i === index ? 'bg-[var(--surface-selected)]' : ''
                }`}
              >
                {/* ⚠️ 走 `ItemIcon` —— 和主列表、和弹窗同一条路径 */}
                <ItemIcon
                  iconDomain={it.iconDomain}
                  text={it.avatarText}
                  hue={it.avatarHue}
                  type={it.type}
                  store={icons}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-md leading-snug">{it.name}</span>
                  {/* 摘要规则与主窗口同一份（`summaryOf`），不在这里再推一遍 */}
                  {it.summary !== null && (
                    <span className="mt-0.5 block truncate text-xs leading-snug text-[var(--ink-tertiary)]">
                      {it.summary}
                    </span>
                  )}
                </span>
                {/* 快捷键写在条目上而不是藏进帮助里 —— 用户按一次就该记住。
                    只在当前选中行显示，否则一屏都是「⏎ 复制」，反而看不见重点 */}
                {it.hasPassword && (
                  <span className={`shrink-0 text-xs transition-opacity duration-[var(--dur-fast)] ${
                    i === index ? 'text-[var(--ink-secondary)] opacity-100' : 'opacity-0'
                  }`}>
                    ⏎ 复制
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      <footer className="panel-foot px-4 py-2.5">
        <span className="min-w-0 truncate">{notice ?? '⏎ 复制密码'}</span>
        <span className="shrink-0">esc 关闭</span>
      </footer>
    </div>
  );
}
