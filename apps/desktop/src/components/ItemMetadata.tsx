import { useEffect, useId, useRef } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import { CopyButton, IconFolder, IconSpinner, TYPE_LABEL } from '@1warden/ui';
import type { VaultFolder } from '@1warden/vault';
import type { ApplicationClient, ItemDetailData } from '../application/types';
import { createAndAssignFolder, pendingFolderAssignment } from '../application/folder-assignment';

export function ItemFolderPicker({ client, item, folders, onOpenFolder, onError, onBusyChange, disabled = false }: {
  client: ApplicationClient; item: ItemDetailData; folders: readonly VaultFolder[];
  onOpenFolder?: ((id: string) => void) | undefined;
  onError?: ((message: string) => void) | undefined;
  onBusyChange?: ((busy: boolean) => void) | undefined;
  disabled?: boolean;
}) {
  const id = useId();
  const saving = useRef(false);
  const alive = useRef(true);
  const blocked = useRef(disabled);
  blocked.current = disabled;
  const callbacks = useRef({ onError, onBusyChange });
  callbacks.current = { onError, onBusyChange };
  const store = useLocalStore(() => ({ busy: false, error: null as string | null, creating: false, name: '' }));
  const [busy, setBusy] = useStoreField(store, 'busy');
  const [error, setError] = useStoreField(store, 'error');
  const [creating, setCreating] = useStoreField(store, 'creating');
  const [name, setName] = useStoreField(store, 'name');
  const folderId = item.summary.folderId;
  const missing = folderId !== null && !folders.some(folder => folder.id === folderId);
  useEffect(() => {
    alive.current = true;
    const pending = pendingFolderAssignment(client, item.summary.id);
    if (pending) {
      saving.current = true; setBusy(true); callbacks.current.onBusyChange?.(true);
      const finished = () => {
        if (!alive.current) return;
        saving.current = false; setBusy(false); callbacks.current.onBusyChange?.(false);
      };
      void pending.then(finished, finished);
    }
    return () => { alive.current = false; callbacks.current.onBusyChange?.(false); };
  }, [client, item.summary.id]);

  async function run(operation: () => Promise<unknown>, creatingFolder = false) {
    if (blocked.current || saving.current) return;
    const started = client.getSnapshot();
    const account = JSON.stringify(started.account);
    if (started.status !== 'unlocked' || !started.account) return;
    let sameAccount = true;
    // This operation subscription stays alive even when a revision remounts detail.
    const unsubscribe = client.subscribe(() => {
      const snapshot = client.getSnapshot();
      if (snapshot.status !== 'unlocked' || JSON.stringify(snapshot.account) !== account) sameAccount = false;
    });
    saving.current = true; setBusy(true); setError(null);
    callbacks.current.onBusyChange?.(true);
    try {
      await operation();
      if (alive.current && sameAccount) { setCreating(false); setName(''); }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '文件夹归类未能保存';
      if (alive.current && sameAccount) setError(message);
      // The global toast survives creation's detail remount. Boundary cancellation
      // messages do not disclose the old account's folder name.
      if (sameAccount || creatingFolder) callbacks.current.onError?.(message);
    } finally {
      unsubscribe(); saving.current = false;
      if (alive.current) { setBusy(false); callbacks.current.onBusyChange?.(false); }
    }
  }
  function move(target: string) {
    if ((target || null) === folderId) return;
    void run(() => client.moveToFolder(item.summary.id, target || null));
  }
  function create() {
    if (!name.trim()) { setError('请输入文件夹名称'); return; }
    void run(() => createAndAssignFolder(client, item.summary.id, name), true);
  }
  function cancelCreation() { if (!saving.current) { setCreating(false); setName(''); setError(null); } }
  return <div data-folder-organization className="mt-6 text-xs text-[var(--ink-tertiary)]">
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="flex shrink-0 items-center gap-1.5"><IconFolder size={13} />文件夹</label>
      <select id={id} data-item-folder aria-label="更改文件夹"
        className="min-w-0 max-w-[240px] rounded-md border border-[var(--border-subtle)] bg-transparent px-2 py-1 text-xs text-[var(--ink-secondary)]"
        value={folderId ?? ''} disabled={busy || disabled} aria-busy={busy}
        onChange={event => move(event.target.value)}>
        <option value="">未分类</option>
        {missing && <option value={folderId}>文件夹暂不可用</option>}
        {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.nameFailed ? '无法解密的文件夹' : folder.name}</option>)}
      </select>
      {!creating && <button type="button" disabled={busy || disabled} className="rounded px-1 py-1 hover:text-[var(--ink-secondary)] disabled:opacity-50"
        onClick={() => { setCreating(true); setError(null); }}>新建文件夹</button>}
      {!busy && folderId && !missing && onOpenFolder && <button type="button" disabled={disabled} className="rounded px-1 py-1 hover:text-[var(--ink-secondary)]"
        onClick={() => onOpenFolder(folderId)}>查看</button>}
      {busy && <span role="status" className="flex items-center gap-1.5"><IconSpinner size={12} />保存中…</span>}
    </div>
    {creating && <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); create(); }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelCreation(); } }}>
      <input autoFocus aria-label="新建文件夹名称" data-item-folder-name className="field min-w-0 flex-1 text-xs"
        placeholder="文件夹名称" value={name} disabled={busy || disabled} onChange={event => setName(event.target.value)} />
      <button type="submit" disabled={busy || disabled || !name.trim()} className="btn btn-ghost text-xs">创建并归类</button>
      <button type="button" disabled={busy} className="btn btn-ghost text-xs" onClick={cancelCreation}>取消</button>
    </form>}
    {error && <p role="alert" className="mt-2 text-[var(--risk)]">{error}</p>}
  </div>;
}

function date(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '未提供';
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export function ItemRecordInfo({ item }: { item: ItemDetailData }) {
  const store = useLocalStore(() => ({ error: null as string | null }));
  const [error, setError] = useStoreField(store, 'error');
  return <footer aria-label="记录信息" data-record-info
    className="mt-8 border-t border-[var(--border-subtle)] pt-4 text-xs leading-relaxed text-[var(--ink-tertiary)]">
    <div className="flex flex-wrap gap-x-5 gap-y-1">
      <p>创建时间 · {date(item.summary.createdAt)}</p>
      <p>更新时间 · {date(item.summary.updatedAt)}</p>
      {item.login?.passwordRevisionDate && <p>密码更新 · {date(item.login.passwordRevisionDate)}</p>}
    </div>
    <div className="mt-1 flex min-w-0 items-center gap-2">
      <span className="shrink-0">{TYPE_LABEL[item.summary.type] ?? '未知类型'} · 记录 ID</span>
      <span className="min-w-0 truncate select-all" title={item.summary.id}>{item.summary.id}</span>
      <CopyButton getValue={async () => item.summary.id} label="复制记录 ID" iconOnly iconSize={12}
        className="shrink-0 rounded p-1 hover:bg-[var(--surface-hover)] hover:text-[var(--ink-secondary)]"
        onError={() => setError('记录 ID 复制失败，请重试')} />
    </div>
    {error && <p role="alert" className="mt-1 text-[var(--risk)]">{error}</p>}
  </footer>;
}
