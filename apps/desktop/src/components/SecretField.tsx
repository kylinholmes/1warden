import { useState, useEffect, useRef, useCallback } from 'react';
import { IconCheck, IconCopy, IconEye } from './icons';

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
  const [copied, setCopied] = useState(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 组件卸载（切换条目）时清掉计时器
  useEffect(() => () => { if (clearTimer.current) clearTimeout(clearTimer.current); }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (clearTimer.current) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(async () => {
        setCopied(false);
        // ⚠️ 只有剪贴板里还是**我们写进去的那个值**时才清空。
        // 无脑清空会抹掉用户在这 30 秒里后来复制的东西 —— 那是个数据丢失 bug。
        try {
          const current = await navigator.clipboard.readText();
          if (current === value) await navigator.clipboard.writeText('');
        } catch {
          // 读剪贴板可能被系统拒绝；那就保持原样，宁可不清理也不要误删
        }
      }, 30_000);
    } catch {
      setCopied(false);
    }
  }, [value]);

  const hidden = masked && !revealed;
  const shown = hidden ? '•'.repeat(Math.min(value.length, 20)) : value;

  return (
    <div className="group flex items-center gap-3 border-b border-[var(--border-subtle)] py-2.5 last:border-b-0">
      <span className="w-[76px] shrink-0 truncate text-[var(--text-sm)] text-[var(--ink-tertiary)]" title={label}>
        {label}
      </span>

      <span
        className={`secret min-w-0 flex-1 truncate text-[var(--text-md)] ${hidden ? 'tracking-[0.2em] text-[var(--ink-secondary)]' : ''}`}
        title={hidden ? undefined : value}
      >
        {shown}
      </span>

      {/*
        操作按钮平时淡出，悬停或聚焦时才出现。
        不是为了好看 —— 一屏十几个字段如果每个都挂着「显示」「复制」，
        真正的信息（值本身）就被按钮淹了。键盘用户 tab 进来时它同样可见。
      */}
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-[var(--dur-fast)] focus-within:opacity-100 group-hover:opacity-100">
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
        <button
          onClick={copy}
          aria-label="复制"
          title="复制（30 秒后自动清空剪贴板）"
          className={`rounded-[var(--radius-sm)] p-1.5 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] ${
            copied ? 'text-[var(--safe)]' : 'text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]'
          }`}
        >
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
        </button>
      </span>
    </div>
  );
}
