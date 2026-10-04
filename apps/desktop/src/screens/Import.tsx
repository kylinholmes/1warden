import { useRef, useState } from 'react';
import { parseBitwardenCsv, type VaultClient, type ImportResult } from '@coffer/vault';

/**
 * 从 CSV 导入。
 *
 * ## 为什么这一步必须做得让人放心
 *
 * 导入是**一次性、不可重来**的操作。用户刚从别处导出、可能已经把原库删了 ——
 * 这时候丢一条密码，或者静默漏掉三行，他根本不会发现，直到某天要登录某个网站。
 *
 * 所以这里有三条硬要求：
 *   1. **先看后导**。解析完先给预览，让人确认条数对得上再动手。
 *   2. **跳过的行逐条说清楚**，含行号与原因 —— 「导入了 187 条」不说
 *      「跳过了 3 条」，等于没报。
 *   3. **导完再说一次结果**，失败的逐条列出。
 */
type Phase =
  | { kind: 'pick' }
  | { kind: 'preview'; fileName: string; parsed: ImportResult }
  | { kind: 'importing'; done: number; total: number }
  | { kind: 'done'; created: number; failed: { name: string; reason: string }[] };

export function ImportScreen({ client, onImported }: {
  client: VaultClient;
  onImported: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function pick(file: File) {
    setError(null);
    try {
      const text = await file.text();
      const parsed = parseBitwardenCsv(text);
      if (parsed.items.length === 0) {
        setError(parsed.skipped[0]?.reason ?? '这个文件里没有可导入的条目');
        return;
      }
      setPhase({ kind: 'preview', fileName: file.name, parsed });
    } catch (e) {
      setError(e instanceof Error ? e.message : '读不了这个文件');
    }
  }

  async function run(parsed: ImportResult) {
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

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h2 className="mb-2 text-[var(--text-xl)] font-semibold tracking-tight">导入</h2>
      <p className="mb-6 text-[var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
        支持 Bitwarden 格式的 CSV —— Bitwarden 官方导出、KeePass 的转换插件、
        1Password 的转换器都能产出它。数据只在本地解析，<strong className="font-medium">
        文件不会上传到任何地方</strong>。
      </p>

      {error && (
        <p className="mb-4 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] px-3 py-2 text-[var(--text-sm)] text-[var(--risk)]">
          {error}
        </p>
      )}

      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          // 清掉 value，否则连续选同一个文件不会再触发 change
          e.target.value = '';
          if (f) void pick(f);
        }}
      />

      {phase.kind === 'pick' && (
        <button
          onClick={() => fileRef.current?.click()}
          className="rounded-[var(--radius-md)] bg-[var(--accent)] px-4 py-2 text-[var(--text-sm)] font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-hover)]"
        >
          选择 CSV 文件…
        </button>
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
            onClick={() => setPhase({ kind: 'pick' })}
            className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-3 py-1.5 text-[var(--text-sm)] text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]"
          >
            再导入一份
          </button>
        </div>
      )}
    </div>
  );
}

function Preview({ fileName, parsed, onRun, onCancel }: {
  fileName: string;
  parsed: ImportResult;
  onRun: () => void;
  onCancel: () => void;
}) {
  const logins = parsed.items.filter((i) => i.type === 'login').length;
  const folders = new Set(parsed.items.map((i) => i.folderName).filter(Boolean)).size;

  return (
    <div className="rounded-[var(--radius-lg)] bg-[var(--surface-raised)] p-4" style={{ boxShadow: 'var(--elev-1)' }}>
      <p className="mb-3 truncate text-[var(--text-sm)]" title={fileName}>
        <span className="text-[var(--ink-tertiary)]">{fileName}</span>
        <span className="ml-2 text-[var(--ink-secondary)]">
          {parsed.items.length} 条可导入
          {logins > 0 && ` · 其中登录 ${logins} 条`}
          {folders > 0 && ` · ${folders} 个文件夹`}
        </span>
      </p>

      {/*
        ⚠️ 跳过的行必须逐条列出来。
        「导入了 187 条」而不说「跳过了 3 条」，用户不会发现少了什么 ——
        直到某天要登录某个网站。
      */}
      {parsed.skipped.length > 0 && (
        <div className="mb-3 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3">
          <p className="mb-1.5 text-[var(--text-xs)] text-[var(--caution)]">
            有 {parsed.skipped.length} 行不会被导入：
          </p>
          <ul className="space-y-0.5">
            {parsed.skipped.slice(0, 8).map((s) => (
              <li key={s.rowNumber} className="text-[var(--text-xs)] text-[var(--ink-tertiary)]">
                第 {s.rowNumber} 行 —— {s.reason}
              </li>
            ))}
            {parsed.skipped.length > 8 && (
              <li className="text-[var(--text-xs)] text-[var(--ink-tertiary)]">
                …还有 {parsed.skipped.length - 8} 行
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
