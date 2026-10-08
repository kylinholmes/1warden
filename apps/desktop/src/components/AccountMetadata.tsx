import { createStore, type StoreApi } from '@1warden/state';
import { useLocalStore, useStoreField, useStore, useStoreSnapshot } from '@1warden/state/react';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, type ReactNode } from 'react';
import type { ProfileDeviceInput } from '@1warden/vault';
import type { ApplicationClient } from '../application/types';
import { createPreferencesProjection, applyPreferences, localPreferences } from '../account-preferences';
import { describeDevice, deviceIdentity } from '../device-info';
import { useProfileAutosave } from './ProfileAutosave';

interface MetadataState { device: ProfileDeviceInput | null; error: string | null; busy: boolean; attempt: number; retry: () => void }
const MetadataContext = createContext<StoreApi<MetadataState> | null>(null);
const emptyMetadata = createStore<MetadataState>(() => ({ device: null, error: null, busy: false, attempt: 0, retry() {} }));
export function useAccountMetadata() {
  const store = useContext(MetadataContext); const state = useStore(store ?? emptyMetadata);
  return store ? state : null;
}
const storage = { getItem: (key: string) => localStorage.getItem(key), setItem: (key: string, value: string) => localStorage.setItem(key, value), removeItem: (key: string) => localStorage.removeItem(key) };

export function AccountMetadataProvider({ client, children }: { client: ApplicationClient; children: ReactNode }) {
  const snapshot = useStoreSnapshot(client.subscribe, client.getSnapshot);
  const autosave = useProfileAutosave();
  const projection = useMemo(() => createPreferencesProjection({ storage, readLocal: localPreferences, apply: applyPreferences }), [client]);
  useLayoutEffect(() => {
    projection(snapshot);
    const pending = autosave?.pendingPreferences();
    if (pending && snapshot.status === 'unlocked') applyPreferences(pending);
  }, [projection, snapshot, autosave]);
  const local = useMemo(() => {
    try { return { device: describeDevice(deviceIdentity(storage, () => crypto.randomUUID()), client.capabilities, navigator.userAgent, navigator.maxTouchPoints), error: null }; }
    catch { return { device: null, error: '本机存储不可用，暂不能记录稳定的设备标识' }; }
  }, [client]);
  const viewStore = useLocalStore<MetadataState>(() => ({ device: local.device, error: local.error, busy: false, attempt: 0,
    retry: () => viewStore.setState(s => ({ attempt: s.attempt + 1 })),
  }));
  const [, setError] = useStoreField(viewStore, 'error');
  const [, setBusy] = useStoreField(viewStore, 'busy');
  const [attempt] = useStoreField(viewStore, 'attempt');
  useLayoutEffect(() => { viewStore.setState({ device: local.device, error: local.error }); }, [viewStore, local]);
  const identity = snapshot.account ? JSON.stringify([snapshot.account.serverUrl, snapshot.account.email]) : null;
  const ready = snapshot.status === 'unlocked' && snapshot.profileReady && !snapshot.profileError && !snapshot.profileSettingsError;
  useEffect(() => {
    setError(local.error); setBusy(false);
    if (!identity || !ready || !local.device) return;
    let alive = true;
    // Let StrictMode tear down its probe mount before scheduling a real write.
    void Promise.resolve().then(async () => {
      if (!alive) return;
      setBusy(true);
      try { await client.recordDevice(local.device!); }
      catch (e) { if (alive) setError(e instanceof Error ? e.message : '设备记录未能同步'); }
      finally { if (alive) setBusy(false); }
    });
    return () => { alive = false; };
  }, [client, identity, ready, local, attempt]);
  return <MetadataContext.Provider value={viewStore}>{children}</MetadataContext.Provider>;
}
