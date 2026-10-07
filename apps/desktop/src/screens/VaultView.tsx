import { ProfileAccountMenu } from '../components/ProfileAccountMenu';
import { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } from 'react';
import { SORT_BY, SORT_LABEL, type SortBy, type UserProfile, type VaultItem, type VaultFolder } from '@coffer/vault';
import type { IconStore } from '@coffer/vault';
import type { ApplicationClient, ItemDetailData, SiteContext, SecretRef } from '../application/types';
/* `IS_DESKTOP` 是**编译期常量**（`__PLATFORM__`），打包时被替换成字面量 ——
   于是移动端的产物里根本不包含 `AutotypeAction` 那一段，而不只是「不执行」。
   见 packages/ui/src/platform.ts。 */
import { iconStoreFor, IS_DESKTOP } from '@coffer/ui';
import { useShowTypes } from '../prefs';
import { ItemIcon } from '@coffer/ui';
import { AutotypeAction } from '../components/AutotypeAction';
import { SecurityReportView } from './SecurityReport';
import { ImportScreen } from './Import';
import { visibleVaultItems, type VaultCategory as Category } from './vault-presentation';

import { Settings } from './Settings';
import { Generator } from './Generator';
import { FloatingPanel, useRetainedPresence } from '@coffer/ui';

import { useToast } from '../components/Toast';
import {
  IconAlert, IconArrowLeft, IconDice, IconFolder, IconImport,
  IconIdentity, IconItems, IconKeyboard, IconMore, IconPencil, IconPlus,
  CopyButton, IconChevronDown, IconSearch, IconShield, IconSpinner, IconStar, IconTrash,
  IDENTITY_LABEL, ItemEditor, ItemRow, NavDrawer, NavTrigger, SecretField, Section,
  TYPE_LABEL, TypeIcon, countByType,
  scheduleClipboardClear, typeDestinations, type ItemSummary,
} from '@coffer/ui';

interface Props {
  client: ApplicationClient;
  onLock: () => void;
}

type Mode = { kind: 'browse' } | { kind: 'loading' } | { kind: 'edit'; item: VaultItem } | { kind: 'new' };

