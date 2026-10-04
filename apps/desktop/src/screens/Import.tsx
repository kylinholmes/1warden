import { useRef, useState } from 'react';
import { parseBitwardenCsv, type VaultClient, type ImportResult } from '@coffer/vault';
import { IconAlert, IconCheck, IconImport } from '../components/icons';

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
 *
 * 版面按这三条排：选文件 → 预览（跳过项用警示色单独框出来）→ 进度 → 结果。
 * 「跳过」和「失败」在视觉上都要**压过**成功的那句话 ——
 * 用户会记住「导入成功」，所以没成功的那部分必须更响。
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
    <div className="flex h-full flex-col">
      <header className="band shrink-0 px-8">
        <h2 className="min-w-0 flex-1 truncate text-[var(--text-lg)] font-semibold">导入</h2>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
        <div className="mx-auto w-full" style={{ maxWidth: 'var(--detail-w)' }}>
          <p className="text-[var(--text-sm)] leading-[var(--lh-prose)] text-[var(--ink-secondary)]">
            支持 Bitwarden 格式的 CSV —— Bitwarden 官方导出、KeePass 的转换插件、
            1Password 的转换器都能产出它。数据只在本地解析，<strong className="font-medium text-[var(--ink-primary)]">
            文件不会上传到任何地方</strong>。
          </p>

          {error && (
            <p role="alert" className="mt-4 flex items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-well)] px-3 py-2.5 text-[var(--text-sm)] text-[var(--risk)]">
              <IconAlert size={15} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1">{error}</span>
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

          <div className="mt-6">
            {phase.kind === 'pick' && <PickStep onChoose={() => fileRef.current?.click()} />}

            {phase.kind === 'preview' && (
              <Preview
                fileName={phase.fileName}
                parsed={phase.parsed}
                onCancel={() => setPhase({ kind: 'pick' })}
                onRun={() => { void run(phase.parsed); }}
              />
            )}

            {phase.kind === 'importing' && <Progress done={phase.done} total={phase.total} />}

            {phase.kind === 'done' && (
              <Result
                created={phase.created}
                failed={phase.failed}
                onAgain={() => setPhase({ kind: 'pick' })}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 选文件。
 *
 * 做成一整块可点的区域，而不是一个小按钮：导入是个「把文件给它」的动作，
 * 目标越大越好找。措辞里写清楚**是点它选文件** —— 没有实现的拖放
 * 就不摆出拖放的暗示，那只会让人把文件拖进来然后什么都没发生。
 */
function PickStep({ onChoose }: { onChoose: () => void }) {
  return (
    <button
      type="button"
      onClick={onChoose}
      className="group flex w-full flex-col items-center gap-3 rounded-[var(--radius-md)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-well)] px-6 py-10 transition-colors duration-[var(--dur-fast)] hover:border-[var(--accent)] hover:bg-[var(--accent-tint)]"
    >
      <span className="grid h-11 w-11 place-items-center rounded-full bg-[var(--surface-paper)] text-[var(--ink-tertiary)] transition-colors duration-[var(--dur-fast)] group-hover:text-[var(--accent)]">
        <IconImport size={20} />
      </span>
      <span className="text-[var(--text-md)] font-medium">选择 CSV 文件</span>
      <span className="text-[var(--text-xs)] text-[var(--ink-tertiary)]">
        点这里浏览 —— 选好之后会先给你看一遍再导入
      </span>
    </button>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : (done / total) * 100;
  return (
    <div className="card-well p-5">
      <p className="text-[var(--text-sm)]">
        正在导入 <span className="font-medium tabular-nums">{done}</span>
        <span className="text-[var(--ink-tertiary)]"> / {total}</span>
      </p>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--border-subtle)]"
        role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total}>
        <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-[var(--dur-fast)]"
          style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Result({ created, failed, onAgain }: {
  created: number;
  failed: { name: string; reason: string }[];
  onAgain: () => void;
}) {
  return (
    <div className="card p-5">
      <p className="flex items-center gap-2.5 text-[var(--text-md)]">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--safe)] text-[var(--surface-paper)]">
          <IconCheck size={14} />
        </span>
        已导入 <span className="font-semibold tabular-nums">{created}</span> 条
      </p>

      {failed.length > 0 && (
        <div className="mt-4 rounded-[var(--radius-sm)] bg-[var(--surface-well)] p-3.5">
          <p className="mb-2 flex items-center gap-2 text-[var(--text-sm)] font-medium text-[var(--risk)]">
            <IconAlert size={14} className="shrink-0" />
            有 {failed.length} 条没写进去
          </p>
          <ul className="space-y-1">
            {failed.map((f) => (
              <li key={f.name} className="text-[var(--text-xs)]">
                <span className="font-medium">{f.name}</span>
                <span className="text-[var(--ink-tertiary)]"> —— {f.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button onClick={onAgain} className="btn btn-quiet mt-4">再导入一份</button>
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
    <div className="card">
      <div className="border-b border-[var(--border-subtle)] px-4 py-3.5">
        <p className="truncate text-[var(--text-sm)] text-[var(--ink-tertiary)]" title={fileName}>
          {fileName}
        </p>
        <p className="mt-1 text-[var(--text-md)]">
          <span className="font-semibold tabular-nums">{parsed.items.length}</span> 条可导入
          {logins > 0 && <span className="text-[var(--ink-secondary)]"> · 其中登录 {logins} 条</span>}
          {folders > 0 && <span className="text-[var(--ink-secondary)]"> · {folders} 个文件夹</span>}
        </p>
      </div>

      {/*
        ⚠️ 跳过的行必须逐条列出来，而且要用**警示色**。
        「导入了 187 条」而不说「跳过了 3 条」，用户不会发现少了什么 ——
        直到某天要登录某个网站。
      */}
      {parsed.skipped.length > 0 && (
        <div className="border-b border-[var(--border-subtle)] bg-[var(--surface-well)] px-4 py-3.5">
          <p className="mb-2 flex items-center gap-2 text-[var(--text-sm)] font-medium text-[var(--caution)]">
            <IconAlert size={14} className="shrink-0" />
            有 {parsed.skipped.length} 行不会被导入
          </p>
          <ul className="space-y-1">
            {parsed.skipped.slice(0, 8).map((s) => (
              <li key={s.rowNumber} className="text-[var(--text-xs)] text-[var(--ink-secondary)]">
                第 <span className="tabular-nums">{s.rowNumber}</span> 行 —— {s.reason}
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

      <div className="flex items-center gap-2 px-4 py-3.5">
        <button onClick={onRun} className="btn btn-primary">
          导入这 {parsed.items.length} 条
        </button>
        <button onClick={onCancel} className="btn btn-quiet">换一个文件</button>
      </div>
    </div>
  );
}
