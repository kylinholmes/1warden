import { useEffect, useId, useRef } from 'react';
import { useLocalStore, useStore } from '@1warden/state/react';
import { CopyButton, Select } from '@1warden/ui';
import { scheduleClipboardClear } from '@1warden/ui/clipboard';
import type { BrowserCredentialActions, CapturePreview, CaptureTarget, GeneratedPasswordSummary } from '../application/browser-credentials';

const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
const source = (url: string) => { try { return new URL(url).origin; } catch { return url; } };
function useActive() {
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  return active;
}

/** Only metadata enters this review; the background retains and validates the captured secret. */
function CaptureCard({ row, actions, onDone, onRefresh }: { row: CapturePreview; actions: BrowserCredentialActions;
  onDone(dismiss: boolean, updated: boolean): void; onRefresh(dismiss: boolean): void }) {
  const id = useId(); const active = useActive();
  const retryControl = useRef<HTMLButtonElement | null>(null);
  const store = useLocalStore(() => ({ selection: row.action === 'save' ? 'new' : row.itemId ? `item:${row.itemId}` : '',
    target: row.targets.find(t => t.id === row.itemId) ?? null as CaptureTarget | null,
    username: row.username ?? '', addUsername: false, busy: false, error: '' }));
  const state = useStore(store);
  useEffect(() => {
    if (!state.busy && state.error) retryControl.current?.focus({ preventScroll: true });
  }, [state.busy, state.error]);
  const updating = state.selection.startsWith('item:');
  const changed = updating && (!state.target || !row.targets.some(t => t.id === state.target?.id && t.updatedAt === state.target.updatedAt));
  async function run(dismiss: boolean, control: HTMLButtonElement) {
    if (store.getState().busy) return;
    retryControl.current = control;
    store.setState({ busy: true, error: '' });
    try {
      if (dismiss) await actions.dismiss(row.id);
      else await actions.save({ captureId: row.id, revision: row.revision, action: updating ? 'update' : 'save',
        ...(updating ? { itemId: state.target!.id, targetUpdatedAt: state.target!.updatedAt,
          ...(state.addUsername && !state.target!.username ? { username: state.username } : {}) } : { username: state.username }) });
      if (active.current) onDone(dismiss, updating);
    } catch (error) {
      if (active.current) { store.setState({ error: message(error) }); onRefresh(dismiss); }
    } finally { if (active.current) store.setState({ busy: false }); }
  }
  return <section data-capture-id={row.id} aria-label="确认保存密码" aria-busy={state.busy} className="card space-y-2 p-3 text-xs">
    <div className="flex items-center justify-between gap-2">
      <h3 tabIndex={-1} className="text-sm font-semibold">{row.action === 'update' ? '更新已保存的密码？' : '保存此网站的密码？'}</h3>
      <span className="shrink-0 text-[var(--ink-tertiary)]">{row.source === 'history' ? '从生成记录恢复' : '检测到表单提交'}</span>
    </div>
    <p className="break-all text-[var(--ink-secondary)]" title={row.url}>{source(row.url)}</p>
    {row.username && <p className="break-all">账号：{row.username}</p>}
    <label htmlFor={`${id}-target`} className="block text-[var(--ink-secondary)]">保存到</label>
    <Select id={`${id}-target`} className="w-full" value={state.selection} disabled={state.busy}
      aria-label="保存到" placeholder="请选择新增或更新已有条目"
      options={[{ value: 'new', label: '新增登录条目' }, ...row.targets.map(t => ({ value: `item:${t.id}`, label: `更新 · ${t.title} · ${t.username || '未填写账号'}` }))]}
      onChange={value => store.setState({ selection: value,
        target: row.targets.find(t => `item:${t.id}` === value) ?? null, username: row.username ?? '', addUsername: false, error: '' })} />
    {state.selection === 'new' && <label className="block space-y-1"><span className="text-[var(--ink-secondary)]">用户名或邮箱（选填）</span>
      <input className="field w-full" autoComplete="off" value={state.username} maxLength={1024} disabled={state.busy}
        onChange={event => store.setState({ username: event.target.value })} /></label>}
    {updating && state.target && <p className="text-[var(--ink-secondary)]">更新「{state.target.title}」的密码。</p>}
    {updating && state.target && !state.target.username && row.username && <label className="flex items-center gap-2">
      <input type="checkbox" checked={state.addUsername} disabled={state.busy}
        onChange={event => store.setState({ addUsername: event.target.checked })} />同时补充账号：{row.username}</label>}
    {changed && <p role="alert" className="text-[var(--risk)]">条目已变化，请重新检查。 <button type="button" className="underline"
      onClick={() => store.setState({ selection: '', target: null, error: '' })}>重新选择</button></p>}
    {state.error && <p role="alert" className="text-[var(--risk)]">{state.error}</p>}
    <div className="flex justify-end gap-2">
      <button type="button" data-capture-action="dismiss" className="btn btn-quiet" disabled={state.busy} onClick={event => { void run(true, event.currentTarget); }}>不保存</button>
      <button type="button" data-capture-action="save" className="btn btn-primary" disabled={state.busy || !state.selection || changed}
        onClick={event => { void run(false, event.currentTarget); }}>{state.busy ? '处理中…' : updating ? '更新密码' : '保存密码'}</button>
    </div>
  </section>;
}

