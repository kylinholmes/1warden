import type { LoginUri } from '@1warden/vault';
import { IconTrash } from './icons';
import { removeLoginUri, updateLoginUri } from './item-editor-fields';

const MATCH_MODES = [
  { value: '', label: '默认' }, { value: '0', label: '域名' },
  { value: '1', label: '主机' }, { value: '2', label: '开头匹配' },
  { value: '3', label: '完全匹配' }, { value: '4', label: '正则表达式' },
  { value: '5', label: '从不匹配' },
];

export function EditorUrls({ uris, visibleIndices, onChange, onRemove }: {
  uris: LoginUri[];
  visibleIndices?: readonly number[];
  onChange: (uris: LoginUri[]) => void;
  onRemove?: (index: number) => void;
}) {
  return (
    <div className="space-y-3">
      {uris.map((uri, index) => (!visibleIndices || visibleIndices.includes(index)) && (
        <div key={uri.sourceId ?? index} data-editor-url={index} className="space-y-2">
          <div className="flex items-start gap-2">
            <input className="field min-w-0 flex-1" value={uri.uri} aria-label={`网址 ${index + 1}`}
              autoComplete="off" spellCheck={false} placeholder="https://github.com"
              onChange={event => onChange(updateLoginUri(uris, index, { uri: event.target.value }))} />
            <button type="button" onClick={() => onRemove ? onRemove(index) : onChange(removeLoginUri(uris, index))}
              title="删除此网址" aria-label={`删除网址 ${index + 1}`}
              className="shrink-0 rounded-[var(--radius-sm)] p-2.5 text-[var(--ink-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--risk)]">
              <IconTrash size={15} />
            </button>
          </div>
          <details className="text-xs text-[var(--ink-tertiary)]">
            <summary className="cursor-pointer py-1">匹配方式 · {MATCH_MODES.find(mode => mode.value === String(uri.match ?? ''))?.label ?? `现有方式 (${uri.match})`}</summary>
            <label className="mt-1 block">
              <span className="sr-only">匹配方式</span>
              <select className="field w-full min-w-0" value={uri.match === null ? '' : String(uri.match)}
                aria-label={`网址 ${index + 1} 匹配方式`}
                onChange={event => onChange(updateLoginUri(uris, index, { match: event.target.value === '' ? null : Number(event.target.value) }))}>
                {MATCH_MODES.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
                {uri.match !== null && !MATCH_MODES.some(mode => mode.value === String(uri.match)) && (
                  <option value={uri.match} disabled>现有方式 ({uri.match})</option>
                )}
              </select>
            </label>
          </details>
        </div>
      ))}
    </div>
  );
}
