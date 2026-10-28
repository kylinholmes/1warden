import { useEffect, useRef } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import { IconSpinner, PageHeader, TYPE_LABEL } from '@1warden/ui';
import type { ApplicationClient, TrashItemSummary } from '../application/types';
import { BulkDeletePanel } from './BulkDelete';

/** Deleted items stay separate from normal vault/search results and secret projections. */
export function TrashView({ client, onBack, onBusyChange }: {
  client: ApplicationClient; onBack: () => void; onBusyChange?: (busy: boolean) => void;
}) {
  const store = useLocalStore(() => ({ items: null as TrashItemSummary[] | null, loading: true,
    restoring: null as string | null, error: null as string | null, restored: null as string | null, cleaning: false }));
  const [items, setItems] = useStoreField(store, 'items');
  const [loading, setLoading] = useStoreField(store, 'loading');
  const [restoring, setRestoring] = useStoreField(store, 'restoring');
  const [error, setError] = useStoreField(store, 'error');
  const [restored, setRestored] = useStoreField(store, 'restored');
  const [cleaning, setCleaning] = useStoreField(store, 'cleaning');
  const request = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const restoreButtons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | 'refresh' | null>(null);
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange;
  useEffect(() => { busyCallback.current?.(cleaning || !!restoring); }, [cleaning, restoring]);
  useEffect(() => () => { busyCallback.current?.(false); }, []);
  useEffect(() => {
    if (loading || restoring || !pendingFocus.current) return;
    const target = pendingFocus.current === 'refresh' ? refreshButton.current : restoreButtons.current.get(pendingFocus.current);
    (target && !target.disabled ? target : heading.current)?.focus({ preventScroll: true });
    pendingFocus.current = null;
  }, [items, loading, restoring, error]);
  function back() { if (!store.getState().cleaning && !store.getState().restoring) onBack(); }
  async function load() {
    if (store.getState().restoring || client.getSnapshot().status !== 'unlocked') return;
    const current = ++request.current;
    setLoading(true); setError(null);
    try { const list = await client.listTrash(); if (current === request.current) setItems(list); }
    catch (cause) { if (current === request.current) setError(cause instanceof Error ? cause.message : '无法载入回收站，请重试'); }
    finally { if (current === request.current) setLoading(false); }
  }
  useEffect(() => {
    const owner = () => {
      const snapshot = client.getSnapshot();
      return JSON.stringify([snapshot.status, snapshot.account?.serverUrl, snapshot.account?.email, snapshot.account?.userId]);
    };
    let currentOwner = owner();
    heading.current?.focus({ preventScroll: true }); void load();
    const unsubscribe = client.subscribe(() => {
      const next = owner();
      if (next === currentOwner) return;
      currentOwner = next; request.current++;
      pendingFocus.current = null;
      store.setState({ items: null, loading: false, restoring: null, error: null, restored: null, cleaning: false });
      void load();
    });
    return () => { request.current++; unsubscribe(); };
  }, [client]);
  async function restore(item: TrashItemSummary) {
    if (item.restoreError || store.getState().restoring || store.getState().loading || store.getState().cleaning) return;
    const current = ++request.current;
    pendingFocus.current = item.id;
    setRestoring(item.id); setError(null); setRestored(null);
    try {
      await client.restoreItem(item.id);
      if (current !== request.current) return;
      const list = store.getState().items ?? [];
      const index = list.findIndex(record => record.id === item.id);
      const remaining = [...list.slice(index + 1), ...list.slice(0, index)].find(record => !record.restoreError);
      pendingFocus.current = remaining?.id ?? 'title';
      setItems(list => list?.filter(record => record.id !== item.id) ?? []);
      setRestored(`已恢复「${item.name}」，可在保险库中查看。`);
    } catch (cause) { if (current === request.current) setError(cause instanceof Error ? cause.message : '恢复失败，请重试'); }
    finally { if (current === request.current) setRestoring(null); }
  }
  return <main aria-label="回收站" className="flex min-h-0 flex-1 flex-col">
    <PageHeader title="回收站" navigation onBack={back} backLabel="返回保险库"
      breadcrumbs={[{ label: '保险库', onSelect: back }, { label: '回收站' }]} />
    <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-8">
      <div className="mx-auto max-w-[680px]">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h1 ref={heading} tabIndex={-1} className="text-xl font-semibold outline-none">回收站</h1>
          <button ref={refreshButton} type="button" className="btn btn-quiet" disabled={loading || !!restoring || cleaning} onClick={() => { pendingFocus.current = 'refresh'; void load(); }}>刷新</button>
        </div>
        <p className="mb-5 text-sm text-[var(--ink-secondary)]">恢复后，条目会回到原来的文件夹。服务器可能按其保留策略清理回收站。</p>
        {error && <p role="alert" className="mb-4 break-words text-sm text-[var(--risk)]">{error}</p>}
        {restored && <p role="status" className="mb-4 break-words text-sm text-[var(--ink-secondary)]">{restored}</p>}
        {loading && <p role="status" className="flex items-center gap-2 text-sm"><IconSpinner size={15} />正在载入回收站…</p>}
        {!loading && !error && items?.length === 0 && <p className="text-sm text-[var(--ink-tertiary)]">回收站为空</p>}
        {!!items?.length && <ul className="card divide-y divide-[var(--border-subtle)]">
          {items.map(item => <li key={item.id} className="flex items-center gap-3 p-4">
            <div className="min-w-0 flex-1"><p className="break-words text-md">{item.nameFailed ? '无法解密' : item.name}</p>
              <p className="mt-1 text-xs text-[var(--ink-tertiary)]">{TYPE_LABEL[item.type] ?? '条目'}</p>
              {item.restoreError && <p className="mt-1 break-words text-xs text-[var(--risk)]">{item.restoreError}</p>}</div>
            <button ref={node => { if (node) restoreButtons.current.set(item.id, node); else restoreButtons.current.delete(item.id); }} type="button" className="btn btn-quiet shrink-0" aria-label={`恢复「${item.nameFailed ? '无法解密' : item.name}」`} disabled={!!item.restoreError || loading || !!restoring || cleaning} onClick={() => { void restore(item); }}>
              {restoring === item.id ? '恢复中…' : '恢复'}
            </button>
          </li>)}
        </ul>}
        <div className="mt-6"><BulkDeletePanel client={client} scope="trash" disabled={loading || !!restoring}
          onBusyChange={setCleaning} onCompleted={() => { setRestored(null); void load(); }} /></div>
      </div>
    </div>
  </main>;
}
