import { ext } from '../ext-api';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { generatePassword, passwordStrength } from '@coffer/crypto';
import { IconStore } from '@coffer/vault';
import { iconStoreFor } from '../icon-store';
import {
  IconAlert, IconCheck, IconCopy, IconGlobe, IconGlyph, IconKey, IconLock, IconSearch, IconStar,
} from '@coffer/ui';

/**
 * 扩展弹窗。
 *
 * 三种状态：未登录 / 已解锁但本站没有匹配条目 / 已解锁且匹配到了。
 * 无论哪种，用户最多两次点击就能拿到密码 —— 密码管理器弹窗的全部意义
 * 就是「别让我离开当前页面去做别的事」。
 *
 * ── 版面
 *
 * 360px 宽的一条，所以只做**一栏**：顶部一条 `.band` 放品牌和锁定，
 * 下面依次是提示、待确认的保存、当前站点、匹配到的条目、生成器。
 * 顺序就是优先级 —— 需要用户做决定的（保存 / 填充）排在上面，
 * 浏览性的（生成器）排在最后。
 */

interface ItemSummary {
  id: string;
  name: string;
  username: string | null;
  hasPassword: boolean;
  hasTotp: boolean;
  uris: string[];
  favorite: boolean;

  /*
   * ── 显示用的字段 ──
   *
   * ⚠️ 和桌面端的快速面板同一个做法：弹窗**拿不到 `VaultItem`**
   * （它只从 background 收摘要），所以 `summaryOf` / `avatarOf` 那套规则
   * 在 background 那边算好、随摘要过来。不这样做的话规则要在两处各写一遍。
   */
  type: string;
  summary: string | null;
  iconDomain: string | null;
  avatarText: string;
  avatarHue: number;
}

interface Status {
  unlocked: boolean;
  account: { email: string; serverUrl: string } | null;
  itemCount: number;
}

/**
 * 待确认的「保存 / 更新」。
 *
 * ⚠️ **不含密码** —— background 只回展示需要的字段，明文在保存那一刻
 * 才由 background 自己取用。弹窗没有任何理由看到它。
 */
interface Pending {
  url: string;
  username: string | null;
  action: 'save' | 'update';
  itemId: string | null;
}

/** 与 background 约定的调用方式 */
async function send<T>(msg: Record<string, unknown>): Promise<T> {
  const res = await ext.runtime.sendMessage(msg) as T & { error?: string };
  if (res && typeof res === 'object' && 'error' in res && res.error) throw new Error(res.error);
  return res;
}

