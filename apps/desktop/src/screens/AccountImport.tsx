import { useEffect } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import { ImportPreviewCard, ImportResult, Select, type ImportOutcome, type ImportPreview } from '@1warden/ui';
import { accountKey, lockedAccount, type AccountTarget } from '../application/account-target';
import type { ApplicationClient } from '../application/types';
import { useTransferLifetime } from './transfer-lifetime';
import { ImportOptions } from './ImportOptions';

function sources(client: ApplicationClient): AccountTarget[] {
  const snapshot = client.getSnapshot();
  const current = snapshot.account ? accountKey(snapshot.account) : null;
  return (snapshot.unlockedAccounts ?? []).flatMap(key => {
    if (key === current) return [];
    try {
      const [serverUrl, email] = JSON.parse(key);
      const account = lockedAccount({ serverUrl, email });
      return [{ serverUrl: account.serverUrl, email: account.email }];
    } catch { return []; }
  });
}

/** Only identities and preview counts reach this component; secrets stay with the account owner. */
export function AccountImport({ client, onImported, onBusyChange }: {
  client: ApplicationClient; onImported: () => void; onBusyChange: (value: boolean) => void;
}) {
  const store = useLocalStore(() => ({ accounts: sources(client), selected: sources(client)[0] ? accountKey(sources(client)[0]!) : '', skipExisting: true,
    preview: null as ImportPreview | null, result: null as ImportOutcome | null, error: null as string | null,
    busy: false, writing: false }));
  const [accounts, setAccounts] = useStoreField(store, 'accounts');
  const [selected, setSelected] = useStoreField(store, 'selected');
  const [skipExisting, setSkipExisting] = useStoreField(store, 'skipExisting');
  const [preview, setPreview] = useStoreField(store, 'preview');
  const [result, setResult] = useStoreField(store, 'result');
  const [error, setError] = useStoreField(store, 'error');
  const [busy, setBusy] = useStoreField(store, 'busy');
  const [writing, setWriting] = useStoreField(store, 'writing');
  const request = useTransferLifetime(client);
  useEffect(() => client.subscribe(() => setAccounts(sources(client))), [client]);
  const source = accounts.find(account => accountKey(account) === selected);
  const target = client.getSnapshot().account;

  function reset() { request.current++; setPreview(null); setResult(null); setError(null); }
  async function perform(write: boolean, retry = false) {
    if (store.getState().busy || !source || (write && !preview)) return;
    const current = ++request.current;
    setBusy(true); setWriting(write); setError(null); onBusyChange(true);
    if (retry) setSkipExisting(true);
    try {
      if (write) {
        const outcome = await client.importAccount(source, { skipExisting: retry || skipExisting });
        if (current !== request.current) return;
        setResult(outcome); onImported();
      } else {
        const next = await client.previewAccountImport(source);
        if (current !== request.current) return;
        setPreview(next); setResult(null);
      }
    } catch (cause) {
      if (current === request.current) setError(cause instanceof Error ? cause.message : '账户迁移失败');
    } finally {
      if (current === request.current) { setBusy(false); setWriting(false); onBusyChange(false); }
    }
  }

  return <div>
    <p className="text-sm leading-relaxed text-[var(--ink-secondary)]">将另一个已解锁账户的个人条目和文件夹复制到当前账户，来源数据会保留。附件需要单独迁移。</p>
    <p className="mt-3 break-all text-sm">导入到：{target?.email}<span className="block text-xs text-[var(--ink-tertiary)]">{target?.serverUrl}</span></p>
    <label className="mt-5 block text-sm">来源账户
      <Select aria-label="来源账户" className="mt-2 w-full" disabled={busy || !accounts.length}
        value={source ? accountKey(source) : ''} onChange={value => { reset(); setSelected(value); }} placeholder="请选择已解锁账户"
        options={accounts.map(account => ({ value: accountKey(account), label: `${account.email} · ${account.serverUrl}` }))} />
    </label>
    {!accounts.length && <p className="mt-3 text-sm text-[var(--ink-tertiary)]">请先添加并解锁另一个账户，再切回此账户进行迁移。</p>}
    {selected && !source && <p role="alert" className="mt-3 text-sm text-[var(--risk)]">来源账户已锁定，请重新解锁并选择。</p>}
    <ImportOptions skipExisting={skipExisting} onChange={setSkipExisting} disabled={busy} />
    {error && <p role="alert" className="mb-4 text-sm text-[var(--risk)]">{error}</p>}
    {busy ? <p role="status" className="text-sm">{writing ? '正在迁移，请稍候…' : '正在读取来源账户…'}</p>
      : result ? <ImportResult result={result} onAgain={reset} onRetry={source ? () => { void perform(true, true); } : undefined} />
      : preview ? <ImportPreviewCard preview={preview} disabled={!source || (preview.total === 0 && preview.folders === 0)}
        onRun={() => { void perform(true); }} onCancel={reset} cancelLabel="重新选择" />
      : <button className="btn btn-primary" disabled={!source} onClick={() => { void perform(false); }}>预览迁移</button>}
  </div>;
}