export function BrowserCredentialReview({ actions, revision }: { actions: BrowserCredentialActions; revision: number }) {
  const root = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{ id: string; action?: string } | null>(null);
  const store = useLocalStore(() => ({ rows: [] as CapturePreview[], error: '', status: '', attempt: 0 }));
  const state = useStore(store);
  useEffect(() => {
    if (!pendingFocus.current) return;
    const pending = pendingFocus.current;
    const card = [...(root.current?.querySelectorAll<HTMLElement>('[data-capture-id]') ?? [])].find(node => node.dataset['captureId'] === pending.id);
    const target = card?.querySelector<HTMLElement>(pending.action ? `[data-capture-action="${pending.action}"]:not(:disabled)` : 'h3') ?? card?.querySelector('h3') ?? root.current?.querySelector('h2');
    if (target) { target.focus({ preventScroll: true }); pendingFocus.current = null; }
  }, [state.rows]);
  useEffect(() => {
    let active = true;
    void actions.list().then(rows => { if (active) store.setState({ rows, error: '' }); },
      error => { if (active) { pendingFocus.current = null; store.setState({ error: message(error) }); } });
    return () => { active = false; };
  }, [actions, revision, state.attempt]);
  return state.rows.length || state.error || state.status ? <div ref={root} aria-label="待保存密码" className="max-h-[55vh] shrink-0 space-y-2 overflow-y-auto border-b border-[var(--border-subtle)] p-3">
    <h2 tabIndex={-1} className="text-sm font-semibold">待保存密码</h2>
    <p role="status" aria-atomic="true" className="text-xs text-[var(--ink-secondary)]">{state.status ? `${state.status}；剩余 ${state.rows.length} 项待检查。` : `有 ${state.rows.length} 项待检查。`}</p>
    {state.error && <p role="alert" className="text-xs text-[var(--risk)]">{state.error} <button type="button" className="underline"
      onClick={() => { pendingFocus.current = { id: state.rows[0]?.id ?? '' }; store.setState(s => ({ attempt: s.attempt + 1 })); }}>重试</button></p>}
    {state.rows.map(row => <CaptureCard key={`${row.id}:${row.revision}`} row={row} actions={actions}
      onDone={(dismiss, updated) => {
        const rows = store.getState().rows; const index = rows.findIndex(item => item.id === row.id);
        pendingFocus.current = { id: rows[index + 1]?.id ?? rows[index - 1]?.id ?? '' };
        store.setState(s => ({ rows: s.rows.filter(r => r.id !== row.id), error: '', status: dismiss ? '已忽略此项' : updated ? '密码已更新' : '密码已保存', attempt: s.attempt + 1 }));
      }}
      onRefresh={dismiss => { pendingFocus.current = { id: row.id, action: dismiss ? 'dismiss' : 'save' }; store.setState(s => ({ status: '操作未完成，请检查后重试', attempt: s.attempt + 1 })); }} />)}
  </div> : null;
}

function HistoryRow({ row, actions, onDelete, onRecover }: { row: GeneratedPasswordSummary; actions: BrowserCredentialActions;
  onDelete(): void; onRecover(row: CapturePreview): void }) {
  const active = useActive();
  const store = useLocalStore(() => ({ secret: null as string | null, busy: false, error: '' }));
  const state = useStore(store);
  const retryControl = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (!state.busy) retryControl.current?.focus({ preventScroll: true }); }, [state.busy]);
  // Revealed history is intentionally short lived even if the generator stays open.
  useEffect(() => {
    if (state.secret === null) return;
    const timer = setTimeout(() => store.setState({ secret: null }), 30_000);
    return () => clearTimeout(timer);
  }, [state.secret]);
  async function run(kind: 'reveal' | 'delete' | 'recover', control: HTMLButtonElement) {
    if (store.getState().busy) return;
    retryControl.current = control;
    store.setState({ busy: true, error: '' });
    try {
      if (kind === 'reveal') { const secret = await actions.revealHistory(row.id); if (active.current) store.setState({ secret }); }
      else if (kind === 'delete') { await actions.deleteHistory(row.id); if (active.current) onDelete(); }
      else { const preview = await actions.recoverHistory(row.id); if (active.current) onRecover(preview); }
    } catch (error) { if (active.current) store.setState({ error: message(error) }); }
    finally { if (active.current) store.setState({ busy: false }); }
  }
  return <li data-history-id={row.id} className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3 text-xs">
    <h3 tabIndex={-1} className="break-all font-medium" title={row.url}>{source(row.url)}</h3>
    <p className="text-[var(--ink-tertiary)]">{new Date(row.createdAt).toLocaleString()}</p>
    <code className="block break-all font-mono">{state.secret ?? '••••••••••••••••'}</code>
    <div className="flex flex-wrap items-center gap-1">
      <button type="button" className="btn btn-quiet" disabled={state.busy} onClick={event => state.secret === null
        ? void run('reveal', event.currentTarget) : store.setState({ secret: null })}>{state.secret === null ? '显示' : '隐藏'}</button>
      <CopyButton getValue={() => actions.revealHistory(row.id)} onCopied={scheduleClipboardClear}
        onError={error => { if (active.current) store.setState({ error: message(error) }); }} />
      <button type="button" data-history-recover="" className="btn btn-quiet" disabled={state.busy} onClick={event => { void run('recover', event.currentTarget); }}>恢复为条目</button>
      <button type="button" className="btn btn-ghost ml-auto" disabled={state.busy} onClick={event => { void run('delete', event.currentTarget); }}>删除</button>
    </div>
    {state.error && <p role="alert" className="text-[var(--risk)]">{state.error}</p>}
  </li>;
}

