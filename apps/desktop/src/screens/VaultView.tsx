import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { searchItems, totpCode, hasTotp, summaryOf, type VaultItem, type VaultFolder, type Attachment } from '@coffer/vault';
import type { VaultClient, IconStore } from '@coffer/vault';
import { saveFile } from '../save';
import { iconStoreFor } from '../icon-store';
import { ItemIcon } from '../components/ItemIcon';
import { SecretField } from '../components/SecretField';
import { AutotypeAction } from '../components/AutotypeAction';
import { SecurityReportView } from './SecurityReport';
import { ImportScreen } from './Import';
import { ItemEditor } from './ItemEditor';
import { Settings } from './Settings';
import { Generator } from './Generator';
import { FloatingPanel } from '../components/FloatingPanel';
import { CopyButton } from '../components/CopyButton';
import { useToast } from '../components/Toast';
import {
  IconAlert, IconDice, IconFolder, IconGear, IconImport,
  IconItems, IconKeyboard, IconLock, IconMore, IconPencil, IconPlus,
  IconSearch, IconShield, IconStar, IconTrash, TypeIcon,
} from '@coffer/ui';

interface Props {
  client: VaultClient;
  onLock: () => void;
}

type Category =
  | { kind: 'all' }
  | { kind: 'favorites' }
  | { kind: 'folder'; id: string }
  | { kind: 'security' }
  | { kind: 'import' };

type Mode = { kind: 'browse' } | { kind: 'edit'; item: VaultItem } | { kind: 'new' };

