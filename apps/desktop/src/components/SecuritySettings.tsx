import { useLocalStore, useStoreField, useStore } from '@1warden/state/react';
import { Select } from '@1warden/ui';
import { AUTO_LOCK_MINUTES, CLIPBOARD_CLEAR_SECONDS, securityPreferencesStore, setSecurityPreference,
  type SecurityPreferences } from '../security-preferences';

export function SecuritySettings({ browser, windows }: { browser: boolean; windows: boolean }) {
  const preferences = useStore(securityPreferencesStore, state => state);
  const feedback = useLocalStore(() => ({ error: '' }));
  const [error, setError] = useStoreField(feedback, 'error');
  const change = (key: keyof SecurityPreferences, value: string) => {
    try { setSecurityPreference(key, Number(value)); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '无法保存设置，请重试'); }
  };
  return <section>
    <h3 className="text-md font-medium">安全</h3>
    <p className="mt-0.5 text-xs text-[var(--ink-tertiary)]">{browser ? '浏览器扩展使用固定安全时限' : '仅用于当前设备，保存后立即生效'}</p>
    <div className="card mt-3 px-4">
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border-subtle)] py-3">
        <div className="min-w-[160px] flex-1">
          <label id="security-lock-label" className="text-md">解锁后自动锁定</label>
          <p className="mt-0.5 text-xs leading-snug text-[var(--ink-tertiary)]">从解锁时计时，切换账户或打开页面不会延长。</p>
        </div>
        {browser ? <span className="text-sm text-[var(--ink-secondary)]">15 分钟</span> : <Select
          aria-labelledby="security-lock-label" className="w-28 shrink-0" value={String(preferences.autoLockMinutes)}
          options={AUTO_LOCK_MINUTES.map(value => ({ value: String(value), label: `${value} 分钟` }))}
          onChange={value => change('autoLockMinutes', value)} />}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border-subtle)] py-3">
        <div className="min-w-[160px] flex-1">
          <label id="security-clipboard-label" className="text-md">复制后清空剪贴板</label>
          <p className="mt-0.5 text-xs leading-snug text-[var(--ink-tertiary)]">{browser ? '仅清除本次复制的内容。' : '用于之后的复制，仅清除本次复制的内容。'}</p>
        </div>
        {browser ? <span className="text-sm text-[var(--ink-secondary)]">30 秒</span> : <Select
          aria-labelledby="security-clipboard-label" className="w-28 shrink-0" value={String(preferences.clipboardClearSeconds)}
          options={CLIPBOARD_CLEAR_SECONDS.map(value => ({ value: String(value), label: `${value} 秒` }))}
          onChange={value => change('clipboardClearSeconds', value)} />}
        {windows && <p className="w-full text-xs leading-snug text-[var(--ink-tertiary)]">新复制的内容不进入 Windows 剪贴板历史或云同步；已有历史需自行删除。</p>}
      </div>
      <div className="py-3">
        <p className="text-md">已泄露密码检查</p>
        <p className="mt-0.5 text-xs leading-snug text-[var(--ink-tertiary)]">在安全报告中按需检查，只发送 SHA-1 哈希的前 5 个字符。</p>
      </div>
    </div>
    {error && <p className="mt-3 text-sm text-[var(--risk)]" role="alert">{error}</p>}
  </section>;
}
