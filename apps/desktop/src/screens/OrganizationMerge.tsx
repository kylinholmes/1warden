import { useEffect, useId, useRef } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import { FloatingPanel, IconSpinner, PageHeader, Select, type ItemSummary } from '@1warden/ui';
import type { OrganizationMergePreview, OrganizationMergeResult } from '@1warden/vault';
import type { ApplicationClient } from '../application/types';

/** Only the owner service reads full records. This dialog keeps display-only previews. */
export function OrganizationMerge({ client, items, open, onClose, onComplete }: {
  client: ApplicationClient; items: ItemSummary[]; open: boolean;
  onClose: () => void; onComplete: (result: OrganizationMergeResult) => void;
}) {
  const titleId = useId();
  const membership = JSON.stringify(items.map(item => item.id));
  const store = useLocalStore(() => ({
    baseId: items[0]?.id ?? '', excluded: [] as string[],
    preview: null as OrganizationMergePreview | null, result: null as OrganizationMergeResult | null,
    choices: {} as Record<string, string>, busy: null as 'preview' | 'save' | null,
    error: null as string | null, needsRefresh: false,
    revealed: {} as Record<string, string>, revealing: null as string | null,
  }));
  const [baseId, setBaseId] = useStoreField(store, 'baseId');
  const [excluded, setExcluded] = useStoreField(store, 'excluded');
  const [preview] = useStoreField(store, 'preview');
  const [result] = useStoreField(store, 'result');
  const [choices, setChoices] = useStoreField(store, 'choices');
  const [busy] = useStoreField(store, 'busy');
  const [error] = useStoreField(store, 'error');
  const [needsRefresh] = useStoreField(store, 'needsRefresh');
  const [revealed] = useStoreField(store, 'revealed');
  const [revealing] = useStoreField(store, 'revealing');
  const request = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    request.current++;
    if (open) store.setState({ baseId: items[0]?.id ?? '', excluded: [], preview: null, result: null,
      choices: {}, busy: null, error: null, needsRefresh: false, revealed: {}, revealing: null });
    return () => { request.current++; store.setState({ revealed: {}, revealing: null }); };
    // Membership, not changing summary objects, defines a new merge session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, open, membership, store]);

  useEffect(() => {
    if (preview || result) heading.current?.focus({ preventScroll: true });
  }, [preview, result]);

  function close() {
    if (store.getState().busy === 'save') return;
    request.current++;
    store.setState({ revealed: {}, revealing: null });
    onClose();
  }
  function back() {
    if (store.getState().busy === 'save') return;
    if (!preview || result) { close(); return; }
    request.current++;
    store.setState({ preview: null, choices: {}, busy: null, error: null, needsRefresh: false, revealed: {}, revealing: null });
  }
  async function loadPreview() {
    const state = store.getState();
    if (state.busy || !open) return;
    const sourceIds = items.filter(item => item.id !== state.baseId && !state.excluded.includes(item.id)).map(item => item.id);
    if (!sourceIds.length) return;
    const version = ++request.current;
    store.setState({ busy: 'preview', error: null, revealed: {}, revealing: null });
    try {
      const next = await client.previewMerge({ baseId: state.baseId, sourceIds });
      if (version !== request.current) return;
      store.setState({ preview: next, choices: {}, needsRefresh: false });
    } catch (cause) {
      if (version === request.current) store.setState({ error: cause instanceof Error ? cause.message : '无法载入合并预览，请重试' });
    } finally {
      if (version === request.current) store.setState({ busy: null });
    }
  }
  async function reveal(fieldKey: string, itemId: string) {
    const state = store.getState();
    if (!open || state.busy || state.needsRefresh || state.revealing || !state.preview
      || (fieldKey !== 'password' && fieldKey !== 'totp')) return;
    const key = `${fieldKey}:${itemId}`;
    if (Object.hasOwn(state.revealed, key)) {
      const next = { ...state.revealed }; delete next[key]; store.setState({ revealed: next }); return;
    }
    const version = request.current;
    const token = state.preview.token;
    store.setState({ revealing: key, error: null });
    try {
      const value = await client.revealMergeValue({ token, fieldKey, itemId });
      if (version === request.current && store.getState().preview?.token === token) {
        store.setState(current => ({ revealed: { ...current.revealed, [key]: value } }));
      }
    } catch (cause) {
      if (version === request.current) store.setState({ error: cause instanceof Error ? cause.message : '无法查看这个字段，请重新载入预览' });
    } finally {
      if (version === request.current) store.setState({ revealing: null });
    }
  }
  async function confirm() {
    const state = store.getState();
    const plan = state.preview;
    if (!open || state.busy || state.needsRefresh || !plan || plan.blockers.length
      || plan.fields.some(field => !field.options.some(option => option.itemId === state.choices[field.key]))) return;
    const version = ++request.current;
    store.setState({ busy: 'save', error: null, revealed: {}, revealing: null });
    try {
      const outcome = await client.mergeItems({ token: plan.token, choices: state.choices });
      if (version !== request.current) return;
      store.setState({ result: outcome });
      onComplete(outcome);
    } catch (cause) {
      if (version === request.current) store.setState({ needsRefresh: true,
        error: cause instanceof Error ? cause.message : '合并未完成，请重新载入预览后核对' });
    } finally {
      if (version === request.current) store.setState({ busy: null });
    }
  }
  const sources = items.filter(item => item.id !== baseId);
  const sourceCount = sources.filter(item => !excluded.includes(item.id)).length;
  const base = preview?.items.find(item => item.id === preview.baseId) ?? items.find(item => item.id === baseId);
  const names = new Map((preview?.items ?? items).map(item => [item.id, item.name || '未命名条目']));
  const sourceNumber = (id: string) => items.findIndex(item => item.id === id) + 1;
  const sourceLabel = (id: string) => `${sourceNumber(id)}. ${names.get(id) ?? '来源条目'}`;
  const updatedLabel = (id: string) => {
    const raw = (preview?.items ?? items).find(item => item.id === id)?.updatedAt;
    const date = raw ? new Date(raw) : null;
    return date && Number.isFinite(date.getTime()) ? `更新于 ${date.toLocaleString('zh-CN')}` : '';
  };
  const unresolved = preview?.fields.filter(field => !choices[field.key]).length ?? 0;
  const blocked = Boolean(preview?.blockers.length);
  const title = result ? '合并结果' : preview ? '预览合并' : '合并条目';

  return <FloatingPanel open={open} onClose={close} labelledBy={titleId} className="w-[min(680px,calc(100vw-32px))] max-w-[680px]"
    footer={<>
      <span className="min-w-0 flex-1 text-xs leading-relaxed text-[var(--ink-secondary)]" role="status">
        {busy === 'save' ? '正在保存主条目并处理来源，请稍候…' : result
          ? '未使用永久删除，回收站中的来源仍可恢复。'
          : preview ? blocked ? '这些记录暂不能安全合并。' : `先保存主条目，再将 ${preview.itemIds.length - 1} 条来源移到回收站。`
          : `已选 ${sourceCount} 条来源；下一步只生成预览，不改动记录。`}
      </span>
      {result ? <button className="btn btn-primary shrink-0" type="button" onClick={close}>完成</button>
        : preview ? <button className="btn btn-primary shrink-0" type="button"
          disabled={!!busy || blocked || (!needsRefresh && unresolved > 0)} onClick={() => { void (needsRefresh ? loadPreview() : confirm()); }}>
          {busy && <IconSpinner size={14} />}{needsRefresh ? '重新载入预览' : busy === 'save' ? '合并中…' : '确认合并'}
        </button>
        : <button className="btn btn-primary shrink-0" type="button" disabled={!!busy || sourceCount === 0 || !baseId}
          onClick={() => { void loadPreview(); }}>{busy && <IconSpinner size={14} />}预览合并</button>}
    </>}>
    <PageHeader panel title={title} titleId={titleId} onBack={busy === 'save' || result ? undefined : back}
      backLabel={preview ? '返回选择主条目' : '取消合并'} breadcrumbs={[
        { label: '整理与分析', ...(busy === 'save' || result ? {} : { onSelect: close }) }, { label: title },
      ]} />
    <div className="panel-body min-h-0 overflow-y-auto p-5 sm:p-6" aria-busy={busy !== null}>
      <h3 ref={heading} tabIndex={-1} className="mb-2 text-lg font-semibold outline-none">{result ? '主条目已保存' : preview ? '核对要合入的信息' : '以哪条记录为主？'}</h3>
      {error && <p role="alert" className="mb-4 break-words text-sm leading-relaxed text-[var(--risk)]">{error}</p>}
      {result ? <div className="space-y-4">
        <p className="break-words text-sm leading-relaxed">信息已合入「{base?.name || '未命名条目'}」，{result.trashedIds.length} 条来源已移到回收站。</p>
        {result.retainedSources.length > 0 && <section role="alert" className="card p-4">
          <h4 className="text-sm font-medium">有 {result.retainedSources.length} 条来源需要检查</h4>
          <p className="mt-1 text-xs text-[var(--ink-secondary)]">不要重复合并；请先同步并检查以下记录。主条目的保存已经完成。</p>
          <ul className="mt-3 space-y-3 text-sm">{result.retainedSources.map(item => <li key={item.id} className="break-words">
            <p>{sourceLabel(item.id)}</p><p className="mt-1 text-xs text-[var(--ink-tertiary)]">{updatedLabel(item.id)}</p>
            <p className="mt-1 text-xs text-[var(--ink-secondary)]">{item.reason}</p>
          </li>)}</ul>
        </section>}
      </div> : preview ? <div className="space-y-5">
        <p className="break-words text-sm leading-relaxed text-[var(--ink-secondary)]">主条目：「{base?.name || '未命名条目'}」。保留它的记录身份；只有确认后才会写入。</p>
        {blocked && <section role="alert" className="card p-4 text-sm">
          <h4 className="font-medium text-[var(--risk)]">暂不能安全合并</h4>
          <ul className="mt-2 list-inside list-disc space-y-2 text-[var(--ink-secondary)]">{preview.blockers.map((reason, index) => <li className="break-words" key={index}>{reason}</li>)}</ul>
          <p className="mt-3 text-xs text-[var(--ink-secondary)]">没有改动任何记录。可以返回调整参与合并的条目。</p>
        </section>}
        {preview.additions.length > 0 && <section className="card p-4">
          <h4 className="text-sm font-medium">合并后的内容汇总</h4>
          <ul className="mt-3 space-y-2 text-sm text-[var(--ink-secondary)]">{preview.additions.map((addition, index) =>
            <li key={index} className="flex items-start justify-between gap-3"><span>{addition.label}</span><span className="shrink-0 tabular-nums">{addition.count}</span></li>)}</ul>
        </section>}
        {preview.fields.length > 0 && <section aria-label="冲突字段" className="space-y-4">
          <div><h4 className="text-sm font-medium">这些字段有不同内容</h4>
            <p className="mt-1 text-xs leading-relaxed text-[var(--ink-secondary)]">逐项选择主条目最终使用哪个来源。敏感值可按需显示；未选内容的保留方式见下方说明。</p></div>
          {preview.fields.map(field => <fieldset key={field.key} className="card min-w-0 p-4" disabled={!!busy || blocked || needsRefresh}>
            <legend className="px-1 text-sm font-medium">{field.label}</legend>
            <div className="space-y-2">{field.options.map(option => <div key={option.itemId}
              className="flex min-w-0 items-start gap-2 rounded-[var(--radius-md)] px-2 py-2 hover:bg-[var(--surface-hover)]">
              <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
              <input type="radio" className="mt-1 shrink-0 accent-[var(--accent)]" name={`${titleId}-${field.key}`}
                aria-label={`${field.label}使用「${sourceLabel(option.itemId)}」`}
                checked={choices[field.key] === option.itemId} onChange={() => setChoices(current => ({ ...current, [field.key]: option.itemId }))} />
              <span className="min-w-0 flex-1"><span className="block break-words text-xs text-[var(--ink-secondary)]">
                {sourceLabel(option.itemId)}{option.itemId === preview.baseId ? ' · 主条目' : ''}
              </span><span className="block text-xs text-[var(--ink-tertiary)]">{updatedLabel(option.itemId)}</span>
              <span className="mt-1 block whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{field.secret ? revealed[`${field.key}:${option.itemId}`] ?? '••••••••' : option.value || '未填写'}</span></span>
              </label>
              {field.secret && <button type="button" className="btn btn-ghost shrink-0 px-2 text-xs" disabled={!!revealing}
                aria-label={`${Object.hasOwn(revealed, `${field.key}:${option.itemId}`) ? '隐藏' : '显示'}${field.label}（来源 ${sourceNumber(option.itemId)}）`}
                onClick={() => { void reveal(field.key, option.itemId); }}>{revealing === `${field.key}:${option.itemId}` ? '载入中…' : Object.hasOwn(revealed, `${field.key}:${option.itemId}`) ? '隐藏' : '显示'}</button>}
            </div>)}</div>
          </fieldset>)}
          {!blocked && <p role="status" className="text-xs text-[var(--ink-secondary)]">{unresolved ? `还有 ${unresolved} 个字段需要选择。` : '所有冲突字段已选择。'}</p>}
        </section>}
        {preview.warnings.length > 0 && <ul role="note" className="space-y-2 text-xs leading-relaxed text-[var(--ink-secondary)]">
          {preview.warnings.map((warning, index) => <li key={index} className="break-words">{warning}</li>)}
        </ul>}
      </div> : <div className="space-y-5">
        <p className="text-sm leading-relaxed text-[var(--ink-secondary)]">主条目保留原记录身份。其他来源的信息先合入主条目，保存成功后再移到回收站。</p>
        <div><label htmlFor={`${titleId}-base`} className="mb-2 block text-sm font-medium">主条目</label>
          <Select id={`${titleId}-base`} aria-label="合并主条目" value={baseId} disabled={!!busy}
            options={items.map((item, index) => ({ value: item.id, label: `${index + 1}. ${item.name || '未命名条目'}${item.username ? ` · ${item.username}` : ''}` }))}
            onChange={value => { setBaseId(value); setExcluded(current => current.filter(id => id !== value)); }} className="w-full" />
        </div>
        <fieldset disabled={!!busy} className="min-w-0">
          <legend className="mb-2 text-sm font-medium">要合并的来源 <span className="font-normal text-[var(--ink-tertiary)]">{sourceCount} / {sources.length}</span></legend>
          <div className="card max-h-[280px] overflow-y-auto divide-y divide-[var(--border-subtle)]">{sources.map(item => <label key={item.id} className="flex min-w-0 cursor-pointer items-start gap-3 p-4 hover:bg-[var(--surface-hover)]">
            <input type="checkbox" aria-label={`合并来源「${sourceLabel(item.id)}」`} className="mt-1 shrink-0 accent-[var(--accent)]"
              checked={!excluded.includes(item.id)} onChange={event => setExcluded(current => event.target.checked ? current.filter(id => id !== item.id) : [...current, item.id])} />
            <span className="min-w-0 flex-1"><span className="block break-words text-sm">{sourceLabel(item.id)}</span>
              <span className="mt-1 block break-words text-xs text-[var(--ink-tertiary)]">{[item.username, item.iconDomain].filter(Boolean).join(' · ') || '登录条目'}</span>
              <span className="mt-1 block text-xs text-[var(--ink-tertiary)]">{updatedLabel(item.id)}</span></span>
          </label>)}</div>
        </fieldset>
      </div>}
    </div>
  </FloatingPanel>;
}
