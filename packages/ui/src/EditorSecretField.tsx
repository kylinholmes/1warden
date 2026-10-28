import { useLocalStore, useStoreField } from '@1warden/state/react';
import { IconEye } from './icons';

/** Reveal is local UI state only; the controlled draft always retains the exact value. */
export function EditorSecretField({ label, value, onChange, multiline = false, placeholder, onGenerate }: {
  label: string; value: string; onChange: (value: string) => void;
  multiline?: boolean; placeholder?: string | undefined; onGenerate?: (() => void) | undefined;
}) {
  const store = useLocalStore(() => ({ revealed: false }));
  const [revealed, setRevealed] = useStoreField(store, 'revealed');
  const action = `${revealed ? '隐藏' : '显示'}${label}`;
  return <div className="flex min-w-0 items-start gap-1">
    <div className="min-w-0 flex-1">
      {multiline ? <textarea value={revealed ? value : value ? '••••••••' : ''} rows={4}
        aria-label={label} readOnly={!revealed} autoComplete="off" spellCheck={false}
        placeholder={revealed ? placeholder : '显示后编辑私钥'}
        className="field secret resize-y leading-[var(--lh-prose)]"
        onChange={event => { if (revealed) onChange(event.target.value); }} />
      : <input value={value} type={revealed ? 'text' : 'password'} aria-label={label}
        autoComplete="off" spellCheck={false} placeholder={placeholder} className="field secret min-w-0"
        onChange={event => onChange(event.target.value)} />}
    </div>
    <button type="button" aria-label={action} title={action} aria-pressed={revealed}
      onClick={event => { if (!event.currentTarget.closest('[inert]')) setRevealed(!revealed); }}
      className="shrink-0 rounded-[var(--radius-sm)] p-2.5 text-[var(--ink-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]">
      <IconEye size={16} off={!revealed} />
    </button>
    {onGenerate && <button type="button" title="生成随机密码"
      onClick={event => { if (!event.currentTarget.closest('[inert]')) { setRevealed(false); onGenerate(); } }}
      className="shrink-0 rounded-[var(--radius-sm)] px-2 py-2.5 text-xs text-[var(--accent)] hover:bg-[var(--accent-tint)]">生成</button>}
  </div>;
}
