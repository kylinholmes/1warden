import { useStoreSnapshot } from '@1warden/state/react';
import { type ReactNode } from 'react';
import type { ApplicationClient } from '../application/types';
import { applyPreferences, localPreferences } from '../account-preferences';
import { AutosaveStatus, useProfileDraft } from './ProfileAutosave';

export function SyncedPreferences({ client, children }: { client?: ApplicationClient; children: (onChange: () => void) => ReactNode }) {
  if (!client) return <>{children(() => {})}</>;
  return <ConnectedPreferences client={client}>{children}</ConnectedPreferences>;
}
function ConnectedPreferences({ client, children }: { client: ApplicationClient; children: (onChange: () => void) => ReactNode }) {
  const snapshot = useStoreSnapshot(client.subscribe, client.getSnapshot);
  const { store, preferences } = useProfileDraft(client);
  const ready = snapshot.status === 'unlocked' && snapshot.profileReady && !snapshot.profileError && !snapshot.profileSettingsError;
  // Only actual user edits enqueue a write; receiving a projection never does.
  const edited = () => store.editPreferences(localPreferences());
  return <div className="space-y-4">
    <fieldset disabled={!ready} className="min-w-0 space-y-6">{children(edited)}</fieldset>
    <div className="border-t border-[var(--border-subtle)] pt-1">
      <AutosaveStatus field={preferences} retry={() => { void store.retry('preferences'); }} discard={() => { store.discard('preferences'); applyPreferences(store.getSnapshot().preferences.value); }} />
      <p className="mt-2 text-xs text-[var(--ink-tertiary)]">明暗模式、配色和侧栏分组自动加密同步。快速搜索与快捷键仅保存在各设备。</p>
      {!ready && <p className="mt-2 text-xs text-[var(--ink-secondary)]">等待保险库完成同步后即可修改。</p>}
      {snapshot.profileSettingsError && <p role="alert" className="mt-2 text-xs text-[var(--risk)]">{snapshot.profileSettingsError}</p>}
    </div>
  </div>;
}
