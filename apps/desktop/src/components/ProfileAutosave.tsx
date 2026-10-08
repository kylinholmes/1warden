import { useStoreSnapshot } from '@1warden/state/react';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { ApplicationClient } from '../application/types';
import { createProfileAutosave, type ProfileAutosave, type SaveField } from '../profile-autosave';

const Context = createContext<ProfileAutosave | null>(null);
export function ProfileAutosaveProvider({ client, children }: { client: ApplicationClient; children: ReactNode }) {
  const store = useMemo(() => createProfileAutosave(client), [client]);
  useEffect(() => {
    store.start();
    const flush = () => { void store.flush(); };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); store.stop(); };
  }, [store]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export const useProfileAutosave = () => useContext(Context);
export function useProfileDraft(client: ApplicationClient) {
  const provided = useProfileAutosave();
  // Standalone previews share the same logic without requiring the whole App tree.
  const own = useMemo(() => provided ?? createProfileAutosave(client), [client, provided]);
  useEffect(() => { if (!provided) { own.start(); return () => { void own.flush(); own.stop(); }; } }, [own, provided]);
  const state = useStoreSnapshot(own.subscribe, own.getSnapshot);
  return { store: own, ...state };
}
export function AutosaveStatus({ field, retry, discard }: { field: SaveField<unknown>; retry: () => void; discard: () => void }) {
  return <div className="mt-3 text-xs" aria-live="polite">
    <p role="status" className={field.error ? 'text-[var(--risk)]' : 'text-[var(--ink-tertiary)]'}>
      {({ idle: '修改后自动加密保存', pending: '等待自动保存…', saving: '正在保存…', saved: '已同步', error: '保存失败，修改已保留在当前应用中' })[field.status]}
    </p>
    {field.error && <div role="alert" className="mt-2 text-[var(--risk)]"><p>{field.error}</p>
      <div className="mt-2 flex flex-wrap gap-2"><button className="btn btn-quiet" onClick={retry}>重试保存</button><button className="btn btn-ghost" onClick={discard}>放弃修改</button></div>
    </div>}
  </div>;
}