export function VaultView({ client, onLock }: Props) {
  const session = client.getSession();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>({ kind: 'all' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'browse' });
  const [confirmDelete, setConfirmDelete] = useState<VaultItem | null>(null);
  const [bump, setBump] = useState(0); // 本地写入后强制重渲染 —— session 不是响应式的
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [folderError, setFolderError] = useState<string | null>(null);

  /*
   * 站点图标的缓存。按服务端地址取 —— 换服务器才重建。
   *
   * `iconStoreFor` 内部是模块级单例：每次渲染新建一个的话缓存等于没有，
   * 滚动一次就要把每个域名重新请求一遍，而服务端首次抓取要 1.5 秒。
   */
  const serverUrl = session.account?.serverUrl ?? '';
  const icons = useMemo(() => (serverUrl === '' ? null : iconStoreFor(serverUrl)), [serverUrl]);

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

  /**
   * 有没有浮层压在上面。
   *
   * ⚠️ 判断的是**所有**浮层，不是某一个。之前这里只挡了设置面板 ——
   * 于是在编辑器里按 ⌘, 会在它上面再压一层设置：两层都监听 document 的
   * Esc，而 `stopPropagation` 拦不住挂在同一个节点上的另一个监听器，
   * 一次按键把两层一起关掉。多出来的那个浮层还会抢走焦点陷阱。
   * 「浮层开着的时候，键盘属于浮层」是一条规则，不是每个面板一条。
   */
  const overlayOpen = settingsOpen || generatorOpen || confirmDelete !== null || mode.kind !== 'browse';

  // ⌘F 聚焦搜索；⌘L 锁定；⌘N 新建；⌘, 设置 —— 键盘优先是安全工具的基本要求
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // 浮层开着时这些快捷键全部让路：焦点在浮层里，
      // 而 ⌘F 会把焦点抢到背后的搜索框上 —— 那就是焦点跑到模态外面去了
      if (overlayOpen) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'f') { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'l') { e.preventDefault(); onLock(); }
      if (e.key === 'n') { e.preventDefault(); setMode({ kind: 'new' }); }
      if (e.key === ',') { e.preventDefault(); setSettingsOpen(true); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onLock, overlayOpen]);

  const sidebar = (
    <Sidebar
      folders={folders}
      category={category}
      onSelect={(c) => { setCategory(c); setSelectedId(null); setMode({ kind: 'browse' }); }}
      counts={{ all: items.length, favorites: items.filter((i) => i.favorite).length }}
      onLock={onLock}
      account={session.account?.email ?? ''}
      onCreateFolder={(name) => folderOp(async () => { await client.createFolder(name); })}
      onRenameFolder={(id, name) => folderOp(async () => { await client.renameFolder(id, name); })}
      onDeleteFolder={(id) => folderOp(async () => {
        await client.deleteFolder(id);
        // 删掉的正是当前筛选中的那个 —— 得切回去，否则列表会空着
        // 而用户不知道为什么
        if (category.kind === 'folder' && category.id === id) setCategory({ kind: 'all' });
      })}
      onOpenSettings={() => setSettingsOpen(true)}
      generatorOpen={generatorOpen}
      onOpenGenerator={() => setGeneratorOpen(true)}
    />
  );

  /*
    安全报告与导入占满右侧。刻意**不**保留条目列表这一栏 ——
    报告讲的是「整个库的状态」，旁边杵着一个可点的列表会把注意力
    拉回单条记录，而且点哪一条都没有对应的详情可看。
  */
  const fullWidth = category.kind === 'security' || category.kind === 'import';

  return (
    <div className="screen-in flex h-full" data-bump={bump}>
      {sidebar}

      {fullWidth ? (
        <div className="below-titlebar flex min-w-0 flex-1 flex-col bg-[var(--surface-paper)]">
          {category.kind === 'security' ? (
            <SecurityReportView items={items} />
          ) : (
            <ImportScreen client={client} onImported={() => setBump((n) => n + 1)} />
          )}
        </div>
      ) : (
        <>
          <div className="below-titlebar flex w-[var(--list-w)] shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-content)]">
            {/* 这一条也是标题栏的一部分 —— 整条顶部带子都可以拖窗口 */}
            <div className="band" data-tauri-drag-region="deep">
              <div className="relative flex min-w-0 flex-1 items-center">
                <IconSearch size={15} className="pointer-events-none absolute left-1.5 text-[var(--ink-tertiary)]" />
                <input
                  ref={searchRef}
                  type="search" value={query} onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索"
                  aria-label="搜索条目"
                  className="field-bare pl-7"
                />
              </div>
              {/* 主操作带文字。上一版是一个只有「＋」的方块 ——
                  对普通用户来说，一个加号到底是「新建条目」还是「新建文件夹」
                  完全看不出来，而这两件事后果差很远 */}
              <button onClick={() => setMode({ kind: 'new' })} title="新建条目  ⌘N" className="btn btn-primary">
                <IconPlus size={14} />
                新建
              </button>
            </div>

            {folderError && (
              <div className="flex items-start gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-well)] px-3.5 py-2">
                <IconAlert size={14} className="mt-0.5 shrink-0 text-[var(--risk)]" />
                <p className="min-w-0 flex-1 text-[var(--text-xs)] text-[var(--risk)]">{folderError}</p>
                <button onClick={() => setFolderError(null)} className="btn btn-ghost shrink-0">知道了</button>
              </div>
            )}

            <ul className="flex-1 overflow-y-auto px-2 py-2">
              {filtered.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  icons={icons}
                  selected={item.id === selectedId}
                  onClick={() => setSelectedId(item.id)}
                />
              ))}
              {filtered.length === 0 && (
                <li className="px-4 py-10 text-center">
                  {query ? (
                    <p className="text-[var(--text-sm)] text-[var(--ink-tertiary)]">
                      没有匹配「{query}」的条目
                    </p>
                  ) : (
                    <>
                      <p className="text-[var(--text-sm)] text-[var(--ink-secondary)]">这里还是空的</p>
                      <p className="mt-1 text-[var(--text-xs)] text-[var(--ink-tertiary)]">
                        点上面的「新建」加第一条
                      </p>
                    </>
                  )}
                </li>
              )}
            </ul>
          </div>

          {/*
            详情栏是**内容**，不是界面 —— 用户名、密码、网址、备注都要能选中复制。
            全局默认是禁止选中的（去浏览器感），这里显式放开。
            少标这一处，用户就复制不了密码，而那种缺失会被当成「功能没做」。
          */}
          <div data-selectable className="below-titlebar min-w-0 flex-1 overflow-y-auto bg-[var(--surface-paper)]">
            {selected ? (
              <ItemDetail
                key={selected.id}
                client={client}
                item={selected}
                onEdit={() => setMode({ kind: 'edit', item: selected })}
                onDelete={() => setConfirmDelete(selected)}
                onToggleFavorite={() => {
                  // ⚠️ 这里原来没有 catch：收藏失败会变成一个没人看见的
                  // unhandled rejection，用户看到的是「点了没反应」。
                  // 收藏按钮就在他手指底下，失败时不会有任何别的地方告诉他
                  void client.toggleFavorite(selected.id)
                    .then(() => setBump((n) => n + 1))
                    .catch((e: unknown) => {
                      toast.show({
                        tone: 'danger',
                        message: `没能更改收藏：${e instanceof Error ? e.message : '未知错误'}`,
                      });
                    });
                }}
              />
            ) : <EmptyDetail hasItems={filtered.length > 0} />}
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
            toast.show({ tone: 'success', message: `已把「${target.name}」移到回收站` });
          }}
          onPermanent={async () => {
            const target = confirmDelete;
            setConfirmDelete(null);
            await client.deletePermanently(target.id);
            setSelectedId(null);
            setBump((n) => n + 1);
            toast.show({ tone: 'neutral', message: `已永久删除「${target.name}」` });
          }}
        />
      )}

      {/*
        设置面板挂在最外层 —— 它浮在三栏之上，和删除确认是同一层的东西。
        入口在侧栏顶端（.band 的右端），和另外两栏的头部在同一条水平线上。
      */}
      <Settings
        open={settingsOpen}
        account={session.account?.email ?? ''}
        serverUrl={session.account?.serverUrl ?? ''}
        onClose={() => setSettingsOpen(false)}
      />

      {/*
        生成器 —— 和「导入」「安全报告」并列的一块内容，但它不是一屏：
        生成密码这件事总是发生在别的上下文里（正在改某条记录、刚打开一个
        注册页），整屏会把用户从那个上下文里拽出来。浮层压在上面。
      */}
      <Generator open={generatorOpen} onClose={() => setGeneratorOpen(false)} />

      {/*
        新建 / 编辑同一个浮层，只是标题与初始值不同。
        **一直挂着**，靠 `open` 开合 —— 条件挂载的话，关掉的一瞬间组件就
        没了，退场动画根本没机会播（FloatingPanel 的 usePresence 要的是
        「还在，但 open 是 false」）。删除确认框至今还是条件挂载的，
        所以它关得比这两个「啪」一下；那是既有行为，这次没动它。
      */}
      <ItemEditor
        client={client}
        open={mode.kind !== 'browse'}
        item={mode.kind === 'edit' ? mode.item : null}
        onCancel={() => setMode({ kind: 'browse' })}
        onDone={(saved) => {
          setMode({ kind: 'browse' });
          if (saved) {
            setSelectedId(saved.id);
            setBump((n) => n + 1);
            // 编辑器一关，界面上就没有「存了没有」的位置了 —— 提示条的典型场景
            toast.show({ tone: 'success', message: `已保存「${saved.name}」` });
          }
        }}
      />
    </div>
  );
}

