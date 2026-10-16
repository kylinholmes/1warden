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
  onDone(): void; onRefresh(): void }) {
  const id = useId(); const active = useActive();
  const store = useLocalStore(() => ({ selection: row.action === 'save' ? 'new' : row.itemId ? `item:${row.itemId}` : '',
    target: row.targets.find(t => t.id === row.itemId) ?? null as CaptureTarget | null,
    username: row.username ?? '', addUsername: false, busy: false, error: '' }));
  const state = useStore(store);
  const updating = state.selection.startsWith('item:');
  const changed = updating && (!state.target || !row.targets.some(t => t.id === state.target?.id && t.updatedAt === state.target.updatedAt));
  async function run(dismiss: boolean) {
    if (store.getState().busy) return;
    store.setState({ busy: true, error: '' });
    try {
      if (dismiss) await actions.dismiss(row.id);
      else await actions.save({ captureId: row.id, revision: row.revision, action: updating ? 'update' : 'save',
        ...(updating ? { itemId: state.target!.id, targetUpdatedAt: state.target!.updatedAt,
          ...(state.addUsername && !state.target!.username ? { username: state.username } : {}) } : { username: state.username }) });
      if (active.current) onDone();
    } catch (error) {
      if (active.current) { store.setState({ error: message(error) }); onRefresh(); }
    } finally { if (active.current) store.setState({ busy: false }); }
  }
  return <section aria-label="确认保存密码" className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3 text-xs">
    <div className="flex items-center justify-between gap-2">
      <strong className="text-sm">{row.action === 'update' ? '更新已保存的密码？' : '保存此网站的密码？'}</strong>
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
      <input className="input w-full" autoComplete="off" value={state.username} maxLength={1024} disabled={state.busy}
        onChange={event => store.setState({ username: event.target.value })} /></label>}
    {updating && state.target && <p className="text-[var(--ink-secondary)]">更新「{state.target.title}」的密码。</p>}
    {updating && state.target && !state.target.username && row.username && <label className="flex items-center gap-2">
      <input type="checkbox" checked={state.addUsername} disabled={state.busy}
        onChange={event => store.setState({ addUsername: event.target.checked })} />同时补充账号：{row.username}</label>}
    {changed && <p role="alert" className="text-[var(--risk)]">条目已变化，请重新检查。 <button type="button" className="underline"
      onClick={() => store.setState({ selection: '', target: null, error: '' })}>重新选择</button></p>}
    {state.error && <p role="alert" className="text-[var(--risk)]">{state.error}</p>}
    <div className="flex justify-end gap-2">
      <button type="button" className="btn btn-quiet" disabled={state.busy} onClick={() => { void run(true); }}>不保存</button>
      <button type="button" className="btn btn-primary" disabled={state.busy || !state.selection || changed}
        onClick={() => { void run(false); }}>{state.busy ? '处理中…' : updating ? '更新密码' : '保存密码'}</button>
    </div>
  </section>;
}

export function BrowserCredentialReview({ actions, revision }: { actions: BrowserCredentialActions; revision: number }) {
  const store = useLocalStore(() => ({ rows: [] as CapturePreview[], error: '', attempt: 0 }));
  const state = useStore(store);
  useEffect(() => {
    let active = true;
    void actions.list().then(rows => { if (active) store.setState({ rows, error: '' }); },
      error => { if (active) store.setState({ error: message(error) }); });
    return () => { active = false; };
  }, [actions, revision, state.attempt]);
  return state.rows.length || state.error ? <div aria-label="待保存密码" className="max-h-[55vh] shrink-0 space-y-2 overflow-y-auto border-b border-[var(--border-subtle)] p-3">
    {state.error && <p role="alert" className="text-xs text-[var(--risk)]">{state.error} <button type="button" className="underline"
      onClick={() => store.setState(s => ({ attempt: s.attempt + 1 }))}>重试</button></p>}
    {state.rows.map(row => <CaptureCard key={`${row.id}:${row.revision}`} row={row} actions={actions}
      onDone={() => store.setState(s => ({ rows: s.rows.filter(r => r.id !== row.id), error: '', attempt: s.attempt + 1 }))}
      onRefresh={() => store.setState(s => ({ attempt: s.attempt + 1 }))} />)}
  </div> : null;
}

