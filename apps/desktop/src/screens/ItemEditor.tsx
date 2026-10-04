import { useState, useEffect, useRef } from 'react';
import { generatePassword, passwordStrength } from '@coffer/crypto';
import { writeTotpSecret } from '@coffer/vault';
import type { VaultItem, ItemType, CustomField } from '@coffer/vault';
import type { VaultClient } from '@coffer/vault';
import {
  IconCard, IconCheck, IconChevronDown, IconIdentity, IconKey, IconNote,
  IconPlus, IconSpinner, IconStar, IconTrash,
} from '../components/icons';

interface Props {
  client: VaultClient;
  item: VaultItem | null;      // null = 新建
  onDone: (saved: VaultItem | null) => void;
  onCancel: () => void;
}

/**
 * 新建 / 编辑条目。
 *
 * ── 这一版的两处改动
 *
 * 1. **表单和详情页用同一套骨架。** 左边一列标签、右边一列控件，
 *    分组卡片、分隔线、字号都和详情页一致。于是「填的时候看到的形状」
 *    和「存完之后看到的形状」是同一个 —— 用户不用重新认一遍界面。
 *    上一版编辑器是「标签在上、输入框在下」的全宽堆叠，
 *    和详情页完全是两种排版。
 *
 * 2. **新建时用图标按钮选类型，不用下拉框。** 四种类型是并列的、互斥的、
 *    而且各有各的图标 —— 直接摆出来一眼就能选。下拉框把四个选项藏起来，
 *    对不熟悉这个产品的人（也就是所有人第一次用的时候）是白加一步。
 */
