import { useRef } from 'react';
import { IMPORT_FORMATS, type ImportFormatId } from '@1warden/vault';
import { IconAlert, IconCheck, IconImport } from './icons';
import { TYPE_LABEL } from './destinations';
import { Select } from './Select';

/**
 * 从别处导入 —— **两端共用这一份**。
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
 *
 * ## ⚠️ 扩展弹窗那份违反了第 2、3 条
 *
 * 它只报「跳过 3 行 / 格式不认」和「已导入 187 条，3 条失败」——
 * **没有行号、没有原因、没有名字**。而它跑的 `parseImport` 明明逐条
 * 给了这些信息，是界面把它们扔掉了一部分。
 *
 * 一条丢掉的密码要到几个月后登录某个网站时才会被发现，那时候已经无从
 * 回想是哪一步丢的。所以这一屏两端必须是同一份 —— 不是审美问题。
 *
 * ## 数据通道不同，所以这里只收**结果**
 *
 * 桌面端在进程内解析（`parseImport` 直接调），扩展端把文件字节发给后台
 * （弹窗**刻意**拿不到解析出来的明文条目，spec 不变量 S1）。两端各自
 * 把结果归一成下面的 `ImportPreview` / `ImportResult`，然后渲染同一份代码。
 */

/** 预览要显示的东西 —— 全部**不含明文** */
export interface ImportPreview {
  fileName: string;
  needsPassword?: boolean;
  format: ImportFormatId;
  formatLabel: string;
  total: number;
  /** 按条目类型分别计数 —— 「我的卡是不是也进来了」是这一屏最想知道的事之一 */
  byType: Record<string, number>;
  folders: number;
  /** ⚠️ 必须有 `rowNumber` 和 `reason`，只有个数就等于没报 */
  skipped: { rowNumber: number; reason: string }[];
  warnings?: string[];
}

export interface ImportOutcome {
  created: number;
  skippedExisting?: number;
  failed: { name: string; reason: string }[];
}

export function ImportView({
  preview,
  progress,
  result,
  error,
  hasFile,
  autoFormat,
  reading = false,
  onPick,
  onFormatChange,
  onRun,
  onReset,
  onRetry,
}: {
  reading?: boolean;
  preview: ImportPreview | null;
  /** 导入中。桌面端和扩展端都由自己的动作产生 */
  progress: { done: number | null; total: number } | null;
  result: ImportOutcome | null;
  error: string | null;
  /** 已经选过文件 —— 决定措辞和格式选择器要不要出现 */
  hasFile: boolean;
  /** 自动识别出来的格式；`null` 表示认不出 */
  autoFormat: ImportFormatId | null;
  onPick: (file: File) => void;
  onFormatChange: (format: ImportFormatId) => void;
  onRun: () => void;
  onReset: () => void;
  onRetry?: (() => void) | undefined;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = progress !== null || reading;

  return (
    <div>
      <p className="text-sm leading-[var(--lh-prose)] text-[var(--ink-secondary)]">
        支持 1Password（.1pux / .1pif / CSV）、Bitwarden（JSON / CSV）、
        KeePass 2（XML 导出），以及 Chrome、Edge、Firefox、Safari、
        LastPass、Dashlane 等常见导出与 Excel 存出来的 CSV。
        数据只在本地解析，<strong className="font-medium text-[var(--ink-primary)]">
        文件不会上传到任何地方</strong>。
        导入会创建新记录，创建和更新时间由服务器重新生成。
      </p>

      {error && (
        <p role="alert" className="mt-4 flex items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-well)] px-3 py-2.5 text-sm text-[var(--risk)]">
          <IconAlert size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </p>
      )}

      <input
        ref={fileRef}
        type="file"
        disabled={busy}
        accept=".csv,.json,.1pux,.1pif,.xml,.txt,text/csv,application/json,text/xml,application/xml"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          // 清掉 value，否则连续选同一个文件不会再触发 change
          e.target.value = '';
          if (f) onPick(f);
        }}
      />

      {/*
        ⚠️ 格式选择器在**解析失败之后**也要在。
        否则用户选错了格式、看到一句「认不出」，却没有任何办法告诉他
        「你可以自己指定」—— 那他就只能换文件，而文件是对的。
      */}
      {hasFile && (
        <div className="mt-4">
          <label htmlFor="import-format" className="mb-1.5 block text-xs text-[var(--ink-tertiary)]">
            格式{autoFormat === null ? '（自动识别不了，请手动选）' : '（已自动识别，可手动改）'}
          </label>
          <Select
            id="import-format"
            value={preview?.format ?? autoFormat ?? 'auto'}
            onChange={value => onFormatChange(value as ImportFormatId)}
            disabled={busy}
            options={IMPORT_FORMATS.map(format => ({ value: format.id, label: format.label }))}
            className="w-full"
          />
        </div>
      )}

      <div className="mt-6">
        {progress !== null ? (
          <Progress done={progress.done} total={progress.total} />
        ) : result !== null ? (
          <ImportResult result={result} onAgain={onReset} onRetry={onRetry} />
        ) : preview !== null ? (
          <ImportPreviewCard preview={preview} disabled={busy} onRun={onRun} onCancel={onReset} />
        ) : (
          <PickStep disabled={busy} hasFile={hasFile} onChoose={() => fileRef.current?.click()} />
        )}
      </div>
    </div>
  );
}

