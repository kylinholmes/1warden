import { Children, type ReactNode } from 'react';

/** Labels above content, shared by independent editor and detail fields. */
export const FIELD_ROW_CLASS = 'flex flex-col min-w-0 gap-1';
export const FIELD_LABEL_CLASS = 'break-words [overflow-wrap:anywhere] text-xs text-[var(--violet)]';

/** Related native fields share one divider and use equal columns when the whole
 * group fits. Only surviving children count: an omitted detail field must not
 * leave a hole, and a three-part name must never wrap into a 2+1 layout.
 */
export function CompoundFieldRow({ label, fieldId, editor = false, children }: {
  label: string;
  fieldId?: string;
  editor?: boolean;
  children: ReactNode;
}) {
  const cells = Children.toArray(children);
  if (!cells.length) return null;
  // Reserve roughly 120 CSS px per short field before switching the whole group.
  // The former 160px budget stacked ordinary names too early at desktop scaling.
  const columns = cells.length === 2 ? ' @[240px]:grid-cols-2'
    : cells.length === 3 ? ' @[360px]:grid-cols-3' : '';
  return <div role="group" aria-label={label} data-compound-field={fieldId} data-editor-field={editor ? fieldId : undefined}
    className="@container min-w-0 border-b border-[var(--border-subtle)] py-2 last:border-b-0">
    <div data-compound-cells className={`grid min-w-0 grid-cols-1 gap-x-3 gap-y-4${columns}`}>
      {cells}
    </div>
  </div>;
}
