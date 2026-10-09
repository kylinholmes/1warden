import { useId, type ReactNode } from 'react';
import { CLIPBOARD_CLEAR_MS, scheduleClipboardClear } from './clipboard';
import { useCopyAction, type CopyActionProps } from './useCopyAction';

/** The value itself is the action. Other controls (such as reveal) stay siblings. */
export function CopyField({ label, children, className = '', onCopied = scheduleClipboardClear, ...action }: CopyActionProps & {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const { state, copy } = useCopyAction({ ...action, onCopied });
  const contentId = useId();
  const feedback = state === 'ok' ? '已复制' : state === 'error' ? '复制失败' : state === 'busy' ? '复制中…' : '';
  return <button type="button" data-field-copy data-state={state}
    aria-label={`复制${label}`} aria-describedby={contentId} aria-busy={state === 'busy'}
    title={`${state === 'error' ? '复制失败，点击重试' : `点击复制${label}`}（${CLIPBOARD_CLEAR_MS / 1000} 秒后自动清空剪贴板）`}
    className={`inline-copy flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-[var(--radius-sm)] text-left ${className}`}
    onClick={event => {
      const selection = event.currentTarget.ownerDocument.getSelection();
      // A drag selection is a separate intent. Keyboard activation still copies.
      if (event.detail > 0 && selection && !selection.isCollapsed
        && (event.currentTarget.contains(selection.anchorNode) || event.currentTarget.contains(selection.focusNode))) return;
      void copy();
    }}>
    <span id={contentId} className="contents">{children}</span>
    <span data-copy-feedback className="inline-copy-feedback shrink-0 text-xs" role="status" aria-live="polite" aria-atomic="true">
      {feedback || <span aria-hidden="true">点击复制</span>}
    </span>
  </button>;
}
