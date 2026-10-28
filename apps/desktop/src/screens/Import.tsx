import { useLocalStore, useStoreField } from '@1warden/state/react';
import { useEffect, useRef } from 'react';
import type { ImportFormatId } from '@1warden/vault';
import { ImportView, PageHeader, type ImportOutcome, type ImportPreview } from '@1warden/ui';
import type { ApplicationClient, ImportFile } from '../application/types';
import { toBase64 } from '../base64';
import { ExportPanel } from './Export';
import { useTransferLifetime } from './transfer-lifetime';
import { MAX_IMPORT_FILE_BYTES, type DroppedFile } from '../file-drop';
import { AccountImport } from './AccountImport';
import { ImportOptions } from './ImportOptions';
import { BulkDeletePanel } from './BulkDelete';

/** Both operations share one navigation destination across every host. */
export function ImportScreen({ client, onImported, onBack, droppedFile, onDropConsumed, onBusyChange }: {
  client: ApplicationClient; onImported: () => void; onBack?: () => void;
  droppedFile?: DroppedFile | null | undefined; onDropConsumed?: (() => void) | undefined; onBusyChange?: (busy: boolean) => void;
}) {
  const store = useLocalStore(() => ({ tab: 'import' as 'import' | 'export', source: 'file' as 'file' | 'account', busy: false, cleaning: false }));
  const [tab, setTab] = useStoreField(store, 'tab');
  const [source, setSource] = useStoreField(store, 'source');
  const [transferring, setBusy] = useStoreField(store, 'busy');
  const [cleaning, setCleaning] = useStoreField(store, 'cleaning');
  const busy = transferring || cleaning;
  function working(value: boolean) { setBusy(value); onBusyChange?.(value || store.getState().cleaning); }
  function cleanupWorking(value: boolean) { setCleaning(value); onBusyChange?.(value || store.getState().busy); }
  useEffect(() => { if (droppedFile && !store.getState().busy && !store.getState().cleaning) { setTab('import'); setSource('file'); } }, [droppedFile]);
  useEffect(() => () => { onBusyChange?.(false); }, []);
  return <main aria-label="导入 / 导出" className="flex h-full flex-col">
    <PageHeader headingLevel={1} navigation title="导入 / 导出" onBack={onBack} backLabel="返回保险库"
      breadcrumbs={[{ label: '保险库', ...(onBack ? { onSelect: onBack } : {}) }, { label: '导入 / 导出' }]} />
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
      <div className="mx-auto w-full" style={{ maxWidth: 'var(--detail-w)' }}>
        <div role="tablist" aria-label="数据迁移" className="mb-6 flex gap-2 border-b border-[var(--border-subtle)] pb-3">
          {(['import', 'export'] as const).map(value => <button key={value} id={`transfer-tab-${value}`} role="tab"
            aria-selected={tab === value} aria-controls={`transfer-panel-${value}`} tabIndex={tab === value ? 0 : -1}
            disabled={busy} className={`btn px-4 py-2 ${tab === value ? 'bg-[var(--accent-tint)] text-[var(--accent)]' : 'text-[var(--ink-secondary)]'}`} onClick={() => setTab(value)}
            onKeyDown={event => {
              if (!busy && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault(); const next = event.key === 'Home' ? 'import' : event.key === 'End' ? 'export' : tab === 'import' ? 'export' : 'import';
                setTab(next); document.getElementById(`transfer-tab-${next}`)?.focus();
              }
            }}>{value === 'import' ? '导入' : '导出'}</button>)}
        </div>
        <div inert={cleaning} role="tabpanel" id={`transfer-panel-${tab}`} aria-labelledby={`transfer-tab-${tab}`}>
          {tab === 'import' ? <>
            <div role="group" aria-label="导入来源" className="mb-5 flex flex-wrap gap-2">
              {(['file', 'account'] as const).map(value => <button key={value} disabled={busy} aria-pressed={source === value}
                className={`btn px-3 py-1.5 ${source === value ? 'bg-[var(--accent-tint)] text-[var(--accent)]' : 'btn-quiet'}`}
                onClick={() => setSource(value)}>{value === 'file' ? '从文件导入' : '从其他账户迁移'}</button>)}
            </div>
            {source === 'file' ? <ImportPanel client={client} onImported={onImported} droppedFile={droppedFile}
              onDropConsumed={onDropConsumed} onBusyChange={working} />
              : <AccountImport client={client} onImported={onImported} onBusyChange={working} />}
          </> : <ExportPanel client={client} onBusyChange={working} />}
        </div>
        <div className="mt-10 border-t border-[var(--border-subtle)] pt-6">
          <BulkDeletePanel client={client} scope="vault" disabled={transferring} onBusyChange={cleanupWorking} />
        </div>
      </div>
    </div>
  </main>;
}

