import { useLocalStore, useStoreField } from '@1warden/state/react';
import { Select } from '@1warden/ui';
import type { ExportFormat } from '@1warden/vault';
import type { ApplicationClient } from '../application/types';
import { useTransferLifetime } from './transfer-lifetime';

export function ExportPanel({ client, onBusyChange }: {
  client: ApplicationClient; onBusyChange: (busy: boolean) => void;
}) {
  const store = useLocalStore(() => ({ format: 'encrypted-json' as ExportFormat, password: '', confirmation: '',
    busy: false, error: null as string | null, message: null as string | null, warnings: [] as string[] }));
  const [format, setFormat] = useStoreField(store, 'format');
  const [password, setPassword] = useStoreField(store, 'password');
  const [confirmation, setConfirmation] = useStoreField(store, 'confirmation');
  const [busy, setBusy] = useStoreField(store, 'busy');
  const [error, setError] = useStoreField(store, 'error');
  const [message, setMessage] = useStoreField(store, 'message');
  const [warnings, setWarnings] = useStoreField(store, 'warnings');
  const request = useTransferLifetime(client);
  async function run() {
    if (store.getState().busy) return;
    setError(null); setMessage(null); setWarnings([]);
    if (format === 'encrypted-json') {
      if (password.length < 12) { setError('导出密码至少需要 12 个字符'); return; }
      if (password !== confirmation) { setError('两次输入的导出密码不一致'); return; }
    }
    const current = ++request.current;
    setBusy(true); onBusyChange(true);
    try {
      const file = await client.exportVault({ format, ...(format === 'encrypted-json' ? { password } : {}) });
      if (current !== request.current) return;
      setPassword(''); setConfirmation(''); setWarnings(file.warnings);
      const saved = await client.saveFile(file.fileName, file.dataBase64);
      if (current !== request.current) return;
      setMessage(saved.path === null ? '已取消保存，未导出文件' : `已导出 ${file.itemCount} 条记录 · ${file.fileName}`);
    } catch (e) {
      if (current === request.current) setError(e instanceof Error ? e.message : '导出失败，请重试');
    } finally {
      if (current === request.current) { setBusy(false); onBusyChange(false); }
    }
  }
  return <form className="space-y-5" onSubmit={event => { event.preventDefault(); void run(); }}>
    <p className="text-sm leading-[var(--lh-prose)] text-[var(--ink-secondary)]">
      导出当前账户的个人保险库，兼容 Bitwarden / Vaultwarden。回收站、组织条目和附件文件不包含在内。
    </p>
    <div>
      <label htmlFor="export-format" className="mb-1.5 block text-xs text-[var(--ink-secondary)]">文件格式</label>
      <Select id="export-format" value={format} disabled={busy} onChange={value => {
        setFormat(value as ExportFormat); setPassword(''); setConfirmation(''); setError(null); setMessage(null); setWarnings([]);
      }} options={[{ value: 'encrypted-json', label: '加密 JSON（推荐）' }, { value: 'json', label: 'JSON（明文）' }, { value: 'csv', label: 'CSV（明文）' }]} />
    </div>
    {format === 'encrypted-json' ? <>
      <p className="text-sm text-[var(--ink-secondary)]">设置独立的导出密码。重新导入时需要此密码，请妥善保管。</p>
      <label className="block text-sm">导出密码<input aria-label="导出密码" type="password" autoComplete="new-password"
        disabled={busy} value={password} onChange={event => setPassword(event.target.value)} className="field secret mt-1.5" /></label>
      <label className="block text-sm">确认导出密码<input aria-label="确认导出密码" type="password" autoComplete="new-password"
        disabled={busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} className="field secret mt-1.5" /></label>
    </> : <p className="rounded-[var(--radius-sm)] bg-[var(--surface-well)] p-3 text-sm text-[var(--risk)]">
      此文件包含明文密码和其他敏感信息，任何拿到文件的人都能读取。请存放在安全的位置。
    </p>}
    {format === 'csv' && <p className="text-sm text-[var(--ink-secondary)]">
      CSV 仅包含登录和安全笔记；通行密钥、密码历史、网址匹配规则等信息会被省略。完整备份请选择 JSON。
    </p>}
    {!client.capabilities.saveAttachments && <p role="alert" className="text-sm text-[var(--risk)]">当前环境不支持保存文件，请在桌面端或浏览器扩展中导出。</p>}
    {error && <p role="alert" className="text-sm text-[var(--risk)]">{error}</p>}
    {warnings.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--ink-secondary)]">{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
    {message && <p role="status" className="text-sm text-[var(--ink-secondary)]">{message}</p>}
    <button type="submit" className="btn btn-primary" disabled={busy || !client.capabilities.saveAttachments}>{busy ? '正在导出…' : '导出文件'}</button>
  </form>;
}
