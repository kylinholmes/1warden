import { useLocalStore, useStoreField } from '@1warden/state/react';
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { UserProfile, VaultFolder } from '@1warden/vault';
import { FloatingPanel, IconDice, IconFolder, IconImport, IconItems, IconMore, IconPencil, IconPlus, IconSearch, IconShield, IconStar, IconTrash, NavDrawer, TypeIcon } from '@1warden/ui';
import { ProfileAccountMenu } from './ProfileAccountMenu';
import type { VaultCategory as Category } from '../screens/vault-presentation';

export interface SidebarProps {
  folders: readonly VaultFolder[];
  category: Category;
  onSelect: (c: Category) => void;
  counts: { all: number; favorites: number };
  onLogout: () => Promise<void>;
  onSwitchAccount: (account: { serverUrl: string; email: string } | null) => Promise<void>;
  account: string;
  profile: UserProfile | null;
  unlockedAccounts?: readonly string[];
  serverUrl: string;
  onOpenSettings: () => void;
  onOpenProfile: () => void;
  /** 生成器是浮层，不是一屏 —— 侧栏只负责把它叫出来，选中态跟着它的开合走 */
  generatorOpen: boolean;
  onOpenGenerator: () => void;
  /** 后台正在同步 —— 列表已可用，只是在更新 */
  syncing: boolean;
  /** 各类别的条目数，**只含 count > 0 的**（侧栏不渲染空类别） */
  /** 有内容的类型。`label` 来自共享词表 —— 不要再在这里查 `TYPE_LABEL` */
  typeCounts: { type: string; label: string; count: number }[];
  /** 设置里的开关 —— 关掉整节不显示 */
  showTypes: boolean;
  onCreateFolder: (name: string) => Promise<void>;
  onRenameFolder: (id: string, name: string) => Promise<void>;
  onDeleteFolder: (id: string) => Promise<void>;
}

const TYPE_COLLAPSE_KEY = '1warden.pref.sidebar.typesCollapsed';
const FOLDER_COLLAPSE_KEY = '1warden.pref.sidebar.foldersCollapsed';
function readCollapsed(key: string): boolean {
  try { return localStorage.getItem(key) === 'true'; } catch { return false; }
}
function persistCollapsed(key: string, value: boolean): void {
  try { localStorage.setItem(key, String(value)); } catch { /* Navigation still works when storage is unavailable. */ }
}

/** Session changes discard pending menus and drafts; collapse preferences contain no account data. */
export function Sidebar(props: SidebarProps) {
  return <SidebarContent key={`${props.serverUrl}:${props.account}`} {...props} />;
}

