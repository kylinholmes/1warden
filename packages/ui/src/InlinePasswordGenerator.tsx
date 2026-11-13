import { useLocalStore, useStoreField } from '@1warden/state/react';
import { useId } from 'react';
import { generatePassword, type PasswordOptions } from '@1warden/crypto';
import { IconDice } from './icons';

const CHARACTER_CLASSES = [
  ['uppercase', '大写'], ['lowercase', '小写'], ['digits', '数字'], ['symbols', '符号'],
] as const;

/** Configuration stays local to this editor; only an explicit generate fills the draft. */
export function InlinePasswordGenerator({ onGenerate, disabled = false }: {
  onGenerate: (value: string) => void; disabled?: boolean;
}) {
  const store = useLocalStore(() => ({ options: { length: 20, lowercase: true, uppercase: true,
    digits: true, symbols: true, avoidAmbiguous: false } as Required<PasswordOptions>, error: null as string | null }));
  const [options, setOptions] = useStoreField(store, 'options');
  const [error, setError] = useStoreField(store, 'error');
  const lengthId = useId();
  const classes = CHARACTER_CLASSES.filter(([key]) => options[key]).length;
  const interactive = (element: Element) => !disabled && !element.closest('[inert]');
  function configure(patch: PasswordOptions) { setOptions(current => ({ ...current, ...patch })); setError(null); }
  return <fieldset disabled={disabled} aria-label="密码生成选项" className="min-w-0 space-y-3 border-t border-[var(--border-subtle)] pt-3">
    <div className="flex min-w-0 items-center gap-3">
      <label htmlFor={lengthId} className="shrink-0 text-xs text-[var(--ink-secondary)]">长度</label>
      <input id={lengthId} aria-label="生成密码长度" type="range" min={8} max={64} step={1} value={options.length}
        className="min-w-0 flex-1" onChange={event => { if (interactive(event.currentTarget)) configure({ length: Number(event.target.value) }); }} />
      <output htmlFor={lengthId} className="tnum w-6 shrink-0 text-right text-sm">{options.length}</output>
      <button type="button" className="btn btn-primary shrink-0 px-2.5" aria-label="生成并填入密码" title="生成并填入密码"
        onClick={event => {
          if (!interactive(event.currentTarget)) return;
          try { onGenerate(generatePassword(options)); setError(null); }
          catch (error) { setError(error instanceof Error ? error.message : '生成失败，请重试'); }
        }}><IconDice size={16} /></button>
    </div>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {CHARACTER_CLASSES.map(([key, label]) => <label key={key} className="flex items-center gap-1.5 whitespace-nowrap text-xs">
        <input type="checkbox" checked={options[key]} disabled={disabled || (options[key] && classes === 1)}
          onChange={event => { if (interactive(event.currentTarget)) configure({ [key]: event.target.checked }); }} />{label}
      </label>)}
    </div>
    <label className="flex items-center gap-1.5 text-xs text-[var(--ink-secondary)]">
      <input type="checkbox" checked={options.avoidAmbiguous}
        onChange={event => { if (interactive(event.currentTarget)) configure({ avoidAmbiguous: event.target.checked }); }} />排除易混字符 Il1O0o
    </label>
    {error && <p role="alert" className="text-xs text-[var(--risk)]">{error}</p>}
  </fieldset>;
}
