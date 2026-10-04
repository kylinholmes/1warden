import { useEffect, useRef, useState } from 'react';
import type { QuickItem } from '../quick-bridge';

/**
 * 快速面板的界面 —— **纯展示**，不碰任何数据源。
 *
 * 这么分是为了能在预览里用假数据截图核对（原生壳的整窗截图依赖辅助功能
 * 授权，开发期经常失效）。数据怎么来、动作怎么执行，都在 `quick/main.tsx`。
 *
 * ⚠️ 只做「复制密码」，不做「输入到其他应用」。后者要先让出焦点再合成按键，
 * 那套倒计时流程主窗口里已经处理好了（见 AutotypeAction）—— 在面板里再实现
 * 一遍只会做出第二个半成品，而且面板这时候正占着焦点，最容易做错。
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
    <div className="flex h-full flex-col overflow-hidden bg-[var(--surface-overlay)]"
      style={{ boxShadow: 'var(--elev-3)' }}>
      <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <span className="text-[var(--text-lg)]" aria-hidden>🔍</span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={locked ? '保险库已锁定' : '搜索保险库…'}
          disabled={locked}
          className="min-w-0 flex-1 bg-transparent text-[var(--text-lg)] outline-none placeholder:text-[var(--ink-tertiary)] disabled:cursor-not-allowed"
        />
        {busy && <span className="shrink-0 text-[var(--text-xs)] text-[var(--ink-tertiary)]">…</span>}
      </div>

      {locked ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-[var(--text-sm)] text-[var(--ink-secondary)]">
            保险库已锁定，无法搜索。
          </p>
          <p className="text-[var(--text-xs)] text-[var(--ink-tertiary)]">
            打开 Coffer 解锁后再按 ⌘⇧\
          </p>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto p-2">
          {items.length === 0 ? (
            <li className="px-3 py-8 text-center text-[var(--text-sm)] text-[var(--ink-tertiary)]">
              {query ? '没有匹配的条目' : '输入以搜索'}
            </li>
          ) : items.map((it, i) => (
            <li key={it.id}>
              <button
                onMouseEnter={() => setIndex(i)}
                onClick={() => onPick(it)}
                className={`flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-left transition-colors duration-[var(--dur-fast)] ${
                  i === index ? 'bg-[var(--surface-selected)]' : ''
                }`}
              >
                <span className="shrink-0 text-[var(--text-lg)]" aria-hidden>🔑</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[var(--text-md)]">{it.name}</span>
                  {it.username && (
                    <span className="block truncate text-[var(--text-xs)] text-[var(--ink-tertiary)]">
                      {it.username}
                    </span>
                  )}
                </span>
                {/* 快捷键写在条目上而不是藏进帮助里 —— 用户按一次就该记住 */}
                <span className="shrink-0 text-[var(--text-xs)] text-[var(--ink-tertiary)]">
                  {it.hasPassword ? '⏎ 复制' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <footer className="flex items-center justify-between border-t border-[var(--border-subtle)] px-4 py-2 text-[var(--text-xs)] text-[var(--ink-tertiary)]">
        <span>{notice ?? '⏎ 复制密码'}</span>
        <span>esc 关闭</span>
      </footer>
    </div>
  );
}