function SidebarContent(props: SidebarProps) {
  const store = useLocalStore(() => ({
    creating: false, menu: null as { id: string; trigger: HTMLButtonElement } | null,
    renaming: null as string | null, deleting: null as string | null,
    typesCollapsed: readCollapsed(TYPE_COLLAPSE_KEY), foldersCollapsed: readCollapsed(FOLDER_COLLAPSE_KEY),
  }));
  const [creating, setCreating] = useStoreField(store, 'creating');
  const [menu, setMenu] = useStoreField(store, 'menu');
  const [renaming, setRenaming] = useStoreField(store, 'renaming');
  const [deleting, setDeleting] = useStoreField(store, 'deleting');
  const [typesCollapsed, setTypesCollapsed] = useStoreField(store, 'typesCollapsed');
  const [foldersCollapsed, setFoldersCollapsed] = useStoreField(store, 'foldersCollapsed');
  const returnTo = useRef<HTMLButtonElement | null>(null);
  const newFolder = useRef<HTMLButtonElement>(null);
  function restoreFocus() {
    if (returnTo.current?.isConnected) returnTo.current.focus({ preventScroll: true });
  }
  function closeDraft() { setCreating(false); setRenaming(null); restoreFocus(); }
  function collapseFolders(value: boolean) {
    setFoldersCollapsed(value); persistCollapsed(FOLDER_COLLAPSE_KEY, value);
    if (value) { setMenu(null); setCreating(false); setRenaming(null); }
  }
  useEffect(() => {
    const existing = new Set(props.folders.map(folder => folder.id));
    if (menu && !existing.has(menu.id)) setMenu(null);
    if (renaming && !existing.has(renaming)) setRenaming(null);
    if (deleting && !existing.has(deleting)) setDeleting(null);
  }, [props.folders, menu, renaming, deleting]);

  const currentKey = props.generatorOpen ? 'generator'
    : props.category.kind === 'type' ? `type:${props.category.type}`
    : props.category.kind === 'folder' ? `folder:${props.category.id}` : props.category.kind;
  function onNavSelect(key: string): void {
    setMenu(null);
    if (key.startsWith('type:')) props.onSelect({ kind: 'type', type: key.slice(5) });
    else if (key.startsWith('folder:')) props.onSelect({ kind: 'folder', id: key.slice(7) });
    else if (key === 'generator') props.onOpenGenerator();
    else props.onSelect({ kind: key as 'all' | 'favorites' | 'security' | 'organization' | 'import' | 'trash' });
  }
  const menuFolder = menu && props.folders.find(folder => folder.id === menu.id);
  const deleteFolder = props.folders.find(folder => folder.id === deleting);
  return <>
    <NavDrawer className="app-sidebar below-titlebar" label="保险库导航"
      brand={<ProfileAccountMenu account={{ email: props.account, serverUrl: props.serverUrl, profile: props.profile }}
        syncing={props.syncing} unlockedAccounts={props.unlockedAccounts ?? []}
        onProfile={props.onOpenProfile} onSettings={props.onOpenSettings}
        onLogout={props.onLogout} onSwitch={props.onSwitchAccount} />}
      current={currentKey} onSelect={onNavSelect}
      groups={[
        { key: 'main', entries: [
          { key: 'all', label: '全部', icon: <IconItems size={16} />, count: props.counts.all },
          { key: 'favorites', label: '收藏', icon: <IconStar size={16} />, count: props.counts.favorites },
          { key: 'security', label: '安全报告', icon: <IconShield size={16} /> },
          { key: 'organization', label: '整理与分析', icon: <IconSearch size={16} /> },
          { key: 'generator', label: '生成器', icon: <IconDice size={16} /> },
          { key: 'import', label: '导入', icon: <IconImport size={16} /> },
          { key: 'trash', label: '回收站', icon: <IconTrash size={16} /> },
        ] },
        ...(props.showTypes && props.typeCounts.length ? [{
          key: 'types', title: '类别', collapsed: typesCollapsed,
          onToggleCollapsed: () => { const value = !typesCollapsed; setTypesCollapsed(value); persistCollapsed(TYPE_COLLAPSE_KEY, value); },
          entries: props.typeCounts.map(t => ({ key: `type:${t.type}`, label: t.label, icon: <TypeIcon type={t.type} size={16} />, count: t.count })),
        }] : []),
        {
          key: 'folders', title: '文件夹', collapsed: foldersCollapsed,
          onToggleCollapsed: () => collapseFolders(!foldersCollapsed),
          action: <button ref={newFolder} type="button" data-nav-new-folder title="新建文件夹" aria-label="新建文件夹"
            onClick={() => { collapseFolders(false); setMenu(null); setRenaming(null); setCreating(true); returnTo.current = newFolder.current; }}
            className="rounded-[var(--radius-sm)] p-1 text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]">
            <IconPlus size={14} />
          </button>,
          render: () => <ul className="space-y-0.5">
            {props.folders.map(folder => {
              const name = folder.nameFailed ? '无法解密' : folder.name;
              const active = props.category.kind === 'folder' && props.category.id === folder.id;
              return renaming === folder.id ? <li key={folder.id} className="py-0.5">
                <InlineInput initial={folder.nameFailed ? '' : folder.name} label="文件夹名"
                  onCancel={closeDraft} onDone={closeDraft} onCommit={value => props.onRenameFolder(folder.id, value)} />
              </li> : <NavItem key={folder.id} label={name} active={active} onClick={() => onNavSelect(`folder:${folder.id}`)}>
                <button type="button" aria-label={`文件夹操作：${name}`} title={`文件夹操作：${name}`}
                  aria-haspopup="menu" aria-expanded={menu?.id === folder.id}
                  onClick={event => { event.stopPropagation(); const trigger = event.currentTarget; setMenu(menu?.id === folder.id ? null : { id: folder.id, trigger }); returnTo.current = trigger; }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-[var(--radius-sm)] p-1.5 text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
                  <IconMore size={15} />
                </button>
              </NavItem>;
            })}
            {creating && <li className="py-0.5"><InlineInput label="新文件夹名" onCancel={closeDraft} onDone={closeDraft} onCommit={props.onCreateFolder} /></li>}
          </ul>,
        },
      ]} />
    {menu && menuFolder && <FolderMenu trigger={menu.trigger} name={menuFolder.nameFailed ? '无法解密' : menuFolder.name}
      onClose={() => setMenu(null)}
      onRename={() => { setMenu(null); setCreating(false); setRenaming(menu.id); }}
      onDelete={() => { setMenu(null); setCreating(false); setRenaming(null); setDeleting(menu.id); }} />}
    {deleteFolder && <DeleteFolderDialog name={deleteFolder.nameFailed ? '无法解密' : deleteFolder.name}
      onCancel={() => { setDeleting(null); restoreFocus(); }}
      onCommit={() => props.onDeleteFolder(deleteFolder.id)} onDone={() => { setDeleting(null); newFolder.current?.focus(); }} />}
  </>;
}

function NavItem({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return <li className="group relative">
    <button type="button" onClick={onClick} title={label} aria-current={active ? 'page' : undefined}
      className={`nav-item flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] py-[7px] pl-2.5 pr-10 text-left text-sm ${active
        ? 'bg-[var(--surface-selected)] font-medium text-[var(--ink-primary)]'
        : 'text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]'}`}>
      <span className="shrink-0 text-[var(--ink-tertiary)]"><IconFolder size={16} /></span>
      <span className="nav-label min-w-0 flex-1 truncate">{label}</span>
    </button>
    <div className="nav-extra">{children}</div>
  </li>;
}

function FolderMenu({ trigger, name, onClose, onRename, onDelete }: {
  trigger: HTMLButtonElement; name: string; onClose: () => void; onRename: () => void; onDelete: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    function position() {
      const menu = menuRef.current; if (!menu) return;
      const anchor = trigger.getBoundingClientRect();
      const width = Math.min(184, Math.max(0, window.innerWidth - 16));
      menu.style.width = `${width}px`;
      const height = menu.getBoundingClientRect().height;
      menu.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - height - 8))}px`;
    }
    position(); menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); if (trigger.isConnected) trigger.focus({ preventScroll: true }); };
  }, [trigger]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    }
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [onClose]);
  return createPortal(<div className="fixed inset-0 z-[70]" onPointerDown={event => {
    if (event.target === event.currentTarget) { event.preventDefault(); event.stopPropagation(); onClose(); }
  }} onClick={event => { event.preventDefault(); event.stopPropagation(); }}>
    <div ref={menuRef} role="menu" aria-label={`文件夹操作：${name}`}
      className="fixed flex flex-col gap-0.5 rounded-[var(--radius-md)] border border-[var(--border-overlay)] bg-[var(--surface-overlay)] p-1"
      style={{ boxShadow: 'var(--elev-pop)', maxHeight: 'calc(100dvh - 16px)', overflowY: 'auto' }}
      onKeyDown={event => {
        const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        } else if (event.key === 'Tab') { event.preventDefault(); onClose(); }
      }}>
      <button type="button" role="menuitem" onClick={onRename} className="btn btn-ghost justify-start gap-2 px-2 py-1.5"><IconPencil size={13} />重命名</button>
      <button type="button" role="menuitem" onClick={onDelete} className="btn btn-ghost justify-start gap-2 px-2 py-1.5 text-[var(--risk)]"><IconTrash size={13} />删除文件夹</button>
    </div>
  </div>, document.body);
}

function useFolderSubmission(onCommit: () => Promise<void>, onDone: () => void) {
  const store = useLocalStore(() => ({ busy: false, error: null as string | null }));
  const [busy, setBusy] = useStoreField(store, 'busy');
  const [error, setError] = useStoreField(store, 'error');
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function submit() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await onCommit(); if (alive.current) onDone(); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '文件夹操作失败'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return { busy, error, submit };
}

function InlineInput({ initial = '', label, onCommit, onDone, onCancel }: {
  initial?: string; label: string; onCommit: (value: string) => Promise<void>; onDone: () => void; onCancel: () => void;
}) {
  const store = useLocalStore(() => ({ value: initial }));
  const [value, setValue] = useStoreField(store, 'value');
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  const { busy, error, submit } = useFolderSubmission(async () => { const trimmed = value.trim(); if (!trimmed) throw new Error('请输入文件夹名'); await onCommit(trimmed); }, onDone);
  useEffect(() => { field.current?.focus({ preventScroll: true }); }, []);
  return <form aria-label={label === '新文件夹名' ? '新建文件夹' : '重命名文件夹'} aria-busy={busy}
    className="rounded-[var(--radius-sm)] bg-[var(--surface-well)] p-2"
    onSubmit={event => { event.preventDefault(); void submit(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onCancel(); } }}>
    <label htmlFor={id} className="mb-1 block text-xs text-[var(--ink-secondary)]">{label}</label>
    <input ref={field} id={id} aria-label={label} placeholder={label} value={value} disabled={busy} required
      aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
      onChange={event => setValue(event.target.value)} className="field w-full min-w-0 px-2 py-1 text-sm" />
    {error && <p id={`${id}-error`} role="alert" className="mt-1 break-words text-xs text-[var(--risk)]">{error}</p>}
    <div className="mt-2 flex gap-1.5">
      <button type="submit" disabled={busy || !value.trim()} className="btn btn-primary px-2 py-1 text-xs">{busy ? '保存中…' : '保存'}</button>
      <button type="button" disabled={busy} onClick={onCancel} className="btn btn-ghost px-2 py-1 text-xs">取消</button>
    </div>
  </form>;
}

function DeleteFolderDialog({ name, onCommit, onDone, onCancel }: { name: string; onCommit: () => Promise<void>; onDone: () => void; onCancel: () => void }) {
  const id = useId();
  const { busy, error, submit } = useFolderSubmission(onCommit, onDone);
  return createPortal(<FloatingPanel open onClose={() => { if (!busy) onCancel(); }} labelledBy={id} className="w-[360px] max-w-[calc(100vw-32px)] p-5">
    <h2 id={id} className="break-words text-md font-medium">删除文件夹「{name}」？</h2>
    <p className="mt-2 text-sm leading-relaxed text-[var(--ink-secondary)]">其中的条目会移至未分类，不会删除条目。</p>
    {error && <p role="alert" className="mt-3 break-words text-sm text-[var(--risk)]">{error}</p>}
    <div className="mt-4 flex flex-wrap gap-2">
      <button type="button" disabled={busy} onClick={() => { void submit(); }} className="btn btn-danger">{busy ? '删除中…' : '删除文件夹'}</button>
      <button type="button" disabled={busy} onClick={onCancel} className="btn btn-ghost">取消</button>
    </div>
  </FloatingPanel>, document.body);
}
