import { useEffect, useRef } from 'react';
import { useLocalStore, useStoreField, useStoreSnapshot } from '@1warden/state/react';
import { IconSpinner, PageHeader, TYPE_LABEL, type ItemSummary } from '@1warden/ui';
import type { OrganizationReport } from '@1warden/vault';
import type { ApplicationClient, ApplicationSnapshot } from '../application/types';

const PAGE_SIZE = 20;
const CATEGORIES = [
  { id: 'identical', label: '已检查内容一致', unit: '组', hint: '已检查的内容一致；历史、附件等未比较内容仍需逐条确认。本页不会合并或删除条目。' },
  { id: 'similar', label: '疑似重复', unit: '组', hint: '这些条目之间存在相同用户名和站点线索，可能关联不同网站或用途，请逐条人工核对后再整理。' },
  { id: 'missingUrls', label: '未填写网址', unit: '条', hint: '补充登录网址有助于识别网站与匹配登录。没有网址也可能是正常的使用方式。' },
  { id: 'missingUsernames', label: '未填写用户名', unit: '条', hint: '确认这些登录是否需要用户名；无需用户名的登录可以保持现状。' },
  { id: 'lowInformationNames', label: '名称信息少', unit: '条', hint: '更明确的名称有助于区分账户和用途。' },
  { id: 'unfiled', label: '未分类', unit: '条', hint: '这些条目尚未放入文件夹。可以按用途分类，也可以继续保留在全部条目中。' },
] as const;
type Category = typeof CATEGORIES[number]['id'];
type ResultRow = { itemIds: string[]; kind?: 'identical' | 'similar' };

function sourceOf(snapshot: ApplicationSnapshot): string {
  return JSON.stringify([snapshot.account?.serverUrl, snapshot.account?.email, snapshot.account?.userId, snapshot.status, snapshot.revision]);
}
function rowsOf(report: OrganizationReport, category: Category): ResultRow[] {
  if (category === 'identical' || category === 'similar') return report.duplicates.filter(group => group.kind === category);
  return report[category].map(id => ({ itemIds: [id] }));
}