export function VaultView({ client, onLock }: Props) {
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
  const session = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>({ kind: 'all' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'browse' });
  const [confirmDelete, setConfirmDelete] = useState<ItemSummary | null>(null);
  const editRequest = useRef(0);
  useEffect(() => () => { editRequest.current++; }, []);
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
  // 侧栏「类别」那一节的开关，偏好存在 localStorage，改了立刻生效
  const [showTypes] = useShowTypes();

  /*
   * 排序方式。
   *
   * ⚠️ 用 `useState` 的惰性初始值读一次 localStorage，**不是**每次渲染都读 ——
   * 后者在 250 条的列表上每次重渲都要碰一次同步存储。
   *
   * 存在这里而不是 `prefs.ts`：它只被这一屏用，没有第二个读者，
   * 加进那个模块只会让「什么时候该用 prefs」这条线变模糊。
   */
  const [sortOpen, setSortOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>(() => {
    const saved = localStorage.getItem('coffer.pref.sortBy');
    return saved === SORT_BY.name || saved === SORT_BY.created ? saved : SORT_BY.updated;
  });
  function changeSort(v: SortBy): void {
    setSortBy(v);
    localStorage.setItem('coffer.pref.sortBy', v);
  }

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
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : '文件夹操作失败');
    }
  }

  const items = session.items;
  const folders = session.folders;
  const [site, setSite] = useState<SiteContext | null>(null);
  const [siteError, setSiteError] = useState<string | null>(null);
  const [contextAttempt, setContextAttempt] = useState(0);
  useEffect(() => {
    const browserActions = client.browser;
    if (!browserActions) return;
    let alive = true;
    let request = 0;
    const refresh = async () => {
      const current = ++request;
      try {
        const context = await browserActions.context();
        if (alive && current === request) { setSite(context); setSiteError(null); }
      } catch (e) {
        if (alive && current === request) { setSite(null); setSiteError(e instanceof Error ? e.message : '无法读取当前页面'); }
      }
    };
    void refresh();
    window.addEventListener('focus', refresh);
    return () => { alive = false; window.removeEventListener('focus', refresh); };
  }, [client, session.revision, contextAttempt]);

  const [search, setSearch] = useState<{ query: string; revision: number; items: ItemSummary[] } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const normalizedQuery = query.trim();
  useEffect(() => {
    let alive = true;
    setSearchError(null);
    if (!normalizedQuery) { setSearch(null); return; }
    const timer = setTimeout(() => {
      void client.search(normalizedQuery).then((found) => {
        if (alive) setSearch({ query: normalizedQuery, revision: session.revision, items: found });
      }).catch((e: unknown) => {
        if (alive) setSearchError(e instanceof Error ? e.message : '搜索失败');
      });
    }, 120);
    return () => { alive = false; clearTimeout(timer); };
  }, [client, normalizedQuery, session.revision, searchAttempt]);
  const searchReady = search?.query === normalizedQuery && search.revision === session.revision;
  const searching = Boolean(normalizedQuery) && !searchReady && !searchError;
  const searchItems = normalizedQuery ? searchReady ? search.items : [] : items;

  function closeEditor(): void { editRequest.current++; setMode({ kind: 'browse' }); }
  async function edit(id: string): Promise<void> {
    const current = ++editRequest.current;
    setMode({ kind: 'loading' });
    try {
      const draft = await client.getDraft(id);
      if (current === editRequest.current && client.getSnapshot().status === 'unlocked') setMode({ kind: 'edit', item: draft });
    } catch (e) {
      if (current !== editRequest.current) return;
      setMode({ kind: 'browse' });
      toast.show({ tone: 'danger', message: e instanceof Error ? e.message : '无法编辑条目' });
    }
  }


  /*
   * 每个类别有多少条。
   *
   * ⚠️ 计数取**全部条目**，不跟着当前筛选变 —— 侧栏上那个数字的意思是
   * 「这个分类里有多少东西」。跟着筛选变的话，用户点进「登录」会看到
   * 其他分类的数字全变成 0，像是数据在丢。
   */
  const typeCounts = useMemo(() => {
    /*
     * ⚠️ 顺序和词表都来自 `@coffer/ui` 的 `typeDestinations` —— 弹窗的 rail
     * 用的是同一个函数。
     *
     * 早先这里按**数量降序**（「条目多的排前面少找一次」），听着合理，
     * 但它让整个导航在每次同步之后**重新洗牌** —— 用户刚记住「卡片在第三个」，
     * 多同步两条就变成第五个了。位置稳定比少找一次更重要。
     */
    return typeDestinations(countByType(items), 16).map((d) => ({
      type: d.key.slice('type:'.length),
      label: d.label,
      count: d.count ?? 0,
    }));
  }, [items]);

  const filtered = useMemo(
    () => visibleVaultItems(searchItems, category, sortBy, site?.matchedIds),
    [searchItems, category, sortBy, site],
  );
  const matchedCount = useMemo(() => {
    const matches = new Set(site?.matchedIds);
    return filtered.filter((item) => matches.has(item.id)).length;
  }, [filtered, site]);

  const selected = filtered.find((i) => i.id === selectedId) ?? null;
  const detailPresence = useRetainedPresence(selected);
  const contentRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const fullWidth = category.kind === 'security' || category.kind === 'import';
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < 620);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [fullWidth]);
  const shownSelected = selected ?? (narrow ? detailPresence.value : null);
  const detailOpen = narrow && selected !== null;
  useEffect(() => {
    if (!detailOpen) return;
    const opener = document.activeElement as HTMLElement | null;
    detailRef.current?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
    };
  }, [detailOpen]);

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
  useEffect(() => {
    if (!detailOpen || overlayOpen) return;
    function onDetailKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSelectedId(null);
      } else if (event.key === 'Tab') {
        const panel = detailRef.current;
        if (!panel) return;
        const controls = Array.from(panel.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]'))
          .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.offsetParent !== null);
        const first = controls[0];
        const last = controls[controls.length - 1];
        const active = document.activeElement;
        if (active === panel || (!event.shiftKey && active === last) || (event.shiftKey && active === first)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
    }
    window.addEventListener('keydown', onDetailKey);
    return () => window.removeEventListener('keydown', onDetailKey);
  }, [detailOpen, overlayOpen]);

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
      onSelect={(c) => { setCategory(c); setSelectedId(null); closeEditor(); }}
      counts={{ all: items.length, favorites: items.filter((i) => i.favorite).length }}
      profile={session.profile}
      unlockedAccounts={session.unlockedAccounts ?? []}
      serverUrl={session.account?.serverUrl ?? ''}
      account={session.account?.email ?? ''}
      onCreateFolder={(name) => folderOp(async () => { await client.createFolder(name); })}
      onRenameFolder={(id, name) => folderOp(async () => { await client.renameFolder(id, name); })}
      onDeleteFolder={(id) => folderOp(async () => {
        await client.deleteFolder(id);
        // 删掉的正是当前筛选中的那个 —— 得切回去，否则列表会空着
        // 而用户不知道为什么
        if (category.kind === 'folder' && category.id === id) setCategory({ kind: 'all' });
      })}
      onSwitchAccount={(account) => client.switchAccount(account)}
      onLogout={() => client.logout()}
      onOpenSettings={() => setSettingsOpen(true)}
      syncing={session.syncing}
      typeCounts={typeCounts}
      showTypes={showTypes}
      generatorOpen={generatorOpen}
      onOpenGenerator={() => setGeneratorOpen(true)}
    />
  );

  /*
    安全报告与导入占满右侧。刻意**不**保留条目列表这一栏 ——
    报告讲的是「整个库的状态」，旁边杵着一个可点的列表会把注意力
    拉回单条记录，而且点哪一条都没有对应的详情可看。
  */
  return (
    <div className="screen-in vault-shell app-shell h-full">
      {sidebar}

      {fullWidth ? (
        <div className="below-titlebar flex min-w-0 flex-1 flex-col bg-[var(--surface-paper)]">
          {category.kind === 'security' ? (
            <SecurityReportView client={client} />
          ) : (
            <ImportScreen client={client} onImported={() => {}} />
          )}
        </div>
      ) : (
        /*
          三栏外壳来自 `@coffer/ui/components.css` —— 和弹窗**同一套**。
          宽度由容器查询决定：宽时三栏并列，窄时详情盖住列表。
          这里不再写死 `w-[var(--list-w)]`，那是布局类的事。
        */
        <div ref={contentRef} className="vault-content" data-detail={selected !== null} data-detail-mounted={detailPresence.mounted}>
          <div inert={detailOpen} className="below-titlebar vault-list bg-[var(--surface-content)]">
            {/* 这一条也是标题栏的一部分 —— 整条顶部带子都可以拖窗口 */}
            <div className="band" data-tauri-drag-region="deep">
              {/* 导航开关 —— 和扩展端同一条位置：顶栏最左、搜索框前面。
                  曾经绝对定位到窗口左上角，那里是 macOS 红绿灯的地盘（系统画的，
                  抢不过），而且窗口角落不该放应用控件。 */}
              <NavTrigger />
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
              {/*
                排序。

                ⚠️ **不能做成三档分段控件。** 试过 —— 三个标签占掉约 250px，
                而这一栏总共 336px，搜索框被挤成只剩一个字的宽度。
                窄栏里的多选一用「一个按钮 + 菜单」，标签只在菜单里展开。

                按钮上显示**当前档**（而不是一个抽象的排序图标）：
                用户不用点开就知道现在按什么排。
              */}
              <div className="relative shrink-0">
                <button
                  onClick={() => setSortOpen((v) => !v)}
                  title="排序方式"
                  aria-label="排序方式"
                  aria-expanded={sortOpen}
                  className="btn btn-ghost gap-1 px-2 py-1 text-xs"
                >
                  {SORT_LABEL[sortBy]}
                  <IconChevronDown size={11} />
                </button>
                {sortOpen && (
                  <>
                    {/* 点别处关掉。透明铺满全屏，比 document 监听简单且不会漏 */}
                    <div className="fixed inset-0 z-20" onClick={() => setSortOpen(false)} />
                    <div
                      className="absolute right-0 top-full z-30 mt-1 min-w-[104px] rounded-[var(--radius-md)] border border-[var(--border-overlay)] bg-[var(--surface-overlay)] p-1"
                      style={{ boxShadow: 'var(--elev-pop)' }}
                    >
                      {([SORT_BY.updated, SORT_BY.created, SORT_BY.name] as const).map((v) => (
                        <button
                          key={v}
                          onClick={() => { changeSort(v); setSortOpen(false); }}
                          className={`flex w-full items-center rounded-[var(--radius-sm)] px-2 py-1 text-left text-xs transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] ${
                            v === sortBy ? 'text-[var(--accent)]' : 'text-[var(--ink-secondary)]'
                          }`}
                        >
                          {SORT_LABEL[v]}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <button onClick={() => setMode({ kind: 'new' })} title="新建条目  ⌘N" className="btn btn-primary">
<IconPlus size={15} />
</button>
            </div>

            {client.browser && <BrowserContext client={client} site={site} error={siteError}
              onRefresh={() => setContextAttempt((n) => n + 1)}
              onSelectSite={() => { setCategory({ kind: 'site' }); setSelectedId(null); }} />}

            {(folderError || searchError) && (
              <div className="flex items-start gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-well)] px-3.5 py-2">
                <IconAlert size={14} className="mt-0.5 shrink-0 text-[var(--risk)]" />
                <p className="min-w-0 flex-1 text-xs text-[var(--risk)]">{folderError || searchError}</p>
                <button onClick={() => {
                  setFolderError(null);
                  if (searchError) { setSearchError(null); setSearchAttempt((n) => n + 1); }
                }} className="btn btn-ghost shrink-0">{searchError ? '重试' : '知道了'}</button>
              </div>
            )}

            <ul className="flex-1 overflow-y-auto px-2 py-2">
              {filtered.map((item, index) => (
                <li key={item.id}>
                  {matchedCount > 0 && (index === 0 || index === matchedCount) && (
                    <p className="px-2 pb-1 pt-2 text-xs text-[var(--ink-tertiary)]">
                      {index === 0 ? '当前网站' : '其他条目'}
                    </p>
                  )}
                  <ItemRow
                    icon={<SummaryIcon item={item} store={icons} />}
                    name={item.name}
                    nameFailed={item.nameFailed}
                    summary={item.summary}
                    favorite={item.favorite}
                    selected={item.id === selectedId}
                    onClick={() => setSelectedId(item.id)}
                  />
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="px-4 py-10 text-center">
                  {searching ? <p role="status" className="text-sm text-[var(--ink-tertiary)]">正在搜索…</p> : searchError ? null : query ? (
                    <p className="text-sm text-[var(--ink-tertiary)]">
                      没有匹配「{query}」的条目
                    </p>
                  ) : session.syncing && items.length === 0 ? (
                    /*
                     * ⚠️ **「还在载入」和「真的是空的」必须分开说。**
                     *
                     * 两者在数据上都是 `items.length === 0`，但对用户是
                     * 完全不同的事。同步期间显示「这里还是空的 / 点新建加第一条」
                     * 是在**报假信**：用户会以为保险库出问题了（他的东西呢？），
                     * 甚至可能真的去新建一条。
                     *
                     * 首次登录（没有本地缓存）时这一段有几秒 —— 正好是
                     * 最容易让人误判的时候。
                     */
                    <>
                      <p className="flex items-center justify-center gap-1.5 text-sm text-[var(--ink-secondary)]">
                        <IconSpinner size={13} className="text-[var(--ink-tertiary)]" />
                        正在载入…
                      </p>
                      <p className="mt-1 text-xs text-[var(--ink-tertiary)]">
                        第一次打开要拉整个保险库，之后就快了
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-[var(--ink-secondary)]">这里还是空的</p>
                      <p className="mt-1 text-xs text-[var(--ink-tertiary)]">
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
          <div ref={detailRef} data-selectable className="below-titlebar vault-detail bg-[var(--surface-paper)]"
            data-state={selected ? 'open' : detailPresence.leaving ? 'closing' : 'closed'}
            tabIndex={-1} inert={narrow && !selected} aria-hidden={narrow && !selected || undefined}
            onAnimationEnd={(event) => {
              if (detailPresence.leaving && event.target === event.currentTarget) detailPresence.onExited();
            }}>
            {shownSelected ? (
              <SelectedDetail
                key={`${shownSelected.id}:${session.revision}`}
                client={client}
                item={shownSelected}
                icons={icons}
                onEdit={() => { void edit(shownSelected.id); }}
                onBack={() => setSelectedId(null)}
                site={site}
                onDelete={() => setConfirmDelete(shownSelected)}
                onToggleFavorite={() => {
                  // ⚠️ 这里原来没有 catch：收藏失败会变成一个没人看见的
                  // unhandled rejection，用户看到的是「点了没反应」。
                  // 收藏按钮就在他手指底下，失败时不会有任何别的地方告诉他
                  void client.toggleFavorite(shownSelected.id)
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
        </div>
      )}

      <DeleteDialog
          item={confirmDelete}
          onCancel={() => setConfirmDelete(null)}
          onTrash={async () => {
            const target = confirmDelete;
            if (!target) return;
            await client.moveToTrash(target.id);
            setConfirmDelete(null);
            setSelectedId(null);
            toast.show({ tone: 'success', message: `已把「${target.name}」移到回收站` });
          }}
          onPermanent={async () => {
            const target = confirmDelete;
            if (!target) return;
            await client.deletePermanently(target.id);
            setConfirmDelete(null);
            setSelectedId(null);
            toast.show({ tone: 'neutral', message: `已永久删除「${target.name}」` });
          }}
      />

      {/*
        设置面板挂在最外层 —— 它浮在三栏之上，和删除确认是同一层的东西。
        入口在侧栏顶端（.band 的右端），和另外两栏的头部在同一条水平线上。
      */}
      <Settings
        client={client}
        open={settingsOpen}
        account={session.account?.email ?? ''}
        serverUrl={session.account?.serverUrl ?? ''}
        onClose={() => setSettingsOpen(false)}
        capabilities={client.capabilities}
        onDisconnect={() => client.logout()}
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
        没了，退场动画根本没机会播。删除确认和载入状态也保持挂载，
        让所有关闭路径都能完成退场。
      */}
      <FloatingPanel open={mode.kind === 'loading'} onClose={closeEditor} labelledBy="edit-loading" className="max-w-sm p-5">
        <p id="edit-loading" role="status" className="flex items-center gap-2"><IconSpinner size={15} />正在载入编辑内容…</p>
        <button onClick={closeEditor} className="btn btn-quiet mt-4 self-start">取消</button>
      </FloatingPanel>
      <ItemEditor
        folders={folders}
        onSave={(d) => client.saveItem(d)}
        open={mode.kind === 'edit' || mode.kind === 'new'}
        item={mode.kind === 'edit' ? mode.item : null}
        onCancel={closeEditor}
        onDone={(saved) => {
          closeEditor();
          if (saved) {
            setSelectedId(saved.id);
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
  item: ItemSummary | null;
  onCancel: () => void;
  onTrash: () => Promise<void>;
  onPermanent: () => Promise<void>;
}) {
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retained = useRetainedPresence(props.item);
  useEffect(() => {
    if (props.item) { setAck(false); setBusy(false); setError(null); }
  }, [props.item]);
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : '删除失败'); setBusy(false); }
  }
  /*
    走和设置面板同一个浮层外壳。

    改之前这个对话框是自己写的：没有 Esc、点遮罩不关、Tab 能走到背后的
    列表上去。它本来是界面上唯一的浮层，所以这些缺口没人碰得到；
    现在有了第二个浮层，两套各漏一点的交互只会让人怀疑哪一套才是对的。
  */
  return (
    <FloatingPanel open={props.item !== null} onClose={() => { if (!busy) props.onCancel(); }} labelledBy="delete-title" className="max-w-sm p-5">
      <h3 id="delete-title" className="text-lg font-semibold">删除「{retained.value?.name}」？</h3>
      <p className="mt-1.5 text-sm text-[var(--ink-secondary)]">
        移到回收站后仍可恢复。永久删除则<strong className="font-medium text-[var(--risk)]">无法撤销</strong>。
      </p>

      <label className="mt-4 flex items-start gap-2.5 rounded-[var(--radius-sm)] bg-[var(--surface-well)] p-2.5 text-xs text-[var(--ink-secondary)]">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
        我知道永久删除无法恢复
      </label>

      {error && <p role="alert" className="mt-3 text-sm text-[var(--risk)]">{error}</p>}
      <div className="mt-4 flex flex-col gap-2">
        <button disabled={busy} onClick={() => { void run(props.onTrash); }} className="btn btn-primary w-full py-2.5">移到回收站</button>
        <button onClick={() => { void run(props.onPermanent); }} disabled={!ack || busy} className="btn btn-danger w-full py-2.5">
          永久删除
        </button>
        <button onClick={props.onCancel} disabled={busy} className="btn w-full py-2.5 text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]">
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
  onLogout: () => Promise<void>;
  onSwitchAccount: (account: { serverUrl: string; email: string } | null) => Promise<void>;
  account: string;
  profile: UserProfile | null;
  unlockedAccounts?: readonly string[];
  serverUrl: string;
  onOpenSettings: () => void;
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
}) {
  /*
   * 导航的键 ↔ `Category` 的映射。
   * 类型和文件夹带前缀（`type:` / `folder:`），和固定项区分开 ——
   * 共享的 `NavRail` 只认字符串键，它不该知道这个 app 的分类类型长什么样。
   */
  const currentKey = props.generatorOpen
    ? 'generator'
    : props.category.kind === 'type' ? `type:${props.category.type}`
    : props.category.kind === 'folder' ? `folder:${props.category.id}`
    : props.category.kind;

  function onNavSelect(key: string): void {
    if (key.startsWith('type:')) props.onSelect({ kind: 'type', type: key.slice('type:'.length) });
    else if (key.startsWith('folder:')) props.onSelect({ kind: 'folder', id: key.slice('folder:'.length) });
    else if (key === 'profile') props.onOpenSettings();
    else if (key === 'generator') props.onOpenGenerator();
    else props.onSelect({ kind: key as 'all' | 'favorites' | 'security' | 'import' });
  }

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
    /*
      ⚠️ 包在 `NavDrawer` 里 —— **和扩展端同一个结构**。
      宽屏时 CSS 把它变回常驻侧栏（见 components.css 的 `@container shell`），
      窄屏时它就是悬停抽屉。两端因此是同一份标记，只是宽度不同。
    */
    <NavDrawer
      className="app-sidebar below-titlebar"
      label="保险库导航"
      brand={<ProfileAccountMenu
        account={{ email: props.account, serverUrl: props.serverUrl, profile: props.profile }}
        syncing={props.syncing}
        unlockedAccounts={props.unlockedAccounts ?? []}
        onProfile={props.onOpenSettings}
        onSettings={props.onOpenSettings}
        onLogout={props.onLogout}
        onSwitch={props.onSwitchAccount}
      />}
      current={currentKey}
      onSelect={onNavSelect}
      groups={[
        { key: 'profile', entries: [{ key: 'profile', label: '资料', icon: <IconIdentity size={16} /> }] },
        {
          key: 'main',
          title: '',
          entries: [
            { key: 'all', label: '全部', icon: <IconItems size={16} />, count: props.counts.all },
            { key: 'favorites', label: '收藏', icon: <IconStar size={16} />, count: props.counts.favorites },
            /* 安全报告与导入都不是「列表筛选」，而是一整块内容 ——
               选中它们时右侧不再显示条目列表，理由见渲染分支 */
            { key: 'security', label: '安全报告', icon: <IconShield size={16} /> },
            { key: 'generator', label: '生成器', icon: <IconDice size={16} /> },
            { key: 'import', label: '导入', icon: <IconImport size={16} /> },
          ],
        },
        {
          key: 'folders',
          title: '文件夹',
          action: (
            <button
              onClick={() => { setCreating(true); setMenuFor(null); }}
              title="新建文件夹"
              aria-label="新建文件夹"
              data-nav-new-folder
              className="rounded-[var(--radius-sm)] p-1 text-[var(--ink-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]"
            >
              <IconPlus size={13} />
            </button>
          ),
          /*
           * ⚠️ 这一节**整个自己渲染** —— 它要就地改名、删除前还要确认，
           * 是一个「带内联编辑的列表」，不是一组导航项。
           * 分组的标题和「+」仍然由 `NavRail` 排版（见上面 action），
           * 只有行是这边的。这是 `NavGroup.render` 存在的理由。
           */
          render: () => (
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
                        <p className="mb-2 text-xs leading-relaxed text-[var(--ink-secondary)]">
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
          ),
        },
        ...(props.showTypes && props.typeCounts.length > 0
          ? [{
              key: 'types',
              title: '类别',
              entries: props.typeCounts.map((t) => ({
                key: `type:${t.type}`,
                label: t.label,
                icon: <TypeIcon type={t.type} size={16} />,
                count: t.count,
              })),
            }]
          : []),
      ]}

    />
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
        className={`nav-item flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-[7px] text-left text-sm transition-colors duration-[var(--dur-fast)] ${
          props.active
            ? 'bg-[var(--surface-selected)] font-medium text-[var(--ink-primary)]'
            : 'text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]'
        }`}
      >
        <span className={props.active ? 'text-[var(--accent)]' : 'text-[var(--ink-tertiary)]'}>
          {props.icon}
        </span>
        <span className="nav-label min-w-0 flex-1 truncate">{props.label}</span>
        {/* 计数是字，不是图形 —— 在玻璃上必须用次级墨（理由见 Sidebar 的注释） */}
        {props.count !== undefined && (
          <span className="nav-count shrink-0 text-2xs tabular-nums text-[var(--ink-secondary)]">{props.count}</span>
        )}
      </button>
      {/* 文件夹项的重命名/删除菜单 —— 折叠态放不下，跟着一起藏 */}
      {props.children && <div className="nav-extra">{props.children}</div>}
    </li>
  );
}

/*
 * `ItemRow` 已经搬到 `@coffer/ui` —— 桌面端和浏览器插件**共用同一个**。
 *
 * 搬家的理由不是「少写点代码」：这一行决定「同一条记录看起来是什么样」，
 * 两处各写一遍的后果是**同一条在两个地方显示成不同的东西**，
 * 而用户会以为记错了、甚至以为丢数据。
 *
 * 组件本身不碰 `VaultItem` —— 图标由调用方给（两端的取法确实不同：
 * 桌面跨源被 CORS 拦、得走 Rust，弹窗有 host_permissions、直接 fetch），
 * 第二行由调用方传 `summaryOf` 的结果。
 */

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
      className="field px-2 py-1 text-sm"
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
        <p className="text-md text-[var(--ink-secondary)]">
          {hasItems ? '选一条记录查看详情' : '还没有可以看的记录'}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-[var(--ink-tertiary)]">
          {hasItems
            ? '用 ↑ ↓ 在列表里移动，⌘F 直接搜名字或网址。'
            : '左上的「新建」可以从空白开始，或从 1Password、Bitwarden 导入。'}
        </p>
      </div>
    </div>
  );
}

function BrowserContext({ client, site, error, onRefresh, onSelectSite }: {
  client: ApplicationClient;
  site: SiteContext | null;
  error: string | null;
  onRefresh: () => void;
  onSelectSite: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  async function capture(save: boolean): Promise<void> {
    if (!client.browser || site?.tabId == null || busy) return;
    setBusy(true); setActionError(null);
    try {
      if (save) await client.browser.saveCapture(site.tabId);
      else await client.browser.dismissCapture(site.tabId);
      onRefresh();
    } catch (e) { setActionError(e instanceof Error ? e.message : '保存提示处理失败'); }
    finally { setBusy(false); }
  }
  if (!site && !error) return null;
  return <div className="border-b border-[var(--border-subtle)] px-3.5 py-2.5">
    {site?.url && <button onClick={onSelectSite} className="flex w-full items-center gap-2 text-left text-xs text-[var(--ink-secondary)]">
      <span className="min-w-0 flex-1 truncate" title={site.url}>当前网站 · {siteHost(site.url)}</span>
      <span className="shrink-0 text-[var(--accent)]">{site.matchedIds.length} 条匹配</span>
    </button>}
    {site?.pending && <div className="mt-2.5 rounded-[var(--radius-sm)] bg-[var(--surface-well)] p-3">
      <p className="text-sm">{site.pending.action === 'update' ? '更新已保存的登录？' : '保存这次登录？'}</p>
      <p className="mt-1 truncate text-xs text-[var(--ink-secondary)]">{siteHost(site.pending.url)}{site.pending.username ? ` · ${site.pending.username}` : ''}</p>
      <div className="mt-2 flex gap-2">
        <button disabled={busy} onClick={() => { void capture(true); }} className="btn btn-primary">{busy ? '处理中…' : site.pending.action === 'update' ? '更新' : '保存'}</button>
        <button disabled={busy} onClick={() => { void capture(false); }} className="btn btn-quiet">忽略</button>
      </div>
    </div>}
    {(error || actionError) && <div role="alert" className="mt-2 text-xs text-[var(--risk)]"><p>{error || actionError}</p>
      {error && <button className="btn btn-ghost mt-1" onClick={onRefresh}>重试</button>}</div>}
  </div>;
}

function siteHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function BrowserFill({ client, itemId, tabId }: { client: ApplicationClient; itemId: string; tabId: number }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  async function fill(): Promise<void> {
    if (!client.browser || busy) return;
    setBusy(true); setResult(null);
    try {
      await client.browser.fill(itemId, tabId);
      setResult({ ok: true, message: '已填充到当前页面' });
    } catch (e) { setResult({ ok: false, message: e instanceof Error ? e.message : '填充失败' }); }
    finally { setBusy(false); }
  }
  return <div className="mb-5">
    <button onClick={() => { void fill(); }} disabled={busy} className="btn btn-primary gap-2"><IconKeyboard size={14} />{busy ? '正在填充…' : '填充到当前页面'}</button>
    {result && <p role={result.ok ? 'status' : 'alert'} className={`mt-2 text-xs ${result.ok ? 'text-[var(--safe)]' : 'text-[var(--risk)]'}`}>{result.message}</p>}
  </div>;
}

function SummaryIcon({ item, store, size }: { item: ItemSummary; store: IconStore | null; size?: number }) {
  return <ItemIcon type={item.type} iconDomain={item.iconDomain} text={item.avatarText} hue={item.avatarHue}
    store={store} {...(size === undefined ? {} : { size })} />;
}

interface DetailProps {
  icons: IconStore | null;
  client: ApplicationClient;
  item: ItemDetailData;
  onEdit: () => void;
  onDelete: () => void;
  onToggleFavorite: () => void;
  onBack: () => void;
  site?: SiteContext | null;
}

function DetailBack({ onBack }: { onBack: () => void }) {
  return <button onClick={onBack} aria-label="返回列表" className="detail-back btn btn-ghost shrink-0 p-1.5"><IconArrowLeft size={17} /></button>;
}

function SelectedDetail({ item, ...props }: Omit<DetailProps, 'item'> & { item: ItemSummary }) {
  const [detail, setDetail] = useState<ItemDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    void props.client.getItem(item.id).then((value) => {
      if (alive) setDetail(value);
    }).catch((e: unknown) => {
      if (alive) setError(e instanceof Error ? e.message : '无法载入条目');
    });
    return () => { alive = false; };
  }, [props.client, item.id, retry]);
  if (detail) return <ItemDetail {...props} item={detail} />;
  return <div className="p-4">
    <DetailBack onBack={props.onBack} />
    {error ? <div role="alert" className="p-4 text-sm text-[var(--risk)]"><p>{error}</p>
      <button className="btn btn-quiet mt-3" onClick={() => setRetry((n) => n + 1)}>重试</button></div>
      : <p role="status" className="flex items-center gap-2 p-4 text-sm text-[var(--ink-secondary)]"><IconSpinner size={15} />正在载入…</p>}
  </div>;
}

function ItemDetail({ client, item, icons, onEdit, onDelete, onToggleFavorite, onBack, site }: DetailProps) {
  const summary = item.summary;
  const [totp, setTotp] = useState<{ code: string; remaining: number; period: number } | null>(null);
  const [totpError, setTotpError] = useState<string | null>(null);
  const [secretError, setSecretError] = useState<string | null>(null);
  useEffect(() => {
    if (!item.login?.hasTotp) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh(): Promise<void> {
      try {
        const value = await client.totp(summary.id);
        if (alive) { setTotp(value); setTotpError(null); }
      } catch (e) {
        if (alive) { setTotp(null); setTotpError(e instanceof Error ? e.message : '无法获取验证码'); }
      } finally {
        if (alive) timer = setTimeout(() => { void refresh(); }, 1000);
      }
    }
    void refresh();
    return () => { alive = false; clearTimeout(timer); };
  }, [client, summary.id, item.login?.hasTotp]);

  function secret(label: string, field: SecretRef, key?: number) {
    return <SecretField key={key ?? label} label={label} value="••••••••" masked
      getValue={() => client.reveal(summary.id, field)}
      revealValue={() => client.reveal(summary.id, field)}
      onCopyError={(e) => setSecretError(e instanceof Error ? e.message : '无法读取字段')} />;
  }

  const uris = item.login?.uris ?? [];

  return (
    <article className="screen-in mx-auto w-full px-8 pb-12" style={{ maxWidth: 'calc(var(--detail-w) + 64px)' }}>
      {/* 头部跟着滚 —— 长条目滚到下面时，用户仍然看得到自己在看哪一条 */}
      <header className="sticky top-0 z-10 -mx-8 flex flex-wrap items-start gap-3.5 border-b border-[var(--border-subtle)] bg-[var(--surface-paper)] px-8 pb-4 pt-5">
        {/*
          ⚠️ 和列表用**同一个** ItemIcon，不是再画一个类型图标。
          之前这里是按类型上色的旧写法，于是同一条记录在列表里显示站点图标、
          在详情栏里却是一把钥匙 —— 明明是同一条。
        */}
        <DetailBack onBack={onBack} />
        <span className="mt-0.5">
          <SummaryIcon item={summary} store={icons} size={36} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className={`truncate text-xl font-semibold tracking-[-0.015em] ${
            summary.nameFailed ? 'italic text-[var(--ink-tertiary)]' : ''
          }`}>
            {summary.nameFailed ? '无法解密' : summary.name}
          </h2>
          <p className="mt-0.5 text-xs text-[var(--ink-tertiary)]">
            {TYPE_LABEL[summary.type] ?? '未知类型'}
            {item.rawType > 5 && '（此类型较新，暂只支持查看）'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          <button onClick={onToggleFavorite} title={summary.favorite ? '取消收藏' : '加入收藏'}
            aria-label={summary.favorite ? '取消收藏' : '加入收藏'}
            className={`rounded-[var(--radius-sm)] p-1.5 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] ${
              summary.favorite ? 'text-[var(--caution)]' : 'text-[var(--ink-tertiary)]'
            }`}>
            <IconStar size={16} filled={summary.favorite} />
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
        {secretError && <p role="alert" className="mb-3 text-sm text-[var(--risk)]">{secretError}</p>}
        {client.browser && site?.tabId != null && item.login && <BrowserFill client={client} itemId={summary.id} tabId={site.tabId} />}
        {item.login && (
          <Section title="登录">
            {item.login.username !== null && <SecretField label="用户名" value={item.login.username} />}
            {item.login.hasPassword && secret('密码', { kind: 'password' })}
            {totp && <TotpRow code={totp.code} remaining={totp.remaining} period={totp.period} />}
            {totpError && <p role="alert" className="py-2 text-xs text-[var(--risk)]">{totpError}</p>}
            {/*
              原生窗口自动输入（spec §7.4）。放在登录字段这一组的末尾 ——
              它是「把凭据送出去」的动作，紧跟在被送出去的东西后面最合理。

              ⚠️ **只有桌面端有这一条**，而且不是「还没做」——
              「往**别的应用**的输入框里合成按键」这件事在 iOS 上根本不存在：
              沙箱不允许，能做的是系统级自动填充（App Extension），
              那是**另一套东西**，不是这一套的移植。见 docs 里移动端那一节。
            */}
            {IS_DESKTOP && client.capabilities.native && item.login.hasPassword && (
              <div className="border-t border-[var(--border-subtle)] py-3 first:border-0">
                <AutotypeAction username={item.login.username} getPassword={() => client.reveal(summary.id, { kind: 'password' })} />
              </div>
            )}
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
            {item.card.hasNumber && secret('卡号', { kind: 'cardNumber' })}
            {item.card.expMonth && <SecretField label="有效期" value={`${item.card.expMonth}/${item.card.expYear ?? ''}`} />}
            {item.card.hasCode && secret('安全码', { kind: 'cardCode' })}
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
            {item.sshKey.hasPrivateKey && secret('私钥', { kind: 'privateKey' })}
          </Section>
        )}

        {item.attachments.length > 0 && (
          <Section title="附件">
            {item.attachments.map((a) => (
              <AttachmentRow key={a.id} client={client} itemId={summary.id} attachment={a} />
            ))}
          </Section>
        )}

        {item.customFields.length > 0 && (
          <Section title="自定义字段">
            {item.customFields.map((f, i) => (
              f.type === 1 ? secret(f.name, { kind: 'custom', index: i }, i) : <SecretField key={i} label={f.name} value={f.value ?? ''} />
            ))}
          </Section>
        )}

        {item.notesFailed && <p role="alert" className="mb-3 text-sm text-[var(--risk)]">无法解密备注</p>}
        {item.notes && (
          <Section title="备注">
            <p className="whitespace-pre-wrap break-words py-2.5 text-md leading-[var(--lh-prose)]">
              {item.notes}
            </p>
          </Section>
        )}

        {item.passwordHistory.length > 0 && (
          <Section title="历史密码">
            {item.passwordHistory.map((h, i) => (
              secret(new Date(h.lastUsedDate).toLocaleDateString('zh-CN'), { kind: 'history', index: i }, i)
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
      <span className="w-[84px] shrink-0 text-sm text-[var(--ink-secondary)]">验证码</span>

      {/* key 让每次换码都重放一遍淡入 —— 这就是「它变了」的信号 */}
      <span key={code} className="code-turn min-w-0 flex-1">
        <span className="secret text-xl font-medium tracking-[0.12em]" style={{ color: tone }}>
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
        <CopyButton getValue={async () => code} onCopied={scheduleClipboardClear} />
      </span>
    </div>
  );
}

/* `TYPE_LABEL` 搬到 `@coffer/ui` 了 —— 两端各写一份的后果是
   同一个类型在两个地方叫不同的名字（真发生过：「信用卡」vs「卡片」）。 */

/* `IDENTITY_LABEL` 搬到 `@coffer/ui` 了 —— 和 `TYPE_LABEL` 同一族，
   各写一份的后果是「身份证号」vs「证件号」那种漂。 */

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
function AttachmentRow({ client, itemId, attachment }: {
  client: ApplicationClient;
  itemId: string;
  attachment: ItemDetailData['attachments'][number];
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'saved' | 'failed'>('idle');
  const [note, setNote] = useState('');

  async function fetchIt(): Promise<void> {
    setState('busy');
    setNote('');
    try {
      const got = await client.downloadAttachment(itemId, attachment.id);
      const saved = await client.saveFile(got.fileName || attachment.fileName || 'attachment', got.dataBase64);
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
      <span className="min-w-0 flex-1 truncate text-sm" title={attachment.fileName}>
        {attachment.fileName || '（没有文件名）'}
      </span>
      {attachment.sizeName && (
        <span className="shrink-0 text-xs text-[var(--ink-tertiary)]">
          {attachment.sizeName}
        </span>
      )}

      {state === 'failed' && (
        <span className="shrink-0 text-xs text-[var(--risk)]" title={note}>取不回来</span>
      )}
      {state === 'saved' && (
        <span className="min-w-0 shrink truncate text-xs text-[var(--safe)]" title={note}>
          已保存 · {note.split('/').pop()}
        </span>
      )}

      <button
        onClick={() => { void fetchIt(); }}
        disabled={state === 'busy' || attachment.failed || !client.capabilities.saveAttachments}
        className="btn btn-quiet shrink-0"
      >
        {state === 'busy' ? '取回中…' : state === 'saved' ? '再取一次' : '取回'}
      </button>
    </div>
  );
}

/* `Section` 也搬到 `@coffer/ui` 了 —— 详情两边的分组方式必须一致，
   否则「登录信息」在一边是一张卡、在另一边是几个散字段。 */

export { ItemDetail, EmptyDetail };
