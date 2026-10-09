import { useLocalStore, useStoreField, useStoreSnapshot } from '@1warden/state/react';
import { useEffect, useRef } from 'react';
import type { ApplicationClient } from '../application/types';
import { ProfileAvatar } from './ProfileAvatar';
import { loadProfileAvatar } from './profile-avatar';
import { AvatarCropper } from './AvatarCropper';
import { AutosaveStatus, useProfileDraft } from './ProfileAutosave';

export function ProfileEditor({ client }: { client: ApplicationClient }) {
  const snapshot = useStoreSnapshot(client.subscribe, client.getSnapshot);
  const { store, profile: field } = useProfileDraft(client);
  const draft = field.value;
  const viewStore = useLocalStore(() => {
    const processing = false;
    const cropImage = (null) as HTMLImageElement | null;
    const error = (null) as string | null;
    return { processing, cropImage, error };
  });
  const [processing, setProcessing] = useStoreField(viewStore, 'processing');
  const [cropImage, setCropImage] = useStoreField(viewStore, 'cropImage');
  const [error, setError] = useStoreField(viewStore, 'error');
  const fileInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const chooseButton = useRef<HTMLButtonElement>(null);
  useEffect(() => () => { generation.current++; }, []);
  const update = store.editProfile;
  async function choose(file: File) {
    const epoch = ++generation.current;
    setProcessing(true); setError(null);
    try {
      const image = await loadProfileAvatar(file);
      if (epoch === generation.current) setCropImage(image);
    } catch (e) { if (epoch === generation.current) setError(e instanceof Error ? e.message : '头像处理失败'); }
    finally { if (epoch === generation.current) setProcessing(false); }
  }
  const unavailable = snapshot.status !== 'unlocked' || !snapshot.profileReady || !!snapshot.profileError || !!snapshot.profileSettingsError;
  const disabled = processing || unavailable;
  return <section className="mb-6" aria-labelledby="profile-heading">
    <h2 id="profile-heading" className="sr-only">个人资料编辑</h2>
    <div className="card p-3">
      <div className="flex flex-wrap items-center gap-3">
        <ProfileAvatar profile={draft} fallback={snapshot.account?.email ?? ''} className="h-14 w-14 text-xl" />
        <div className="min-w-0 flex-1 space-y-2">
          <button ref={chooseButton} type="button" className="btn btn-quiet" disabled={disabled} onClick={() => fileInput.current?.click()}>{processing ? '正在处理…' : '选择头像'}</button>
          {draft.avatarDataUrl && <button type="button" className="btn btn-ghost ml-1" disabled={disabled} onClick={() => update({ avatarDataUrl: null })}>移除</button>}
          <p className="text-xs text-[var(--ink-tertiary)]">JPG、PNG 或 WebP，可拖动和缩放裁剪</p>
        </div>
        <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" aria-label="选择头像图片" className="sr-only" tabIndex={-1} disabled={disabled}
          onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void choose(file); }} />
      </div>
      {cropImage && !unavailable && <AvatarCropper key={cropImage.src} image={cropImage} onCancel={() => {
        setCropImage(null); chooseButton.current?.focus({ preventScroll: true });
      }} onConfirm={avatarDataUrl => {
        update({ avatarDataUrl }); void store.flush(); setCropImage(null); chooseButton.current?.focus({ preventScroll: true });
      }} />}
      <label htmlFor="profile-name" className="mt-4 mb-1 block text-xs font-medium text-[var(--violet)]">显示名称</label>
      <input id="profile-name" className="field" maxLength={80} value={draft.displayName} placeholder="怎么称呼你" disabled={disabled}
        onChange={(e) => update({ displayName: e.target.value })} onBlur={() => { void store.flush(); }} />
      <p className="mt-2 text-xs text-[var(--ink-tertiary)]">头像和名称随保险库加密同步，并缓存在本机供锁定时显示。</p>
      {!snapshot.profileReady && <p role="status" className="mt-2 text-xs text-[var(--ink-secondary)]">{snapshot.syncing ? '正在同步个人资料…' : '个人资料尚未完成同步，请重新解锁后再编辑。'}</p>}
      {(error || snapshot.profileError || snapshot.profileSettingsError) && <p role="alert" className="mt-2 text-xs text-[var(--risk)]">{error || snapshot.profileError || snapshot.profileSettingsError}</p>}
      <AutosaveStatus field={field} retry={() => { void store.retry('profile'); }} discard={() => store.discard('profile')} />
    </div>
  </section>;
}
