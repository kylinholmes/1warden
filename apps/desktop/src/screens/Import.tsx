import { useState } from 'react';
import {
  parseImport, detectImportFormat, IMPORT_FORMATS,
  type VaultClient, type ImportResult, type ImportFormatId,
} from '@coffer/vault';
import { ImportView, type ImportOutcome, type ImportPreview } from '@coffer/ui';

/**
 * 从别处导入 —— **桌面端这里只剩数据通道**。
 *
 * 界面本体在 `@coffer/ui` 的 `ImportView`，和扩展弹窗**同一份代码**。
 * 那三条硬要求（先看后导、跳过的行逐条说清楚、失败的逐条列出）写在
 * 那边，因为它们是**这一屏的规矩**，不是某一端的实现细节。
 *
 * 这里负责两件共享组件不该知道的事：
 *
 * 1. **解析在本地跑**（`parseImport` 直接调）。扩展端做不到 ——
 *    弹窗**刻意**拿不到解析出来的明文条目（spec 不变量 S1），
 *    所以那边把文件字节发给后台、由后台解析。
 * 2. **写入通过 `VaultClient`**，带进度回调。
 *
 * ## 为什么按**字节**读文件
 *
 * 1PUX 是 ZIP，二进制。用 `text()` 读它字节就毁了，而且毁得看不出来 ——
 * 报出来的是一句「这不是 ZIP」，用户以为文件坏了。所以统一读 `arrayBuffer()`，
 * 由解析层自己决定怎么解码。
 *
 * ## 为什么格式可以手动选
 *
 * 1Password 与 Chrome 的 CSV 都是 `...,url,username,password,...`，
 * 光看列名分不开。所以自动识别只是**预选**，用户永远能自己改 ——
 * 而改完之后用同一份字节重新解析，不需要重新选文件。
 */
type Phase =
  | { kind: 'pick' }
  | { kind: 'preview'; parsed: ImportResult; format: ImportFormatId }
  | { kind: 'importing'; done: number; total: number };

/** 领域对象 → 显示用的 brief。和扩展端后台那边算的是**同一个形状** */
function toPreview(name: string, parsed: ImportResult, format: ImportFormatId): ImportPreview {
  return {
    fileName: name,
    format,
    formatLabel: IMPORT_FORMATS.find((f) => f.id === format)?.label ?? format,
    total: parsed.items.length,
    byType: parsed.items.reduce<Record<string, number>>((m, i) => {
      m[i.type] = (m[i.type] ?? 0) + 1;
      return m;
    }, {}),
    folders: new Set(parsed.items.map((i) => i.folderName).filter((n) => n !== null)).size,
    skipped: parsed.skipped,
  };
}

export function ImportScreen({ client, onImported }: {
  client: VaultClient;
  onImported: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const [error, setError] = useState<string | null>(null);
  /** 原始字节留着 —— 换格式时重新解析不用再让用户选一次文件 */
  const [raw, setRaw] = useState<{ name: string; data: Uint8Array } | null>(null);
  const [result, setResult] = useState<ImportOutcome | null>(null);

  async function parse(data: Uint8Array, fileName: string, format: ImportFormatId): Promise<void> {
    setError(null);
    setResult(null);
    try {
      const parsed = await parseImport(data, format);
      if (parsed.items.length === 0) {
        setError(parsed.skipped[0]?.reason ?? '这个文件里没有可导入的条目');
        // 留在选择阶段 —— 用户可以直接换个格式再试，不用重新选文件
        setPhase({ kind: 'pick' });
        return;
      }
      setPhase({ kind: 'preview', parsed, format });
    } catch (e) {
      setError(e instanceof Error ? e.message : '读不了这个文件');
      setPhase({ kind: 'pick' });
    }
  }

  async function pick(file: File): Promise<void> {
    setError(null);
    // ⚠️ 按字节读，不按文本读 —— 1PUX 是 ZIP，读成文本字节就毁了
    const data = new Uint8Array(await file.arrayBuffer());
    setRaw({ name: file.name, data });
    await parse(data, file.name, 'auto');
  }

  /** 换格式：用同一份字节重解析 */
  async function changeFormat(format: ImportFormatId): Promise<void> {
    if (raw === null) return;
    await parse(raw.data, raw.name, format);
  }

  async function run(parsed: ImportResult): Promise<void> {
    setPhase({ kind: 'importing', done: 0, total: parsed.items.length });
    try {
      const r = await client.importItems(parsed.items, (done, total) => {
        setPhase({ kind: 'importing', done, total });
      });
      setResult({ created: r.created, failed: r.failed });
      setPhase({ kind: 'pick' });
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败');
      setPhase({ kind: 'pick' });
    }
  }

  function reset(): void {
    setPhase({ kind: 'pick' });
    setResult(null);
    setError(null);
  }

  const autoFormat = raw === null ? null : detectImportFormat(raw.data);

  return (
    <div className="flex h-full flex-col">
      {/* 顶部的带子就是窗口的标题栏 —— 空白处可拖 */}
      <header className="band shrink-0 px-8" data-tauri-drag-region="deep">
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">导入</h2>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
        <div className="mx-auto w-full" style={{ maxWidth: 'var(--detail-w)' }}>
          <ImportView
            preview={phase.kind === 'preview' ? toPreview(raw?.name ?? '', phase.parsed, phase.format) : null}
            progress={phase.kind === 'importing' ? { done: phase.done, total: phase.total } : null}
            result={result}
            error={error}
            hasFile={raw !== null}
            autoFormat={autoFormat}
            onPick={(f) => { void pick(f); }}
            onFormatChange={(f) => { void changeFormat(f); }}
            onRun={() => { if (phase.kind === 'preview') void run(phase.parsed); }}
            onReset={reset}
          />
        </div>
      </div>
    </div>
  );
}
