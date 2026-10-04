import { useState, useMemo, useCallback } from 'react';
import { VaultClient } from './vault-client';
import { Connect } from './screens/Connect';
import { VaultView } from './screens/VaultView';
import { Unlock } from './screens/Unlock';

type Phase = 'connect' | 'unlocked';

export function App() {
  const [phase, setPhase] = useState<Phase>('connect');
  const [error, setError] = useState<string | null>(null);

  // 自动锁定：空闲 15 分钟。外壳层还应监听系统休眠/锁屏 —— 那是 Tauri 侧的事。
  const client = useMemo(() => new VaultClient({
    autoLockMs: 15 * 60 * 1000,
    onLock: () => setPhase('connect'),
    onStatus: () => { /* 状态变化由 phase 表达，这里不需要额外处理 */ },
  }), []);

  const handleLock = useCallback(() => {
    client.lock();
    setPhase('connect');
  }, [client]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center">
          <p className="mb-3 text-[var(--text-lg)] font-medium text-[var(--risk)]">出错了</p>
          <p className="secret text-[var(--text-sm)] text-[var(--ink-secondary)]">{error}</p>
        </div>
      </div>
    );
  }

  if (phase === 'unlocked') {
    return <VaultView client={client} onLock={handleLock} />;
  }

  // 已经登录过（有账户）但被锁定时显示解锁屏，不显示完整的连接表单
  if (client.getSession().account) {
    return (
      <Unlock
        client={client}
        onUnlocked={() => setPhase('unlocked')}
        onDisconnect={() => { client.logout(); setPhase('connect'); }}
      />
    );
  }

  return <Connect client={client} onConnected={() => setPhase('unlocked')} />;
}

export function ErrorBoundary({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
