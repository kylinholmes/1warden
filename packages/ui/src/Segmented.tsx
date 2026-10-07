import { useId, type ReactNode } from 'react';

/**
 * 分段控件 —— 三五个互斥选项，全部摆在明面上。
 *
 * ## 为什么不用下拉框
 *
 * 用在「主题」和「生成器的模式」两处，它们的共同点是：**选项少、互斥、
 * 而且「现在选的是哪个」本身就是要看的信息**。下拉框把选项藏进一次点击
 * 后面，只留当前值在外面 —— 对一个只有三个选项、用户还想知道另外两个是
 * 什么的东西，那是白加一步。
 *
 * 顺带解决一件事：设置面板里原来那个「主题」下拉是 `disabled` 的占位，
 * 一个灰掉的控件既不能点、也看不出将来长什么样。分段控件把三个状态
 * 直接摊开，用户一眼就知道这个设置有几档。
 *
 * ## 键盘
 *
 * 走的是单选组的规矩，不是按钮组的：整组只占**一个** Tab 停留点，
 * 进去之后左右（上下也行）直接改选择。三个按钮各占一个 Tab 停留点的话，
 * 键盘用户要按三次才能穿过这一行。
 */
export function Segmented<T extends string>({ value, options, onChange, label, className = '' }: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string; icon?: ReactNode }>;
  onChange: (value: T) => void;
  /** 这一组叫什么。视觉上由旁边那行标签承担，读屏靠这个属性 */
  label: string;
  className?: string;
}) {
  const uid = useId();
  const index = options.findIndex((o) => o.value === value);

  function select(next: number): void {
    const option = options[(next + options.length) % options.length]!;
    onChange(option.value);
    // 焦点跟着选择走 —— 否则连按两次方向键，第二次是从旧位置继续算的
    document.getElementById(`${uid}-${option.value}`)?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`inline-flex gap-0.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-well)] p-0.5 ${className}`}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            id={`${uid}-${o.value}`}
            type="button"
            role="radio"
            aria-checked={active}
            // 只让选中的那个能被 Tab 到（roving tabindex）
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const delta =
                e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
                : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1
                : 0;
              if (delta === 0 || index < 0) return;
              e.preventDefault();
              select(index + delta);
            }}
            className={`inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1 text-xs transition-colors duration-[var(--dur-fast)] ${
              active
                ? 'bg-[var(--accent-tint)] font-medium text-[var(--accent)]'
                : 'text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]'
            }`}
            style={active ? { boxShadow: 'var(--elev-raise)' } : undefined}
          >
            {o.icon && <span className={active ? 'text-[var(--accent)]' : 'text-[var(--ink-tertiary)]'}>{o.icon}</span>}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
