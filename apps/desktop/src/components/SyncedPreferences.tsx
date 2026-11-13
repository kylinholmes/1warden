import { useStoreSnapshot } from '@1warden/state/react';
import { type ReactNode } from 'react';
import type { ProfilePreferences } from '@1warden/vault';
import type { ApplicationClient } from '../application/types';
import { applyPreferences, localPreferences } from '../account-preferences';
import { AutosaveStatus, useProfileDraft } from './ProfileAutosave';

type PreferenceChange = (patch: Partial<ProfilePreferences>) => void;
export function SyncedPreferences({ client, children }: { client?: ApplicationClient; children: (onChange: PreferenceChange) => ReactNode }) {
  if (!client) return <>{children(() => {})}</>;
  return <ConnectedPreferences client={client}>{children}</ConnectedPreferences>;
}
function ConnectedPreferences({ client, children }: { client: ApplicationClient; children: (onChange: PreferenceChange) => ReactNode }) {
  const snapshot = useStoreSnapshot(client.subscribe, client.getSnapshot);
  const { store, preferences } = useProfileDraft(client);
  const editable = store.canEditPreferences();
  // Only actual user edits enqueue a write; receiving a projection never does.
  const edited: PreferenceChange = patch => store.editPreferences(patch, localPreferences());
  return <div className="space-y-4">
    <fieldset disabled={!editable} className="min-w-0 space-y-6">{children(edited)}</fieldset>
    <div className="border-t border-[var(--border-subtle)] pt-1">
      <AutosaveStatus field={preferences} canDiscardPending={!snapshot.syncing && (!snapshot.profileReady || !!snapshot.syncError || !!snapshot.profileError || !!snapshot.profileSettingsError)}
        retry={() => { void store.retry('preferences'); }} discard={() => { store.discard('preferences'); applyPreferences(store.getSnapshot().preferences.value); }} />
      <p className="mt-2 text-xs text-[var(--ink-tertiary)]">明暗模式、配色、图标样式和侧栏分组自动加密同步。快速搜索与快捷键仅保存在各设备。</p>
      {editable && preferences.status === 'pending' && (snapshot.syncing || !snapshot.profileReady) && <p className="mt-2 text-xs text-[var(--ink-secondary)]">已在本机生效，同步完成后保存。</p>}
      {(snapshot.syncError || snapshot.profileError || snapshot.profileSettingsError) && <p role="alert" className="mt-2 text-xs text-[var(--risk)]">{snapshot.profileSettingsError || snapshot.profileError || snapshot.syncError}</p>}
    </div>
  </div>;
}
