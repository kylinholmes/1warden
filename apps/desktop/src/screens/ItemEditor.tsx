import { useState, useEffect, useRef } from 'react';
import { generatePassword, passwordStrength } from '@coffer/crypto';
import { writeTotpSecret } from '@coffer/vault';
import type { VaultItem, ItemType, CustomField } from '@coffer/vault';
import type { VaultClient } from '../vault-client';

interface Props {
  client: VaultClient;
  item: VaultItem | null;      // null = 新建
  onDone: (saved: VaultItem | null) => void;
  onCancel: () => void;
}

export function ItemEditor({ client, item, onDone, onCancel }: Props) {
  const [draft, setDraft] = useState<VaultItem>(() => item ?? blankItem());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  const isNew = item === null;
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
    <div className="mx-auto flex h-full max-w-2xl flex-col">
      <header className="flex items-center justify-between border-b border-[var(--border-subtle)] px-6 py-4">
        <h2 className="text-[var(--text-lg)] font-semibold">{isNew ? '新建条目' : '编辑'}</h2>
        <div className="flex items-center gap-2">
          <button onClick={onCancel} disabled={busy}
            className="rounded-[var(--radius-md)] px-3 py-1.5 text-[var(--text-sm)] text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]">
            取消
          </button>
          <button onClick={save} disabled={busy}
            className="rounded-[var(--radius-md)] bg-[var(--accent)] px-4 py-1.5 text-[var(--text-sm)] font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-hover)] disabled:opacity-50">
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <p className="mb-4 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] px-3 py-2 text-[var(--text-sm)] text-[var(--risk)]">
            {error}
          </p>
        )}

        <Field label="名称" required>
          <input ref={nameRef} value={draft.name} onChange={(e) => patch({ name: e.target.value })}
            className={inputCls} placeholder="例如 GitHub" />
        </Field>

        {isNew && (
          <Field label="类型">
            <select value={draft.type} onChange={(e) => setType(patch, e.target.value as ItemType)} className={inputCls}>
              <option value="login">登录</option>
              <option value="secureNote">安全笔记</option>
              <option value="card">信用卡</option>
              <option value="identity">身份信息</option>
            </select>
          </Field>
        )}

        {draft.type === 'login' && (
          <>
            <Field label="用户名">
              <input value={draft.login?.username ?? ''} onChange={(e) => patchLogin({ username: e.target.value })}
                className={inputCls} autoComplete="off" />
            </Field>

            <Field label="密码">
              <div className="flex gap-2">
                <input value={draft.login?.password ?? ''} onChange={(e) => patchLogin({ password: e.target.value })}
                  className={`${inputCls} secret`} autoComplete="off" spellCheck={false} />
                <GenerateButton onGenerated={(pw) => patchLogin({ password: pw })} />
              </div>
              <StrengthMeter value={draft.login?.password ?? ''} />
            </Field>

            <Field label="验证码（otpauth:// 或密钥）">
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
                className={`${inputCls} secret`} placeholder="otpauth://totp/… 或 base32 密钥" autoComplete="off" />
            </Field>

            <Field label="网址">
              <input
                value={draft.login?.uris[0]?.uri ?? ''}
                onChange={(e) => patchLogin({
                  uris: e.target.value ? [{ uri: e.target.value, match: draft.login?.uris[0]?.match ?? null }] : [],
                })}
                className={inputCls} placeholder="https://github.com" />
            </Field>
          </>
        )}

        {draft.type === 'card' && (
          <>
            <Field label="持卡人">
              <input value={draft.card?.cardholderName ?? ''} className={inputCls}
                onChange={(e) => patch({ card: { ...blankCard(), ...draft.card, cardholderName: e.target.value } })} />
            </Field>
            <Field label="卡号">
              <input value={draft.card?.number ?? ''} className={`${inputCls} secret`} autoComplete="off"
                onChange={(e) => patch({ card: { ...blankCard(), ...draft.card, number: e.target.value } })} />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="月份">
                <input value={draft.card?.expMonth ?? ''} className={inputCls} inputMode="numeric"
                  onChange={(e) => patch({ card: { ...blankCard(), ...draft.card, expMonth: e.target.value } })} />
              </Field>
              <Field label="年份">
                <input value={draft.card?.expYear ?? ''} className={inputCls} inputMode="numeric"
                  onChange={(e) => patch({ card: { ...blankCard(), ...draft.card, expYear: e.target.value } })} />
              </Field>
              <Field label="安全码">
                <input value={draft.card?.code ?? ''} className={`${inputCls} secret`} autoComplete="off"
                  onChange={(e) => patch({ card: { ...blankCard(), ...draft.card, code: e.target.value } })} />
              </Field>
            </div>
          </>
        )}

        {draft.type === 'identity' && (
          <>
            {([['firstName', '名'], ['lastName', '姓'], ['email', '邮箱'],
              ['phone', '电话'], ['company', '公司'], ['ssn', '身份证号']] as const).map(([k, label]) => (
              <Field key={k} label={label}>
                <input value={(draft.identity?.[k] ?? '') as string} className={inputCls}
                  onChange={(e) => patch({ identity: { ...blankIdentity(), ...draft.identity, [k]: e.target.value } })} />
              </Field>
            ))}
          </>
        )}

        <Field label="备注">
          <textarea value={draft.notes ?? ''} onChange={(e) => patch({ notes: e.target.value })}
            rows={4} className={`${inputCls} resize-y`} />
        </Field>

        <Field label="自定义字段">
          <CustomFields
            fields={draft.customFields}
            onChange={(customFields) => patch({ customFields })}
          />
        </Field>

        <label className="mb-6 flex items-center gap-2 text-[var(--text-sm)]">
          <input type="checkbox" checked={draft.favorite} onChange={(e) => patch({ favorite: e.target.checked })} />
          加入收藏
        </label>
      </div>
    </div>
  );
}