/**
 * 删除确认。
 *
 * ⚠️ 两个选项的后果**差别巨大**，所以措辞必须毫不含糊：
 * 「移到回收站」可以恢复，「永久删除」不能。把两者做得看起来差不多
 * 是这类界面上最容易造成不可逆损失的设计错误。
 *
 * 视觉上也照这个事实排：可恢复的那个是主按钮（实心），
 * 不可逆的那个要勾选确认之后才亮起，而且是描边的红 —— 不做成默认顺手的位置。
 */
function DeleteDialog(props: {
  item: VaultItem;
  onCancel: () => void;
  onTrash: () => void;
  onPermanent: () => void;
}) {
  const [ack, setAck] = useState(false);
  /*
    走和设置面板同一个浮层外壳。

    改之前这个对话框是自己写的：没有 Esc、点遮罩不关、Tab 能走到背后的
    列表上去。它本来是界面上唯一的浮层，所以这些缺口没人碰得到；
    现在有了第二个浮层，两套各漏一点的交互只会让人怀疑哪一套才是对的。
  */
  return (
    <FloatingPanel open onClose={props.onCancel} labelledBy="delete-title" className="max-w-sm p-5">
      <h3 id="delete-title" className="text-[var(--text-lg)] font-semibold">删除「{props.item.name}」？</h3>
      <p className="mt-1.5 text-[var(--text-sm)] text-[var(--ink-secondary)]">
        移到回收站后仍可恢复。永久删除则<strong className="font-medium text-[var(--risk)]">无法撤销</strong>。
      </p>

      <label className="mt-4 flex items-start gap-2.5 rounded-[var(--radius-sm)] bg-[var(--surface-well)] p-2.5 text-[var(--text-xs)] text-[var(--ink-secondary)]">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
        我知道永久删除无法恢复
      </label>

      <div className="mt-4 flex flex-col gap-2">
        <button onClick={props.onTrash} className="btn btn-primary w-full py-2.5">移到回收站</button>
        <button onClick={props.onPermanent} disabled={!ack} className="btn btn-danger w-full py-2.5">
          永久删除
        </button>
        <button onClick={props.onCancel} className="btn w-full py-2.5 text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]">
          取消
        </button>
      </div>
    </FloatingPanel>
  );
}

/**
 * 侧栏。
 *
 * ⚠️ 这一栏是玻璃（见 styles.css 的 --surface-glass），于是它的配色规矩
 * 和右边两块**不一样**，改这里的文字颜色之前先读那段注释：
 *
 *   - 文字最低用**次级墨**。三级墨压在实心面上本来就只有 4.94:1，
 *     玻璃再一稀释就掉到 3.58:1 —— 计数、账户邮箱、快捷键提示因此都上移一档。
 *   - 图标可以留三级墨：图形元件按 WCAG 1.4.11 是 3:1。
 *   - 选中态与悬停态用的是**不透明**的填充，不受壁纸影响，照旧。
 */
