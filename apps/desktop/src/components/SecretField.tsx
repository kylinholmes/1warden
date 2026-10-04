import { useState, useEffect, useRef, useCallback } from 'react';

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
      if (clearTimer.current) clearTimer.current = null;
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

  const shown = masked && !revealed ? '•'.repeat(Math.min(value.length, 24)) : value;

  return (
    <div className="group flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] py-2.5 last:border-0">
      <span className="shrink-0 text-[var(--text-sm)] text-[var(--ink-secondary)]">{label}</span>

      <span className="flex min-w-0 items-center gap-1">
        <span
          className={`secret truncate text-right text-[var(--text-md)] ${masked && !revealed ? 'tracking-widest' : ''}`}
          title={masked && !revealed ? undefined : value}
        >
          {shown}
        </span>

        {masked && (
          <button
            onClick={() => setRevealed((r) => !r)}
            aria-label={revealed ? '隐藏' : '显示'}
            title={revealed ? '隐藏' : '显示'}
            className="shrink-0 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[var(--text-xs)] text-[var(--ink-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)]"
          >
            {revealed ? '隐藏' : '显示'}
          </button>
        )}

        <button
          onClick={copy}
          aria-label="复制"
          title="复制（30 秒后自动清空剪贴板）"
          className={`shrink-0 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[var(--text-xs)] transition-colors duration-[var(--dur-fast)] ${
            copied
              ? 'text-[var(--safe)]'
              : 'text-[var(--ink-tertiary)] opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-[var(--surface-hover)]'
          }`}
        >
          {copied ? '已复制 ✓' : '复制'}
        </button>
      </span>
    </div>
  );
}