function ImportPanel({ client, onImported, droppedFile, onDropConsumed, onBusyChange }: {
  client: ApplicationClient; onImported: () => void; droppedFile?: DroppedFile | null | undefined;
  onDropConsumed?: (() => void) | undefined; onBusyChange: (busy: boolean) => void;
}) {
  const viewStore = useLocalStore(() => {
    const file = (null) as ImportFile | null;
    const preview = (null) as ImportPreview | null;
    const busy = false;
    const parsing = false;
    const error = (null) as string | null;
    const result = (null) as ImportOutcome | null;
    return { file, preview, busy, parsing, error, result, encrypted: false, password: '', skipExisting: true };
  });
  const [file, setFile] = useStoreField(viewStore, 'file');
  const [preview, setPreview] = useStoreField(viewStore, 'preview');
  const [busy, setBusy] = useStoreField(viewStore, 'busy');
  const [parsing, setParsing] = useStoreField(viewStore, 'parsing');
  const [error, setError] = useStoreField(viewStore, 'error');
  const [result, setResult] = useStoreField(viewStore, 'result');
  const [encrypted, setEncrypted] = useStoreField(viewStore, 'encrypted');
  const [password, setPassword] = useStoreField(viewStore, 'password');
  const [skipExisting, setSkipExisting] = useStoreField(viewStore, 'skipExisting');
  const passwordInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (encrypted && !parsing && !error) passwordInput.current?.focus({ preventScroll: true }); }, [encrypted, parsing, error]);
  const request = useTransferLifetime(client);
  useEffect(() => {
    // StrictMode probes mounts with setup/cleanup/setup. Consume only a live mount.
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && droppedFile && !viewStore.getState().busy && !viewStore.getState().parsing) {
        setPassword(''); setEncrypted(false);
        void parse({ ...droppedFile, format: 'auto' });
        onDropConsumed?.();
      }
    });
    return () => { cancelled = true; };
  }, [droppedFile]);

  async function parse(next: ImportFile, current = ++request.current): Promise<void> {
    setError(null);
    setResult(null);
    setPreview(null);
    setParsing(true); onBusyChange(true);
    setFile(next);
    try {
      const parsed = await client.parseImport(next);
      if (current !== request.current) return;
      if (parsed.needsPassword) { setEncrypted(true); return; }
      if (parsed.total === 0 && parsed.folders === 0) throw new Error(parsed.skipped[0]?.reason ?? '这个文件里没有可导入的条目');
      setEncrypted(false); setPassword('');
      setPreview(parsed);
    } catch (e) {
      if (current === request.current) setError(e instanceof Error ? e.message : '读不了这个文件');
    } finally {
      if (current === request.current) { setParsing(false); onBusyChange(false); }
    }
  }

  async function pick(selected: File): Promise<void> {
    if (viewStore.getState().busy || viewStore.getState().parsing) return;
    if (selected.size > MAX_IMPORT_FILE_BYTES) { setError('文件过大，请选择不超过 50 MiB 的文件'); return; }
    setPassword(''); setEncrypted(false);
    const current = ++request.current;
    setError(null);
    setPreview(null);
    setParsing(true); onBusyChange(true);
    try {
      const data = new Uint8Array(await selected.arrayBuffer());
      if (current !== request.current) return;
      await parse({ name: selected.name, dataBase64: toBase64(data), format: 'auto' }, current);
    } catch (e) {
      if (current === request.current) {
        setParsing(false); onBusyChange(false);
        setError(e instanceof Error ? e.message : '读不了这个文件');
      }
    }
  }

  function changeFormat(format: ImportFormatId): void {
    if (file && !busy && !parsing) void parse({ ...file, format });
  }

  async function run(retry = false): Promise<void> {
    if (!file || !preview || viewStore.getState().busy || viewStore.getState().parsing) return;
    const current = ++request.current;
    setBusy(true); onBusyChange(true);
    setError(null);
    if (retry) setSkipExisting(true);
    try {
      const outcome = await client.importData({ ...file, format: preview.format, skipExisting: retry || skipExisting });
      if (current !== request.current) return;
      setResult(outcome);
      if (outcome.failed.length === 0) { setPreview(null); setFile(null); }
      onImported();
    } catch (e) {
      if (current === request.current) setError(e instanceof Error ? e.message : '导入失败');
    } finally {
      if (current === request.current) { setBusy(false); onBusyChange(false); }
    }
  }

  function reset(): void {
    if (busy || parsing) return;
    request.current++;
    setPassword(''); setEncrypted(false);
    setFile(null);
    setPreview(null);
    setParsing(false);
    setResult(null);
    setError(null);
  }

  return <>
    <ImportOptions skipExisting={skipExisting} onChange={setSkipExisting} disabled={busy || parsing} />
    {parsing && <p role="status" className="mb-4 text-sm text-[var(--ink-secondary)]">正在读取文件…</p>}
    {encrypted && <form className="mb-5 space-y-3 rounded-[var(--radius-md)] bg-[var(--surface-well)] p-4"
      onSubmit={event => { event.preventDefault(); if (file && !parsing && password) void parse({ ...file, password }); }}>
      <h2 className="text-md font-semibold">解密导入文件</h2>
      <p className="text-sm">{file?.name} 是加密的 JSON 文件，请输入导出时设置的密码。</p>
      <label className="block text-sm">文件解密密码<input ref={passwordInput} type="password" aria-label="文件解密密码" autoComplete="off"
        disabled={parsing} value={password} onChange={event => setPassword(event.target.value)} className="field secret mt-1.5" /></label>
      <button className="btn btn-primary" disabled={parsing || !password}>解密并预览</button>
    </form>}
    <ImportView preview={preview} progress={busy ? { done: null, total: preview?.total ?? 0 } : null}
      result={result} error={error} hasFile={file !== null} autoFormat={preview?.format ?? (encrypted ? 'bitwarden-json' : null)}
      reading={parsing} onPick={f => { void pick(f); }} onFormatChange={changeFormat}
      onRun={() => { void run(); }} onReset={reset} onRetry={file && preview ? () => { void run(true); } : undefined} />
  </>;
}