export function ItemEditor({ client, item, onDone, onCancel }: Props) {
  const [draft, setDraft] = useState<VaultItem>(() => item ?? blankItem());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  const isNew = item === null;
  // 文件夹列表从会话里取 —— 编辑期间新建的文件夹看不到，这是可接受的：
  // 用户不会一边编辑一边去侧栏建文件夹
  const folders = client.getSession().folders;
  function patch(p: Partial<VaultItem>) { setDraft((d) => ({ ...d, ...p })); }
  function patchLogin(p: Partial<NonNullable<VaultItem['login']>>) {
    setDraft((d) => ({ ...d, login: { ...(d.login ?? blankLogin()), ...p } }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // 名是必填的 —— 一条没有名字的记录在列表里是一片空白，用户找不回来
      if (draft.name.trim().length === 0) throw new Error('名称不能为空');
      onDone(await client.saveItem(draft));
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="band shrink-0 px-6">
        <h2 className="min-w-0 flex-1 truncate text-[var(--text-lg)] font-semibold">
          {isNew ? '新建条目' : '编辑条目'}
        </h2>
        <button
          type="button"
          onClick={() => patch({ favorite: !draft.favorite })}
          title={draft.favorite ? '取消收藏' : '加入收藏'}
          aria-pressed={draft.favorite}
          className={`rounded-[var(--radius-sm)] p-1.5 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] ${
            draft.favorite ? 'text-[var(--caution)]' : 'text-[var(--ink-tertiary)]'
          }`}
        >
          <IconStar size={16} filled={draft.favorite} />
        </button>
        <button onClick={onCancel} disabled={busy} className="btn btn-quiet">取消</button>
        <button onClick={save} disabled={busy} className="btn btn-primary">
          {busy && <IconSpinner size={14} />}
          {busy ? '保存中…' : '保存'}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-7">
        <div className="mx-auto w-full" style={{ maxWidth: 'var(--detail-w)' }}>
          {error && (
            <p className="mb-5 rounded-[var(--radius-sm)] bg-[var(--surface-well)] px-3 py-2 text-[var(--text-sm)] text-[var(--risk)]">
              {error}
            </p>
          )}

          <Group title={isNew ? '类型' : undefined}>
            {isNew ? (
              <div className="grid grid-cols-4 gap-2 py-3">
                {([
                  ['login', '登录', <IconKey size={17} />],
                  ['secureNote', '安全笔记', <IconNote size={17} />],
                  ['card', '信用卡', <IconCard size={17} />],
                  ['identity', '身份信息', <IconIdentity size={17} />],
                ] as const).map(([t, label, icon]) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(patch, t)}
                    aria-pressed={draft.type === t}
                    className={`flex flex-col items-center gap-1.5 rounded-[var(--radius-md)] border px-2 py-3 text-[var(--text-xs)] transition-colors duration-[var(--dur-fast)] ${
                      draft.type === t
                        ? 'border-[var(--accent)] bg-[var(--accent-tint)] text-[var(--ink-primary)]'
                        : 'border-[var(--border-subtle)] text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]'
                    }`}
                  >
                    <span className={draft.type === t ? 'text-[var(--accent)]' : 'text-[var(--ink-tertiary)]'}>
                      {icon}
                    </span>
                    {label}
                  </button>
                ))}
              </div>
            ) : (
              <Row label="名称">
                <input ref={nameRef} value={draft.name} onChange={(e) => patch({ name: e.target.value })}
                  className="field" placeholder="例如 GitHub" />
              </Row>
            )}
          </Group>

          <Group title="基本信息">
            {isNew && (
              <Row label="名称">
                <input ref={nameRef} value={draft.name} onChange={(e) => patch({ name: e.target.value })}
                  className="field" placeholder="例如 GitHub" />
              </Row>
            )}
            {/*
              ⚠️ 这个选择器此前**根本不存在** —— 于是每个条目创建时 folderId 都是
              null，侧栏那个「文件夹」分区永远不可能有内容。API 层的文件夹 CRUD
              早就写好了，缺的是把它接到界面上。
            */}
            <Row label="文件夹">
              <Select
                value={draft.folderId ?? ''}
                onChange={(v) => patch({ folderId: v === '' ? null : v })}
                options={[{ value: '', label: '（无）' },
                  ...folders.map((f) => ({ value: f.id, label: f.nameFailed ? '无法解密' : f.name }))]}
              />
            </Row>
          </Group>

          {draft.type === 'login' && (
            <Group title="登录">
              <Row label="用户名">
                <input value={draft.login?.username ?? ''} onChange={(e) => patchLogin({ username: e.target.value })}
                  className="field" autoComplete="off" />
              </Row>

              <Row label="密码">
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    <input
                      value={draft.login?.password ?? ''}
                      onChange={(e) => patchLogin({ password: e.target.value })}
                      className="field secret pr-[76px]" autoComplete="off" spellCheck={false}
                    />
                    <button type="button" onClick={() => patchLogin({ password: generatePassword({ length: 20 }) })}
                      title="生成随机密码"
                      className="absolute right-1 top-1/2 -translate-y-1/2 rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-xs)] text-[var(--accent)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--accent-tint)]">
                      生成
                    </button>
                  </div>
                </div>
                <StrengthMeter value={draft.login?.password ?? ''} />
              </Row>

              <Row label="验证码" hint="otpauth:// 链接，或直接填 base32 密钥">
                <input
                  value={draft.login?.totp ?? ''}
                  onChange={(e) => {
                    const { loginTotp, customFields } = writeTotpSecret(draft, e.target.value || null);
                    setDraft((d) => ({
                      ...d,
                      login: { ...(d.login ?? blankLogin()), totp: loginTotp },
                      customFields,
                    }));
                  }}
                  className="field secret" placeholder="otpauth://totp/…" autoComplete="off" />
              </Row>

              <Row label="网址">
                <input
                  value={draft.login?.uris[0]?.uri ?? ''}
                  onChange={(e) => patchLogin({
                    uris: e.target.value ? [{ uri: e.target.value, match: draft.login?.uris[0]?.match ?? null }] : [],
                  })}
                  className="field" placeholder="https://github.com" />
              </Row>
            </Group>
          )}

          {draft.type === 'card' && (
            <Group title="卡片">
              <Row label="持卡人">
                <input value={draft.card?.cardholderName ?? ''} className="field"
                  onChange={(e) => patch({ card: { ...blankCard(), ...draft.card, cardholderName: e.target.value } })} />
              </Row>
              <Row label="卡号">
                <input value={draft.card?.number ?? ''} className="field secret" autoComplete="off"
                  onChange={(e) => patch({ card: { ...blankCard(), ...draft.card, number: e.target.value } })} />
              </Row>
              {/* 有效期和安全码是一组 —— 填的时候也是一起看卡背面，放一行 */}
              <Row label="有效期">
                <div className="grid grid-cols-3 gap-2">
                  <input value={draft.card?.expMonth ?? ''} className="field" inputMode="numeric" placeholder="月"
                    aria-label="月份"
                    onChange={(e) => patch({ card: { ...blankCard(), ...draft.card, expMonth: e.target.value } })} />
                  <input value={draft.card?.expYear ?? ''} className="field" inputMode="numeric" placeholder="年"
                    aria-label="年份"
                    onChange={(e) => patch({ card: { ...blankCard(), ...draft.card, expYear: e.target.value } })} />
                  <input value={draft.card?.code ?? ''} className="field secret" autoComplete="off" placeholder="安全码"
                    aria-label="安全码"
                    onChange={(e) => patch({ card: { ...blankCard(), ...draft.card, code: e.target.value } })} />
                </div>
              </Row>
            </Group>
          )}

          {draft.type === 'identity' && (
            <Group title="身份信息">
              {([['firstName', '名'], ['lastName', '姓'], ['email', '邮箱'],
                ['phone', '电话'], ['company', '公司'], ['ssn', '身份证号']] as const).map(([k, label]) => (
                <Row key={k} label={label}>
                  <input value={(draft.identity?.[k] ?? '') as string} className="field"
                    onChange={(e) => patch({ identity: { ...blankIdentity(), ...draft.identity, [k]: e.target.value } })} />
                </Row>
              ))}
            </Group>
          )}

          <Group title="备注">
            <div className="py-3">
              <textarea value={draft.notes ?? ''} onChange={(e) => patch({ notes: e.target.value })}
                rows={4} aria-label="备注" placeholder="需要记下来的其他事情"
                className="field resize-y leading-[var(--lh-prose)]" />
            </div>
          </Group>

          <Group title="自定义字段">
            <div className="py-3">
              <CustomFields
                fields={draft.customFields}
                onChange={(customFields) => patch({ customFields })}
              />
            </div>
          </Group>
        </div>
      </div>
    </div>
  );
}

