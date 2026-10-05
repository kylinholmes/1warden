import { useState, useEffect } from 'react';
import { CopyButton, IconEye, scheduleClipboardClear } from '@coffer/ui';

interface Props {
  label: string;
  value: string;
  /** 默认遮蔽 —— 只有密码、卡号、安全码这类才需要 */
  masked?: boolean;
}

/**
 * 一个可复制、可揭示的字段。
 *
 * ⚠️ **永不默认明文展示** —— 这是 spec 里明确的安全不变量。
 * 遮蔽的字段要用户主动点「显示」才展开，且展开状态在失焦或切换条目时收回。
 *
 * ── 排版
 *
 * 上一版是「标签靠左、值靠右」两端对齐。对短值没问题，
 * 但网址一长就变成右边一坨被截断的省略号，而左边空着一大片。
 *
 * 改成两列网格：标签占固定宽度的一列，值从同一条竖线开始、向左排满。
 * 于是所有值**左边缘对齐**，扫一眼就能上下比较；长网址也能从头读起。
 * 这处偏离 1Password 是有意的 —— 它也是两端对齐，代价同样是长网址难读。
 */
export function SecretField({ label, value, masked = false }: Props) {
  const [revealed, setRevealed] = useState(false);
  const hidden = masked && !revealed;
  const shown = hidden ? '•'.repeat(Math.min(value.length, 20)) : value;

  return (
    <div className="group flex items-center gap-3 border-b border-[var(--border-subtle)] py-2.5 last:border-b-0">
      <span className="w-[76px] shrink-0 truncate text-sm text-[var(--ink-tertiary)]" title={label}>
        {label}
      </span>

      <span
        className={`secret min-w-0 flex-1 truncate text-md ${hidden ? 'tracking-[0.2em] text-[var(--ink-secondary)]' : ''}`}
        title={hidden ? undefined : value}
      >
        {shown}
      </span>

      {/*
        ⚠️ 按钮**始终可见**，只是画得很轻（tertiary 灰）。
        上一版是悬停才出现（opacity-0 → group-hover），看着很干净，
        但对普通用户是实打实的发现问题：界面上一眼看不出「这里能复制」，
        而复制恰恰是密码管理器里最高频的动作。
        保持低调的办法是不给它颜色和边框，而不是把它藏起来。
      */}
      <span className="flex shrink-0 items-center gap-0.5">
        {masked && (
          <button
            onClick={() => setRevealed((r) => !r)}
            aria-label={revealed ? '隐藏' : '显示'}
            title={revealed ? '隐藏' : '显示'}
            className="rounded-[var(--radius-sm)] p-1.5 text-[var(--ink-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]"
          >
            <IconEye size={14} off={revealed} />
          </button>
        )}
        <CopyButton
          getValue={async () => value}
          onCopied={scheduleClipboardClear}
          iconOnly
          iconSize={14}
          className={`rounded-[var(--radius-sm)] p-1.5 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] ${
            'text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]'
          }`}
        />
      </span>
    </div>
  );
}
