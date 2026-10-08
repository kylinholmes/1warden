import type { CustomField, ItemType } from '@1warden/vault';
import { IconTrash } from './icons';
import { changeCustomFieldType, linkedFieldTargets } from './item-editor-fields';

export function EditorCustomFields({ fields, itemType, onChange, onRemove }: {
  fields: CustomField[];
  itemType: ItemType;
  onChange: (fields: CustomField[]) => void;
  onRemove?: (index: number) => void;
}) {
  const targets = linkedFieldTargets(itemType);
  function update(index: number, patch: Partial<CustomField>) {
    onChange(fields.map((field, i) => i === index ? { ...field, ...patch } : field));
  }
  return (
    <div className="@container space-y-3">
      {fields.map((field, index) => {
        const unsupported = field.unsupportedType !== undefined;
        const linkedSupported = targets.some(target => target.id === field.linkedId);
        return (
          <div key={field.sourceId ?? index} data-editor-custom={index} className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] p-2.5">
            <div className="flex items-start gap-2">
              <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 @[360px]:grid-cols-[minmax(0,1fr)_104px]">
                <input value={field.name} placeholder="名称" aria-label={`字段 ${index + 1} 名称`}
                  disabled={unsupported} onChange={event => update(index, { name: event.target.value })}
                  className="field min-w-0" />
                <select value={field.type} disabled={unsupported} className="field min-w-0"
                  aria-label={`字段 ${index + 1} 类型`}
                  onChange={event => onChange(fields.map((f, i) => i === index
                    ? changeCustomFieldType(f, Number(event.target.value) as CustomField['type'], itemType) : f))}>
                  <option value={0}>文本</option><option value={1}>隐藏</option><option value={2}>开关</option>
                  {(targets.length > 0 || field.type === 3) && <option value={3} disabled={targets.length === 0}>关联</option>}
                </select>
              </div>
              <button type="button" onClick={() => onRemove ? onRemove(index) : onChange(fields.filter((_, i) => i !== index))}
                title="删除此字段" aria-label={`删除字段 ${index + 1}`}
                className="shrink-0 rounded-[var(--radius-sm)] p-2.5 text-[var(--ink-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--risk)]">
                <IconTrash size={15} />
              </button>
            </div>
            <div className="mt-2">
              {unsupported ? (
                <p className="text-xs text-[var(--ink-tertiary)]">现有字段类型 ({field.unsupportedType}) 暂不支持编辑，保存时会保留。</p>
              ) : field.type === 2 ? (
                <>
                  <label className="flex min-h-9 items-center gap-2 text-sm">
                    <input type="checkbox" checked={field.value === 'true'} aria-label={`字段 ${index + 1} 开关`}
                      className="h-4 w-4 accent-[var(--accent)]"
                      onChange={event => update(index, { value: event.target.checked ? 'true' : 'false' })} />
                    {field.value === 'true' ? '开启' : '关闭'}
                  </label>
                  {field.value !== 'true' && field.value !== 'false' && (
                    <p className="text-xs text-[var(--ink-tertiary)]">现有值不是 true/false，未改动时会保留。</p>
                  )}
                </>
              ) : field.type === 3 ? (
                <>
                  <select className="field" value={field.linkedId === null ? '' : String(field.linkedId)}
                    aria-label={`字段 ${index + 1} 关联目标`}
                    onChange={event => update(index, { linkedId: Number(event.target.value), value: '' })}>
                    {!linkedSupported && <option value={field.linkedId === null ? '' : String(field.linkedId)} disabled>
                      现有关联 ({field.linkedId ?? '未指定'})
                    </option>}
                    {targets.map(target => <option key={target.id} value={target.id}>{target.label}</option>)}
                  </select>
                  {!linkedSupported && <p className="mt-1 text-xs text-[var(--ink-tertiary)]">此关联目标暂不支持，未改动时会保留。</p>}
                </>
              ) : (
                <input value={field.value} placeholder="值" aria-label={`字段 ${index + 1} 值`}
                  type={field.type === 1 ? 'password' : 'text'} autoComplete="off" spellCheck={false}
                  onChange={event => update(index, { value: event.target.value })} className="field secret" />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
