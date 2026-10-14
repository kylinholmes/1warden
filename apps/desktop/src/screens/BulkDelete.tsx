import { useEffect, useId, useRef } from 'react';
import { useLocalStore, useStoreField, useStoreSnapshot } from '@1warden/state/react';
import { IconSpinner } from '@1warden/ui';
import type { BulkDeletePreview, BulkDeleteResult, BulkDeleteScope } from '@1warden/vault';
import type { ApplicationClient, ApplicationSnapshot } from '../application/types';

function ownerOf(snapshot: ApplicationSnapshot): string {
  return JSON.stringify([snapshot.status, snapshot.account?.serverUrl, snapshot.account?.email, snapshot.account?.userId]);
}

/** The UI holds only safe preview metadata; the vault owner binds the token to IDs. */
export function BulkDeletePanel({ client, scope, onCompleted, onBusyChange, disabled = false }: { client: ApplicationClient; scope: BulkDeleteScope;
  onCompleted?: (result: BulkDeleteResult) => void; onBusyChange?: (busy: boolean) => void; disabled?: boolean }) {
  const snapshot = useStoreSnapshot(client.subscribe, client.getSnapshot);
  const owner = ownerOf(snapshot);
  const titleId = useId();
  const request = useRef(0);
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange;
  const store = useLocalStore(() => ({ owner: '', preview: null as BulkDeletePreview | null, result: null as BulkDeleteResult | null,
    busy: null as 'preview' | 'commit' | null, acknowledged: false, error: null as string | null, attempted: false }));
  const [stateOwner] = useStoreField(store, 'owner');
  const [storedPreview] = useStoreField(store, 'preview');
  const [storedResult] = useStoreField(store, 'result');
  const [busy] = useStoreField(store, 'busy');
  const [acknowledged, setAcknowledged] = useStoreField(store, 'acknowledged');
  const [storedError] = useStoreField(store, 'error');
  const [attempted] = useStoreField(store, 'attempted');
  const unlocked = snapshot.status === 'unlocked' && !!snapshot.account;
  const current = stateOwner === owner && unlocked;
  const preview = current && storedPreview?.scope === scope ? storedPreview : null;
  const result = current ? storedResult : null;
  const error = current ? storedError : null;
  const permanent = scope === 'trash';

  useEffect(() => {
    let expectedOwner = ownerOf(client.getSnapshot());
    function reset() {
      request.current++;
      store.setState({ owner: expectedOwner, preview: null, result: null, busy: null, acknowledged: false, error: null, attempted: false });
    }
    reset();
    // Observe every session transition, even lock/unlock in a single React batch.
    const unsubscribe = client.subscribe(() => {
      const next = ownerOf(client.getSnapshot());
      if (next !== expectedOwner) { expectedOwner = next; reset(); }
    });
    return () => { request.current++; unsubscribe(); busyCallback.current?.(false); };
  }, [client, scope, store]);

  useEffect(() => { busyCallback.current?.(!!busy || !!preview); }, [busy, preview]);

  function stillCurrent(version: number, source: string) {
    return request.current === version && ownerOf(client.getSnapshot()) === source;
  }
  async function loadPreview() {
    if (store.getState().busy || disabled || !unlocked) return;
    const version = ++request.current; const source = ownerOf(client.getSnapshot());
    store.setState({ owner: source, busy: 'preview', preview: null, result: null, acknowledged: false, error: null, attempted: true });
    try {
      const next = await client.previewBulkDelete(scope);
      if (stillCurrent(version, source)) store.setState({ preview: next });
    } catch (cause) {
      if (stillCurrent(version, source)) store.setState({ error: cause instanceof Error ? cause.message : '无法载入清理预览，请重试' });
    } finally {
      if (stillCurrent(version, source)) store.setState({ busy: null });
    }
  }
  function cancel() {
    if (store.getState().busy) return;
    request.current++;
    store.setState({ preview: null, acknowledged: false, error: null, attempted: false });
  }
  async function confirm() {
    const state = store.getState(); const plan = state.preview;
    if (state.busy || !plan || plan.scope !== scope || plan.count === 0 || !unlocked
      || state.owner !== ownerOf(client.getSnapshot()) || (permanent && !state.acknowledged)) return;
    const version = ++request.current; const source = state.owner;
    // Remove the token before awaiting: retries always start with a fresh preview.
    store.setState({ busy: 'commit', preview: null, error: null, acknowledged: false });
    try {
      const outcome = await client.commitBulkDelete(plan.token);
      if (!stillCurrent(version, source)) return;
      store.setState({ result: outcome });
      onCompleted?.(outcome);
    } catch (cause) {
      if (stillCurrent(version, source)) store.setState({ error: cause instanceof Error ? cause.message : '清理未完成，请同步后重新预览' });
    } finally {
      if (stillCurrent(version, source)) store.setState({ busy: null });
    }
  }

  return <section className="card p-5" aria-labelledby={titleId} aria-busy={!!busy}>
    <h2 id={titleId} className="text-md font-semibold">{permanent ? '清空回收站' : '批量移到回收站'}</h2>
    <p className="mt-2 text-sm leading-relaxed text-[var(--ink-secondary)]">{permanent
      ? '永久删除当前账户回收站中的全部个人记录，删除后无法恢复。'
      : '将当前账户的全部个人记录（包括归档）移到回收站，之后可恢复。'}个人资料和组织记录会保留。</p>
    {preview && <div className="mt-4 space-y-3">
      <div className="break-words text-sm"><p className="font-medium">{preview.account.email}</p><p className="text-[var(--ink-secondary)]">{preview.account.serverUrl}</p></div>
      <p className="text-sm font-medium">{permanent ? '将永久删除' : '将移到回收站'} {preview.count} 条个人记录。</p>
      <p className="text-sm text-[var(--ink-secondary)]">{permanent ? '此操作无法恢复，附件也会一并删除。' : '这些记录可在回收站中恢复；服务器的回收站保留策略仍然适用。'}</p>
      {permanent && <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={acknowledged} disabled={!!busy} className="mt-0.5" onChange={event => setAcknowledged(event.target.checked)} />
        <span>我确认永久删除这些记录，并理解此操作无法恢复</span>
      </label>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-quiet" disabled={!!busy} onClick={cancel}>取消</button>
        <button type="button" className="btn btn-danger" disabled={!!busy || !preview.count || (permanent && !acknowledged)} onClick={() => { void confirm(); }}>
          {permanent ? '确认永久删除' : '确认移到回收站'}
        </button>
      </div>
    </div>}
    {busy && <p role="status" className="mt-4 flex items-center gap-2 text-sm"><IconSpinner size={15} />{busy === 'preview' ? '正在读取清理范围…' : '正在处理已确认的记录…'}</p>}
    {error && <p role="alert" className="mt-4 break-words text-sm text-[var(--risk)]">{error}</p>}
    {result && <div className="mt-4 space-y-3">
      <p role="status" className="text-sm">{permanent ? '已永久删除' : '已移到回收站'} {result.completed} 条；跳过 {result.skipped} 条已变化或不再符合范围的记录。</p>
      {result.failed.length > 0 && <div role="alert" className="text-sm text-[var(--risk)]">
        <p>有 {result.failed.length} 条记录需要检查。请先同步核实，再重新预览。</p>
        <ul className="mt-2 space-y-2">{result.failed.map((failed, index) => <li key={index} className="break-words">{failed.name}：{failed.reason}</li>)}</ul>
      </div>}
    </div>}
    {!preview && !busy && <button type="button" className="btn btn-quiet mt-4" disabled={disabled || !unlocked} onClick={() => { void loadPreview(); }}>
      {attempted ? '重新预览' : permanent ? '预览清空回收站' : '预览移到回收站'}
    </button>}
  </section>;
}
