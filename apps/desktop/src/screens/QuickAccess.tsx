import { useEffect, useRef, useState } from 'react';
import type { QuickItem } from '../quick-bridge';
import { IconLock, IconSearch, TypeIcon } from '../components/icons';

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
export function QuickAccess({ items, locked, busy, notice, onQueryChange, onPick, onClose }: {
  items: readonly QuickItem[];
  locked: boolean;
  busy: boolean;
  notice: string | null;
  onQueryChange: (q: string, seq: number) => void;
  onPick: (item: QuickItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // 结果变了就把选中项收回到第一条 —— 否则光标会停在一个已经不存在的下标上
  useEffect(() => { setIndex(0); }, [items]);

  function update(value: string) {
    setQuery(value);
    seq.current += 1;
    onQueryChange(value, seq.current);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, items.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[index];
      if (item) onPick(item);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-overlay)]"
      style={{ boxShadow: 'var(--elev-modal)' }}>
      {/* 搜索就是这一屏的主角 —— 给它 --text-lg，比列表里的条目名还大一号，
          因为用户打开面板时脑子里想的是「我要找的那个东西叫什么」 */}
      <div className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-3.5">
        {locked
          ? <IconLock size={18} className="shrink-0 text-[var(--ink-tertiary)]" />
          : <IconSearch size={18} className="shrink-0 text-[var(--ink-tertiary)]" />}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={locked ? '保险库已锁定' : '搜索保险库…'}
          aria-label="搜索保险库"
          disabled={locked}
          className="min-w-0 flex-1 bg-transparent text-[var(--text-lg)] outline-none placeholder:text-[var(--ink-tertiary)] disabled:cursor-not-allowed"
        />
        {busy && <span className="shrink-0 text-[var(--text-xs)] text-[var(--ink-tertiary)]">…</span>}
      </div>

      {locked ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
          <span className="mb-1 grid h-10 w-10 place-items-center rounded-full bg-[var(--surface-well)] text-[var(--ink-tertiary)]">
            <IconLock size={18} />
          </span>
          <p className="text-[var(--text-sm)] text-[var(--ink-secondary)]">保险库已锁定，无法搜索</p>
          <p className="text-[var(--text-xs)] text-[var(--ink-tertiary)]">
            打开 Coffer 解锁后按 ⌘⇧\
          </p>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto p-2">
          {items.length === 0 ? (
            <li className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
              <p className="text-[var(--text-sm)] text-[var(--ink-secondary)]">
                {query ? `没有匹配「${query}」的条目` : '输入以搜索'}
              </p>
              {!query && (
                <p className="text-[var(--text-xs)] text-[var(--ink-tertiary)]">
                  名称、用户名、网址都能搜
                </p>
              )}
            </li>
          ) : items.map((it, i) => (
            <li key={it.id}>
              <button
                onMouseEnter={() => setIndex(i)}
                onClick={() => onPick(it)}
                className={`flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2.5 py-2 text-left transition-colors duration-[var(--dur-fast)] ${
                  i === index ? 'bg-[var(--surface-selected)]' : ''
                }`}
              >
                <span className="tile" data-type="login">
                  <TypeIcon type="login" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[var(--text-md)] leading-snug">{it.name}</span>
                  {it.username && (
                    <span className="mt-0.5 block truncate text-[var(--text-xs)] leading-snug text-[var(--ink-tertiary)]">
                      {it.username}
                    </span>
                  )}
                </span>
                {/* 快捷键写在条目上而不是藏进帮助里 —— 用户按一次就该记住。
                    只在当前选中行显示，否则一屏都是「⏎ 复制」，反而看不见重点 */}
                {it.hasPassword && (
                  <span className={`shrink-0 text-[var(--text-xs)] transition-opacity duration-[var(--dur-fast)] ${
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

      <footer className="flex items-center justify-between border-t border-[var(--border-subtle)] px-4 py-2.5 text-[var(--text-xs)] text-[var(--ink-tertiary)]">
        <span className="min-w-0 truncate">{notice ?? '⏎ 复制密码'}</span>
        <span className="shrink-0">esc 关闭</span>
      </footer>
    </div>
  );
}