function Sidebar(props: {
  folders: readonly VaultFolder[];
  category: Category;
  onSelect: (c: Category) => void;
  counts: { all: number; favorites: number };
  onLock: () => void;
  account: string;
  onOpenSettings: () => void;
  /** 生成器是浮层，不是一屏 —— 侧栏只负责把它叫出来，选中态跟着它的开合走 */
  generatorOpen: boolean;
  onOpenGenerator: () => void;
  onCreateFolder: (name: string) => Promise<void>;
  onRenameFolder: (id: string, name: string) => Promise<void>;
  onDeleteFolder: (id: string) => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  return (
    /*
      唯一的玻璃面。窗口材质是**整窗**的（macOS 的 Liquid Glass / Windows 的
      mica 都作用于整个窗口，没法只给一栏），所以做法是反过来：窗口透明 +
      材质，右边两块用不透明的表面盖住，只剩这一条把材质透出来。
      见 styles.css 的 --surface-glass —— α 是算出来的，不是调出来的。
    */
    <nav className="below-titlebar flex w-[var(--rail-w)] shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-glass)]">
      {/*
        和列表栏、详情栏共用 `.band` 的高度 —— 三个面板的顶部对齐在同一条线上。

        这条带子同时是**自绘标题栏**的那一段：`data-tauri-drag-region="deep"`
        让整条带子都能拖窗口，而里面的按钮、输入框这些可交互元素自动豁免
        （Tauri 的 drag.js 会认出 button/input/a/label）。
        `pl-[var(--traffic-inset)]` 给系统红绿灯让位（只有 macOS 有）。
      */}
      <div className="band pl-[var(--traffic-inset)]" data-tauri-drag-region="deep">
        <span className="grid h-[22px] w-[22px] place-items-center rounded-[7px] bg-[var(--accent)] text-[var(--accent-ink)]">
          <IconLock size={13} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[var(--text-lg)] font-semibold tracking-[-0.01em]">Coffer</span>
        {/* 设置入口在顶栏右端。**不放进底部账户区**：那里是「你是谁 / 离开」，
            设置是「这个应用怎么运作」，和账户不是一类东西 */}
        <button
          onClick={props.onOpenSettings}
          title="设置  ⌘,"
          aria-label="设置"
          className="shrink-0 rounded-[var(--radius-sm)] p-1.5 text-[var(--ink-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]"
        >
          <IconGear size={15} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 py-2.5">
        <ul className="space-y-0.5">
          <NavItem
            icon={<IconItems size={16} />}
            label="全部" count={props.counts.all}
            active={props.category.kind === 'all'}
            onClick={() => props.onSelect({ kind: 'all' })}
          />
          <NavItem
            icon={<IconStar size={16} />}
            label="收藏" count={props.counts.favorites}
            active={props.category.kind === 'favorites'}
            onClick={() => props.onSelect({ kind: 'favorites' })}
          />
          {/* 安全报告不是一个「列表筛选」，而是一整块内容 —— 选中它时右侧
              不再显示条目列表，理由见上面的渲染分支 */}
          <NavItem
            icon={<IconShield size={16} />}
            label="安全报告"
            active={props.category.kind === 'security'}
            onClick={() => props.onSelect({ kind: 'security' })}
          />
          {/* 生成器也是「第二块内容」，但它开的是浮层 —— `active` 跟着浮层的
              开合走，用户一眼能看到这一层是从哪儿点出来的 */}
          <NavItem
            icon={<IconDice size={16} />}
            label="生成器"
            active={props.generatorOpen}
            onClick={props.onOpenGenerator}
          />
          <NavItem
            icon={<IconImport size={16} />}
            label="导入"
            active={props.category.kind === 'import'}
            onClick={() => props.onSelect({ kind: 'import' })}
          />
        </ul>

        {/*
          ⚠️ 这个分区**始终显示**，不以「已有文件夹」为前提。
          之前的写法是 `props.folders.length > 0 && ...`，而那时没有任何途径
          能建出第一个文件夹 —— 于是它对用户永远不会出现，整套文件夹功能等于不存在。
        */}
        <div className="mt-4 mb-1 flex items-center justify-between pl-2.5 pr-1">
          <span className="text-[var(--text-xs)] font-medium text-[var(--ink-secondary)]">文件夹</span>
          <button
            onClick={() => { setCreating(true); setMenuFor(null); }}
            title="新建文件夹"
            aria-label="新建文件夹"
            className="rounded-[var(--radius-sm)] p-1 text-[var(--ink-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]"
          >
            <IconPlus size={13} />
          </button>
        </div>

        <ul className="space-y-0.5">
          {props.folders.map((f) => {
            const name = f.nameFailed ? '无法解密' : f.name;
            if (renaming === f.id) {
              return (
                <li key={f.id} className="px-0.5 py-0.5">
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
                <li key={f.id} className="py-0.5">
                  <div className="rounded-[var(--radius-sm)] bg-[var(--surface-well)] p-2.5">
                    {/* ⚠️ 删除文件夹**不会删掉里面的密码** —— 服务端只删关联行，
                        条目变成「无文件夹」。措辞必须与这个事实一致 */}
                    <p className="mb-2 text-[var(--text-xs)] leading-relaxed text-[var(--ink-secondary)]">
                      里面的条目会变成「无文件夹」，<strong className="font-medium text-[var(--ink-primary)]">不会被删除</strong>。
                    </p>
                    <div className="flex gap-1.5">
                      <button onClick={async () => { await props.onDeleteFolder(f.id); setConfirmDelete(null); }}
                        className="btn btn-ghost px-2 py-1 text-[var(--risk)]">删除</button>
                      <button onClick={() => setConfirmDelete(null)}
                        className="btn btn-ghost px-2 py-1">取消</button>
                    </div>
                  </div>
                </li>
              );
            }
            return (
              /*
               * ⚠️ **不要再包一层 `<li>`** —— `NavItem` 自己渲染的就是 `<li>`，
               * 套起来会产生 `<li>` 嵌 `<li>`，React 会报 hydration 错误，
               * 而浏览器会把结构改写成别的东西，排 version 就跟着乱。
               * 菜单按钮与重命名输入框都挂到同一个 `<li>` 里。
               */
              <NavItem
                key={f.id}
                className="group relative"
                icon={<IconFolder size={16} />}
                label={name}
                active={props.category.kind === 'folder' && props.category.id === f.id}
                onClick={() => props.onSelect({ kind: 'folder', id: f.id })}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === f.id ? null : f.id); }}
                  title="更多" aria-label="文件夹操作"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-[var(--radius-sm)] p-1 text-[var(--ink-tertiary)] opacity-0 transition-opacity duration-[var(--dur-fast)] focus:opacity-100 group-hover:opacity-100 hover:bg-[var(--surface-hover)]"
                >
                  <IconMore size={14} />
                </button>
                {menuFor === f.id && (
                  <div className="absolute right-1 top-full z-20 mt-1 flex gap-0.5 rounded-[var(--radius-md)] border border-[var(--border-overlay)] bg-[var(--surface-overlay)] p-1"
                    style={{ boxShadow: 'var(--elev-pop)' }}>
                    <button onClick={() => { setRenaming(f.id); setMenuFor(null); }}
                      className="btn btn-ghost px-2 py-1 gap-1.5"><IconPencil size={12} />重命名</button>
                    <button onClick={() => { setConfirmDelete(f.id); setMenuFor(null); }}
                      className="btn btn-ghost px-2 py-1 gap-1.5 text-[var(--risk)]"><IconTrash size={12} />删除</button>
                  </div>
                )}
              </NavItem>
            );
          })}

          {creating && (
            <li className="py-0.5">
              <InlineInput
                placeholder="新文件夹名"
                onCancel={() => setCreating(false)}
                onCommit={async (v) => { await props.onCreateFolder(v); setCreating(false); }}
              />
            </li>
          )}
        </ul>
      </div>

      <div className="border-t border-[var(--border-subtle)] p-2.5">
        <div className="mb-1 flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--accent-tint)] text-[var(--text-2xs)] font-semibold text-[var(--accent)]">
            {props.account.slice(0, 1).toUpperCase() || '?'}
          </span>
          <span className="truncate text-[var(--text-xs)] text-[var(--ink-secondary)]" title={props.account}>
            {props.account}
          </span>
        </div>
        <button
          onClick={props.onLock}
          className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[var(--text-sm)] text-[var(--ink-secondary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]"
        >
          <IconLock size={15} />
          <span className="flex-1">锁定</span>
          <kbd className="text-[var(--text-2xs)] text-[var(--ink-secondary)]">⌘L</kbd>
        </button>
      </div>
    </nav>
  );
}

