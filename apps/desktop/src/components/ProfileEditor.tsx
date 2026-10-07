import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { UserProfile } from '@coffer/vault';
import type { ApplicationClient } from '../application/types';
import { ProfileAvatar } from './ProfileAvatar';
import { prepareProfileAvatar } from './profile-avatar';

export function ProfileEditor({ client }: { client: ApplicationClient }) {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [draft, setDraft] = useState<UserProfile>(snapshot.profile ?? { displayName: '', avatarDataUrl: null });
  const [version, setVersion] = useState(snapshot.profileVersion);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => {
    if (!dirty) { setDraft(snapshot.profile ?? { displayName: '', avatarDataUrl: null }); setVersion(snapshot.profileVersion); }
  }, [snapshot.profile, snapshot.profileVersion, dirty]);
  function update(patch: Partial<UserProfile>) { setDraft((p) => ({ ...p, ...patch })); setDirty(true); setSaved(false); setError(null); }
  async function choose(file: File) {
    const epoch = ++generation.current;
    setProcessing(true); setError(null); setSaved(false);
    try {
      const avatarDataUrl = await prepareProfileAvatar(file);
      if (epoch === generation.current) update({ avatarDataUrl });
    } catch (e) { if (epoch === generation.current) setError(e instanceof Error ? e.message : '头像处理失败'); }
    finally { if (epoch === generation.current) setProcessing(false); }
  }
  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try { await client.saveProfile(draft, version); setDirty(false); setSaved(true); }
    catch (e) { setError(e instanceof Error ? e.message : '个人资料保存失败'); }
    finally { setBusy(false); }
  }
  const disabled = busy || processing || snapshot.status !== 'unlocked' || !snapshot.profileReady;
  return <section className="mb-6" aria-labelledby="profile-heading">
    <h3 id="profile-heading" className="mb-3 text-sm font-semibold">个人资料</h3>
    <div className="card p-3">
      <div className="flex flex-wrap items-center gap-3">
        <ProfileAvatar profile={draft} fallback={snapshot.account?.email ?? ''} className="h-14 w-14 text-xl" />
        <div className="min-w-0 flex-1 space-y-2">
          <button type="button" className="btn btn-quiet" disabled={disabled} onClick={() => fileInput.current?.click()}>{processing ? '正在处理…' : '选择头像'}</button>
          {draft.avatarDataUrl && <button type="button" className="btn btn-ghost ml-1" disabled={disabled} onClick={() => update({ avatarDataUrl: null })}>移除</button>}
          <p className="text-xs text-[var(--ink-tertiary)]">JPG、PNG 或 WebP，自动裁成方形</p>
        </div>
        <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" aria-label="选择头像图片" className="sr-only" tabIndex={-1}
          onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void choose(file); }} />
      </div>
      <label htmlFor="profile-name" className="mt-4 mb-1 block text-xs font-medium text-[var(--violet)]">显示名称</label>
      <input id="profile-name" className="field" maxLength={80} value={draft.displayName} placeholder="怎么称呼你" disabled={disabled}
        onChange={(e) => update({ displayName: e.target.value })} />
      <p className="mt-2 text-xs text-[var(--ink-tertiary)]">头像和名称随保险库加密同步，并缓存在本机供锁定时显示。</p>
      {!snapshot.profileReady && <p role="status" className="mt-2 text-xs text-[var(--ink-secondary)]">{snapshot.syncing ? '正在同步个人资料…' : '个人资料尚未完成同步，请重新解锁后再编辑。'}</p>}
      {(error || snapshot.profileError) && <p role="alert" className="mt-2 text-xs text-[var(--risk)]">{error || snapshot.profileError}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary" disabled={disabled || !dirty || !!snapshot.profileError} onClick={() => { void save(); }}>{busy ? '正在保存…' : '保存个人资料'}</button>
        {saved && <span role="status" className="text-xs text-[var(--safe)]">已保存</span>}
      </div>
    </div>
  </section>;
}