/** Local, read-only findings. A result belongs to one account and one snapshot. */
export function Organization({ client, onBack, onEditItem, editing = false }: {
  client: ApplicationClient;
  onBack: () => void;
  onEditItem: (id: string) => void | Promise<void>;
  editing?: boolean;
}) {
  const snapshot = useStoreSnapshot(client.subscribe, client.getSnapshot);
  const source = sourceOf(snapshot);
  const unlocked = snapshot.status === 'unlocked' && snapshot.account !== null;
  const store = useLocalStore(() => ({ owner: null as ApplicationClient | null, source: '',
    report: null as OrganizationReport | null, error: null as string | null, retry: 0,
    category: null as Category | null, limit: PAGE_SIZE, groupLimits: {} as Record<string, number>,
    editingId: null as string | null, editError: null as string | null }));
  const [owner] = useStoreField(store, 'owner');
  const [reportSource] = useStoreField(store, 'source');
  const [storedReport] = useStoreField(store, 'report');
  const [storedError] = useStoreField(store, 'error');
  const [retry, setRetry] = useStoreField(store, 'retry');
  const [category, setCategory] = useStoreField(store, 'category');
  const [limit, setLimit] = useStoreField(store, 'limit');
  const [groupLimits, setGroupLimits] = useStoreField(store, 'groupLimits');
  const [editingId] = useStoreField(store, 'editingId');
  const [editError] = useStoreField(store, 'editError');
  const request = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [client]);
  useEffect(() => {
    const current = ++request.current;
    store.setState({ owner: client, source, report: null, error: null, limit: PAGE_SIZE, groupLimits: {}, editingId: null, editError: null });
    if (unlocked) {
      void client.organizationReport().then(report => {
        if (current !== request.current || sourceOf(client.getSnapshot()) !== source) return;
        const selected = store.getState().category ?? CATEGORIES.find(option => rowsOf(report, option.id).length > 0)?.id ?? 'identical';
        store.setState({ report, category: selected });
      }).catch((cause: unknown) => {
        if (current === request.current && sourceOf(client.getSnapshot()) === source) {
          store.setState({ error: cause instanceof Error ? cause.message : '无法分析当前已载入的条目，请重试' });
        }
      });
    }
    return () => { request.current++; };
  }, [client, source, unlocked, retry, store]);

  const current = unlocked && owner === client && reportSource === source;
  const report = current ? storedReport : null;
  const error = current ? storedError : null;
  const selected = CATEGORIES.find(option => option.id === category) ?? CATEGORIES[0];
  const rows = report ? rowsOf(report, selected.id) : [];
  const hasFindings = report && CATEGORIES.some(option => rowsOf(report, option.id).length > 0);
  const items = new Map(snapshot.items.map(item => [item.id, item]));
  const incomplete = snapshot.syncing || !!snapshot.syncError || snapshot.lastSyncedAt === null;
  const wasEditing = useRef(editing);
  const focusAfterEdit = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) focusAfterEdit.current = true;
    wasEditing.current = editing;
    if (editing || !focusAfterEdit.current) return;
    let cancelled = false;
    // Let the dialog restore its opener first. A removed row or an inert exit
    // panel needs a stable destination that survives report refreshes.
    queueMicrotask(() => {
      if (cancelled) return;
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected || active.closest('[inert]')) {
        heading.current?.focus({ preventScroll: true });
      }
      if (report || error || !unlocked) focusAfterEdit.current = false;
    });
    return () => { cancelled = true; };
  }, [editing, report, error, unlocked, source]);

  async function edit(id: string) {
    if (editing || store.getState().editingId || !current || !items.has(id)) return;
    const version = request.current;
    store.setState({ editingId: id, editError: null });
    try { await onEditItem(id); }
    catch (cause) { if (version === request.current) store.setState({ editError: cause instanceof Error ? cause.message : '无法打开条目编辑器，请重试' }); }
    finally { if (version === request.current) store.setState({ editingId: null }); }
  }

  function renderItem(id: string) {
    const item = items.get(id);
    const name = item ? item.nameFailed ? '无法解密名称' : item.name || '未命名条目' : '条目已不在当前已载入记录中';
    return <li key={id} className="flex min-w-0 flex-wrap items-center gap-3 p-4">
      <div className="min-w-0 flex-1 basis-[160px]">
        <p className="break-words [overflow-wrap:anywhere] text-md font-medium">{name}</p>
        {item && <ItemContext item={item} />}
      </div>
      <button type="button" className="btn btn-quiet shrink-0" aria-label={`编辑「${name}」`}
        disabled={!item || editing || !!editingId} onClick={() => { void edit(id); }}>
        {editingId === id ? '载入中…' : '编辑'}
      </button>
    </li>;
  }

  return <main aria-label="整理与分析" className="flex min-h-0 flex-1 flex-col">
    <PageHeader navigation title="整理与分析" onBack={onBack} backLabel="返回保险库"
      breadcrumbs={[{ label: '保险库', onSelect: onBack }, { label: '整理与分析' }]} />
    <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-8">
      <div className="mx-auto w-full max-w-[760px]">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 ref={heading} tabIndex={-1} className="text-xl font-semibold outline-none">整理与分析</h1>
          {report && <button type="button" className="btn btn-quiet" disabled={editing || !!editingId}
            onClick={() => setRetry(value => value + 1)}>重新分析</button>}
        </div>
        <p className="mb-3 text-sm leading-relaxed text-[var(--ink-secondary)]">只在本地读取当前账户已载入的条目，不上传分析内容，不更改记录，也不生成安全评分。</p>
        {unlocked && <p role="note" className="mb-5 break-words text-xs leading-relaxed text-[var(--ink-tertiary)]">
          {snapshot.syncing ? '正在同步；本页仅分析当前已载入的记录，同步完成后会更新结果。'
            : snapshot.syncError ? '同步未完成；当前记录可能不是最新版本，本页结果不代表服务器上的全部内容。'
            : snapshot.lastSyncedAt === null ? '尚无成功同步记录；只能分析当前已载入的内容，无法确认服务器上的全部条目。'
            : '分析范围为当前账户已载入的活跃条目，不包括回收站。'}
        </p>}
        {!unlocked ? <p role="status" className="text-sm text-[var(--ink-secondary)]">解锁当前账户后即可分析，过期结果已隐藏。</p>
          : error ? <div role="alert" className="card p-5 text-sm text-[var(--risk)]">
            <p className="break-words [overflow-wrap:anywhere]">{error}</p>
            <button type="button" className="btn btn-quiet mt-3" onClick={() => setRetry(value => value + 1)}>重试分析</button>
          </div>
          : !report ? <p role="status" className="flex items-center gap-2 text-sm text-[var(--ink-secondary)]"><IconSpinner size={15} />正在分析当前已载入的条目…</p>
          : <>
            <p className="mb-4 text-xs leading-relaxed text-[var(--ink-secondary)]">共载入 {report.total} 条，已检查 {report.checked} 条。
              {report.skipped > 0 && <> 跳过 {report.skipped} 条无法完整读取或暂不支持的记录。</>}
            </p>
            {report.total === 0 ? <div role="status" className="card p-6 text-sm text-[var(--ink-secondary)]">
              {incomplete ? '当前尚无可检查的已载入条目，请在同步完成后重新分析。' : '当前已载入的保险库没有条目。'}
            </div> : !hasFindings ? <div role="status" className="card p-6 text-sm text-[var(--ink-secondary)]">
              已检查的记录暂未发现整理线索。{report.skipped > 0 && '未能检查的记录不在此结论范围内。'}
            </div> : <>
              <label className="mb-5 block text-sm"><span className="mb-2 block text-[var(--ink-secondary)]">查看分类</span>
                <select aria-label="整理分类" className="field max-w-full sm:max-w-[320px]" value={selected.id}
                  onChange={event => { setCategory(event.target.value as Category); setLimit(PAGE_SIZE); }}>
                  {CATEGORIES.map(option => <option key={option.id} value={option.id}>{option.label} · {rowsOf(report, option.id).length} {option.unit}</option>)}
                </select>
              </label>
              <h2 className="text-md font-medium">{selected.label}</h2>
              <p className="mt-1 mb-4 text-xs leading-relaxed text-[var(--ink-secondary)]">{selected.hint}</p>
              {current && editError && <p role="alert" className="mb-4 break-words text-sm text-[var(--risk)]">{editError}</p>}
              {rows.length === 0 ? <p role="status" className="card p-5 text-sm text-[var(--ink-secondary)]">这一类暂未发现整理线索。</p>
                : selected.id === 'identical' || selected.id === 'similar' ? <div className="space-y-4">
                  {rows.slice(0, limit).map((row, index) => {
                    const key = `${selected.id}:${row.itemIds[0]}`;
                    const groupLimit = groupLimits[key] ?? PAGE_SIZE;
                    return <section key={key} className="card overflow-hidden" aria-label={`${selected.label}第 ${index + 1} 组`}>
                      <h3 className="border-b border-[var(--border-subtle)] px-4 py-3 text-sm font-medium">第 {index + 1} 组 · {row.itemIds.length} 条记录</h3>
                      <ul className="divide-y divide-[var(--border-subtle)]">{row.itemIds.slice(0, groupLimit).map(renderItem)}</ul>
                      {row.itemIds.length > groupLimit && <button type="button" className="btn btn-quiet m-4" aria-label={`显示第 ${index + 1} 组更多条目`}
                        onClick={() => setGroupLimits(value => ({ ...value, [key]: groupLimit + PAGE_SIZE }))}>显示更多条目（还剩 {row.itemIds.length - groupLimit} 条）</button>}
                    </section>;
                  })}
                </div> : <ul className="card divide-y divide-[var(--border-subtle)]">{rows.slice(0, limit).flatMap(row => row.itemIds.map(renderItem))}</ul>}
              {rows.length > limit && <button type="button" className="btn btn-quiet mt-4" onClick={() => setLimit(value => value + PAGE_SIZE)}>
                显示更多{selected.unit === '组' ? '分组' : '条目'}（还剩 {rows.length - limit} {selected.unit}）
              </button>}
              <p className="mt-5 text-xs leading-relaxed text-[var(--ink-tertiary)]">同一条目可能出现在多个分类中。编辑后会根据当前已载入的记录重新分析。</p>
            </>}
          </>}
      </div>
    </div>
  </main>;
}

function ItemContext({ item }: { item: ItemSummary }) {
  return <div className="mt-1 space-y-1 text-xs text-[var(--ink-tertiary)]">
    <p className="break-words [overflow-wrap:anywhere]">{TYPE_LABEL[item.type] ?? '条目'}{item.username ? ` · ${item.username}` : ''}</p>
    {item.iconDomain && <p className="break-words [overflow-wrap:anywhere]">{item.iconDomain}</p>}
  </div>;
}