function NavItem(props: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  /** 挂在同一个 `<li>` 里的附加内容（文件夹的重命名/删除菜单） */
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <li className={props.className}>
      {/* 选中态用**填充 + 字重**，不用强调色文字 ——
          强调色留给「可以点的动作」，用它给导航项上色会让界面到处是青色 */}
      <button
        onClick={props.onClick}
        className={`flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-[7px] text-left text-[var(--text-sm)] transition-colors duration-[var(--dur-fast)] ${
          props.active
            ? 'bg-[var(--surface-selected)] font-medium text-[var(--ink-primary)]'
            : 'text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]'
        }`}
      >
        <span className={props.active ? 'text-[var(--accent)]' : 'text-[var(--ink-tertiary)]'}>
          {props.icon}
        </span>
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        {/* 计数是字，不是图形 —— 在玻璃上必须用次级墨（理由见 Sidebar 的注释） */}
        {props.count !== undefined && (
          <span className="shrink-0 text-[var(--text-2xs)] tabular-nums text-[var(--ink-secondary)]">{props.count}</span>
        )}
      </button>
      {props.children}
    </li>
  );
}

function ItemRow({ item, selected, onClick, icons }: {
  item: VaultItem; selected: boolean; onClick: () => void; icons: IconStore | null;
}) {
  /*
   * 第二行取自 `@coffer/vault` 的 `summaryOf`，不是在这里现推。
   *
   * 桌面端和浏览器插件显示同一个列表，各推各的迟早会出现
   * 「同一条在插件里显示 bilibili、在桌面端显示 www.bilibili.com」。
   * 那里也定了两条硬规则：卡号必须掩码、没有可显示的就返回 null
   * （不填「登录信息」这种每行都一样的占位词）。
   */
  const subtitle = summaryOf(item);

  return (
    <li>
      <button
        onClick={onClick}
        /*
         * 行高：两行文字（名字 + 摘要）配上 34px 的图标。
         * `items-start` 而不是 `items-center` —— 有摘要的那几行比没摘要的
         * 高一截，居中对齐会让图标在列表里上下跳动。
         */
        className={`flex w-full items-start gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5 text-left transition-colors duration-[var(--dur-fast)] ${
          selected ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]'
        }`}
      >
        <ItemIcon item={item} store={icons} />
        <span className="min-w-0 flex-1 py-0.5">
          <span className={`block truncate text-[var(--text-md)] leading-snug ${
            item.nameFailed ? 'italic text-[var(--ink-tertiary)]' : ''
          }`}>
            {item.nameFailed ? '无法解密' : item.name}
          </span>
          {subtitle !== null && (
            <span className="mt-0.5 block truncate text-[var(--text-xs)] leading-snug text-[var(--ink-tertiary)]">
              {subtitle}
            </span>
          )}
        </span>
        {item.favorite && <IconStar size={13} filled className="mt-1.5 shrink-0 text-[var(--caution)]" />}
      </button>
    </li>
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
      aria-label={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && value.trim().length > 0) void onCommit(value.trim());
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={onCancel}
      className="field px-2 py-1 text-[var(--text-sm)]"
    />
  );
}

