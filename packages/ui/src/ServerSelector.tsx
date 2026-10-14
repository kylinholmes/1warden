import { useEffect, useRef } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import type { SavedAccount } from './accounts';
import { Select } from './Select';
import { ServerSpeed } from './ServerSpeed';

export const DEFAULT_SERVER_URL = 'https://vault.vaultwarden.com';
const presets = [
  { value: 'vaultwarden', label: 'Vaultwarden.com（社区托管）', url: DEFAULT_SERVER_URL },
  { value: 'bitwarden-us', label: 'Bitwarden（美国）', url: 'https://vault.bitwarden.com' },
  { value: 'bitwarden-eu', label: 'Bitwarden（欧洲）', url: 'https://vault.bitwarden.eu' },
];
const clean = (value: string) => {
  try { return new URL(value.trim()).href.replace(/\/+$/, ''); }
  catch { return value.trim().replace(/\/+$/, ''); }
};
export function initialServerUrl(value: string | undefined, accounts: SavedAccount[]): string {
  // An explicit empty value is a custom server the user has not filled in yet.
  return value ?? accounts[0]?.serverUrl ?? DEFAULT_SERVER_URL;
}

/** Keep the public URL as account identity; measurements use public endpoints only. */
export function ServerSelector({ value, accounts, disabled, onChange }: {
  value: string; accounts: SavedAccount[]; disabled: boolean; onChange: (url: string) => void;
}) {
  const saved = [...new Map(accounts.map(account => [clean(account.serverUrl), account.serverUrl])).values()];
  const options = [
    ...saved.map(url => ({ value: `saved:${url}`, label: `已保存：${url.replace(/^https?:\/\//i, '')}`, url })),
    { value: 'custom', label: '自定义服务器', url: '' },
    ...presets,
  ];
  const infer = (url: string) => options.find(option => option.value !== 'custom' && clean(option.url) === clean(url))?.value ?? 'custom';
  const store = useLocalStore(() => ({ choice: infer(value) }));
  const [choice, setChoice] = useStoreField(store, 'choice');
  const custom = useRef(choice === 'custom' ? value : '');
  const last = useRef(value);
  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    const next = infer(value);
    setChoice(next);
    if (next === 'custom') custom.current = value;
  }, [value, accounts]);
  function update(url: string) { last.current = url; onChange(url); }
  return <div className="space-y-3">
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-[var(--ink-secondary)]">服务器</span>
      <Select aria-label="服务器" value={choice} options={options} disabled={disabled} onChange={next => {
        if (choice === 'custom') custom.current = value;
        setChoice(next);
        update(next === 'custom' ? custom.current : options.find(option => option.value === next)!.url);
      }} />
    </label>
    {choice === 'custom' ? <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-[var(--ink-secondary)]">服务器地址</span>
      <input type="url" required autoComplete="url" disabled={disabled} value={value}
        placeholder="https://vault.example.com" className="field"
        onChange={event => { custom.current = event.target.value; update(event.target.value); }} />
      <span className="mt-1.5 block text-xs text-[var(--ink-tertiary)]">填写你的 Vaultwarden 或 Bitwarden 服务器地址。</span>
    </label> : <p className="break-all text-xs text-[var(--ink-tertiary)]">{value}</p>}
    <ServerSpeed serverUrl={value} disabled={disabled} />
  </div>;
}