const inputCls =
  'w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 text-[var(--text-md)] outline-none focus:border-[var(--accent)]';

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="mb-4 block">
      <span className="mb-1 block text-[var(--text-sm)] font-medium text-[var(--ink-secondary)]">
        {label}{required && <span className="ml-1 text-[var(--risk)]">*</span>}
      </span>
      {children}
    </label>
  );
}

/** 生成密码。默认是「长度 + 数字 + 符号」三项 —— 对普通用户更简单，
 *  大小写等细节不必让人操心。 */
function GenerateButton({ onGenerated }: { onGenerated: (pw: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onGenerated(generatePassword({ length: 20 }))}
      title="生成随机密码"
      className="shrink-0 rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-3 py-2 text-[var(--text-sm)] text-[var(--ink-secondary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)]"
    >
      生成
    </button>
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
    <span className="mt-2 flex items-center gap-2">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="h-1 w-8 rounded-full"
            style={{ background: i <= score ? colors[score] : 'var(--border-subtle)' }} />
        ))}
      </span>
      <span className="text-[var(--text-xs)] text-[var(--ink-tertiary)]">
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
            value={f.name} placeholder="名称"
            onChange={(e) => onChange(fields.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            className={`${inputCls} w-1/3`}
          />
          <input
            value={f.value} placeholder="值"
            type={f.type === 1 ? 'password' : 'text'}
            onChange={(e) => onChange(fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            className={`${inputCls} secret`}
          />
          <select
            value={f.type}
            onChange={(e) => onChange(fields.map((x, j) => (j === i ? { ...x, type: Number(e.target.value) as 0 | 1 | 2 | 3 } : x)))}
            className={`${inputCls} w-24 shrink-0`}
            title="字段类型"
          >
            {/* ⚠️ 只发 0–3。服务端在 type 缺失或不可解析时回退到 1（隐藏） */}
            <option value={0}>文本</option>
            <option value={1}>隐藏</option>
            <option value={2}>开关</option>
            <option value={3}>关联</option>
          </select>
          <button type="button" onClick={() => onChange(fields.filter((_, j) => j !== i))}
            title="删除此字段"
            className="shrink-0 rounded-[var(--radius-md)] px-2 text-[var(--ink-tertiary)] hover:bg-[var(--surface-hover)]">
            ✕
          </button>
        </div>
      ))}
      <button type="button"
        onClick={() => onChange([...fields, { name: '', value: '', type: 0, linkedId: null }])}
        className="rounded-[var(--radius-md)] px-3 py-1.5 text-[var(--text-sm)] text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]">
        + 添加字段
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