/** File picker and window-wide drag/drop lead to the same preview. */
function PickStep({ hasFile, disabled, onChoose }: { hasFile: boolean; disabled: boolean; onChoose: () => void }) {
  return (
    <button
      type="button"
      onClick={onChoose}
      disabled={disabled}
      className="group flex w-full flex-col items-center gap-3 rounded-[var(--radius-md)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-well)] px-6 py-10 transition-colors duration-[var(--dur-fast)] hover:border-[var(--accent)] hover:bg-[var(--accent-tint)]"
    >
      <span className="grid h-11 w-11 place-items-center rounded-full bg-[var(--surface-paper)] text-[var(--ink-tertiary)] transition-colors duration-[var(--dur-fast)] group-hover:text-[var(--accent)]">
        <IconImport size={20} />
      </span>
      <span className="text-md font-medium">{hasFile ? '换一个文件' : '选择要导入的文件'}</span>
      <span className="text-xs text-[var(--ink-tertiary)]">
        点击选择或拖入文件，先预览再确认导入（最大 50 MiB）
      </span>
    </button>
  );
}

function Progress({ done, total }: { done: number | null; total: number }) {
  const pct = done === null ? 35 : total === 0 ? 0 : (done / total) * 100;
  return (
    <div className="card-well p-5">
      <p className="text-sm">
        正在导入{done === null ? ` ${total} 条记录…` : <><span className="font-medium tabular-nums"> {done}</span><span className="text-[var(--ink-tertiary)]"> / {total}</span></>}
      </p>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--border-subtle)]"
        role="progressbar" aria-label="导入进度" aria-valuenow={done ?? undefined} aria-valuemin={0} aria-valuemax={total}>
        <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-[var(--dur-fast)]"
          style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function ImportResult({ result: { created, failed, skippedExisting = 0 }, onAgain, onRetry }: {
  result: ImportOutcome;
  onAgain: () => void;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <div className="card p-4 @[640px]:p-5">
      <p className="flex items-center gap-2.5 text-md">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--safe)] text-[var(--surface-paper)]">
          <IconCheck size={14} />
        </span>
        {created === 0 && failed.length === 0 && skippedExisting === 0 ? '文件夹导入完成' : <>已导入 <span className="font-semibold tabular-nums">{created}</span> 条</>}
      </p>
      {skippedExisting > 0 && <p className="mt-3 text-sm text-[var(--ink-secondary)]">已跳过 {skippedExisting} 条已有条目</p>}

      {/*
        ⚠️ 失败的那些**必须逐个列出来**（名字 + 原因）。
        只说「3 条失败」的话，用户既不知道是哪三条，也无从重试 ——
        而这一屏是他最后一次能知道「少了什么」的地方。
      */}
      {failed.length > 0 && (
        <div className="mt-4 rounded-[var(--radius-sm)] bg-[var(--surface-well)] p-3.5">
          <p className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--risk)]">
            <IconAlert size={14} className="shrink-0" />
            有 {failed.length} 项未完成或未能确认
          </p>
          <ul className="space-y-1">
            {failed.map((f, index) => (
              <li key={index} className="text-xs">
                <span className="font-medium">{f.name}</span>
                <span className="text-[var(--ink-tertiary)]"> —— {f.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {failed.length > 0 && onRetry && <button onClick={onRetry} className="btn btn-primary">跳过已有条目并重试</button>}
        <button onClick={onAgain} className="btn btn-quiet">再导入一份</button>
      </div>
    </div>
  );
}

export function ImportPreviewCard({ preview, disabled, onRun, onCancel, cancelLabel = '换一个文件' }: {
  preview: ImportPreview;
  disabled: boolean;
  onRun: () => void;
  onCancel: () => void;
  cancelLabel?: string;
}) {
  const breakdown = Object.entries(preview.byType).map(([t, n]) => `${TYPE_LABEL[t] ?? t} ${n}`);

  return (
    <div className="card">
      <div className="border-b border-[var(--border-subtle)] px-4 py-3.5">
        <p className="truncate text-sm text-[var(--ink-tertiary)]" title={preview.fileName}>
          {preview.fileName}
        </p>
        <p className="mt-1 text-md">
          <span className="font-semibold tabular-nums">{preview.total}</span> 条可导入
          {breakdown.length > 0 && (
            <span className="text-[var(--ink-secondary)]"> —— {breakdown.join(' · ')}</span>
          )}
          {preview.folders > 0 && (
            <span className="text-[var(--ink-tertiary)]"> · {preview.folders} 个文件夹</span>
          )}
        </p>
      </div>

      {/*
        ⚠️ 跳过的行必须逐条列出来，而且要用**警示色**。
        「导入了 187 条」而不说「跳过了 3 条」，用户不会发现少了什么 ——
        直到某天要登录某个网站。
      */}
      {preview.skipped.length > 0 && (
        <div className="border-b border-[var(--border-subtle)] bg-[var(--surface-well)] px-4 py-3.5">
          <p className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--caution)]">
            <IconAlert size={14} className="shrink-0" />
            有 {preview.skipped.length} 行不会被导入
          </p>
          <ul className="space-y-1">
            {preview.skipped.slice(0, 8).map((s) => (
              <li key={s.rowNumber} className="text-xs text-[var(--ink-secondary)]">
                第 <span className="tabular-nums">{s.rowNumber}</span> 行 —— {s.reason}
              </li>
            ))}
          </ul>
          {preview.skipped.length > 8 && <details className="mt-2 text-xs text-[var(--ink-secondary)]">
            <summary className="cursor-pointer text-[var(--accent)]">查看其余 {preview.skipped.length - 8} 行</summary>
            <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
              {preview.skipped.slice(8).map(s => <li key={s.rowNumber}>
                第 <span className="tabular-nums">{s.rowNumber}</span> 行 —— {s.reason}
              </li>)}
            </ul>
          </details>}
        </div>
      )}

      {!!preview.warnings?.length && <ul className="space-y-1 border-b border-[var(--border-subtle)] px-4 py-3 text-xs text-[var(--caution)]">
        {preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
      </ul>}
      <div className="flex items-center gap-2 px-4 py-3.5">
        <button onClick={onRun} disabled={disabled} className="btn btn-primary">
          {preview.total > 0 ? `导入这 ${preview.total} 条` : `导入 ${preview.folders} 个文件夹`}
        </button>
        <button onClick={onCancel} disabled={disabled} className="btn btn-quiet">{cancelLabel}</button>
      </div>
    </div>
  );
}
