import { useId } from 'react';
import { IconArrowLeft, IconChevronDown, IconClose } from './icons';
import { NavTrigger } from './NavRail';

export interface Breadcrumb { label: string; onSelect?: () => void }

/** One back affordance, hit target and focus treatment throughout the app. */
export function BackButton({ onBack, label, className = '', showLabel = false }: { onBack: () => void; label: string; className?: string; showLabel?: boolean }) {
  return <button type="button" data-page-back aria-label={label} title={label} onClick={onBack}
    className={`btn btn-ghost min-h-11 min-w-11 shrink-0 gap-2 p-2 ${className}`}><IconArrowLeft size={18} />{showLabel && <span>{label}</span>}</button>;
}

/** Shared page/dialog header. Current crumb is text; ancestors are real actions. */
export function PageHeader({ title, titleId, breadcrumbs, onBack, backLabel = '返回上一页', navigation = false, onClose, closeLabel, panel = false }: {
  title: string; titleId?: string; breadcrumbs: readonly Breadcrumb[];
  onBack?: (() => void) | undefined; backLabel?: string; navigation?: boolean;
  onClose?: () => void; closeLabel?: string; panel?: boolean;
}) {
  const generatedId = useId();
  return <header className={`${panel ? 'panel-head' : 'band'} page-header`} data-tauri-drag-region={panel ? undefined : 'deep'}>
    {navigation && <NavTrigger />}
    {onBack && <BackButton onBack={onBack} label={backLabel} />}
    <h2 id={titleId ?? generatedId} className="sr-only">{title}</h2>
    <nav aria-label={`${title}路径`} className="min-w-0 flex-1 text-sm">
      <ol className="flex min-w-0 items-center gap-1">
        {breadcrumbs.map((crumb, index) => <li key={`${index}:${crumb.label}`} className={`flex min-w-0 items-center gap-1 ${index === breadcrumbs.length - 1 ? 'flex-auto' : 'shrink'}`}>
          {index > 0 && <IconChevronDown size={13} aria-hidden="true" className="shrink-0 -rotate-90 text-[var(--ink-tertiary)]" />}
          {index === breadcrumbs.length - 1 || !crumb.onSelect
            ? <span aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined} className="min-w-0 truncate font-medium" title={crumb.label}>{crumb.label}</span>
            : <button type="button" onClick={crumb.onSelect} className="btn btn-ghost min-h-11 min-w-0 max-w-full px-1 text-[var(--ink-secondary)]" title={crumb.label}>
              <span className="min-w-0 truncate">{crumb.label}</span>
            </button>}
        </li>)}
      </ol>
    </nav>
    {!onBack && onClose && <button type="button" onClick={onClose} aria-label={closeLabel ?? `关闭${title}`} title={closeLabel ?? `关闭${title}`}
      className="btn btn-ghost min-h-11 min-w-11 shrink-0 p-2"><IconClose size={18} /></button>}
  </header>;
}