export function GeneratedPasswordHistory({ actions }: { actions: BrowserCredentialActions }) {
  const active = useActive();
  const root = useRef<HTMLElement>(null);
  const recoveryOrigin = useRef('');
  const pendingFocus = useRef<{ kind: 'capture' | 'history'; id: string; action?: string } | null>(null);
  const store = useLocalStore(() => ({ rows: [] as GeneratedPasswordSummary[], loading: true, error: '', status: '', attempt: 0, recover: null as CapturePreview | null }));
  const state = useStore(store);
  useEffect(() => {
    const pending = pendingFocus.current; if (!pending) return;
    const attribute = pending.kind === 'capture' ? 'data-capture-id' : 'data-history-id';
    const row = [...(root.current?.querySelectorAll<HTMLElement>(`[${attribute}]`) ?? [])].find(node => node.getAttribute(attribute) === pending.id);
    const control = pending.action === 'recover' ? '[data-history-recover]' : pending.action ? `[data-capture-action="${pending.action}"]:not(:disabled)` : 'h3';
    (row?.querySelector<HTMLElement>(control) ?? row?.querySelector('h3') ?? root.current?.querySelector('h2'))?.focus({ preventScroll: true });
    pendingFocus.current = null;
  }, [state.rows, state.recover]);
  useEffect(() => {
    let active = true;
    void actions.history().then(rows => { if (active) store.setState({ rows, loading: false, error: '' }); },
      error => { if (active) store.setState({ error: message(error), loading: false }); });
    return () => { active = false; };
  }, [actions, state.attempt]);
  return <section ref={root} className="mt-5 space-y-3 border-t border-[var(--border-subtle)] pt-4" aria-label="网站生成记录">
    <h2 tabIndex={-1} className="text-sm font-semibold">网站生成记录</h2>
    <p className="text-xs text-[var(--ink-secondary)]">保留最近 30 天、最多 100 条。未完成注册时，可在这里找回填入的密码。</p>
    {state.loading && <p role="status" className="text-xs">正在读取…</p>}
    {state.status && <p role="status" className="text-xs text-[var(--ink-secondary)]">{state.status}</p>}
    {state.error && <p role="alert" className="text-xs text-[var(--risk)]">{state.error} <button type="button" className="underline"
      onClick={() => store.setState(s => ({ attempt: s.attempt + 1 }))}>重试</button></p>}
    {state.recover && <CaptureCard key={`${state.recover.id}:${state.recover.revision}`} row={state.recover} actions={actions}
      onDone={(dismiss, updated) => {
        pendingFocus.current = { kind: 'history', id: recoveryOrigin.current, action: 'recover' };
        store.setState({ recover: null, status: dismiss ? '已忽略此项，生成记录仍保留。' : updated ? '密码已更新。' : '密码已保存。' });
      }} onRefresh={dismiss => {
        const id = state.recover!.id;
        pendingFocus.current = { kind: 'capture', id, action: dismiss ? 'dismiss' : 'save' };
        store.setState({ status: '操作未完成，请检查后重试。' });
        void actions.list().then(rows => { if (active.current) store.setState({ recover: rows.find(r => r.id === id) ?? null }); }).catch(() => {});
      }} />}
    {!state.loading && !state.error && !state.rows.length && <p className="text-xs text-[var(--ink-tertiary)]">暂无网站生成记录</p>}
    <ul className="space-y-2">{state.rows.map(row => <HistoryRow key={row.id} row={row} actions={actions}
      onDelete={() => {
        const rows = store.getState().rows; const index = rows.findIndex(item => item.id === row.id);
        pendingFocus.current = { kind: 'history', id: rows[index + 1]?.id ?? rows[index - 1]?.id ?? '' };
        store.setState(s => ({ rows: s.rows.filter(r => r.id !== row.id), status: `已删除生成记录；剩余 ${Math.max(0, s.rows.length - 1)} 条。` }));
      }}
      onRecover={recover => {
        recoveryOrigin.current = row.id; pendingFocus.current = { kind: 'capture', id: recover.id };
        store.setState({ recover, status: '生成记录已载入，请检查后保存。' });
      }} />)}</ul>
  </section>;
}
