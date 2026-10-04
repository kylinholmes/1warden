import { useRef, useState } from 'react';
import {
  parseImport, detectImportFormat, IMPORT_FORMATS,
  type VaultClient, type ImportResult, type ImportFormatId,
} from '@coffer/vault';

/**
 * 从别处导入。
 *
 * ## 为什么这一步必须做得让人放心
 *
 * 导入是**一次性、不可重来**的操作。用户刚从别处导出、可能已经把原库删了 ——
 * 这时候丢一条密码，或者静默漏掉三行，他根本不会发现，直到某天要登录某个网站。
 *
 * 所以这里有三条硬要求：
 *   1. **先看后导**。解析完先给预览，让人确认条数对得上再动手。
 *   2. **跳过的逐条说清楚**，含行号与原因 —— 「导入了 187 条」不说
 *      「跳过了 3 条」，等于没报。
 *   3. **导完再说一次结果**，失败的逐条列出。
 *
 * ## 为什么按字节读文件
 *
 * 1PUX 是 ZIP，二进制。用 `text()` 读它字节就毁了，而且毁得看不出来 ——
 * 报出来的是一句「这不是 ZIP」，用户以为文件坏了。所以统一读 `arrayBuffer()`，
 * 由解析层自己决定怎么解码。
 *
 * ## 为什么格式可以手动选
 *
 * 1Password 与 Chrome 的 CSV 都是 `...,url,username,password,...`，
 * 光看列名分不开。所以自动识别只是**预选**，用户永远能自己改 ——
 * 而改完之后会用同一份字节重新解析，不需要重新选文件。
 */
type Phase =
  | { kind: 'pick' }
  | { kind: 'preview'; fileName: string; parsed: ImportResult; format: ImportFormatId }
  | { kind: 'importing'; done: number; total: number }
  | { kind: 'done'; created: number; failed: { name: string; reason: string }[] };