function HistoryRow({ row, actions, onDelete, onRecover }: { row: GeneratedPasswordSummary; actions: BrowserCredentialActions;
  onDelete(): void; onRecover(row: CapturePreview): void }) {
  const active = useActive();
  const store = useLocalStore(() => ({ secret: null as string | null, busy: false, error: '' }));
  const state = useStore(store);
  // Revealed history is intentionally short lived even if the generator stays open.
  useEffect(() => {
    if (state.secret === null) return;
    const timer = setTimeout(() => store.setState({ secret: null }), 30_000);
    return () => clearTimeout(timer);
  }, [state.secret]);
  async function run(kind: 'reveal' | 'delete' | 'recover') {
    if (store.getState().busy) return;
    store.setState({ busy: true, error: '' });
    try {
      if (kind === 'reveal') { const secret = await actions.revealHistory(row.id); if (active.current) store.setState({ secret }); }
      else if (kind === 'delete') { await actions.deleteHistory(row.id); if (active.current) onDelete(); }
      else { const preview = await actions.recoverHistory(row.id); if (active.current) onRecover(preview); }
    } catch (error) { if (active.current) store.setState({ error: message(error) }); }
    finally { if (active.current) store.setState({ busy: false }); }
  }
  return <li className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border)] p-3 text-xs">
    <p className="break-all font-medium" title={row.url}>{source(row.url)}</p>
    <p className="text-[var(--ink-tertiary)]">{new Date(row.createdAt).toLocaleString()}</p>
    <code className="block break-all font-mono">{state.secret ?? '••••••••••••••••'}</code>
    <div className="flex flex-wrap items-center gap-1">
      <button type="button" className="btn btn-quiet" disabled={state.busy} onClick={() => state.secret === null
        ? void run('reveal') : store.setState({ secret: null })}>{state.secret === null ? '显示' : '隐藏'}</button>
      <CopyButton getValue={() => actions.revealHistory(row.id)} onCopied={scheduleClipboardClear}
        onError={error => { if (active.current) store.setState({ error: message(error) }); }} />
      <button type="button" className="btn btn-quiet" disabled={state.busy} onClick={() => { void run('recover'); }}>恢复为条目</button>
      <button type="button" className="btn btn-ghost ml-auto" disabled={state.busy} onClick={() => { void run('delete'); }}>删除</button>
    </div>
    {state.error && <p role="alert" className="text-[var(--risk)]">{state.error}</p>}
  </li>;
}

export function GeneratedPasswordHistory({ actions }: { actions: BrowserCredentialActions }) {
  const active = useActive();
  const store = useLocalStore(() => ({ rows: [] as GeneratedPasswordSummary[], loading: true, error: '', attempt: 0, recover: null as CapturePreview | null }));
  const state = useStore(store);
  useEffect(() => {
    let active = true;
    void actions.history().then(rows => { if (active) store.setState({ rows, loading: false, error: '' }); },
      error => { if (active) store.setState({ error: message(error), loading: false }); });
    return () => { active = false; };
  }, [actions, state.attempt]);
  return <section className="mt-5 space-y-3 border-t border-[var(--border-subtle)] pt-4" aria-label="网站生成记录">
    <h2 className="text-sm font-semibold">网站生成记录</h2>
    <p className="text-xs text-[var(--ink-secondary)]">保留最近 30 天、最多 100 条。未完成注册时，可在这里找回填入的密码。</p>
    {state.loading && <p role="status" className="text-xs">正在读取…</p>}
    {state.error && <p role="alert" className="text-xs text-[var(--risk)]">{state.error} <button type="button" className="underline"
      onClick={() => store.setState(s => ({ attempt: s.attempt + 1 }))}>重试</button></p>}
    {state.recover && <CaptureCard key={`${state.recover.id}:${state.recover.revision}`} row={state.recover} actions={actions}
      onDone={() => store.setState({ recover: null })} onRefresh={() => {
        const id = state.recover!.id;
        void actions.list().then(rows => { if (active.current) store.setState({ recover: rows.find(r => r.id === id) ?? null }); }).catch(() => {});
      }} />}
    {!state.loading && !state.error && !state.rows.length && <p className="text-xs text-[var(--ink-tertiary)]">暂无网站生成记录</p>}
    <ul className="space-y-2">{state.rows.map(row => <HistoryRow key={row.id} row={row} actions={actions}
      onDelete={() => store.setState(s => ({ rows: s.rows.filter(r => r.id !== row.id) }))}
      onRecover={recover => store.setState({ recover })} />)}</ul>
  </section>;
}