export function Popup() {
  const [status, setStatus] = useState<Status | null>(null);
  const [items, setItems] = useState<ItemSummary[]>([]);
  /*
   * 站点图标的缓存。
   *
   * 弹窗自己有 host_permissions（匹配所有 http/https），所以**可以直接
   * fetch** 服务端的图标接口 —— 不用绕 background。桌面端那边不行
   * （跨源被 CORS 拦），它得走 Rust。这是两边唯一的分歧点。
   *
   * 和桌面端一样是**模块级单例**：弹窗每次打开都重建的话缓存等于没有，
   * 而服务端首次抓一个图标要 1.5 秒。
   */
  const icons = useMemo(() => {
    const url = status?.account?.serverUrl;
    if (!url) return null;
    return iconStoreFor(url, async (u) => {
      const r = await fetch(u);
      if (!r.ok) return null;
      return new Uint8Array(await r.arrayBuffer());
    });
  }, [status?.account?.serverUrl]);
  const [tabUrl, setTabUrl] = useState('');
  const [tabId, setTabId] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const refresh = useCallback(async () => {
    const tabs = await ext.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    setTabUrl(tab?.url ?? '');
    setTabId(tab?.id);

    const st = await send<Status>({ type: 'coffer:status' });
    setStatus(st);
    if (!st.unlocked || !tab?.url) { setItems([]); setPending(null); return; }

    const { pending: p } = await send<{ pending: Pending | null }>({
      type: 'coffer:pending', ...(tab.id === undefined ? {} : { tabId: tab.id }),
    });
    setPending(p);

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
    return (
      <div className="flex flex-col">
        <PopupBand />
        <p className="p-4 text-[var(--text-sm)] text-[var(--ink-tertiary)]">正在载入…</p>
      </div>
    );
  }

  return (
    <div className="screen-in flex flex-col">
      <PopupBand unlocked={status.unlocked} onLock={async () => {
        await send({ type: 'coffer:lock' });
        await refresh();
      }} />

      <div className="flex flex-col gap-3 p-3.5">
        {error && <Note tone="risk">{error}</Note>}
        {notice && <Note tone="accent">{notice}</Note>}

        {status.unlocked && pending && (
          <SavePrompt
            pending={pending}
            busy={busy}
            onSave={async () => {
              setBusy(true); setError(null);
              try {
                await send({ type: 'coffer:save-capture', ...(tabId === undefined ? {} : { tabId }) });
                setPending(null);
                setNotice(pending.action === 'update' ? '已更新' : '已保存');
                window.close();
              } catch (e) {
                setError(e instanceof Error ? e.message : '保存失败');
              } finally { setBusy(false); }
            }}
            onDismiss={async () => {
              await send({ type: 'coffer:dismiss-capture', ...(tabId === undefined ? {} : { tabId }) });
              setPending(null);
            }}
          />
        )}

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
            <SiteLine url={tabUrl} account={status.account?.email ?? null} />
            {items.length === 0
              ? <Empty reason={tabUrl ? '这个站点没有匹配的条目' : '当前标签页不是网页'} />
              : items.map((it) => (
                <ItemRow key={it.id} item={it} icons={icons} onFill={async () => {
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
    </div>
  );
}

/** 顶部带子 —— 和其他界面同一条高度，弹窗里也保持这个骨架 */
function PopupBand({ unlocked, onLock }: { unlocked?: boolean; onLock?: () => void }) {
  return (
    <header className="band">
      <span className="grid h-[22px] w-[22px] place-items-center rounded-[7px] bg-[var(--accent)] text-[var(--accent-ink)]">
        <IconLock size={13} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[var(--text-lg)] font-semibold tracking-[-0.01em]">
        Coffer
      </span>
      {unlocked && onLock && (
        <button onClick={onLock} className="btn btn-ghost gap-1.5" title="锁定保险库">
          <IconLock size={13} />
          锁定
        </button>
      )}
    </header>
  );
}

/**
 * 「要保存这条登录吗？」
 *
 * 放在最上面 —— 它是当前唯一需要用户做决定的东西。列表只是备选。
 * 措辞上明确说出是**哪个账号**：用户在同一个站点可能有多个账号，
 * 一句笼统的「保存密码？」会让他不知道该不该点。
 */
function SavePrompt({ pending, busy, onSave, onDismiss }: {
  pending: Pending;
  busy: boolean;
  onSave: () => void;
  onDismiss: () => void;
}) {
  let host = pending.url;
  try { host = new URL(pending.url).host; } catch { /* 原样显示 */ }

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--accent)] bg-[var(--accent-tint)] p-3">
      <p className="text-[var(--text-sm)] font-medium">
        {pending.action === 'update' ? '更新这条登录？' : '保存这条登录？'}
      </p>
      <p className="mt-0.5 truncate text-[var(--text-xs)] text-[var(--ink-secondary)]" title={pending.url}>
        {host}
        {pending.username ? ` · ${pending.username}` : ''}
      </p>
      <div className="mt-3 flex gap-2">
        <button onClick={onSave} disabled={busy} className="btn btn-primary flex-1 py-2">
          {busy ? '保存中…' : pending.action === 'update' ? '更新' : '保存'}
        </button>
        <button onClick={onDismiss} disabled={busy} className="btn btn-quiet py-2">不用</button>
      </div>
    </div>
  );
}

/** 当前站点 + 是哪个账户 —— 两个都要说，用户可能在多个账户间开着同一个站点 */
function SiteLine({ url, account }: { url: string; account: string | null }) {
  let host = url;
  try { host = new URL(url).host; } catch { /* 不是网址就原样显示 */ }
  return (
    <div className="flex items-center gap-2 px-0.5">
      <IconGlobe size={13} className="shrink-0 text-[var(--ink-tertiary)]" />
      <span className="min-w-0 flex-1 truncate text-[var(--text-xs)] text-[var(--ink-secondary)]" title={url}>
        {host || '（无站点）'}
      </span>
      {account && (
        <span className="min-w-0 max-w-[45%] shrink-0 truncate text-[var(--text-xs)] text-[var(--ink-tertiary)]" title={account}>
          {account}
        </span>
      )}
    </div>
  );
}

/**
 * 一条匹配到的记录。
 *
 * 主力动作是**填充**，但 1Password 扩展里用得最多的其实是**复制** ——
 * 用户常常是「复制密码 → 去别处粘贴」，而不是在网页表单里填。
 * 所以两者都得在，而且复制要够快（一次点击，不用展开菜单）。
 */
function ItemRow({ item, icons, onFill }: { item: ItemSummary; icons: IconStore | null; onFill: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function copy(field: 'username' | 'password' | 'totp') {
    setError(null);
    try {
      // background 取出明文并安排好「30 秒后清理」，值回到这里由我们写剪贴板。
      // 写在这里而不是 background：弹窗有用户手势，而且写失败时能当场报错 ——
      // 放到离屏文档里写就没人能告诉用户「这次没复制上」。
      const { value } = await send<{ value: string }>({ type: 'coffer:copy', itemId: item.id, field });
      await navigator.clipboard.writeText(value);
      setCopied(field);
      setTimeout(() => setCopied(null), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : '复制失败');
    }
  }

  const fields: { key: 'username' | 'password' | 'totp'; label: string }[] = [];
  if (item.username) fields.push({ key: 'username', label: '用户名' });
  if (item.hasPassword) fields.push({ key: 'password', label: '密码' });
  if (item.hasTotp) fields.push({ key: 'totp', label: '验证码' });

  return (
    <div className="card p-2.5">
      <div className="flex items-center gap-2.5">
        <IconGlyph
          domain={item.iconDomain}
          text={item.avatarText}
          hue={item.avatarHue}
          type={item.type}
          store={icons}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-[var(--text-md)] leading-snug">{item.name}</span>
            {item.favorite && <IconStar size={12} filled className="shrink-0 text-[var(--caution)]" />}
          </span>
          {item.username && (
            <span className="mt-0.5 block truncate text-[var(--text-xs)] leading-snug text-[var(--ink-tertiary)]">
              {item.username}
            </span>
          )}
        </span>
        {item.hasPassword && (
          <button onClick={onFill} className="btn btn-primary shrink-0">填充</button>
        )}
      </div>

      {fields.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1 border-t border-[var(--border-subtle)] pt-2">
          {fields.map((f) => (
            <button key={f.key} onClick={() => { void copy(f.key); }}
              data-state={copied === f.key ? 'ok' : undefined}
              className="btn btn-ghost gap-1.5">
              {copied === f.key ? <IconCheck size={12} /> : <IconCopy size={12} />}
              {copied === f.key ? '已复制' : `复制${f.label}`}
            </button>
          ))}
          {/* 复制后会清空剪贴板，把这件事说出来 —— 否则用户过一会儿粘贴不出来
              会以为是坏了 */}
          <span className="ml-auto shrink-0 pr-1 text-[var(--text-2xs)] text-[var(--ink-tertiary)]">
            30 秒后清空
          </span>
        </div>
      )}

      {error && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[var(--text-xs)] text-[var(--risk)]">
          <IconAlert size={12} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

/** 空状态要说明**为什么**空，并给出下一步 —— 一句「没有结果」等于没说 */
function Empty({ reason }: { reason: string }) {
  return (
    <div className="card-well px-4 py-7 text-center">
      <span className="mx-auto mb-2.5 grid h-9 w-9 place-items-center rounded-full bg-[var(--surface-paper)] text-[var(--ink-tertiary)]">
        <IconSearch size={17} />
      </span>
      <p className="text-[var(--text-sm)] text-[var(--ink-secondary)]">{reason}</p>
      <p className="mt-1 text-[var(--text-xs)] text-[var(--ink-tertiary)]">
        在 Coffer 里把网址加到对应条目上，这里就能匹配到
      </p>
    </div>
  );
}

function Note({ tone, children }: { tone: 'risk' | 'accent'; children: React.ReactNode }) {
  const color = tone === 'risk' ? 'var(--risk)' : 'var(--ink-secondary)';
  return (
    <p className="flex items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-well)] px-3 py-2 text-[var(--text-sm)]"
      role="status">
      {tone === 'risk' && <IconAlert size={14} className="mt-0.5 shrink-0" style={{ color }} />}
      <span className="min-w-0 flex-1" style={{ color }}>{children}</span>
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
    <form className="flex flex-col gap-2.5" onSubmit={(e) => {
      e.preventDefault();
      onSubmit({ serverUrl: serverUrl.trim(), email: email.trim(), masterPassword });
    }}>
      <p className="text-[var(--text-xs)] leading-relaxed text-[var(--ink-tertiary)]">
        主密码只在本地用于派生密钥，永不发送到服务器。
      </p>
      <input required type="url" value={serverUrl} placeholder="https://vault.example.com"
        aria-label="服务器地址"
        onChange={(e) => setServerUrl(e.target.value)}
        className="field text-[var(--text-sm)]" />
      <input required type="email" value={email} placeholder="邮箱"
        aria-label="邮箱"
        onChange={(e) => setEmail(e.target.value)}
        className="field text-[var(--text-sm)]" />
      <input required type="password" value={masterPassword} placeholder="主密码"
        aria-label="主密码"
        onChange={(e) => setMasterPassword(e.target.value)}
        className="field secret text-[var(--text-sm)]" />
      <button type="submit" disabled={busy} className="btn btn-primary py-2.5">
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
    <div className="card p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[var(--text-xs)] font-medium text-[var(--ink-tertiary)]">
          生成密码
        </span>
        <button onClick={() => setValue(generatePassword({ length, digits, symbols }))}
          className="btn btn-ghost shrink-0">换一个</button>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <code className="secret min-w-0 flex-1 truncate rounded-[var(--radius-sm)] bg-[var(--surface-well)] px-2 py-1.5 text-[var(--text-sm)]">
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
          data-state={copied ? 'ok' : undefined}
          className="btn btn-quiet shrink-0 gap-1.5 text-[var(--accent)]"
        >
          {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>

      <label className="mt-2.5 flex items-center gap-2 text-[var(--text-xs)] text-[var(--ink-secondary)]">
        长度
        <input type="range" min={8} max={64} value={length}
          onChange={(e) => setLength(Number(e.target.value))} className="flex-1" />
        <span className="tnum w-6 text-right">{length}</span>
      </label>
      <div className="mt-1.5 flex gap-4 text-[var(--text-xs)] text-[var(--ink-secondary)]">
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
        <div className="mt-2.5 flex items-center gap-2.5">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--border-subtle)]">
            <div className="h-full rounded-full transition-[width] duration-[var(--dur-base)]" style={{
              width: `${Math.min(100, (strength.score / 4) * 100)}%`,
              background: strength.score >= 3 ? 'var(--safe)' : strength.score >= 2 ? 'var(--caution)' : 'var(--risk)',
            }} />
          </div>
          <span className="shrink-0 text-[var(--text-2xs)] tabular-nums text-[var(--ink-tertiary)]">
            约 {Math.round(strength.entropyBits)} 位熵
          </span>
        </div>
      )}
    </div>
  );
}

/* 图标从 `@coffer/ui` 来 —— 和桌面端**同一份**。
 *
 * 这里原本有一份自己的拷贝，上面写着「两个 app 之间没有共享包，
 * 为一个图标集建一个不划算」。现在有了，而那份拷贝已经开始长歪：
 * 它的大小默认值是 14 而桌面端是 16；它不接受 `className`，
 * 于是弹窗里四处 `className=` 一直是**类型错误** ——
 * 只是从来没人在扩展端跑过 `tsc`（见根 tsconfig 的说明）。
 *
 * 「同一套画法写两遍」和「写一份」的差别，就在这几处。
 */
