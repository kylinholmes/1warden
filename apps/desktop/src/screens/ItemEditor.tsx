import { useCallback, useEffect, useRef, useState } from 'react';
import { generatePassword, passwordStrength } from '@coffer/crypto';
import { writeTotpSecret } from '@coffer/vault';
import type { VaultItem, ItemType, CustomField } from '@coffer/vault';
import type { VaultClient } from '@coffer/vault';
import { FloatingPanel } from '../components/FloatingPanel';
import { STRENGTH_COLORS, STRENGTH_LABELS } from '../components/strength';
import {
  IconCard, IconChevronDown, IconClose, IconIdentity, IconKey, IconNote,
  IconPlus, IconSpinner, IconStar, IconTerminal, IconTrash,
} from '@coffer/ui';

interface Props {
  client: VaultClient;
  item: VaultItem | null;      // null = 新建
  /** 浮层的开合。**组件本身一直挂着** —— 见下面「退场」那一段 */
  open: boolean;
  onDone: (saved: VaultItem | null) => void;
  onCancel: () => void;
}

/**
 * 新建 / 编辑条目 —— 一个浮在主界面之上的浮层。
 *
 * ── 为什么从「整屏」改成浮层
 *
 * 之前它占满右侧一整屏。问题是这个动作**总是发生在某个上下文里**：
 * 用户正看着某条记录的详情，或者刚从搜索结果里选了它。整屏会把那个
 * 上下文整个换掉 —— 关掉之后要自己找回来（列表滚动位置、筛选、选中的那条）。
 * 浮层压在上面，底下的三栏一动不动。
 *
 * 交互契约（Esc、点遮罩、焦点进出与归还、Tab 循环、退场动画）全部来自
 * `FloatingPanel`，和设置面板、删除确认是同一套。这也是这次改动最省事的地方：
 * 那些容易漏掉一条的东西不需要在这里再实现一遍。
 *
 * ── 版面：滚动区 + 固定底栏
 *
 * 表单有六组字段（类型 / 基本信息 / 登录 / 信用卡 / 身份 / SSH 密钥 / 备注 /
 * 自定义字段），比面板高得多。所以：头部不滚（标题和收藏一直在），
 * 中间滚，**底栏不滚** —— 「保存」必须永远在手指底下，
 * 让用户在长表单里滚到底才能保存是没道理的。
 *
 * ── 未保存的改动
 *
 * Esc 是用户关浮层的肌肉记忆，而这里按一下就可能丢掉填了一半的表单 ——
 * 在密码管理器里这是最让人恼火的一类丢失（那些密码往往是他刚生成的、
 * 自己都还没记住）。所以关闭前先问一句，而且这一问**只出现在底栏**：
 * 不新开一层对话框，不抢焦点，也不改变面板的位置。
 *
 * 第三次确认：**没有任何键盘路径能丢掉改动**。Esc 第一次是「你要关吗」，
 * 第二次是把这一问撤掉、回到编辑。要丢只能点「放弃改动」。
 */
