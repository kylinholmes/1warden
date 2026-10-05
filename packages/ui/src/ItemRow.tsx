import type { ReactNode } from 'react';
import { IconStar } from './icons';

/**
 * 条目在列表里的一行 —— **桌面端和浏览器插件共用这一个**。
 *
 * ## 为什么必须共用
 *
 * 这是两端最容易漂的一块：它承载的是「同一条记录看起来是什么样」，
 * 而两处各写一遍的后果不是「样式不一致」那么轻 —— 是**同一条在两个地方
 * 显示成不同的东西**（插件里显示 `bilibili`、桌面端显示 `www.bilibili.com`）。
 * 用户会以为记错了、甚至以为丢数据。
 *
 * 所以第二行**不由这个组件推**，由调用方把 `@coffer/vault` 的 `summaryOf`
 * 结果传进来 —— 那条规则（卡号必须掩码、没有可显示的就返回 null 而不是
 * 填「登录信息」这种每行都一样的占位词）只写在一处。
 *
 * ## 为什么图标是插槽而不是 `item`
 *
 * 两端的图标**取法**是真的不同，而且这个不同是对的：桌面端跨源被 CORS 拦，
 * 得走 Rust；弹窗有 host_permissions，直接 fetch。共享的 `IconStore` 已经把
 * 规则和缓存策略收在 `@coffer/vault` 里，分叉只在「怎么发请求」那一个回调上。
 *
 * 所以这里收 `ReactNode`：桌面传 `<ItemIcon item store />`，弹窗传
 * `<IconGlyph domain text hue type store />`（它只拿得到摘要，见那个组件的
 * 双入口说明）。**组件本身不碰 `VaultItem`、不碰 `VaultClient`。**
 *
 * ## 动作不进这一行
 *
 * 弹窗早先把「填充」「复制用户名/密码/验证码」「30 秒后清空」全铺在行里，
 * 结果是**每条又宽又高、列表和详情都不像**。那些属于详情 —— 用 `trailing`
 * 只放一个最轻的入口（比如一个星标或一个箭头），重动作留给点进去之后。
 */
export interface ItemRowProps {
  /** 左边那块图标。由调用方决定用哪个入口 —— 见上 */
  icon: ReactNode;
  name: string;
  /**
   * 名字解不开（独立密钥缺失等）。显示成占位词并弱化，
   * **不要传空字符串** —— 那样这一行会看起来像坏了。
   */
  nameFailed?: boolean;
  /** 第二行。`null` = 这条没有可显示的信息，不填占位词 */
  summary: string | null;
  favorite?: boolean;
  selected?: boolean;
  /** 右边追加的东西。不传就只有名字那两行 */
  trailing?: ReactNode;
  onClick?: () => void;
}

export function ItemRow({
  icon, name, nameFailed, summary, favorite, selected, trailing, onClick,
}: ItemRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      /*
       * `items-start` 而不是 `items-center` —— 有摘要的那几行比没摘要的高一截，
       * 居中对齐会让图标在列表里上下跳动。
       */
      className={`flex w-full items-start gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5 text-left transition-colors duration-[var(--dur-fast)] ${
        selected ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]'
      }`}
    >
      {icon}
      <span className="min-w-0 flex-1 py-0.5">
        <span className={`block truncate text-md leading-snug ${
          nameFailed ? 'italic text-[var(--ink-tertiary)]' : ''
        }`}>
          {nameFailed ? '无法解密' : name}
        </span>
        {summary !== null && (
          <span className="mt-0.5 block truncate text-xs leading-snug text-[var(--ink-tertiary)]">
            {summary}
          </span>
        )}
      </span>
      {favorite && <IconStar size={13} filled className="mt-1.5 shrink-0 text-[var(--caution)]" />}
      {trailing}
    </button>
  );
}