export function ImportScreen({ client, onImported }: {
  client: VaultClient;
  onImported: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const [error, setError] = useState<string | null>(null);
  /** 原始字节留着 —— 换格式时重新解析不用再让用户选一次文件 */
  const [raw, setRaw] = useState<{ name: string; data: Uint8Array } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function parse(data: Uint8Array, fileName: string, format: ImportFormatId): Promise<void> {
    setError(null);
    try {
      const parsed = await parseImport(data, format);
      if (parsed.items.length === 0) {
        setError(parsed.skipped[0]?.reason ?? '这个文件里没有可导入的条目');
        // 还留在选择阶段 —— 用户可以直接换一个格式再试，不用重新选文件
        setPhase({ kind: 'pick' });
        return;
      }
      setPhase({ kind: 'preview', fileName, parsed, format });
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
      setPhase({ kind: 'done', created: r.created, failed: r.failed });
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败');
      setPhase({ kind: 'pick' });
    }
  }

  const detected = raw === null ? null : detectImportFormat(raw.data);

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h2 className="mb-2 text-[var(--text-xl)] font-semibold tracking-tight">导入</h2>
      <p className="mb-6 text-[var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
        支持 1Password（.1pux / .1pif / CSV）、Bitwarden（JSON / CSV）、
        KeePass 2（XML 导出），以及 Chrome、Edge、Firefox、Safari、
        LastPass、Dashlane 等常见导出与 Excel 存出来的 CSV。
        数据只在本地解析，
        <strong className="font-medium">文件不会上传到任何地方</strong>。
      </p>

      {error && (
        <p className="mb-4 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] px-3 py-2 text-[var(--text-sm)] text-[var(--risk)]">
          {error}
        </p>
      )}

      <input
        ref={fileRef}
        type="file"
        accept=".csv,.json,.1pux,.1pif,.xml,.txt,text/csv,application/json,text/xml,application/xml"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          // 清掉 value，否则连续选同一个文件不会再触发 change
          e.target.value = '';
          if (f) void pick(f);
        }}
      />

      {phase.kind === 'pick' && (
        <>
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-[var(--radius-md)] bg-[var(--accent)] px-4 py-2 text-[var(--text-sm)] font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-hover)]"
          >
            {raw === null ? '选择文件…' : '换一个文件'}
          </button>

          {/*
            ⚠️ 格式选择器在**解析失败之后**也要在。
            否则用户选错了格式、看到一句「认不出」，却没有任何办法告诉他
            「你可以自己指定」—— 那他就只能换文件，而文件是对的。
          */}
          {raw !== null && (
            <div className="mt-4">
              <label className="mb-1.5 block text-[var(--text-xs)] text-[var(--ink-tertiary)]">
                格式{detected === null ? '（自动识别不了，请手动选）' : '（已自动识别，可手动改）'}
              </label>
              <select
                value={phase.kind === 'preview' ? phase.format : (detected ?? 'auto')}
                onChange={(e) => { void changeFormat(e.target.value as ImportFormatId); }}
                className="w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 text-[var(--text-sm)]"
              >
                {IMPORT_FORMATS.map((f) => (
                  <option key={f.id} value={f.id}>{f.label}</option>
                ))}
              </select>
              <p className="mt-1.5 text-[var(--text-xs)] text-[var(--ink-tertiary)]">{raw.name}</p>
            </div>
          )}
        </>
      )}

      {phase.kind === 'preview' && (
        <Preview
          fileName={phase.fileName}
          parsed={phase.parsed}
          onCancel={() => setPhase({ kind: 'pick' })}
          onRun={() => { void run(phase.parsed); }}
        />
      )}

      {phase.kind === 'importing' && (
        <div>
          <p className="mb-2 text-[var(--text-sm)]">
            正在导入 {phase.done} / {phase.total}…
          </p>
          <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--border-subtle)' }}>
            <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-[var(--dur-fast)]"
              style={{ width: `${phase.total === 0 ? 0 : (phase.done / phase.total) * 100}%` }} />
          </div>
        </div>
      )}

      {phase.kind === 'done' && (
        <div>
          <p className="mb-4 text-[var(--text-sm)]">
            已导入 <strong className="font-medium">{phase.created}</strong> 条。
          </p>
          {phase.failed.length > 0 && (
            <>
              <p className="mb-2 text-[var(--text-sm)] text-[var(--risk)]">
                有 {phase.failed.length} 条没写进去：
              </p>
              <ul className="mb-4 space-y-1">
                {phase.failed.map((f) => (
                  <li key={f.name} className="rounded-[var(--radius-sm)] bg-[var(--surface-sunken)] px-3 py-1.5 text-[var(--text-xs)]">
                    <span className="font-medium">{f.name}</span>
                    <span className="text-[var(--ink-tertiary)]"> —— {f.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <button
            onClick={() => { setRaw(null); setPhase({ kind: 'pick' }); }}
            className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-3 py-1.5 text-[var(--text-sm)] text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]"
          >
            再导入一份
          </button>
        </div>
      )}
    </div>
  );
}

/** 条目类型的分布 —— 让人一眼看出「我的卡是不是也进来了」 */
function summarise(parsed: ImportResult): string {
  const byType = new Map<string, number>();
  for (const i of parsed.items) byType.set(i.type, (byType.get(i.type) ?? 0) + 1);

  const LABEL: Record<string, string> = {
    login: '登录', secureNote: '笔记', card: '卡片', identity: '身份',
  };
  const parts = [...byType].map(([t, n]) => `${LABEL[t] ?? t} ${n}`);
  const folders = new Set(parsed.items.map((i) => i.folderName).filter(Boolean)).size;
  if (folders > 0) parts.push(`${folders} 个文件夹`);
  return parts.join(' · ');
}

function Preview({ fileName, parsed, onRun, onCancel }: {
  fileName: string;
  parsed: ImportResult;
  onRun: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-[var(--radius-lg)] bg-[var(--surface-raised)] p-4" style={{ boxShadow: 'var(--elev-1)' }}>
      <p className="mb-3 truncate text-[var(--text-sm)]" title={fileName}>
        <span className="text-[var(--ink-tertiary)]">{fileName}</span>
        <span className="ml-2 text-[var(--ink-secondary)]">
          {parsed.items.length} 条可导入
          <span className="text-[var(--ink-tertiary)]"> —— {summarise(parsed)}</span>
        </span>
      </p>

      {/*
        ⚠️ 跳过的必须逐条列出来。
        「导入了 187 条」而不说「跳过了 3 条」，用户不会发现少了什么 ——
        直到某天要登录某个网站。
      */}
      {parsed.skipped.length > 0 && (
        <div className="mb-3 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3">
          <p className="mb-1.5 text-[var(--text-xs)] text-[var(--caution)]">
            有 {parsed.skipped.length} 条不会被导入：
          </p>
          <ul className="space-y-0.5">
            {parsed.skipped.slice(0, 8).map((s) => (
              <li key={s.rowNumber} className="text-[var(--text-xs)] text-[var(--ink-tertiary)]">
                第 {s.rowNumber} 条 —— {s.reason}
              </li>
            ))}
            {parsed.skipped.length > 8 && (
              <li className="text-[var(--text-xs)] text-[var(--ink-tertiary)]">
                …还有 {parsed.skipped.length - 8} 条
              </li>
            )}
          </ul>
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={onRun}
          className="rounded-[var(--radius-md)] bg-[var(--accent)] px-4 py-1.5 text-[var(--text-sm)] font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-hover)]">
          导入这 {parsed.items.length} 条
        </button>
        <button onClick={onCancel}
          className="rounded-[var(--radius-md)] px-3 py-1.5 text-[var(--text-sm)] text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]">
          换一个文件
        </button>
      </div>
    </div>
  );
}
