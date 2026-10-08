import { useStoreSnapshot } from '@1warden/state/react';

import type { ApplicationClient } from '../application/types';
import { useAccountMetadata } from './AccountMetadata';

export function UserDetails({ client }: { client: ApplicationClient }) {
  const snapshot = useStoreSnapshot(client.subscribe, client.getSnapshot);
  const metadata = useAccountMetadata();
  const devices = snapshot.profileSettings?.devices ?? [];
  const date = (value: number) => new Date(value).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return <div className="mb-6 space-y-6">
    <section aria-labelledby="account-devices-heading">
      <h2 id="account-devices-heading" className="sr-only">登录设备列表</h2>
      <p className="mt-1 text-xs text-[var(--ink-tertiary)]">仅记录使用过此账户的 1Warden 客户端，不表示当前在线，也不用于远程退出。</p>
      <div className="card mt-3 divide-y divide-[var(--border-subtle)] px-3">
        {devices.map(device => <div key={device.id} className="py-3">
          <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{device.name}</span>
            {metadata?.device?.id === device.id && <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs text-[var(--accent)]">本机</span>}</div>
          <p className="mt-1 text-xs text-[var(--ink-secondary)]">最近使用 {date(device.lastSeen)}</p>
          <p className="mt-1 text-xs text-[var(--ink-tertiary)]">首次记录 {date(device.firstSeen)} · {device.id.slice(0, 8)}</p>
        </div>)}
        {!devices.length && <p className="py-3 text-sm text-[var(--ink-secondary)]">{metadata?.busy ? '正在记录本机…' : '暂无设备记录'}</p>}
      </div>
      <p className="mt-2 text-xs text-[var(--ink-tertiary)]">解锁后更新，最多每小时记录一次；按资料容量保留最近使用的设备（最多 10 台）。</p>
      {(metadata?.error || snapshot.profileSettingsError) && <div className="mt-2 text-xs text-[var(--risk)]" role="alert">
        <p>{snapshot.profileSettingsError || metadata?.error}</p>
        {metadata?.error && <button type="button" className="btn btn-quiet mt-2" disabled={metadata.busy} onClick={metadata.retry}>重试记录本机</button>}
      </div>}
    </section>
    <p className="text-xs text-[var(--ink-tertiary)]">这些信息保存在保险库的特殊加密资料记录中。1Warden 隐藏这条记录；其他 Bitwarden 客户端可能将它显示为安全笔记。</p>
  </div>;
}
