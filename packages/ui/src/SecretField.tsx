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
   * 揭示时取的值。**不传就用 `value`。**
   *
   * ⚠️ 和 `getValue` **分开**，虽然两边取的是同一个值 —— 因为它们的
   * **副作用不同**：复制会安排「30 秒后清空剪贴板」，而揭示不会
   * （也不该）。复用 `getValue` 的话，每点一次「显示」都会给一个
   * 从没被复制的值挂上一个清理定时器，明文还多躺一份在离屏文档里。
   *
   * 这个错误是**截图发现的**：揭示出来的值显示成了复制那条桩的假值。
   */
  revealValue?: () => Promise<string>;
  /**
   * 复制成功之后。桌面端传 `scheduleClipboardClear`（它有常驻窗口，
   * 定时器有地方活）；弹窗**不传** —— 那边由后台的离屏文档负责，
   * 因为弹窗一关它的定时器就没了。
   */
  onCopied?: (value: string) => void | Promise<void>;
  onCopyError?: (e: unknown) => void;
}

export function SecretField({
  label, value, masked = false, getValue, revealValue, onCopied, onCopyError,
}: SecretFieldProps) {
  /**
   * 揭示出来的值。`null` = 遮着。
   *
   * ⚠️ 它存的可能是**异步取回来的**，不是 `value` —— 见下面的 `toggle`。
   */
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const hidden = masked && revealed === null;
  const shown = hidden ? '•'.repeat(Math.min(value.length, 20)) : (revealed ?? value);

  /**
   * 揭示 / 遮回去。
   *
   * ⚠️ **有 `getValue` 时要去取一次，而不是直接把 `value` 摊开。**
   *
   * 桌面端手里有明文，`value` 就是真值，摊开即可。而浏览器弹窗**没有**
   * （列表接口刻意只回摘要）—— 它传进来的 `value` 是一串占位点。
   * 以前这个开关只在「`value` 就是真值」时才给（见上面 `masked` 的说明），
   * 于是弹窗里**根本没有「显示」这个按钮**，而桌面端有。
   * 同一屏两边一个有眼睛一个没有，用户只会觉得弹窗是残的。
   *
   * 接上 `getValue` 之后两边一致：揭示同样是「取一次」，而且明文只在
   * 揭开那一刻过手，不揭开就永远不到组件状态里 —— 和复制那条路一样。
   */
  async function toggle(): Promise<void> {
    if (revealed !== null) { setRevealed(null); return; }
    const fetch = revealValue ?? getValue;
    if (!fetch) { setRevealed(value); return; }
    setRevealing(true);
    try {
      setRevealed(await fetch());
    } catch (e) {
      // 取不到就保持遮着 —— 把失败说出去，但不要说成「已显示」
      onCopyError?.(e);
    } finally {
      setRevealing(false);
    }
  }

  return (
    <div className="group flex items-center gap-3 border-b border-[var(--border-subtle)] py-2.5 last:border-b-0">
      <span className="w-[76px] shrink-0 truncate text-sm text-[var(--violet)]" title={label}>
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
            onClick={() => { void toggle(); }}
            disabled={revealing}
            aria-label={hidden ? '显示' : '隐藏'}
            title={hidden ? '显示' : '隐藏'}
            className="rounded-[var(--radius-sm)] p-1.5 text-[var(--ink-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)] disabled:opacity-50"
          >
            <IconEye size={14} off={hidden} />
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
