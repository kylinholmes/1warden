import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { searchItems, totpCode, hasTotp, type VaultItem, type VaultFolder } from '@coffer/vault';
import type { VaultClient } from '../vault-client';
import { SecretField } from '../components/SecretField';

interface Props {
  client: VaultClient;
  onLock: () => void;
}

type Category = { kind: 'all' } | { kind: 'favorites' } | { kind: 'folder'; id: string };

export function VaultView({ client, onLock }: Props) {
  const session = client.getSession();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>({ kind: 'all' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const items = session.items;
  const folders = session.folders;

  const filtered = useMemo(() => {
    let pool = items;
    if (category.kind === 'favorites') pool = pool.filter((i) => i.favorite);
    else if (category.kind === 'folder') pool = pool.filter((i) => i.folderId === category.id);
    return searchItems(pool, folders, query).map((h) => h.item);
  }, [items, folders, query, category]);

  const selected = filtered.find((i) => i.id === selectedId) ?? null;

  // 每 30 秒重新算一次验证码 —— 只在真的显示了验证码时才跑
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!selected || !hasTotp(selected)) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [selected]);

  // ⌘F 聚焦搜索；⌘L 锁定 —— 键盘优先是安全工具的基本要求
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); searchRef.current?.focus(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'l') { e.preventDefault(); onLock(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onLock]);

  return (
    <div className="flex h-full">
      <Sidebar
        folders={folders}
        category={category}
        onSelect={(c) => { setCategory(c); setSelectedId(null); }}
        counts={{ all: items.length, favorites: items.filter((i) => i.favorite).length }}
        onLock={onLock}
        account={session.account?.email ?? ''}
      />

      <div className="flex w-[320px] shrink-0 flex-col border-r border-[var(--border-subtle)]">
        <div className="border-b border-[var(--border-subtle)] p-3">
          <input
            ref={searchRef}
            type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索…  ⌘F"
            className="w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-1.5 text-[var(--text-sm)] outline-none focus:border-[var(--accent)]"
          />
        </div>

        <ul className="flex-1 overflow-y-auto p-2">
          {filtered.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              selected={item.id === selectedId}
              onClick={() => setSelectedId(item.id)}
            />
          ))}
          {filtered.length === 0 && (
            <li className="px-3 py-8 text-center text-[var(--text-sm)] text-[var(--ink-tertiary)]">
              {query ? '没有匹配的条目' : '这里还是空的'}
            </li>
          )}
        </ul>
      </div>

      <div className="flex-1 overflow-y-auto">
        {selected
          ? <ItemDetail key={selected.id} item={selected} />
          : <EmptyDetail />}
      </div>
    </div>
  );
}

function Sidebar(props: {
  folders: readonly VaultFolder[];
  category: Category;
  onSelect: (c: Category) => void;
  counts: { all: number; favorites: number };
  onLock: () => void;
  account: string;
}) {
  return (
    <nav className="flex w-[190px] shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
      <div className="p-3">
        <div className="px-2 py-1 text-[var(--text-lg)] font-semibold tracking-tight">Coffer</div>
      </div>

      <ul className="flex-1 space-y-0.5 px-2">
        <NavItem
          label="全部" count={props.counts.all}
          active={props.category.kind === 'all'}
          onClick={() => props.onSelect({ kind: 'all' })}
        />
        <NavItem
          label="收藏" count={props.counts.favorites}
          active={props.category.kind === 'favorites'}
          onClick={() => props.onSelect({ kind: 'favorites' })}
        />
        {props.folders.length > 0 && (
          <li className="px-2 pt-4 pb-1 text-[var(--text-xs)] font-medium uppercase tracking-wide text-[var(--ink-tertiary)]">
            文件夹
          </li>
        )}
        {props.folders.map((f) => (
          <NavItem
            key={f.id}
            label={f.nameFailed ? '无法解密' : f.name}
            active={props.category.kind === 'folder' && props.category.id === f.id}
            onClick={() => props.onSelect({ kind: 'folder', id: f.id })}
          />
        ))}
      </ul>

      <div className="border-t border-[var(--border-subtle)] p-2">
        <div className="truncate px-2 py-1 text-[var(--text-xs)] text-[var(--ink-tertiary)]" title={props.account}>
          {props.account}
        </div>
        <button
          onClick={props.onLock}
          className="w-full rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[var(--text-sm)] text-[var(--ink-secondary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)]"
        >
          锁定  ⌘L
        </button>
      </div>
    </nav>
  );
}

