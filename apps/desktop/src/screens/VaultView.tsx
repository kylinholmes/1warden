import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { searchItems, totpCode, hasTotp, type VaultItem, type VaultFolder } from '@coffer/vault';
import type { VaultClient } from '@coffer/vault';
import { SecretField } from '../components/SecretField';
import { AutotypeAction } from '../components/AutotypeAction';
import { SecurityReportView } from './SecurityReport';
import { ItemEditor } from './ItemEditor';

interface Props {
  client: VaultClient;
  onLock: () => void;
}

type Category =
  | { kind: 'all' }
  | { kind: 'favorites' }
  | { kind: 'folder'; id: string }
  | { kind: 'security' };

type Mode = { kind: 'browse' } | { kind: 'edit'; item: VaultItem } | { kind: 'new' };

export function VaultView({ client, onLock }: Props) {
  const session = client.getSession();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>({ kind: 'all' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'browse' });
  const [confirmDelete, setConfirmDelete] = useState<VaultItem | null>(null);
  const [bump, setBump] = useState(0); // 本地写入后强制重渲染 —— session 不是响应式的
  const searchRef = useRef<HTMLInputElement>(null);
  const [folderError, setFolderError] = useState<string | null>(null);

  /**
   * 文件夹操作。
   *
   * ⚠️ 每个都必须**有地方报错**。这里出错的原因通常是服务端拒绝
   * （名字太长、网络断了），静默吞掉的话用户会以为「点了没反应」。
   */
  async function folderOp(op: () => Promise<void>): Promise<void> {
    setFolderError(null);
    try {
      await op();
      setBump((n) => n + 1);
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : '文件夹操作失败');
    }
  }

  const items = session.items;
  const folders = session.folders;

  const filtered = useMemo(() => {
    let pool = items;
    if (category.kind === 'favorites') pool = pool.filter((i) => i.favorite);
    else if (category.kind === 'folder') pool = pool.filter((i) => i.folderId === category.id);
    return searchItems(pool, folders, query).map((h) => h.item);
  }, [items, folders, query, category]);

  const selected = filtered.find((i) => i.id === selectedId) ?? null;

  // 每 30 秒重新算一次验证码 —— 只在真的显示了验证码时才跑
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!selected || !hasTotp(selected)) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [selected]);

  // ⌘F 聚焦搜索；⌘L 锁定 —— 键盘优先是安全工具的基本要求
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); searchRef.current?.focus(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'l') { e.preventDefault(); onLock(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onLock]);

  // 快捷键：⌘N 新建。放在编辑态下会被输入框抢走，所以只在浏览态生效
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n' && mode.kind === 'browse') {
        e.preventDefault();
        setMode({ kind: 'new' });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode.kind]);

  // 编辑器占满右侧，侧栏与列表保持可见 —— 用户在编辑时仍能看到自己在哪个位置
  if (mode.kind !== 'browse') {
    return (
      <div className="flex h-full">
        <Sidebar
          folders={folders} category={category}
          onSelect={(c) => { setCategory(c); setSelectedId(null); setMode({ kind: 'browse' }); }}
          counts={{ all: items.length, favorites: items.filter((i) => i.favorite).length }}
          onLock={onLock} account={session.account?.email ?? ''}
          onNew={() => setMode({ kind: 'new' })}
          onCreateFolder={(name) => folderOp(async () => { await client.createFolder(name); })}
          onRenameFolder={(id, name) => folderOp(async () => { await client.renameFolder(id, name); })}
          onDeleteFolder={(id) => folderOp(async () => {
            await client.deleteFolder(id);
            // 删掉的正是当前筛选中的那个 —— 得切回去，否则列表会空着
            // 而用户不知道为什么
            if (category.kind === 'folder' && category.id === id) setCategory({ kind: 'all' });
          })}
        />
        <div className="flex-1 overflow-hidden">
          <ItemEditor
            client={client}
            item={mode.kind === 'edit' ? mode.item : null}
            onCancel={() => setMode({ kind: 'browse' })}
            onDone={(saved) => {
              setMode({ kind: 'browse' });
              if (saved) { setSelectedId(saved.id); setBump((n) => n + 1); }
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full" data-bump={bump}>
      <Sidebar
        folders={folders}
        category={category}
        onSelect={(c) => { setCategory(c); setSelectedId(null); }}
        counts={{ all: items.length, favorites: items.filter((i) => i.favorite).length }}
        onLock={onLock}
        account={session.account?.email ?? ''}
        onNew={() => setMode({ kind: 'new' })}
        onCreateFolder={(name) => folderOp(async () => { await client.createFolder(name); })}
        onRenameFolder={(id, name) => folderOp(async () => { await client.renameFolder(id, name); })}
        onDeleteFolder={(id) => folderOp(async () => {
          await client.deleteFolder(id);
          if (category.kind === 'folder' && category.id === id) setCategory({ kind: 'all' });
        })}
      />

      {/*
        安全报告占满右侧。刻意**不**保留条目列表这一栏 ——
        报告讲的是「整个库的状态」，旁边杵着一个可点的列表会把注意力
        拉回单条记录，而且点哪一条都没有对应的详情可看。
      */}
      {category.kind === 'security' ? (
        <div className="flex-1 overflow-y-auto">
          <SecurityReportView items={items} />
        </div>
      ) : (
      <>
      <div className="flex w-[320px] shrink-0 flex-col border-r border-[var(--border-subtle)]">
        {folderError && (
          <div className="flex items-start gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2">
            <p className="min-w-0 flex-1 text-[var(--text-xs)] text-[var(--risk)]">{folderError}</p>
            <button onClick={() => setFolderError(null)}
              className="shrink-0 text-[var(--text-xs)] text-[var(--ink-tertiary)] hover:underline">知道了</button>
          </div>
        )}
        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] p-3">
          <input
            ref={searchRef}
            type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索…  ⌘F"
            className="min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-1.5 text-[var(--text-sm)] outline-none focus:border-[var(--accent)]"
          />
          <button
            onClick={() => setMode({ kind: 'new' })}
            title="新建条目  ⌘N"
            className="shrink-0 rounded-[var(--radius-md)] bg-[var(--accent)] px-2.5 py-1.5 text-[var(--text-sm)] font-medium text-[var(--accent-ink)] transition-opacity duration-[var(--dur-fast)] hover:bg-[var(--accent-hover)]"
          >
            ＋
          </button>
        </div>

        <ul className="flex-1 overflow-y-auto p-2">
          {filtered.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              selected={item.id === selectedId}
              onClick={() => setSelectedId(item.id)}
            />
          ))}
          {filtered.length === 0 && (
            <li className="px-3 py-8 text-center text-[var(--text-sm)] text-[var(--ink-tertiary)]">
              {query ? '没有匹配的条目' : '这里还是空的 —— 点右上角 ＋ 新建一条'}
            </li>
          )}
        </ul>
      </div>

      <div className="flex-1 overflow-y-auto">
        {selected ? (
          <ItemDetail
            key={selected.id}
            item={selected}
            onEdit={() => setMode({ kind: 'edit', item: selected })}
            onDelete={() => setConfirmDelete(selected)}
            onToggleFavorite={() => {
              void client.toggleFavorite(selected.id).then(() => setBump((n) => n + 1));
            }}
          />
        ) : <EmptyDetail />}
      </div>

      </>
      )}

      {confirmDelete && (
        <DeleteDialog
          item={confirmDelete}
          onCancel={() => setConfirmDelete(null)}
          onTrash={async () => {
            const target = confirmDelete;
            setConfirmDelete(null);
            await client.moveToTrash(target.id);
            setSelectedId(null);
            setBump((n) => n + 1);
          }}
          onPermanent={async () => {
            const target = confirmDelete;
            setConfirmDelete(null);
            await client.deletePermanently(target.id);
            setSelectedId(null);
            setBump((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

/**
 * 删除确认。
 *
 * ⚠️ 两个选项的后果**差别巨大**，所以措辞必须毫不含糊：
 * 「移到回收站」可以恢复，「永久删除」不能。把两者做得看起来差不多
 * 是这类界面上最容易造成不可逆损失的设计错误。
 */
function DeleteDialog(props: {
  item: VaultItem;
  onCancel: () => void;
  onTrash: () => void;
  onPermanent: () => void;
}) {
  const [ack, setAck] = useState(false);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" role="dialog" aria-modal>
      <div className="w-full max-w-sm rounded-[var(--radius-lg)] bg-[var(--surface-overlay)] p-5" style={{ boxShadow: 'var(--elev-3)' }}>
        <h3 className="mb-1 text-[var(--text-lg)] font-semibold">删除「{props.item.name}」？</h3>
        <p className="mb-4 text-[var(--text-sm)] text-[var(--ink-secondary)]">
          移到回收站后仍可恢复。永久删除则<strong>无法撤销</strong>。
        </p>

        <label className="mb-4 flex items-start gap-2 text-[var(--text-sm)] text-[var(--ink-secondary)]">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
          我知道永久删除无法恢复
        </label>

        <div className="flex flex-col gap-2">
          <button onClick={props.onTrash}
            className="w-full rounded-[var(--radius-md)] bg-[var(--accent)] px-4 py-2 text-[var(--text-sm)] font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-hover)]">
            移到回收站
          </button>
          <button onClick={props.onPermanent} disabled={!ack}
            className="w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-4 py-2 text-[var(--text-sm)] font-medium text-[var(--risk)] transition-opacity duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] disabled:opacity-40">
            永久删除
          </button>
          <button onClick={props.onCancel}
            className="w-full rounded-[var(--radius-md)] px-4 py-2 text-[var(--text-sm)] text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]">
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

function Sidebar(props: {
  folders: readonly VaultFolder[];
  category: Category;
  onSelect: (c: Category) => void;
  counts: { all: number; favorites: number };
  onLock: () => void;
  account: string;
  onNew: () => void;
  onCreateFolder: (name: string) => Promise<void>;
  onRenameFolder: (id: string, name: string) => Promise<void>;
  onDeleteFolder: (id: string) => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  return (
    <nav className="flex w-[190px] shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
      <div className="flex items-center justify-between p-3">
        <div className="px-2 py-1 text-[var(--text-lg)] font-semibold tracking-tight">Coffer</div>
        <button
          onClick={props.onNew}
          title="新建条目  ⌘N"
          className="mr-1 rounded-[var(--radius-sm)] px-2 py-1 text-[var(--ink-secondary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)]"
        >
          ＋
        </button>
      </div>

      <ul className="flex-1 space-y-0.5 px-2">
        <NavItem
          label="全部" count={props.counts.all}
          active={props.category.kind === 'all'}
          onClick={() => props.onSelect({ kind: 'all' })}
        />
        <NavItem
          label="收藏" count={props.counts.favorites}
          active={props.category.kind === 'favorites'}
          onClick={() => props.onSelect({ kind: 'favorites' })}
        />
        {/* 安全报告不是一个「列表筛选」，而是一整块内容 —— 选中它时右侧
            不再显示条目列表，理由见下面的渲染分支 */}
        <NavItem
          label="安全报告"
          active={props.category.kind === 'security'}
          onClick={() => props.onSelect({ kind: 'security' })}
        />
        {/*
          ⚠️ 这一行**始终显示**，不再以「已有文件夹」为前提。
          之前的写法是 `props.folders.length > 0 && ...`，而那时没有任何途径
          能建出第一个文件夹 —— 于是这个分区对用户永远不会出现，
          整套文件夹功能等于不存在。
        */}
        <li className="flex items-center justify-between px-2 pt-4 pb-1">
          <span className="text-[var(--text-xs)] font-medium uppercase tracking-wide text-[var(--ink-tertiary)]">
            文件夹
          </span>
          <button
            onClick={() => { setCreating(true); setMenuFor(null); }}
            title="新建文件夹"
            className="rounded-[var(--radius-sm)] px-1.5 text-[var(--text-sm)] leading-none text-[var(--ink-tertiary)] hover:bg-[var(--surface-hover)]"
          >
            ＋
          </button>
        </li>

        {props.folders.map((f) => {
          const name = f.nameFailed ? '无法解密' : f.name;
          if (renaming === f.id) {
            return (
              <li key={f.id} className="px-2 py-0.5">
                <InlineInput
                  initial={f.nameFailed ? '' : name}
                  placeholder="文件夹名"
                  onCancel={() => setRenaming(null)}
                  onCommit={async (v) => { await props.onRenameFolder(f.id, v); setRenaming(null); }}
                />
              </li>
            );
          }
          if (confirmDelete === f.id) {
            return (
              <li key={f.id} className="px-2 py-0.5">
                <div className="rounded-[var(--radius-sm)] bg-[var(--surface-hover)] p-2">
                  {/* ⚠️ 删除文件夹**不会删掉里面的密码** —— 服务端只删关联行，
                      条目变成「无文件夹」。措辞必须与这个事实一致 */}
                  <p className="mb-1.5 text-[var(--text-xs)] leading-relaxed text-[var(--ink-secondary)]">
                    删除文件夹？里面的条目会变成「无文件夹」，<strong className="font-medium">不会被删除</strong>。
                  </p>
                  <div className="flex gap-1.5">
                    <button onClick={async () => { await props.onDeleteFolder(f.id); setConfirmDelete(null); }}
                      className="rounded-[var(--radius-sm)] px-2 py-0.5 text-[var(--text-xs)] font-medium text-[var(--risk)] hover:bg-[var(--surface-sunken)]">
                      删除
                    </button>
                    <button onClick={() => setConfirmDelete(null)}
                      className="rounded-[var(--radius-sm)] px-2 py-0.5 text-[var(--text-xs)] text-[var(--ink-secondary)] hover:bg-[var(--surface-sunken)]">
                      取消
                    </button>
                  </div>
                </div>
              </li>
            );
          }
          return (
            <li key={f.id} className="group relative">
              <NavItem
                label={name}
                active={props.category.kind === 'folder' && props.category.id === f.id}
                onClick={() => props.onSelect({ kind: 'folder', id: f.id })}
              />
              <button
                onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === f.id ? null : f.id); }}
                title="更多"
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded-[var(--radius-sm)] px-1 text-[var(--text-xs)] text-[var(--ink-tertiary)] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--surface-hover)]"
              >
                ⋯
              </button>
              {menuFor === f.id && (
                <div className="absolute right-1 top-full z-10 mt-0.5 flex gap-1 rounded-[var(--radius-sm)] bg-[var(--surface-overlay)] p-1"
                  style={{ boxShadow: 'var(--elev-2)' }}>
                  <button onClick={() => { setRenaming(f.id); setMenuFor(null); }}
                    className="rounded-[var(--radius-sm)] px-2 py-0.5 text-[var(--text-xs)] text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]">
                    重命名
                  </button>
                  <button onClick={() => { setConfirmDelete(f.id); setMenuFor(null); }}
                    className="rounded-[var(--radius-sm)] px-2 py-0.5 text-[var(--text-xs)] text-[var(--risk)] hover:bg-[var(--surface-hover)]">
                    删除
                  </button>
                </div>
              )}
            </li>
          );
        })}

        {creating && (
          <li className="px-2 py-0.5">
            <InlineInput
              placeholder="新文件夹名"
              onCancel={() => setCreating(false)}
              onCommit={async (v) => { await props.onCreateFolder(v); setCreating(false); }}
            />
          </li>
        )}
      </ul>

      <div className="border-t border-[var(--border-subtle)] p-2">
        <div className="truncate px-2 py-1 text-[var(--text-xs)] text-[var(--ink-tertiary)]" title={props.account}>
          {props.account}
        </div>
        <button
          onClick={props.onLock}
          className="w-full rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[var(--text-sm)] text-[var(--ink-secondary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)]"
        >
          锁定  ⌘L
        </button>
      </div>
    </nav>
  );
}

function NavItem(props: { label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button
        onClick={props.onClick}
        className={`flex w-full items-center justify-between rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[var(--text-sm)] transition-colors duration-[var(--dur-fast)] ${
          props.active
            ? 'bg-[var(--surface-selected)] font-medium text-[var(--accent)]'
            : 'text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]'
        }`}
      >
        <span className="truncate">{props.label}</span>
        {props.count !== undefined && (
          <span className="ml-2 shrink-0 text-[var(--text-xs)] text-[var(--ink-tertiary)]">{props.count}</span>
        )}
      </button>
    </li>
  );
}

function ItemRow({ item, selected, onClick }: { item: VaultItem; selected: boolean; onClick: () => void }) {
  const subtitle = item.login?.username
    ?? item.login?.uris[0]?.uri
    ?? (item.type === 'secureNote' ? '安全笔记' : '');

  return (
    <li>
      <button
        onClick={onClick}
        className={`flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-left transition-colors duration-[var(--dur-fast)] ${
          selected ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]'
        }`}
      >
        <ItemGlyph type={item.type} favorite={item.favorite} />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[var(--text-md)] ${item.nameFailed ? 'text-[var(--ink-tertiary)] italic' : ''}`}>
            {item.nameFailed ? '无法解密' : item.name}
          </span>
          {subtitle && (
            <span className="block truncate text-[var(--text-xs)] text-[var(--ink-tertiary)]">{subtitle}</span>
          )}
        </span>
      </button>
    </li>
  );
}

/** 类型图标 —— 用字符而不是图片资源，避免引入任何外部资产 */
function ItemGlyph({ type, favorite }: { type: VaultItem['type']; favorite: boolean }) {
  const glyph = type === 'login' ? '🔑'
    : type === 'card' ? '💳'
    : type === 'identity' ? '👤'
    : type === 'secureNote' ? '📝'
    : type === 'sshKey' ? '🔧'
    : '❓';
  return (
    <span className="relative shrink-0 text-[var(--text-lg)]" aria-hidden>
      {glyph}
      {favorite && (
        <span className="absolute -right-1 -top-1 text-[9px] text-[var(--caution)]" title="已收藏">★</span>
      )}
    </span>
  );
}

/**
 * 就地输入 —— 新建 / 重命名文件夹用。
 *
 * 不用 `window.prompt`：原生壳里它不可靠（会被 webview 拦掉或样式不可控），
 * 而且它拿不到我们的设计系统。
 */
function InlineInput({ initial = '', placeholder, onCommit, onCancel }: {
  initial?: string;
  placeholder: string;
  onCommit: (value: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && value.trim().length > 0) void onCommit(value.trim());
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={onCancel}
      className="w-full rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--surface-raised)] px-2 py-1 text-[var(--text-sm)] outline-none"
    />
  );
}

function EmptyDetail() {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-[var(--text-sm)] text-[var(--ink-tertiary)]">选择左侧的一条记录</p>
    </div>
  );
}

function ItemDetail({ item, onEdit, onDelete, onToggleFavorite }: {
  item: VaultItem;
  onEdit: () => void;
  onDelete: () => void;
  onToggleFavorite: () => void;
}) {
  const [totp, setTotp] = useState<{ code: string; remaining: number; period: number } | null>(null);

  const refreshTotp = useCallback(() => {
    if (!hasTotp(item)) { setTotp(null); return; }
    totpCode(item).then(setTotp).catch(() => setTotp(null));
  }, [item]);

  useEffect(() => {
    refreshTotp();
    const id = setInterval(refreshTotp, 1000);
    return () => clearInterval(id);
  }, [refreshTotp]);

  return (
    <article className="mx-auto max-w-2xl p-8">
      <header className="mb-6 flex items-start gap-4">
        <ItemGlyph type={item.type} favorite={item.favorite} />
        <div className="min-w-0 flex-1">
          <h2 className={`text-[var(--text-xl)] font-semibold tracking-tight ${item.nameFailed ? 'italic text-[var(--ink-tertiary)]' : ''}`}>
            {item.nameFailed ? '无法解密' : item.name}
          </h2>
          <p className="mt-0.5 text-[var(--text-xs)] text-[var(--ink-tertiary)]">
            {TYPE_LABEL[item.type] ?? '未知类型'}
            {item.rawType > 5 && '（此类型较新，暂只支持查看）'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button onClick={onToggleFavorite} title={item.favorite ? '取消收藏' : '加入收藏'}
            className={`rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-sm)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] ${
              item.favorite ? 'text-[var(--caution)]' : 'text-[var(--ink-tertiary)]'
            }`}>
            {item.favorite ? '★' : '☆'}
          </button>
          {/* 未知类型不提供编辑 —— 保存会把它降级成别的类型，等于破坏数据 */}
          {item.rawType >= 1 && item.rawType <= 5 && (
            <button onClick={onEdit}
              className="rounded-[var(--radius-sm)] px-2.5 py-1 text-[var(--text-sm)] text-[var(--ink-secondary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)]">
              编辑
            </button>
          )}
          <button onClick={onDelete}
            className="rounded-[var(--radius-sm)] px-2.5 py-1 text-[var(--text-sm)] text-[var(--ink-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] hover:text-[var(--risk)]">
            删除
          </button>
        </div>
      </header>

      {item.login && (
        <Section>
          {item.login.username !== null && <SecretField label="用户名" value={item.login.username} />}
          {item.login.password !== null && <SecretField label="密码" value={item.login.password} masked />}
          {totp && <TotpRow code={totp.code} remaining={totp.remaining} period={totp.period} />}
          {/*
            原生窗口自动输入（spec §7.4）。放在登录字段这一组的末尾 ——
            它是「把凭据送出去」的动作，紧跟在被送出去的东西后面最合理。
          */}
          <div className="border-t border-[var(--border-subtle)] py-2.5 last:border-0">
            <AutotypeAction username={item.login.username} password={item.login.password} />
          </div>
          {item.login.uris.map((u, i) => (
            <SecretField key={i} label={i === 0 ? '网址' : `网址 ${i + 1}`} value={u.uri} />
          ))}
        </Section>
      )}

      {item.card && (
        <Section>
          {item.card.cardholderName && <SecretField label="持卡人" value={item.card.cardholderName} />}
          {item.card.brand && <SecretField label="卡组织" value={item.card.brand} />}
          {item.card.number && <SecretField label="卡号" value={item.card.number} masked />}
          {item.card.expMonth && <SecretField label="有效期" value={`${item.card.expMonth}/${item.card.expYear ?? ''}`} />}
          {item.card.code && <SecretField label="安全码" value={item.card.code} masked />}
        </Section>
      )}

      {item.identity && (
        <Section>
          {Object.entries(item.identity)
            .filter(([, v]) => v !== null && v !== '')
            .map(([k, v]) => (
              <SecretField key={k} label={IDENTITY_LABEL[k] ?? k} value={v as string} />
            ))}
        </Section>
      )}

      {item.customFields.length > 0 && (
        <Section title="自定义字段">
          {item.customFields.map((f, i) => (
            <SecretField key={i} label={f.name} value={f.value} masked={f.type === 1} />
          ))}
        </Section>
      )}

      {item.notes && (
        <Section title="备注">
          <p className="whitespace-pre-wrap break-words text-[var(--text-md)] leading-relaxed">{item.notes}</p>
        </Section>
      )}

      {item.passwordHistory.length > 0 && (
        <Section title="历史密码">
          {item.passwordHistory.map((h, i) => (
            <SecretField
              key={i}
              label={new Date(h.lastUsedDate).toLocaleDateString('zh-CN')}
              value={h.password} masked
            />
          ))}
        </Section>
      )}
    </article>
  );
}

function TotpRow({ code, remaining, period }: { code: string; remaining: number; period: number }) {
  const pct = Math.max(0, Math.min(1, remaining / period));
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] py-2.5 last:border-0">
      <span className="text-[var(--text-sm)] text-[var(--ink-secondary)]">验证码</span>
      <span className="flex items-center gap-3">
        <span className="secret text-[var(--text-lg)] font-medium tracking-[0.15em]">{code}</span>
        {/* 倒计时环 —— 让用户知道还剩多久，而不是干等着数字变 */}
        <span className="relative grid h-5 w-5 place-items-center" title={`剩余 ${remaining} 秒`}>
          <svg viewBox="0 0 20 20" className="h-5 w-5 -rotate-90">
            <circle cx="10" cy="10" r="8" fill="none" stroke="var(--border-subtle)" strokeWidth="2.5" />
            <circle
              cx="10" cy="10" r="8" fill="none" stroke="var(--accent)" strokeWidth="2.5"
              strokeDasharray={2 * Math.PI * 8}
              strokeDashoffset={2 * Math.PI * 8 * (1 - pct)}
              style={{ transition: 'stroke-dashoffset 1s linear' }}
            />
          </svg>
        </span>
        <CopyButton value={code} />
      </span>
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = {
  login: '登录', secureNote: '安全笔记', card: '信用卡',
  identity: '身份信息', sshKey: 'SSH 密钥', unknown: '未知类型',
};

const IDENTITY_LABEL: Record<string, string> = {
  title: '称谓', firstName: '名', middleName: '中间名', lastName: '姓',
  address1: '地址', address2: '地址 2', address3: '地址 3', city: '城市',
  state: '省/州', postalCode: '邮编', country: '国家', company: '公司',
  email: '邮箱', phone: '电话', ssn: '身份证号', username: '用户名',
  passportNumber: '护照号', licenseNumber: '驾照号',
};

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      {title && <h3 className="mb-2 text-[var(--text-xs)] font-medium uppercase tracking-wide text-[var(--ink-tertiary)]">{title}</h3>}
      <div className="rounded-[var(--radius-lg)] bg-[var(--surface-raised)] px-4 py-1" style={{ boxShadow: 'var(--elev-1)' }}>
        {children}
      </div>
    </section>
  );
}

export { CopyButton };

/** 复制到剪贴板，**N 秒后自动清空**（若期间用户没复制别的东西） */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        setCopied(false);
        // 只有剪贴板里还是我们写进去的东西时才清 —— 否则会清掉用户后来复制的内容
        try {
          const current = await navigator.clipboard.readText();
          if (current === value) await navigator.clipboard.writeText('');
        } catch { /* 读剪贴板可能被拒绝，那就保持原样 */ }
      }, 30_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      onClick={copy}
      title="复制"
      className={`rounded-[var(--radius-sm)] px-2 py-0.5 text-[var(--text-xs)] transition-colors duration-[var(--dur-fast)] ${
        copied ? 'text-[var(--safe)]' : 'text-[var(--ink-tertiary)] hover:bg-[var(--surface-hover)]'
      }`}
    >
      {copied ? '已复制 ✓' : '复制'}
    </button>
  );
}
