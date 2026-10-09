import { useLocalStore, useStoreField } from '@1warden/state/react';
import { ProfileAvatar } from '../components/ProfileAvatar';
import { useEffect, useRef, type FormEvent } from 'react';
import type { ApplicationClient } from '../application/types';
import type { TwoFactorChallenge } from '@1warden/vault';
import { BackButton, IconAlert, IconGlobe, IconSpinner, TwoFactorForm } from '@1warden/ui';
import { twoFactorChallenge } from './auth-error';

interface Props {
  client: ApplicationClient;
  onUnlocked: () => void;
  onDisconnect: () => void;
}

/**
 * 已登录但被锁定时的解锁屏。
 *
 * 与连接屏的区别：这里已经有账户信息了，只需要主密码。
 * 这个区分很重要 —— 解锁是高频动作，不该每次都让用户面对一整张表单。
 *
 * ── 动效
 *
 * 这一屏只有一处动效：按下解锁之后，头像外圈开始缓缓扩散（`.breathe`），
 * 直到保险库出现。
 *
 * 它存在的理由是**等待**：派生密钥加一次网络往返接近一秒，
 * 界面在这段时间里完全不动的话，用户会以为没点上然后再点一次。
 * 所以动效回答的是「收到了，正在开」，而不是「看我会动」。
 *
 * 刻意没做「解锁成功再播一段动画然后才进保险库」：那会让每一次解锁都
 * 慢上半秒，而解锁是这个应用里最高频的动作。**该快的地方不快，
 * 就是在用别人的时间换自己的好看。** 进保险库的爽感由保险库本身的
 * 淡入承担（`.screen-in`）。
 */
export function Unlock({ client, onUnlocked, onDisconnect }: Props) {
  const viewStore = useLocalStore(() => {
    const password = '';
    const busy = false;
    const error = (null) as string | null;
    const challenge = (null) as TwoFactorChallenge | null;
    return { password, busy, error, challenge };
  });
  const [password, setPassword] = useStoreField(viewStore, 'password');
  const [busy, setBusy] = useStoreField(viewStore, 'busy');
  const [error, setError] = useStoreField(viewStore, 'error');
  const [challenge, setChallenge] = useStoreField(viewStore, 'challenge');
  const { account, profile } = client.getSnapshot();
  const inputRef = useRef<HTMLInputElement>(null);
  const operation = useRef(0);
  useEffect(() => () => { operation.current++; }, []);

  // 解锁屏一出现就聚焦输入框 —— 用户按下快捷键后应该能直接开始打字
  useEffect(() => { inputRef.current?.focus(); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const version = ++operation.current;
    setBusy(true);
    setError(null);
    try {
      await client.unlock(password);
      if (version !== operation.current) return;
      setPassword(''); // 成功后立刻从组件状态里清掉
      onUnlocked();
    } catch (err) {
      if (version !== operation.current) return;
      const nextChallenge = twoFactorChallenge(err);
      if (nextChallenge) setChallenge(nextChallenge);
      else setError(messageOf(err));
      setPassword('');
      // 失败后把焦点还给输入框：用户下一步一定是重输
      inputRef.current?.focus();
    } finally {
      if (version === operation.current) setBusy(false);
    }
  }

  async function submitCode(code: string, provider: number, remember: boolean): Promise<void> {
    const version = ++operation.current;
    setBusy(true);
    setError(null);
    try {
      await client.connectWithTwoFactor(code, provider, remember);
      if (version !== operation.current) return;
      onUnlocked();
    } catch (err) {
      if (version !== operation.current) return;
      if ((err as { kind?: string } | null)?.kind === 'authRestartRequired') setChallenge(null);
      setError(messageOf(err));
    } finally { if (version === operation.current) setBusy(false); }
  }

  return (
    /* 整块背景可拖 —— 和连接屏同理，这一屏没有顶部带子（见 Connect.tsx） */
    <div className="below-titlebar flex h-full flex-col items-center overflow-y-auto bg-[var(--surface-canvas)] p-8" data-tauri-drag-region="deep">
      <div className="screen-in my-auto w-full max-w-[380px] shrink-0">
        <BackButton label="返回首页" showLabel className="mb-6" onBack={() => { operation.current++; setPassword(''); onDisconnect(); }} />
        <div className="flex flex-col items-center text-center">
          <ProfileAvatar profile={profile} fallback={account?.email ?? ''} className={`mb-4 h-16 w-16 text-xl ${busy ? 'breathe' : ''}`} />
          <p className="text-md font-medium">{profile?.displayName || account?.email}</p>
          {profile?.displayName && <p className="mt-1 text-xs text-[var(--ink-secondary)]">{account?.email}</p>}
          <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--ink-tertiary)]">
            <IconGlobe size={12} className="shrink-0" />
            <span className="truncate">{hostOf(account?.serverUrl ?? '')}</span>
          </p>
        </div>

        {challenge ? <div className="mt-7"><TwoFactorForm providers={challenge.providers} busy={busy}
          onSubmit={({ code, provider, remember }) => { void submitCode(code, provider, remember); }} /></div>
          : <form onSubmit={submit} className="mt-7 space-y-3">
          <input
            ref={inputRef}
            id="unlock-password"
            type="password" required value={password} disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="主密码"
            aria-label="主密码"
            className="field secret py-2.5 text-center"
          />
          <button
            type="submit" disabled={busy || password.length === 0}
            className="btn btn-primary w-full py-2.5"
          >
            {busy && <IconSpinner size={15} />}
            {busy ? '解锁中…' : '解锁'}
          </button>
        </form>}

        {error && (
          <p role="alert" className="mt-4 flex items-start justify-center gap-2 text-sm text-[var(--risk)]">
            <IconAlert size={15} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}

      </div>
    </div>
  );
}

/** 只用于展示的主机名 —— 真正的解析在 Rust 侧，这里不参与逻辑 */
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function messageOf(err: unknown): string {
  const kind = (err as { kind?: string } | null)?.kind;
  switch (kind) {
    case 'network': return '连不上服务器';
    case 'timeout': return '服务器响应超时';
    case 'auth': return '主密码不正确';
    case 'rateLimited': return '尝试过于频繁，请稍后再试';
    default: return err instanceof Error ? err.message : '解锁失败';
  }
}
