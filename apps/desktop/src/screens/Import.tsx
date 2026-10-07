import { useEffect, useRef, useState } from 'react';
import type { ImportFormatId } from '@coffer/vault';
import { ImportView, NavTrigger, type ImportOutcome, type ImportPreview } from '@coffer/ui';
import type { ApplicationClient, ImportFile } from '../application/types';
import { toBase64 } from '../base64';

/** File parsing and encryption belong to the application service on every host. */
export function ImportScreen({ client, onImported }: {
  client: ApplicationClient;
  onImported: () => void;
}) {
  const [file, setFile] = useState<ImportFile | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportOutcome | null>(null);
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
      <header className="band shrink-0 px-8" data-tauri-drag-region="deep">
        <NavTrigger />
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">导入</h2>
      </header>
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