function NavItem(props: { label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button
        onClick={props.onClick}
        className={`flex w-full items-center justify-between rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[var(--text-sm)] transition-colors duration-[var(--dur-fast)] ${
          props.active
            ? 'bg-[var(--surface-selected)] font-medium text-[var(--accent)]'
            : 'text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]'
        }`}
      >
        <span className="truncate">{props.label}</span>
        {props.count !== undefined && (
          <span className="ml-2 shrink-0 text-[var(--text-xs)] text-[var(--ink-tertiary)]">{props.count}</span>
        )}
      </button>
    </li>
  );
}

function ItemRow({ item, selected, onClick }: { item: VaultItem; selected: boolean; onClick: () => void }) {
  const subtitle = item.login?.username
    ?? item.login?.uris[0]?.uri
    ?? (item.type === 'secureNote' ? '安全笔记' : '');

  return (
    <li>
      <button
        onClick={onClick}
        className={`flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-left transition-colors duration-[var(--dur-fast)] ${
          selected ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]'
        }`}
      >
        <ItemGlyph type={item.type} favorite={item.favorite} />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[var(--text-md)] ${item.nameFailed ? 'text-[var(--ink-tertiary)] italic' : ''}`}>
            {item.nameFailed ? '无法解密' : item.name}
          </span>
          {subtitle && (
            <span className="block truncate text-[var(--text-xs)] text-[var(--ink-tertiary)]">{subtitle}</span>
          )}
        </span>
      </button>
    </li>
  );
}

/** 类型图标 —— 用字符而不是图片资源，避免引入任何外部资产 */
function ItemGlyph({ type, favorite }: { type: VaultItem['type']; favorite: boolean }) {
  const glyph = type === 'login' ? '🔑'
    : type === 'card' ? '💳'
    : type === 'identity' ? '👤'
    : type === 'secureNote' ? '📝'
    : type === 'sshKey' ? '🔧'
    : '❓';
  return (
    <span className="relative shrink-0 text-[var(--text-lg)]" aria-hidden>
      {glyph}
      {favorite && (
        <span className="absolute -right-1 -top-1 text-[9px] text-[var(--caution)]" title="已收藏">★</span>
      )}
    </span>
  );
}

function EmptyDetail() {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-[var(--text-sm)] text-[var(--ink-tertiary)]">选择左侧的一条记录</p>
    </div>
  );
}

function ItemDetail({ item }: { item: VaultItem }) {
  const [totp, setTotp] = useState<{ code: string; remaining: number; period: number } | null>(null);

  const refreshTotp = useCallback(() => {
    if (!hasTotp(item)) { setTotp(null); return; }
    totpCode(item).then(setTotp).catch(() => setTotp(null));
  }, [item]);

  useEffect(() => {
    refreshTotp();
    const id = setInterval(refreshTotp, 1000);
    return () => clearInterval(id);
  }, [refreshTotp]);

  return (
    <article className="mx-auto max-w-2xl p-8">
      <header className="mb-6 flex items-start gap-4">
        <ItemGlyph type={item.type} favorite={item.favorite} />
        <div className="min-w-0 flex-1">
          <h2 className={`text-[var(--text-xl)] font-semibold tracking-tight ${item.nameFailed ? 'italic text-[var(--ink-tertiary)]' : ''}`}>
            {item.nameFailed ? '无法解密' : item.name}
          </h2>
          <p className="mt-0.5 text-[var(--text-xs)] text-[var(--ink-tertiary)]">
            {TYPE_LABEL[item.type] ?? '未知类型'}
            {item.rawType > 5 && '（此类型较新，暂只支持查看）'}
          </p>
        </div>
      </header>

      {item.login && (
        <Section>
          {item.login.username !== null && <SecretField label="用户名" value={item.login.username} />}
          {item.login.password !== null && <SecretField label="密码" value={item.login.password} masked />}
          {totp && <TotpRow code={totp.code} remaining={totp.remaining} period={totp.period} />}
          {item.login.uris.map((u, i) => (
            <SecretField key={i} label={i === 0 ? '网址' : `网址 ${i + 1}`} value={u.uri} />
          ))}
        </Section>
      )}

      {item.card && (
        <Section>
          {item.card.cardholderName && <SecretField label="持卡人" value={item.card.cardholderName} />}
          {item.card.brand && <SecretField label="卡组织" value={item.card.brand} />}
          {item.card.number && <SecretField label="卡号" value={item.card.number} masked />}
          {item.card.expMonth && <SecretField label="有效期" value={`${item.card.expMonth}/${item.card.expYear ?? ''}`} />}
          {item.card.code && <SecretField label="安全码" value={item.card.code} masked />}
        </Section>
      )}

      {item.identity && (
        <Section>
          {Object.entries(item.identity)
            .filter(([, v]) => v !== null && v !== '')
            .map(([k, v]) => (
              <SecretField key={k} label={IDENTITY_LABEL[k] ?? k} value={v as string} />
            ))}
        </Section>
      )}

      {item.customFields.length > 0 && (
        <Section title="自定义字段">
          {item.customFields.map((f, i) => (
            <SecretField key={i} label={f.name} value={f.value} masked={f.type === 1} />
          ))}
        </Section>
      )}

      {item.notes && (
        <Section title="备注">
          <p className="whitespace-pre-wrap break-words text-[var(--text-md)] leading-relaxed">{item.notes}</p>
        </Section>
      )}

      {item.passwordHistory.length > 0 && (
        <Section title="历史密码">
          {item.passwordHistory.map((h, i) => (
            <SecretField
              key={i}
              label={new Date(h.lastUsedDate).toLocaleDateString('zh-CN')}
              value={h.password} masked
            />
          ))}
        </Section>
      )}
    </article>
  );
}

function TotpRow({ code, remaining, period }: { code: string; remaining: number; period: number }) {
  const pct = Math.max(0, Math.min(1, remaining / period));
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] py-2.5 last:border-0">
      <span className="text-[var(--text-sm)] text-[var(--ink-secondary)]">验证码</span>
      <span className="flex items-center gap-3">
        <span className="secret text-[var(--text-lg)] font-medium tracking-[0.15em]">{code}</span>
        {/* 倒计时环 —— 让用户知道还剩多久，而不是干等着数字变 */}
        <span className="relative grid h-5 w-5 place-items-center" title={`剩余 ${remaining} 秒`}>
          <svg viewBox="0 0 20 20" className="h-5 w-5 -rotate-90">
            <circle cx="10" cy="10" r="8" fill="none" stroke="var(--border-subtle)" strokeWidth="2.5" />
            <circle
              cx="10" cy="10" r="8" fill="none" stroke="var(--accent)" strokeWidth="2.5"
              strokeDasharray={2 * Math.PI * 8}
              strokeDashoffset={2 * Math.PI * 8 * (1 - pct)}
              style={{ transition: 'stroke-dashoffset 1s linear' }}
            />
          </svg>
        </span>
        <CopyButton value={code} />
      </span>
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = {
  login: '登录', secureNote: '安全笔记', card: '信用卡',
  identity: '身份信息', sshKey: 'SSH 密钥', unknown: '未知类型',
};

const IDENTITY_LABEL: Record<string, string> = {
  title: '称谓', firstName: '名', middleName: '中间名', lastName: '姓',
  address1: '地址', address2: '地址 2', address3: '地址 3', city: '城市',
  state: '省/州', postalCode: '邮编', country: '国家', company: '公司',
  email: '邮箱', phone: '电话', ssn: '身份证号', username: '用户名',
  passportNumber: '护照号', licenseNumber: '驾照号',
};

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      {title && <h3 className="mb-2 text-[var(--text-xs)] font-medium uppercase tracking-wide text-[var(--ink-tertiary)]">{title}</h3>}
      <div className="rounded-[var(--radius-lg)] bg-[var(--surface-raised)] px-4 py-1" style={{ boxShadow: 'var(--elev-1)' }}>
        {children}
      </div>
    </section>
  );
}

export { CopyButton };

/** 复制到剪贴板，**N 秒后自动清空**（若期间用户没复制别的东西） */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        setCopied(false);
        // 只有剪贴板里还是我们写进去的东西时才清 —— 否则会清掉用户后来复制的内容
        try {
          const current = await navigator.clipboard.readText();
          if (current === value) await navigator.clipboard.writeText('');
        } catch { /* 读剪贴板可能被拒绝，那就保持原样 */ }
      }, 30_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      onClick={copy}
      title="复制"
      className={`rounded-[var(--radius-sm)] px-2 py-0.5 text-[var(--text-xs)] transition-colors duration-[var(--dur-fast)] ${
        copied ? 'text-[var(--safe)]' : 'text-[var(--ink-tertiary)] hover:bg-[var(--surface-hover)]'
      }`}
    >
      {copied ? '已复制 ✓' : '复制'}
    </button>
  );
}
