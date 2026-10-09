import { useEffect, useRef } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import type { CustomField, ItemType } from '@1warden/vault';
import { linkedFieldTargets } from './item-editor-fields';
import { IconPlus } from './icons';

/** An in-panel picker keeps its width and focus inside FloatingPanel. */
export function EditorAddMore({ itemType, onCustom }: {
  itemType: ItemType;
  onCustom: (type: CustomField['type']) => void;
}) {
  const store = useLocalStore(() => ({ expanded: false }));
  const [expanded, setExpanded] = useStoreField(store, 'expanded');
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const customTypes: { type: CustomField['type']; label: string }[] = [
    { type: 0, label: '文本' }, { type: 1, label: '隐藏' }, { type: 2, label: '开关' },
    ...(linkedFieldTargets(itemType).length ? [{ type: 3 as const, label: '关联' }] : []),
  ];
  useEffect(() => {
    if (expanded) wrapper.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [expanded]);
  useEffect(() => { setExpanded(false); }, [itemType]);
  useEffect(() => {
    if (!expanded) return;
    const closeOutside = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setExpanded(false);
    };
    const closeOnOutsideFocus = (event: FocusEvent) => {
      const picker = wrapper.current;
      const target = event.target;
      if (picker && target instanceof Node && !picker.contains(target) && !target.contains(picker)) setExpanded(false);
    };
    const restoreAfterPointer = () => {
      const picker = wrapper.current;
      const active = document.activeElement;
      // A cancelled drag or WebKit button press can leave focus on the dialog.
      // Return keyboard ownership without scrolling or selecting any option.
      if (picker && (!active || active.contains(picker))) {
        picker.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('focusin', closeOnOutsideFocus);
    document.addEventListener('pointerup', restoreAfterPointer);
    document.addEventListener('pointercancel', restoreAfterPointer);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('focusin', closeOnOutsideFocus);
      document.removeEventListener('pointerup', restoreAfterPointer);
      document.removeEventListener('pointercancel', restoreAfterPointer);
    };
  }, [expanded]);
  return (
    <div ref={wrapper} className="mb-6 min-w-0" data-escape-scope={expanded ? 'true' : undefined}
      onBlur={event => {
        // WebKit may focus the document or the containing dialog before a
        // menu button's click. Neither transition means another control owns
        // focus; closing here would remove that button before click fires.
        const target = event.relatedTarget;
        if (target && !event.currentTarget.contains(target) && !target.contains(event.currentTarget)) setExpanded(false);
      }}
      onKeyDown={event => {
        if (!expanded) {
          if (event.key === 'ArrowDown') { event.preventDefault(); setExpanded(true); }
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); setExpanded(false); trigger.current?.focus();
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
          event.preventDefault(); items[next]?.focus();
        }
      }}>
      <button ref={trigger} data-editor-add-more type="button" className="btn btn-quiet gap-1.5" aria-haspopup="menu"
        aria-expanded={expanded} aria-controls="editor-add-more-menu" onClick={() => setExpanded(value => !value)}>
        <IconPlus size={14} />添加自定义字段
      </button>
      {expanded && <div id="editor-add-more-menu" role="menu" aria-label="添加自定义字段"
        className="mt-2 max-h-[280px] min-w-0 overflow-x-hidden overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-overlay)] p-2">
        <div role="group" aria-label="自定义字段">
          <p className="px-2 pb-1 pt-2 text-xs text-[var(--ink-tertiary)]">自定义字段</p>
          {customTypes.map(({ type, label }) => <button key={type} data-add-custom={type} role="menuitem" type="button"
            className="block w-full rounded-[var(--radius-sm)] px-2 py-2 text-left text-sm text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]"
            onClick={() => { setExpanded(false); onCustom(type); }}>自定义 · {label}</button>)}
        </div>
      </div>}
    </div>
  );
}
