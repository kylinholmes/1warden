import { useLocalStore, useStoreField } from '@1warden/state/react';
import { useEffect, useRef } from 'react';
import type { ImportFormatId } from '@1warden/vault';
import { ImportView, PageHeader, type ImportOutcome, type ImportPreview } from '@1warden/ui';
import type { ApplicationClient, ImportFile } from '../application/types';
import { toBase64 } from '../base64';

/** File parsing and encryption belong to the application service on every host. */
export function ImportScreen({ client, onImported, onBack }: {
  client: ApplicationClient;
  onImported: () => void;
  onBack?: () => void;
}) {
  const viewStore = useLocalStore(() => {
    const file = (null) as ImportFile | null;
    const preview = (null) as ImportPreview | null;
    const busy = false;
    const parsing = false;
    const error = (null) as string | null;
    const result = (null) as ImportOutcome | null;
    return { file, preview, busy, parsing, error, result };
  });
  const [file, setFile] = useStoreField(viewStore, 'file');
  const [preview, setPreview] = useStoreField(viewStore, 'preview');
  const [busy, setBusy] = useStoreField(viewStore, 'busy');
  const [parsing, setParsing] = useStoreField(viewStore, 'parsing');
  const [error, setError] = useStoreField(viewStore, 'error');
  const [result, setResult] = useStoreField(viewStore, 'result');
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);

  async function parse(next: ImportFile, current = ++request.current): Promise<void> {
    setError(null);
    setResult(null);
    setPreview(null);
    setParsing(true);
    setFile(next);
    try {
      const parsed = await client.parseImport(next);
      if (current !== request.current) return;
      if (parsed.total === 0) throw new Error(parsed.skipped[0]?.reason ?? '这个文件里没有可导入的条目');
      setPreview(parsed);
    } catch (e) {
      if (current === request.current) setError(e instanceof Error ? e.message : '读不了这个文件');
    } finally {
      if (current === request.current) setParsing(false);
    }
  }

  async function pick(selected: File): Promise<void> {
    const current = ++request.current;
    setError(null);
    setPreview(null);
    setParsing(true);
    try {
      const data = new Uint8Array(await selected.arrayBuffer());
      if (current !== request.current) return;
      await parse({ name: selected.name, dataBase64: toBase64(data), format: 'auto' }, current);
    } catch (e) {
      if (current === request.current) {
        setParsing(false);
        setError(e instanceof Error ? e.message : '读不了这个文件');
      }
    }
  }

  function changeFormat(format: ImportFormatId): void {
    if (file && !busy) void parse({ ...file, format });
  }

  async function run(): Promise<void> {
    if (!file || !preview || busy) return;
    const current = ++request.current;
    setBusy(true);
    setError(null);
    try {
      const outcome = await client.importData({ ...file, format: preview.format });
      if (current !== request.current) return;
      setResult(outcome);
      setPreview(null);
      setFile(null);
      onImported();
    } catch (e) {
      if (current === request.current) setError(e instanceof Error ? e.message : '导入失败');
    } finally {
      if (current === request.current) setBusy(false);
    }
  }

  function reset(): void {
    if (busy) return;
    request.current++;
    setFile(null);
    setPreview(null);
    setParsing(false);
    setResult(null);
    setError(null);
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader navigation title="导入" onBack={onBack} backLabel="返回保险库"
        breadcrumbs={[{ label: '保险库', ...(onBack ? { onSelect: onBack } : {}) }, { label: '导入' }]} />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
        <div className="mx-auto w-full" style={{ maxWidth: 'var(--detail-w)' }}>
          {parsing && <p role="status" className="mb-4 text-sm text-[var(--ink-secondary)]">正在读取文件…</p>}
          <ImportView
            preview={preview}
            progress={busy ? { done: null, total: preview?.total ?? 0 } : null}
            result={result}
            error={error}
            hasFile={file !== null}
            autoFormat={preview?.format ?? null}
            onPick={(f) => { void pick(f); }}
            onFormatChange={changeFormat}
            onRun={() => { void run(); }}
            onReset={reset}
          />
        </div>
      </div>
    </div>
  );
}