/**
 * 分组卡片。
 *
 * `title` 为空时（新建时的「类型」组）只画一个没有标题的卡片 ——
 * 标题栏留白比一个「类型」二字更省事，反正四个按钮自解释。
 */
function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      {title && (
        <h3 className="mb-2 text-[var(--text-xs)] font-medium text-[var(--ink-tertiary)]">{title}</h3>
      )}
      <div className="card px-4">{children}</div>
    </section>
  );
}

/**
 * 一行：标签在左，控件在右。
 *
 * 和详情页的 `SecretField` 用同一个 76px 标签列 —— 编辑态与只读态对齐，
 * 切换时视线不用重新找位置。
 */
function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-[var(--border-subtle)] py-3 last:border-b-0">
      <span className="w-[76px] shrink-0 pt-[9px] text-[var(--text-sm)] text-[var(--ink-tertiary)]">{label}</span>
      <div className="min-w-0 flex-1">
        {children}
        {hint && <span className="mt-1 block text-[var(--text-xs)] text-[var(--ink-tertiary)]">{hint}</span>}
      </div>
    </div>
  );
}

/** 原生下拉框的箭头又大又靠边 —— 关掉它，自己画一个 */
function Select({ value, onChange, options }: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="field appearance-none pr-9"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <IconChevronDown size={15}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--ink-tertiary)]" />
    </div>
  );
}

/**
 * 强度条。
 *
 * ⚠️ 这是**输入时**的即时反馈，用的是字符类熵 —— 够用，但它会把
 * `P@ssw0rd1!` 算得偏高。真正用于「弱密码报告」的判定必须是词典式的
 * （见 @coffer/vault 的 health 模块），否则字典密码会被报成安全。
 */