/**
 * 没选中条目时的详情栏。
 *
 * 上一版这里是一句「选择左侧的一条记录」飘在一片空灰里。
 * 空白不等于留白 —— 一块什么都没有的区域只会让人觉得「是不是坏了」。
 * 这里给三样东西：这是哪儿（标题）、能做什么（快捷键）、不能做什么（提示）。
 */
function EmptyDetail({ hasItems }: { hasItems: boolean }) {
  return (
    <div className="screen-in flex h-full items-center justify-center p-10">
      <div className="max-w-[300px] text-center">
        <span className="mx-auto mb-4 grid h-11 w-11 place-items-center rounded-[var(--radius-md)] bg-[var(--surface-well)] text-[var(--ink-tertiary)]">
          <IconKeyboard size={20} />
        </span>
        <p className="text-[var(--text-md)] text-[var(--ink-secondary)]">
          {hasItems ? '选一条记录查看详情' : '还没有可以看的记录'}
        </p>
        <p className="mt-1.5 text-[var(--text-xs)] leading-relaxed text-[var(--ink-tertiary)]">
          {hasItems
            ? '用 ↑ ↓ 在列表里移动，⌘F 直接搜名字或网址。'
            : '左上的「新建」可以从空白开始，或从 1Password、Bitwarden 导入。'}
        </p>
      </div>
    </div>
  );
}

