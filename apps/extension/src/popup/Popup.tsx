import { useCallback, useEffect, useState } from 'react';
import { generatePassword, passwordStrength } from '@coffer/crypto';

/**
 * 扩展弹窗。
 *
 * 三种状态：未登录 / 已解锁但本站没有匹配条目 / 已解锁且匹配到了。
 * 无论哪种，用户最多两次点击就能拿到密码 —— 密码管理器弹窗的全部意义
 * 就是「别让我离开当前页面去做别的事」。
 */

interface ItemSummary {
  id: string;
  name: string;
  username: string | null;
  hasPassword: boolean;
  uris: string[];
  favorite: boolean;
}

interface Status {
  unlocked: boolean;
  account: { email: string; serverUrl: string } | null;
  itemCount: number;
}

/** 与 background 约定的调用方式 */
async function send<T>(msg: Record<string, unknown>): Promise<T> {
  const res = await chrome.runtime.sendMessage(msg) as T & { error?: string };
  if (res && typeof res === 'object' && 'error' in res && res.error) throw new Error(res.error);
  return res;
}

export function Popup() {
  const [status, setStatus] = useState<Status | null>(null);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [tabUrl, setTabUrl] = useState('');
  const [tabId, setTabId] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    setTabUrl(tab?.url ?? '');
    setTabId(tab?.id);

    const st = await send<Status>({ type: 'coffer:status' });
    setStatus(st);
    if (!st.unlocked || !tab?.url) { setItems([]); return; }

    // ⚠️ 匹配交给 background 做：它手里是**完整的**条目（含每个网址的
    // `match` 类型），而列表接口刻意只回摘要。把匹配放在这边就得先把
    // 完整 uris 送过来，那等于为了省一次消息把攻击面扩大一圈。
    const { items: matched } = await send<{ items: ItemSummary[] }>({
      type: 'coffer:matches', url: tab.url,
    });
    setItems(matched);
  }, []);

  useEffect(() => { void refresh().catch((e: unknown) => setError(String(e))); }, [refresh]);

  if (status === null) {
    return <div className="p-6 text-[var(--text-sm)] text-[var(--ink-tertiary)]">正在载入…</div>;
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <Header status={status} onLock={async () => {
        await send({ type: 'coffer:lock' });
        await refresh();
      }} />

      {error && <Note tone="risk">{error}</Note>}
      {notice && <Note tone="accent">{notice}</Note>}

      {!status.unlocked ? (
        <ConnectForm busy={busy} onSubmit={async (p) => {
          setBusy(true); setError(null);
          try {
            await send({ type: 'coffer:connect', ...p });
            await refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : '连接失败');
          } finally { setBusy(false); }
        }} />
      ) : (
        <>
          <SiteLine url={tabUrl} />
          {items.length === 0
            ? <Empty reason={tabUrl ? '这个站点没有匹配的条目' : '当前标签页不是网页'} />
            : items.map((it) => (
              <ItemRow key={it.id} item={it} onFill={async () => {
                if (tabId === undefined) return;
                setBusy(true); setError(null); setNotice(null);
                try {
                  const r = await send<{ ok: boolean; failed: unknown[] }>({
                    type: 'coffer:fill', itemId: it.id, tabId,
                  });
                  if (r.ok) { setNotice('已填充'); window.close(); }
                  else setError(`有 ${r.failed.length} 个字段没填成功 —— 页面可能改版了`);
                } catch (e) {
                  setError(e instanceof Error ? e.message : '填充失败');
                } finally { setBusy(false); }
              }} />
            ))}
          <Generator />
        </>
      )}
    </div>
  );
}

function Header({ status, onLock }: { status: Status; onLock: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[var(--text-lg)] font-semibold tracking-tight">Coffer</span>
      {status.unlocked && (
        <button onClick={onLock}
          className="rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-xs)] text-[var(--ink-tertiary)] hover:bg-[var(--surface-hover)]">
          锁定
        </button>
      )}
    </div>
  );
}

function SiteLine({ url }: { url: string }) {
  let host = url;
  try { host = new URL(url).host; } catch { /* 不是网址就原样显示 */ }
  return (
    <div className="truncate text-[var(--text-xs)] text-[var(--ink-tertiary)]" title={url}>
      {host || '（无站点）'}
    </div>
  );
}

function ItemRow({ item, onFill }: { item: ItemSummary; onFill: () => void }) {
  return (
    <button
      onClick={onFill}
      className="flex w-full items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 text-left transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)]"
    >
      <span className="shrink-0 text-[var(--text-lg)]" aria-hidden>{item.favorite ? '★' : '🔑'}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[var(--text-md)]">{item.name}</span>
        {item.username && (
          <span className="block truncate text-[var(--text-xs)] text-[var(--ink-tertiary)]">{item.username}</span>
        )}
      </span>
      {/* 没有密码的条目点进去也没得填，直接说明白，别让用户白点一次 */}
      <span className="shrink-0 text-[var(--text-xs)] text-[var(--accent)]">
        {item.hasPassword ? '填充' : '无密码'}
      </span>
    </button>
  );
}

