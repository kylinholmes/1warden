import { useLocalStore, useStoreField } from '@1warden/state/react';
import { IconEye } from './icons';
import { CopyField } from './CopyField';
import { FIELD_LABEL_CLASS, FIELD_ROW_CLASS } from './CompoundFieldRow';

/**
 * 一个可复制、可揭示的字段 —— **桌面端和浏览器插件共用**。
 *
 * ⚠️ **永不默认明文展示** —— 这是 spec 里明确的安全不变量。
 * 遮蔽的字段要用户主动点「显示」才展开。
 *
 * 标签在上、内容在下，与编辑态共用阅读起点；不再为每个字段
 * 预留固定标签列。姓名/地址用正文，只有凭据或显式技术字段用等宽。
 */
export interface SecretFieldProps {
  label: string;
  /** **显示**用的值。遮蔽字段可以传占位串，复制仍走 `getValue` —— 见下 */
  value: string;
  /** 是否给「显示/隐藏」开关。只有 `value` 就是真值时才该给 */
  masked?: boolean;
  /** Names and addresses should remain readable without hover or horizontal scrolling. */
  wrap?: boolean;
  /** Technical values can opt in; masked credentials use monospace by default. */
  monospace?: boolean;
  /** Grouped native fields share their container's spacing and divider. */
  layout?: 'row' | 'inline';
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
  label, value, masked = false, wrap = true, monospace = masked, layout = 'row', getValue, revealValue, onCopied, onCopyError,
}: SecretFieldProps) {
  /**
   * 揭示出来的值。`null` = 遮着。
   *
   * ⚠️ 它存的可能是**异步取回来的**，不是 `value` —— 见下面的 `toggle`。
   */
  const viewStore = useLocalStore(() => {
    const revealed = (null) as string | null;
    const revealing = false;
    return { revealed, revealing };
  });
  const [revealed, setRevealed] = useStoreField(viewStore, 'revealed');
  const [revealing, setRevealing] = useStoreField(viewStore, 'revealing');
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
    <div data-field-layout={layout} className={`group flex min-w-0 items-center gap-3${layout === 'inline' ? '' : ' border-b border-[var(--border-subtle)] py-2 last:border-b-0'}`}>
      <CopyField label={label} getValue={getValue ?? (async () => value)} onCopied={onCopied} onError={onCopyError}>
        <span data-field-content className={`${FIELD_ROW_CLASS} flex-1 self-stretch`}>
          <span data-field-label className={FIELD_LABEL_CLASS}>
            {label}
          </span>
          <span data-field-value
            className={`${monospace ? 'secret ' : ''}min-w-0 text-md leading-normal ${wrap && !hidden ? 'whitespace-pre-wrap break-words [overflow-wrap:anywhere]' : 'truncate'} ${hidden ? 'tracking-[0.2em] text-[var(--ink-secondary)]' : ''}`}
          >
            {shown}
          </span>
        </span>
      </CopyField>

      {/* Keep reveal separate so it never also triggers copy. */}
      {masked && <span data-field-actions className="flex shrink-0 items-center gap-0.5">
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
      </span>}
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
    <section className="mb-6">
      {title && (
        <h3 className="mb-2 text-xs font-medium text-[var(--ink-tertiary)]">{title}</h3>
      )}
      <div className="card px-4">{children}</div>
    </section>
  );
}
