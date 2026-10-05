import { useState, type FormEvent } from 'react';
import { IconSpinner } from './icons';

/**
 * 两步验证 —— **两端共用这一份**。
 *
 * ## 为什么它必须存在
 *
 * `VaultClient.connect` 在服务器要求两步验证时抛一个 `TwoFactorChallenge`，
 * 调用方**必须**接住它、问用户要验证码、再调 `connectWithTwoFactor`
 * （见 `packages/vault/src/client.ts` 的说明）。
 *
 * 桌面端接了。**扩展端从来没接** —— 整个 `apps/desktop/extension/` 里
 * `twoFactor` 出现 **0 次**。于是：
 *
 * - 用户输入完全正确的主密码
 * - 后台抛出 `TwoFactorChallenge`
 * - 消息层把它当成一般错误回给弹窗
 * - 弹窗显示 `apiMessageOf(e)`，而那个 challenge 没有 `kind`，
 *   所以**直接显示 `err.message` 的英文原文**
 *
 * 结果是：**开了两步验证的 Vaultwarden 用户根本登不进扩展**，
 * 而且看到的是一句看不懂的英文。这不是「少个功能」，是一道进不去的门 ——
 * 而两步验证恰恰是自建服务的人最常开的东西之一。
 *
 * ## 为什么做成共享组件而不是在弹窗里补一段
 *
 * 补一段 = 第二次「两端各写一遍」。这个仓库里那一族已经有 9 件了
 * （见 `docs/restructure-plan.md`），每一件都是这么开始的。
 */

/** 两步验证方式的名称 —— 数字来自官方枚举 */
export const PROVIDER_NAME: Record<number, string> = {
  0: '验证器应用', 1: '邮箱', 2: 'Duo', 3: 'YubiKey',
  5: '记住的设备', 6: '组织 Duo', 7: '安全密钥', 8: '恢复代码',
};

export function TwoFactorForm({
  providers,
  busy,
  onSubmit,
}: {
  providers: readonly number[];
  busy: boolean;
  onSubmit: (p: { code: string; provider: number; remember: boolean }) => void;
}) {
  const [code, setCode] = useState('');
  const [remember, setRemember] = useState(true);

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit({ code: code.trim(), provider: providers[0] ?? 0, remember });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-[var(--ink-secondary)]">
        可用方式：{providers.map((p) => PROVIDER_NAME[p] ?? `方式 ${p}`).join('、')}
      </p>

      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-[var(--ink-secondary)]">验证码</span>
        <input
          type="text"
          required
          inputMode="numeric"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="field secret text-center text-xl tracking-[0.3em]"
        />
      </label>

      <label className="flex items-center gap-2.5 text-sm text-[var(--ink-secondary)]">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        记住这台设备
      </label>

      <button type="submit" disabled={busy} className="btn btn-primary w-full py-2.5">
        {busy && <IconSpinner size={15} />}
        {busy ? '验证中…' : '验证'}
      </button>
    </form>
  );
}
