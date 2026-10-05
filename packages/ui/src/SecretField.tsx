import { useState } from 'react';
import { IconEye } from './icons';
import { CopyButton } from './CopyButton';
import { scheduleClipboardClear } from './clipboard';

/**
 * 一个可复制、可揭示的字段 —— **桌面端和浏览器插件共用**。
 *
 * ⚠️ **永不默认明文展示** —— 这是 spec 里明确的安全不变量。
 * 遮蔽的字段要用户主动点「显示」才展开。
 *
 * ── 排版
 *
 * 上一版是「标签靠左、值靠右」两端对齐。对短值没问题，
 * 但网址一长就变成右边一坨被截断的省略号，而左边空着一大片。
 *
 * 改成两列网格：标签占固定宽度的一列，值从同一条竖线开始、向左排满。
 * 于是所有值**左边缘对齐**，扫一眼就能上下比较；长网址也能从头读起。
 * 这处偏离 1Password 是有意的 —— 它也是两端对齐，代价同样是长网址难读。
 *
 * ⚠️ 那个 `76px` 是**跨组件对齐**的：`ItemEditor` 的编辑态也用同一列宽，
 * 只读态和编辑态因此不会左右跳。改它要两处一起改。
 */
export interface SecretFieldProps {
  label: string;
  /** **显示**用的值。遮蔽字段可以传占位串，复制仍走 `getValue` —— 见下 */
  value: string;
  /** 是否给「显示/隐藏」开关。只有 `value` 就是真值时才该给 */
  masked?: boolean;
  /**
   * 复制时取的值。**不传就用 `value`。**
   *
   * 浏览器弹窗必须要传：它手里**没有**明文（列表接口刻意只回摘要），
   * 得去后台取一次。这样明文只在复制那一刻过手，不会躺进组件状态 ——
   * 而状态里的东西会进 devtools、进内存快照、进崩溃报告。
   */
  getValue?: () => Promise<string>;
  /**
   * 复制成功之后。桌面端传 `scheduleClipboardClear`（它有常驻窗口，
   * 定时器有地方活）；弹窗**不传** —— 那边由后台的离屏文档负责，
   * 因为弹窗一关它的定时器就没了。
   */
  onCopied?: (value: string) => void;
  onCopyError?: (e: unknown) => void;
}

export function SecretField({
  label, value, masked = false, getValue, onCopied, onCopyError,
}: SecretFieldProps) {
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
            type="button"
            onClick={() => setRevealed((r) => !r)}
            aria-label={revealed ? '隐藏' : '显示'}
            title={revealed ? '隐藏' : '显示'}
            className="rounded-[var(--radius-sm)] p-1.5 text-[var(--ink-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]"
          >
            <IconEye size={14} off={revealed} />
          </button>
        )}
        <CopyButton
          getValue={getValue ?? (async () => value)}
          {...(onCopied === undefined ? { onCopied: scheduleClipboardClear } : { onCopied })}
          {...(onCopyError === undefined ? {} : { onError: onCopyError })}
          iconOnly
          iconSize={14}
          className="rounded-[var(--radius-sm)] p-1.5 text-[var(--ink-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]"
        />
      </span>
    </div>
  );
}

/**
 * 详情里的一个分组：一行小标题 + 一张卡片。
 *
 * 桌面端和弹窗共用 —— 详情两边的分组方式必须一致，
 * 否则「登录信息」在一边是一张卡、在另一边是几个散字段。
 */
export function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      {title && (
        <h3 className="mb-2 text-xs font-medium text-[var(--ink-tertiary)]">{title}</h3>
      )}
      <div className="card px-4">{children}</div>
    </section>
  );
}
