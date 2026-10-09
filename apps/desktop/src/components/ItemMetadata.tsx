import { useEffect, useId, useRef } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import { CopyField, IconChevronDown, IconFolder, IconPlus, IconSpinner, TYPE_LABEL } from '@1warden/ui';
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
  const manageButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const saving = useRef(false);
  const alive = useRef(true);
  const blocked = useRef(disabled);
  blocked.current = disabled;
  const callbacks = useRef({ onError, onBusyChange });
  callbacks.current = { onError, onBusyChange };
  const store = useLocalStore(() => ({ busy: false, error: null as string | null, changing: false, creating: false, name: '' }));
  const [busy, setBusy] = useStoreField(store, 'busy');
  const [error, setError] = useStoreField(store, 'error');
  const [changing, setChanging] = useStoreField(store, 'changing');
  const [creating, setCreating] = useStoreField(store, 'creating');
  const [name, setName] = useStoreField(store, 'name');
  const folderId = item.summary.folderId;
  const folder = folders.find(folder => folder.id === folderId);
  const missing = folderId !== null && !folder;
  const folderName = folderId === null ? '未分类' : missing ? '文件夹暂不可用'
    : folder?.nameFailed ? '无法解密的文件夹' : folder?.name ?? '未分类';
  useEffect(() => {
    if (restoreFocus.current && !busy && !disabled && !changing) {
      restoreFocus.current = false;
      manageButton.current?.focus();
    }
  }, [busy, disabled, changing]);
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
      if (alive.current && sameAccount) { restoreFocus.current = true; setCreating(false); setChanging(false); setName(''); }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '文件夹归类未能保存';
      // The global toast survives creation's detail remount. Boundary cancellation
      // messages do not disclose the old account's folder name.
      if (sameAccount || creatingFolder) {
        if (callbacks.current.onError) callbacks.current.onError(message);
        else if (alive.current && sameAccount) setError(message);
      }
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
  function cancelCreation() {
    if (!saving.current) { setCreating(false); setName(''); setError(null); manageButton.current?.focus(); }
  }
  function closeEditor() {
    if (!saving.current) { setChanging(false); setCreating(false); setName(''); setError(null); manageButton.current?.focus(); }
  }
  return <div data-folder-organization data-folder-id={folderId ?? ''} aria-busy={busy} className="py-3 text-xs text-[var(--ink-secondary)]">
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex shrink-0 items-center gap-1.5 text-sm text-[var(--ink-primary)]"><IconFolder size={14} />文件夹</span>
      {folderId && !missing && onOpenFolder
        ? <button type="button" disabled={busy || disabled} className="ml-auto flex min-w-0 items-center gap-1 rounded px-1 py-2 hover:text-[var(--accent)]"
          title={folderName} aria-label={`打开文件夹 ${folderName}`} onClick={() => onOpenFolder(folderId)}>
          <span className="truncate">{folderName}</span><IconChevronDown size={12} className="shrink-0 -rotate-90" />
        </button>
        : <span className="ml-auto min-w-0 truncate text-[var(--ink-tertiary)]" title={folderName}>{folderName}</span>}
      <button ref={manageButton} type="button" disabled={busy || disabled} className="btn btn-ghost shrink-0 text-xs"
        aria-label={changing ? '完成文件夹归类' : '更改文件夹归类'} aria-expanded={changing} aria-controls={`${id}-editor`}
        onClick={() => { if (changing) closeEditor(); else { setChanging(true); setError(null); } }}>{changing ? '完成' : '更改'}</button>
    </div>
    <div id={`${id}-editor`} hidden={!changing} onKeyDown={event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (creating) cancelCreation(); else closeEditor();
      }
    }}>
      {changing && <>
        {!creating ? <div className="mt-3 flex flex-wrap items-center gap-2">
          <select id={id} data-item-folder aria-label="更改文件夹" autoFocus
            className="field min-w-0 flex-1 basis-40 text-xs"
            value={folderId ?? ''} disabled={busy || disabled} aria-busy={busy}
            onChange={event => move(event.target.value)}>
            <option value="">未分类</option>
            {missing && <option value={folderId}>文件夹暂不可用</option>}
            {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.nameFailed ? '无法解密的文件夹' : folder.name}</option>)}
          </select>
          <button type="button" disabled={busy || disabled} className="btn btn-quiet gap-1.5 text-xs"
            onClick={() => { setCreating(true); setError(null); }}><IconPlus size={13} />新建文件夹</button>
        </div> : <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); create(); }}>
          <input autoFocus aria-label="新建文件夹名称" data-item-folder-name className="field min-w-0 flex-1 basis-40 text-xs"
            placeholder="文件夹名称" value={name} disabled={busy || disabled} onChange={event => setName(event.target.value)} />
          <button type="submit" disabled={busy || disabled || !name.trim()} className="btn btn-quiet text-xs">创建并归类</button>
          <button type="button" disabled={busy} className="btn btn-ghost text-xs" onClick={cancelCreation}>取消</button>
        </form>}
      </>}
    </div>
    {busy && <p role="status" className="mt-2 flex items-center gap-1.5"><IconSpinner size={12} />保存中…</p>}
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
  return <footer aria-label="记录信息" data-record-info
    className="mt-8 border-t border-[var(--border-subtle)] pt-4 text-xs leading-relaxed text-[var(--ink-tertiary)]">
    <div className="flex flex-wrap gap-x-5 gap-y-1">
      <p>创建时间 · {date(item.summary.createdAt)}</p>
      <p>更新时间 · {date(item.summary.updatedAt)}</p>
      {item.login?.passwordRevisionDate && <p>密码更新 · {date(item.login.passwordRevisionDate)}</p>}
    </div>
    <div className="mt-1 flex min-w-0 items-center gap-2">
      <span className="shrink-0">{TYPE_LABEL[item.summary.type] ?? '未知类型'} · 记录 ID</span>
      <CopyField getValue={async () => item.summary.id} label="记录 ID">
        <span className="min-w-0 flex-1 truncate">{item.summary.id}</span>
      </CopyField>
    </div>
  </footer>;
}
