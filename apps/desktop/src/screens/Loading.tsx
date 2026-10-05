/**
 * 登录之后、保险库就绪之前的那一屏。
 *
 * ## 它替代的是什么
 *
 * 原先 `unlocking` 被算作「还在连接」，于是渲染的是**连接屏** ——
 * 也就是用户刚刚提交过的那个登录表单。表现是：
 *
 *   点「登录」→ 表单还在，按钮灰着 → 几秒内什么都不动 → 突然进保险库
 *
 * 那几秒其实在**同步整个保险库**（拉全部密文 + 逐条解密）。用户在等，
 * 但界面上没有任何东西告诉他还在等 —— 于是感觉是「卡住了 / 很慢」。
 *
 * ⚠️ 这一屏**不改变实际耗时**，改的是「等待期间用户看到什么」。
 * 真要缩短耗时是另一件事，见下面「还没做的」。
 *
 * ## 为什么带账号信息
 *
 * 同步可能要几秒。显示「正在载入谁的保险库」让用户确认自己登对了账号 ——
 * 尤其是多个账户之间切换的时候。只放一个转圈会让那几秒显得更长。
 *
 * ## 还没做的（别把这一屏当成性能优化）
 *
 * · **进度**：`/api/sync` 是一次性返回全部密文的，没有分页，
 *   所以拿不到「已加载 N/M」。只能显示不确定态。
 * · **缓存**：本地缓存解密后的数据会和「密钥与明文永不落盘」冲突（spec S1），
 *   要做的话是那个不变量的显式例外，和指纹解锁同一类问题，得单独决定。
 * · **KDF 那一段**：`beginUnlock` 发生在登录**之后**，所以主密钥派生
 *   （Argon2 可能上秒）仍然耗在连接屏上。要覆盖它得让客户端暴露阶段。
 */
import { IconLock, IconSpinner } from '@coffer/ui';

export function Loading({ account }: { account: string }) {
  return (
    <div className="below-titlebar flex h-full flex-col items-center justify-center gap-4 bg-[var(--surface-canvas)] p-8">
      <div className="flex items-center gap-2.5">
        <span className="grid h-[22px] w-[22px] place-items-center rounded-[7px] bg-[var(--accent)] text-[var(--accent-ink)]">
          <IconLock size={13} />
        </span>
        <span className="text-[var(--text-lg)] font-semibold tracking-[-0.01em]">Coffer</span>
      </div>

      <IconSpinner size={20} className="text-[var(--ink-tertiary)]" />

      <div className="text-center">
        <p className="text-[var(--text-sm)] text-[var(--ink-secondary)]">正在载入保险库…</p>
        {account !== '' && (
          <p className="mt-1 truncate text-[var(--text-xs)] text-[var(--ink-tertiary)]">{account}</p>
        )}
      </div>
    </div>
  );
}