export function ItemEditor({ client, item, open, onDone, onCancel }: Props) {
  const [draft, setDraft] = useState<VaultItem>(() => item ?? blankItem());
  /** 打开那一刻的样子 —— 判断「改没改过」就靠它 */
  const [initial, setInitial] = useState<VaultItem>(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  /**
   * 「这是在新建吗」也在打开时定下来，不跟着 prop 走。
   *
   * 面板关掉的那 140ms 里退场动画还在播，而那时 VaultView 已经把
   * `item` 换成 null 了 —— 标题会当着用户的面从「编辑条目」跳成
   * 「新建条目」，像是点错了什么东西。
   */
  const [isNew, setIsNew] = useState(item === null);

  /*
   * ⚠️ 只在**开**的那一刻取一次 item，之后不再跟着 prop 走。
   *
   * 后台同步会把 session.items 换成一整批新对象 —— 如果重置逻辑依赖
   * `item` 的引用，用户正在填的表单会被同步悄悄清空，而屏幕上
   * 什么都不会提示。引用变了不代表用户在编辑另一条记录。
   */
  const itemRef = useRef(item);
  itemRef.current = item;

  useEffect(() => {
    if (!open) return;
    const start = itemRef.current ?? blankItem();
    setIsNew(itemRef.current === null);
    setInitial(start);
    setDraft(start);
    setError(null);
    setBusy(false);
    setConfirming(false);
  }, [open]);

  // 文件夹列表从会话里取 —— 编辑期间新建的文件夹看不到，这是可接受的：
  // 用户不会一边编辑一边去侧栏建文件夹
  const folders = client.getSession().folders;
  function patch(p: Partial<VaultItem>) { setDraft((d) => ({ ...d, ...p })); }
  function patchLogin(p: Partial<NonNullable<VaultItem['login']>>) {
    setDraft((d) => ({ ...d, login: { ...(d.login ?? blankLogin()), ...p } }));
  }

  /*
   * 改没改过。
   *
   * 用 JSON 比对而不是自己维护一个 dirty 标志：标志要靠每一个
   * onChange 记得去置位，而这里光是入口就有二十几个（包括自定义字段
   * 的增删改、验证码写入时的连带写入）。漏一个的症状是
   * 「改了却直接关掉、什么也没问」—— 而那正是这个功能要防的事。
   * draft 里全是字符串、数字与数组，没有 Date、函数或循环引用。
   */
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

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

  const requestClose = useCallback(() => {
    // 保存中不给关：这时候关掉，用户无从知道到底存上没有
    if (busy) return;
    if (!dirty) { onCancel(); return; }
    setConfirming(true);
  }, [busy, dirty, onCancel]);

  /*
   * 浮层要的 onClose：Esc、点遮罩、右上角的叉都走这里。
   * 正在问「要放弃吗」的时候，再按 Esc 是**把这一问撤掉**，不是丢掉改动。
   */
  const handleClose = useCallback(() => {
    if (confirming) { setConfirming(false); return; }
    requestClose();
  }, [confirming, requestClose]);

  return (
    <FloatingPanel
      open={open}
      onClose={handleClose}
      labelledBy="editor-title"
      className="max-w-[620px]"
      footer={confirming ? (
        <>
          <span className="min-w-0 truncate text-[var(--ink-secondary)]">有未保存的改动，关掉就没了</span>
          <span className="flex shrink-0 items-center gap-2">
            <button onClick={() => setConfirming(false)} className="btn btn-quiet">继续编辑</button>
            <button onClick={onCancel} className="btn btn-danger">放弃改动</button>
          </span>
        </>
      ) : (
        <>
          {/* 保存的结果贴着保存按钮说 —— 长表单里用户早就滚到底了，
              报错放在表单顶部等于没报 */}
          {error
            ? <span className="min-w-0 truncate text-[var(--risk)]" title={error}>{error}</span>
            : <span className="min-w-0 truncate">{isNew ? '新条目会加密后存到服务器' : '改动会加密后存到服务器'}</span>}
          <span className="flex shrink-0 items-center gap-2">
            <button onClick={requestClose} disabled={busy} className="btn btn-quiet">取消</button>
            <button onClick={save} disabled={busy} className="btn btn-primary">
              {busy && <IconSpinner size={14} />}
              {busy ? '保存中…' : '保存'}
            </button>
          </span>
        </>
      )}
    >
      <div className="panel-head">
        <h2 id="editor-title" className="min-w-0 flex-1 truncate text-[var(--text-md)] font-medium">
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
        <button onClick={requestClose} aria-label="关闭" title="关闭  esc" className="btn btn-ghost -mr-1 p-1.5">
          <IconClose size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {/* ⚠️ 不能传 `title={undefined}` —— exactOptionalPropertyTypes 下那是类型错误，
              而且意图也不同：这里要的是「不显示标题」而不是「标题是 undefined」 */}
        <Group {...(isNew ? { title: '类型' } : {})}>
          {isNew ? (
            <div className="grid grid-cols-5 gap-2 py-3">
              {([
                ['login', '登录', <IconKey size={17} />],
                ['secureNote', '笔记', <IconNote size={17} />],
                ['card', '信用卡', <IconCard size={17} />],
                ['identity', '身份', <IconIdentity size={17} />],
                ['sshKey', 'SSH 密钥', <IconTerminal size={17} />],
              ] as const).map(([t, label, icon]) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(patch, t)}
                  aria-pressed={draft.type === t}
                  className={`flex flex-col items-center gap-1.5 rounded-[var(--radius-md)] border px-1 py-3 text-[var(--text-xs)] transition-colors duration-[var(--dur-fast)] ${
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
              <input value={draft.name} onChange={(e) => patch({ name: e.target.value })}
                className="field" placeholder="例如 GitHub" />
            </Row>
          )}
        </Group>

        <Group title="基本信息">
          {isNew && (
            <Row label="名称">
              <input value={draft.name} onChange={(e) => patch({ name: e.target.value })}
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

        {/*
          ⚠️ SSH 密钥此前**只有详情页能看**：模型里有这一组、类型里有它、
          列表图标也有它，但编辑器里一个字都改不了 —— 从 Bitwarden 导进来的
          SSH 密钥，打开编辑看到的是「基本信息 + 备注」，会以为密钥丢了。
          私钥用多行框：它本来就是多行的（PEM / OpenSSH 格式），
          单行框会把换行吞掉，而用户看不出来自己贴进去的东西已经变形了。
        */}
        {draft.type === 'sshKey' && (
          <Group title="SSH 密钥">
            <Row label="私钥">
              <textarea
                value={draft.sshKey?.privateKey ?? ''}
                onChange={(e) => patch({ sshKey: { ...blankSshKey(), ...draft.sshKey, privateKey: e.target.value } })}
                rows={4} aria-label="私钥" spellCheck={false} autoComplete="off"
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                className="field secret resize-y leading-[var(--lh-snug)]"
              />
            </Row>
            <Row label="公钥">
              <textarea
                value={draft.sshKey?.publicKey ?? ''}
                onChange={(e) => patch({ sshKey: { ...blankSshKey(), ...draft.sshKey, publicKey: e.target.value } })}
                rows={2} aria-label="公钥" spellCheck={false} autoComplete="off"
                placeholder="ssh-ed25519 AAAA…"
                className="field secret resize-y leading-[var(--lh-snug)]"
              />
            </Row>
            <Row label="指纹">
              <input
                value={draft.sshKey?.fingerprint ?? ''}
                onChange={(e) => patch({ sshKey: { ...blankSshKey(), ...draft.sshKey, fingerprint: e.target.value } })}
                className="field secret" spellCheck={false} autoComplete="off"
                placeholder="SHA256:…" />
            </Row>
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
    </FloatingPanel>
  );
}

/**
 * 分组卡片。
 *
 * `title` 为空时（新建时的「类型」组）只画一个没有标题的卡片 ——
 * 标题栏留白比一个「类型」二字更省事，反正图标按钮自解释。
 */
function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 last:mb-0">
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
 *
 * 说法与颜色取自 `components/strength.ts` —— 生成器那边说的是同一套话。
 */
function StrengthMeter({ value }: { value: string }) {
  if (value.length === 0) return null;
  const { score, entropyBits } = passwordStrength(value);

  return (
    <span className="mt-2 flex items-center gap-2.5">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="h-1 w-7 rounded-full transition-colors duration-[var(--dur-base)]"
            style={{ background: i <= score ? STRENGTH_COLORS[score] : 'var(--border-subtle)' }} />
        ))}
      </span>
      <span className="text-[var(--text-xs)] tabular-nums text-[var(--ink-tertiary)]">
        {STRENGTH_LABELS[score]} · 约 {Math.round(entropyBits)} 位熵
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
  // ⚠️ `fido2Credentials` 不能省 —— 它是必填的，而且漏了的话
  // 新建的条目会在保存时丢掉该条目上已有的 passkey
  return {
    username: null, password: null, totp: null, uris: [],
    passwordRevisionDate: null, fido2Credentials: [],
  };
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
function blankSshKey() {
  return { privateKey: null, publicKey: null, fingerprint: null };
}

function blankItem(): VaultItem {
  return {
    id: '', type: 'login', rawType: 1, name: '', nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: blankLogin(), card: null, identity: null, secureNote: null, sshKey: null,
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
    // 换类型时另外几组必须显式置空 —— 留着上一组的数据会写出一条
    // 「类型是卡片、却带着用户名密码」的条目
    sshKey: type === 'sshKey' ? blankSshKey() : null,
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
