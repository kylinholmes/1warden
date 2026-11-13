import { useLocalStore, useStoreField } from '@1warden/state/react';
import { useId, useLayoutEffect, useRef } from 'react';
import { IconEye } from './icons';
import { InlinePasswordGenerator } from './InlinePasswordGenerator';

/** Reveal is local UI state only; the controlled draft always retains the exact value. */
export function EditorSecretField({ label, value, onChange, multiline = false, placeholder, onGenerate, disabled = false }: {
  label: string; value: string; onChange: (value: string) => void;
  multiline?: boolean; placeholder?: string | undefined; onGenerate?: ((value: string) => void) | undefined; disabled?: boolean;
}) {
  const store = useLocalStore(() => ({ revealed: false, generatorOpen: false }));
  const [revealed, setRevealed] = useStoreField(store, 'revealed');
  const [generatorOpen, setGeneratorOpen] = useStoreField(store, 'generatorOpen');
  const generatorId = useId();
  const generatorButton = useRef<HTMLButtonElement>(null);
  const generatorOptions = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Expansion should reveal the complete options inside the editor's scroll
    // area. Keep focus on the trigger and leave subsequent edits in place.
    if (generatorOpen) generatorOptions.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }, [generatorOpen]);
  const action = `${revealed ? '隐藏' : '显示'}${label}`;
  return <div className="min-w-0" data-escape-scope={generatorOpen || undefined} onKeyDown={event => {
    if (event.key !== 'Escape' || !generatorOpen) return;
    event.preventDefault(); event.stopPropagation(); setGeneratorOpen(false); generatorButton.current?.focus();
  }}>
    <div className={multiline ? 'flex min-w-0 items-start gap-1' : 'relative flex min-w-0 items-center'}>
    <div className="min-w-0 flex-1">
      {multiline ? <textarea value={revealed ? value : value ? '••••••••' : ''} rows={4}
        aria-label={label} readOnly={!revealed} disabled={disabled} autoComplete="off" spellCheck={false}
        placeholder={revealed ? placeholder : '显示后编辑私钥'}
        className="field secret resize-y leading-[var(--lh-prose)]"
        onChange={event => { if (revealed) onChange(event.target.value); }} />
      : <input value={value} type={revealed ? 'text' : 'password'} aria-label={label} disabled={disabled}
        autoComplete="off" spellCheck={false} placeholder={placeholder}
        className={`field secret min-w-0 ${onGenerate ? '!pr-[76px]' : '!pr-10'}`}
        onChange={event => onChange(event.target.value)} />}
    </div>
    <div className={multiline ? 'flex shrink-0 items-center gap-0.5' : 'absolute right-1.5 flex items-center gap-0.5'}>
      <button type="button" aria-label={action} title={action} aria-pressed={revealed} disabled={disabled}
        onClick={event => { if (!event.currentTarget.closest('[inert]')) setRevealed(!revealed); }}
        className="shrink-0 rounded-[var(--radius-sm)] p-1.5 text-[var(--ink-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]">
        <IconEye size={16} off={!revealed} />
      </button>
      {onGenerate && <button ref={generatorButton} type="button" title="密码生成选项" aria-label="密码生成选项" aria-expanded={generatorOpen} aria-controls={generatorId} disabled={disabled}
        onClick={event => { if (!event.currentTarget.closest('[inert]')) setGeneratorOpen(!generatorOpen); }}
        className="shrink-0 rounded-[var(--radius-sm)] px-2 py-1 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent-tint)]">生成</button>}
    </div>
    </div>
    {onGenerate && <div ref={generatorOptions} id={generatorId} hidden={!generatorOpen} className="mt-3 scroll-mb-3">
      <InlinePasswordGenerator disabled={disabled} onGenerate={next => { setRevealed(false); onGenerate(next); }} />
    </div>}
  </div>;
}