function Empty({ reason }: { reason: string }) {
  return (
    <div className="rounded-[var(--radius-md)] bg-[var(--surface-sunken)] px-3 py-6 text-center text-[var(--text-sm)] text-[var(--ink-tertiary)]">
      {reason}
    </div>
  );
}

function Note({ tone, children }: { tone: 'risk' | 'accent'; children: React.ReactNode }) {
  const color = tone === 'risk' ? 'var(--risk)' : 'var(--accent)';
  return (
    <p className="rounded-[var(--radius-md)] bg-[var(--surface-sunken)] px-3 py-2 text-[var(--text-sm)]"
      style={{ color }}>
      {children}
    </p>
  );
}

function ConnectForm({ busy, onSubmit }: {
  busy: boolean;
  onSubmit: (p: { serverUrl: string; email: string; masterPassword: string }) => void;
}) {
  const [serverUrl, setServerUrl] = useState('');
  const [email, setEmail] = useState('');
  const [masterPassword, setMasterPassword] = useState('');

  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => {
      e.preventDefault();
      onSubmit({ serverUrl: serverUrl.trim(), email: email.trim(), masterPassword });
    }}>
      <p className="text-[var(--text-xs)] text-[var(--ink-tertiary)]">
        主密码只在本地用于派生密钥，永不发送到服务器。
      </p>
      <input required type="url" value={serverUrl} placeholder="https://vault.example.com"
        onChange={(e) => setServerUrl(e.target.value)}
        className={inputCls} />
      <input required type="email" value={email} placeholder="邮箱"
        onChange={(e) => setEmail(e.target.value)}
        className={inputCls} />
      <input required type="password" value={masterPassword} placeholder="主密码"
        onChange={(e) => setMasterPassword(e.target.value)}
        className={`${inputCls} secret`} />
      <button type="submit" disabled={busy}
        className="rounded-[var(--radius-md)] bg-[var(--accent)] px-3 py-2 font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-hover)] disabled:opacity-50">
        {busy ? '正在解锁…' : '解锁'}
      </button>
    </form>
  );
}

/** 生成器默认只暴露三项 —— 与 1Password 一致，其余收起来 */
function Generator() {
  const [length, setLength] = useState(20);
  const [digits, setDigits] = useState(true);
  const [symbols, setSymbols] = useState(true);
  const [value, setValue] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setValue(generatePassword({ length, digits, symbols }));
    setCopied(false);
  }, [length, digits, symbols]);

  const strength = value ? passwordStrength(value) : null;

  return (
    <div className="mt-1 rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[var(--text-xs)] font-medium uppercase tracking-wide text-[var(--ink-tertiary)]">
          生成密码
        </span>
        <button onClick={() => setValue(generatePassword({ length, digits, symbols }))}
          className="text-[var(--text-xs)] text-[var(--accent)] hover:underline">换一个</button>
      </div>

      <div className="mb-2 flex items-center gap-2">
        <code className="secret min-w-0 flex-1 truncate rounded-[var(--radius-sm)] bg-[var(--surface-sunken)] px-2 py-1.5 text-[var(--text-sm)]">
          {value}
        </code>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            // 30 秒后清空剪贴板，且只在内容仍是我们的东西时才清
            setTimeout(async () => {
              try {
                if (await navigator.clipboard.readText() === value) {
                  await navigator.clipboard.writeText('');
                }
              } catch { /* 读剪贴板可能被拒绝 */ }
            }, 30_000);
          }}
          className="shrink-0 rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-xs)] text-[var(--accent)] hover:bg-[var(--surface-hover)]">
          {copied ? '已复制 ✓' : '复制'}
        </button>
      </div>

      <label className="mb-1 flex items-center gap-2 text-[var(--text-xs)] text-[var(--ink-secondary)]">
        长度
        <input type="range" min={8} max={64} value={length}
          onChange={(e) => setLength(Number(e.target.value))} className="flex-1" />
        <span className="secret w-6 text-right">{length}</span>
      </label>
      <div className="flex gap-4 text-[var(--text-xs)] text-[var(--ink-secondary)]">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={digits} onChange={(e) => setDigits(e.target.checked)} />
          包含数字
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={symbols} onChange={(e) => setSymbols(e.target.checked)} />
          包含符号
        </label>
      </div>

      {strength && (
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
            <div className="h-full rounded-full" style={{
              width: `${Math.min(100, (strength.score / 4) * 100)}%`,
              background: strength.score >= 3 ? 'var(--safe)' : strength.score >= 2 ? 'var(--caution)' : 'var(--risk)',
            }} />
          </div>
          <span className="text-[var(--text-xs)] text-[var(--ink-tertiary)]">
            约 {Math.round(strength.entropyBits)} 位熵
          </span>
        </div>
      )}
    </div>
  );
}

const inputCls = 'w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2.5 py-1.5 text-[var(--text-sm)] outline-none focus:border-[var(--accent)]';