function ItemDetail({ client, item, onEdit, onDelete, onToggleFavorite }: {
  client: VaultClient;
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

  const uris = item.login?.uris ?? [];

  return (
    <article className="screen-in mx-auto w-full px-8 pb-12" style={{ maxWidth: 'calc(var(--detail-w) + 64px)' }}>
      {/* 头部跟着滚 —— 长条目滚到下面时，用户仍然看得到自己在看哪一条 */}
      <header className="sticky top-0 z-10 -mx-8 flex items-start gap-3.5 border-b border-[var(--border-subtle)] bg-[var(--surface-paper)] px-8 pb-4 pt-5">
        <span className="tile mt-0.5 h-9 w-9" data-type={item.type}>
          <TypeIcon type={item.type} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className={`truncate text-[var(--text-xl)] font-semibold tracking-[-0.015em] ${
            item.nameFailed ? 'italic text-[var(--ink-tertiary)]' : ''
          }`}>
            {item.nameFailed ? '无法解密' : item.name}
          </h2>
          <p className="mt-0.5 text-[var(--text-xs)] text-[var(--ink-tertiary)]">
            {TYPE_LABEL[item.type] ?? '未知类型'}
            {item.rawType > 5 && '（此类型较新，暂只支持查看）'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          <button onClick={onToggleFavorite} title={item.favorite ? '取消收藏' : '加入收藏'}
            aria-label={item.favorite ? '取消收藏' : '加入收藏'}
            className={`rounded-[var(--radius-sm)] p-1.5 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] ${
              item.favorite ? 'text-[var(--caution)]' : 'text-[var(--ink-tertiary)]'
            }`}>
            <IconStar size={16} filled={item.favorite} />
          </button>
          {/* 未知类型不提供编辑 —— 保存会把它降级成别的类型，等于破坏数据 */}
          {item.rawType >= 1 && item.rawType <= 5 && (
            <button onClick={onEdit} className="btn btn-quiet gap-1.5">
              <IconPencil size={13} />
              编辑
            </button>
          )}
          <button onClick={onDelete} className="btn btn-ghost gap-1.5 hover:text-[var(--risk)]">
            <IconTrash size={13} />
            删除
          </button>
        </div>
      </header>

      <div className="pt-6">
        {item.login && (
          <Section title="登录">
            {item.login.username !== null && <SecretField label="用户名" value={item.login.username} />}
            {item.login.password !== null && <SecretField label="密码" value={item.login.password} masked />}
            {totp && <TotpRow code={totp.code} remaining={totp.remaining} period={totp.period} />}
            {/*
              原生窗口自动输入（spec §7.4）。放在登录字段这一组的末尾 ——
              它是「把凭据送出去」的动作，紧跟在被送出去的东西后面最合理。
            */}
            <div className="border-t border-[var(--border-subtle)] py-3 first:border-0">
              <AutotypeAction username={item.login.username} password={item.login.password} />
            </div>
          </Section>
        )}

        {uris.length > 0 && (
          <Section title="网址">
            {uris.map((u, i) => (
              <SecretField key={i} label={i === 0 ? '网址' : `网址 ${i + 1}`} value={u.uri} />
            ))}
          </Section>
        )}

        {item.card && (
          <Section title="信用卡">
            {item.card.cardholderName && <SecretField label="持卡人" value={item.card.cardholderName} />}
            {item.card.brand && <SecretField label="卡组织" value={item.card.brand} />}
            {item.card.number && <SecretField label="卡号" value={item.card.number} masked />}
            {item.card.expMonth && <SecretField label="有效期" value={`${item.card.expMonth}/${item.card.expYear ?? ''}`} />}
            {item.card.code && <SecretField label="安全码" value={item.card.code} masked />}
          </Section>
        )}

        {item.identity && (
          <Section title="身份信息">
            {Object.entries(item.identity)
              .filter(([, v]) => v !== null && v !== '')
              .map(([k, v]) => (
                <SecretField key={k} label={IDENTITY_LABEL[k] ?? k} value={v as string} />
              ))}
          </Section>
        )}

        {/*
          ⚠️ SSH 密钥此前**一个字段都没渲染** —— 类型列表里有它、列表图标有 🔧、
          标签写着「SSH 密钥」，但详情页是空的。用户从 Bitwarden 导入一条 SSH 密钥，
          看到的是一个只有标题的页面，像是数据丢了。

          私钥按**隐藏字段**处理：它是这几个里头唯一真正敏感的东西，
          公钥和指纹本来就是给人看的。
        */}
        {item.sshKey && (
          <Section title="SSH 密钥">
            {item.sshKey.publicKey && <SecretField label="公钥" value={item.sshKey.publicKey} />}
            {item.sshKey.fingerprint && <SecretField label="指纹" value={item.sshKey.fingerprint} />}
            {item.sshKey.privateKey && <SecretField label="私钥" value={item.sshKey.privateKey} masked />}
          </Section>
        )}

        {item.attachments.length > 0 && (
          <Section title="附件">
            {item.attachments.map((a) => (
              <AttachmentRow key={a.id} client={client} item={item} attachment={a} />
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
            <p className="whitespace-pre-wrap break-words py-2.5 text-[var(--text-md)] leading-[var(--lh-prose)]">
              {item.notes}
            </p>
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
      </div>
    </article>
  );
}

/**
 * 验证码。
 *
 * 三处「让状态自己说话」，都不是装饰：
 *
 * 1. 环里直接写还剩几秒 —— 用户不用去数弧长。
 * 2. 颜色随剩余时间走 强调色 → 橙 → 红。**临近失效这件事必须一眼看见**，
 *    否则用户会在最后一秒点复制，粘进去的却已经是上一个码。
 * 3. 换码时 420ms 的淡入 —— 提醒「这是新的了」。没有它，
 *    数字是无声无息变的，用户会怀疑自己看错了。
 */
function TotpRow({ code, remaining, period }: { code: string; remaining: number; period: number }) {
  const pct = Math.max(0, Math.min(1, remaining / period));
  const urgent = remaining <= 3;
  const near = remaining <= 7;
  const tone = urgent ? 'var(--risk)' : near ? 'var(--caution)' : 'var(--accent)';
  const R = 11.5;
  const C = 2 * Math.PI * R;

  return (
    <div className="flex items-center gap-3 border-t border-[var(--border-subtle)] py-2.5">
      <span className="w-[84px] shrink-0 text-[var(--text-sm)] text-[var(--ink-secondary)]">验证码</span>

      {/* key 让每次换码都重放一遍淡入 —— 这就是「它变了」的信号 */}
      <span key={code} className="code-turn min-w-0 flex-1">
        <span className="secret text-[var(--text-xl)] font-medium tracking-[0.12em]" style={{ color: tone }}>
          {code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-2.5">
        {/*
          环里写秒数 —— 用户不用去数弧长。数字用中性色、环用彩色：
          两个都上色的话（试过）数字会糊在环里读不清，
          而颜色要传达的信息本来就只有环在承担。
        */}
        <span
          className="relative grid h-[30px] w-[30px] place-items-center"
          title={`${remaining} 秒后失效`}
          role="timer"
          aria-label={`验证码剩余 ${remaining} 秒`}
        >
          <svg viewBox="0 0 30 30" className="absolute inset-0 h-[30px] w-[30px] -rotate-90">
            <circle cx="15" cy="15" r={R} fill="none" stroke="var(--border-subtle)" strokeWidth="2" />
            <circle
              cx="15" cy="15" r={R} fill="none"
              stroke={tone} strokeWidth="2" strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - pct)}
              style={{ transition: 'stroke-dashoffset 1s linear, stroke 300ms linear' }}
            />
          </svg>
          <span className="text-[10px] font-medium tabular-nums leading-none text-[var(--ink-secondary)]">
            {remaining}
          </span>
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

/**
 * 一条附件。
 *
 * ⚠️ **取回是显式动作，不自动下载。** 用户打开一条条目多半只是想看密码，
 * 为了看一眼列表就把几十兆拉下来是错的。
 *
 * 三种「没有结果」必须分得开，否则用户只能反复点：
 *   - 用户取消       → 什么都不说（那不是失败）
 *   - 保存成功       → 告诉他存到哪了
 *   - 取不回来       → 说清楚为什么（地址过期 / 密钥不对 / 服务端上没了）
 */
function AttachmentRow({ client, item, attachment }: {
  client: VaultClient;
  item: VaultItem;
  attachment: Attachment;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'saved' | 'failed'>('idle');
  const [note, setNote] = useState('');

  async function fetchIt(): Promise<void> {
    setState('busy');
    setNote('');
    try {
      const got = await client.downloadAttachment(item.id, attachment.id);
      const saved = await saveFile(got.fileName || attachment.fileName || 'attachment', got.bytes);
      if (saved.path === null) {
        // 用户取消 —— 回到可以再点的状态，不说任何话
        setState('idle');
        return;
      }
      setState('saved');
      // 说清楚**存到哪了** —— 「已保存」而不说位置，用户还得自己去找
      setNote(saved.path);
    } catch (e) {
      setState('failed');
      setNote(e instanceof Error ? e.message : '取不回来');
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border-subtle)] py-2.5 last:border-0">
      <span className="min-w-0 flex-1 truncate text-[var(--text-sm)]" title={attachment.fileName}>
        {attachment.fileName || '（没有文件名）'}
      </span>
      {attachment.sizeName && (
        <span className="shrink-0 text-[var(--text-xs)] text-[var(--ink-tertiary)]">
          {attachment.sizeName}
        </span>
      )}

      {state === 'failed' && (
        <span className="shrink-0 text-[var(--text-xs)] text-[var(--risk)]" title={note}>取不回来</span>
      )}
      {state === 'saved' && (
        <span className="min-w-0 shrink truncate text-[var(--text-xs)] text-[var(--safe)]" title={note}>
          已保存 · {note.split('/').pop()}
        </span>
      )}

      <button
        onClick={() => { void fetchIt(); }}
        disabled={state === 'busy'}
        className="btn btn-quiet shrink-0"
      >
        {state === 'busy' ? '取回中…' : state === 'saved' ? '再取一次' : '取回'}
      </button>
    </div>
  );
}

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      {title && (
        <h3 className="mb-2 text-[var(--text-xs)] font-medium text-[var(--ink-tertiary)]">{title}</h3>
      )}
      <div className="card px-4">{children}</div>
    </section>
  );
}

export { ItemDetail, EmptyDetail };