function StrengthMeter({ value }: { value: string }) {
  if (value.length === 0) return null;
  const { score, entropyBits } = passwordStrength(value);
  const labels = ['很弱', '弱', '一般', '强', '很强'];
  const colors = ['var(--risk)', 'var(--risk)', 'var(--caution)', 'var(--safe)', 'var(--safe)'];

  return (
    <span className="mt-2 flex items-center gap-2.5">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="h-1 w-7 rounded-full transition-colors duration-[var(--dur-base)]"
            style={{ background: i <= score ? colors[score] : 'var(--border-subtle)' }} />
        ))}
      </span>
      <span className="text-[var(--text-xs)] tabular-nums text-[var(--ink-tertiary)]">
        {labels[score]} · 约 {Math.round(entropyBits)} 位熵
      </span>
    </span>
  );
}

function CustomFields({ fields, onChange }: { fields: CustomField[]; onChange: (f: CustomField[]) => void }) {
  return (
    <div className="space-y-2">
      {fields.map((f, i) => (
        <div key={i} className="flex gap-2">
          <input
            value={f.name} placeholder="名称" aria-label="字段名称"
            onChange={(e) => onChange(fields.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            className="field w-1/3"
          />
          <input
            value={f.value} placeholder="值" aria-label="字段值"
            type={f.type === 1 ? 'password' : 'text'}
            onChange={(e) => onChange(fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            className="field secret"
          />
          <div className="relative w-[92px] shrink-0">
            <select
              value={f.type}
              onChange={(e) => onChange(fields.map((x, j) => (j === i ? { ...x, type: Number(e.target.value) as 0 | 1 | 2 | 3 } : x)))}
              className="field appearance-none pr-7"
              title="字段类型" aria-label="字段类型"
            >
              {/* ⚠️ 只发 0–3。服务端在 type 缺失或不可解析时回退到 1（隐藏） */}
              <option value={0}>文本</option>
              <option value={1}>隐藏</option>
              <option value={2}>开关</option>
              <option value={3}>关联</option>
            </select>
            <IconChevronDown size={14}
              className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--ink-tertiary)]" />
          </div>
          <button type="button" onClick={() => onChange(fields.filter((_, j) => j !== i))}
            title="删除此字段" aria-label="删除此字段"
            className="shrink-0 rounded-[var(--radius-sm)] px-2 text-[var(--ink-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] hover:text-[var(--risk)]">
            <IconTrash size={15} />
          </button>
        </div>
      ))}
      <button type="button"
        onClick={() => onChange([...fields, { name: '', value: '', type: 0, linkedId: null }])}
        className="btn btn-quiet gap-1.5">
        <IconPlus size={13} />
        添加字段
      </button>
    </div>
  );
}

// ── 空白模板 ──

function blankLogin() {
  return { username: null, password: null, totp: null, uris: [], passwordRevisionDate: null };
}
function blankCard() {
  return { cardholderName: null, brand: null, number: null, expMonth: null, expYear: null, code: null };
}
function blankIdentity() {
  return {
    title: null, firstName: null, middleName: null, lastName: null,
    address1: null, address2: null, address3: null, city: null, state: null,
    postalCode: null, country: null, company: null, email: null, phone: null,
    ssn: null, username: null, passportNumber: null, licenseNumber: null,
  };
}

function blankItem(): VaultItem {
  return {
    id: '', type: 'login', rawType: 1, name: '', nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, hasItemKey: false,
    login: blankLogin(), card: null, identity: null, secureNote: null,
    customFields: [], passwordHistory: [], attachments: [],
  };
}

function setType(patch: (p: Partial<VaultItem>) => void, type: ItemType) {
  const rawType = { login: 1, secureNote: 2, card: 3, identity: 4, sshKey: 5, unknown: -1 }[type];
  patch({
    type, rawType,
    login: type === 'login' ? blankLogin() : null,
    card: type === 'card' ? blankCard() : null,
    identity: type === 'identity' ? blankIdentity() : null,
    secureNote: type === 'secureNote' ? { type: 0 } : null,
  });
}

function messageOf(err: unknown): string {
  const kind = (err as { kind?: string } | null)?.kind;
  switch (kind) {
    case 'network': return '连不上服务器，改动尚未保存';
    case 'auth': return '登录已过期，请重新解锁';
    case 'conflict': return '这条记录在别处被修改过，请重新同步后再改';
    default: return err instanceof Error ? err.message : '保存失败';
  }
}

void IconCheck;
