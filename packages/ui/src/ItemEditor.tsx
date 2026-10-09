import { useLocalStore, useStoreField } from '@1warden/state/react';
import { useCallback, useEffect, useRef } from 'react';
import { generatePassword, passwordStrength } from '@1warden/crypto';
import type { VaultItem, VaultFolder, ItemType } from '@1warden/vault';
import { emptyBankAccount, emptyDriversLicense, emptyPassport } from '@1warden/vault';
import { FloatingPanel } from './FloatingPanel';
import { EditorUrls } from './EditorUrls';
import { EditorCardExpiry, EditorDateField } from './EditorDateFields';
import { CompoundFieldRow, FIELD_LABEL_CLASS, FIELD_ROW_CLASS } from './CompoundFieldRow';
import { EditorCustomFields } from './EditorCustomFields';
import { EditorAddMore } from './EditorAddMore';
import {
  blankEditorItem, blankLogin, blankCard, blankIdentity, blankSshKey,
  createCustomField, customFieldsForItemType,
  nativeEditorFields, nativeFieldValue, removeLoginUri, savedLoginUris, updateNativeField,
  type NativeEditorField,
} from './item-editor-fields';
import { STRENGTH_COLORS, STRENGTH_LABELS } from './strength';
import { TYPE_LABEL, TYPE_ORDER } from './destinations';
import {
  IconChevronDown, IconSpinner, IconStar, TypeIcon,
} from './icons';

interface Props {
  /** 文件夹列表。桌面端从会话里拿，扩展端从 `1warden:folders` 拿 */
  /* 只读 —— 编辑器只拿它填下拉，不改文件夹本身 */
  folders: readonly VaultFolder[];
  /** 保存。桌面端直接调 client，扩展端发消息给后台 —— 加密在他们那边 */
  onSave: (draft: VaultItem) => Promise<Pick<VaultItem, 'id' | 'name'>>;
  item: VaultItem | null;      // null = 新建
  /** 浮层的开合。**组件本身一直挂着** —— 见下面「退场」那一段 */
  open: boolean;
  onDone: (saved: Pick<VaultItem, 'id' | 'name'> | null) => void;
  onCancel: () => void;
  onCreateFolder?: (name: string) => Promise<{ id: string; name: string }>;
}

const CARD_BRANDS = [
  ['Visa', 'Visa'], ['Mastercard', 'Mastercard 万事达'], ['Amex', 'American Express 美国运通'],
  ['UnionPay', 'UnionPay 银联'], ['JCB', 'JCB'], ['Discover', 'Discover'],
  ['Diners Club', 'Diners Club'], ['Maestro', 'Maestro'], ['RuPay', 'RuPay'], ['Other', '其他'],
] as const;

const EDITOR_ROW_CLASS = `${FIELD_ROW_CLASS} border-b border-[var(--border-subtle)] py-2 last:border-b-0`;

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
 * 固定字段按类型全部展开，自定义字段按需添加。头部不滚（标题和收藏一直在），
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
export function ItemEditor({ folders, onSave, item, open, onDone, onCancel, onCreateFolder }: Props) {
  const viewStore = useLocalStore(() => {
    const draft = item ?? newEditorItem();
    const initial = draft;
    const busy = false;
    const error = (null) as string | null;
    const confirming = false;
    const isNew = item === null;
    return {
      draft, initial, busy, error, confirming, isNew,
      pendingFocus: null as string | null,
      undoRemoval: null as { label: string; run: () => void } | null,
      createdFolders: [] as { id: string; name: string }[],
      folderName: '', creatingFolder: false, folderError: null as string | null,
    };
  });
  const [draft, writeDraft] = useStoreField(viewStore, 'draft');
  // Zustand updates synchronously: even an event queued before the blocked
  // state renders cannot change the snapshot already being saved.
  function setDraft(next: Parameters<typeof writeDraft>[0]) {
    if (!viewStore.getState().busy) writeDraft(next);
  }
  /** 打开那一刻的样子 —— 判断「改没改过」就靠它 */
  const [initial, setInitial] = useStoreField(viewStore, 'initial');
  const [busy, setBusy] = useStoreField(viewStore, 'busy');
  const [error, setError] = useStoreField(viewStore, 'error');
  const [confirming, setConfirming] = useStoreField(viewStore, 'confirming');
  /**
   * 「这是在新建吗」也在打开时定下来，不跟着 prop 走。
   *
   * 面板关掉的那 140ms 里退场动画还在播，而那时 VaultView 已经把
   * `item` 换成 null 了 —— 标题会当着用户的面从「编辑条目」跳成
   * 「新建条目」，像是点错了什么东西。
   */
  const [isNew, setIsNew] = useStoreField(viewStore, 'isNew');
  const [pendingFocus, setPendingFocus] = useStoreField(viewStore, 'pendingFocus');
  const [undoRemoval, setUndoRemoval] = useStoreField(viewStore, 'undoRemoval');
  const editorBody = useRef<HTMLDivElement>(null);
  const restoreAfterSave = useRef<HTMLElement | null>(null);
  const [createdFolders, setCreatedFolders] = useStoreField(viewStore, 'createdFolders');
  const [folderName, setFolderName] = useStoreField(viewStore, 'folderName');
  const [creatingFolder, setCreatingFolder] = useStoreField(viewStore, 'creatingFolder');
  const [folderError, setFolderError] = useStoreField(viewStore, 'folderError');


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
    const start = itemRef.current ?? newEditorItem();
    setBusy(false);
    setIsNew(itemRef.current === null);
    setInitial(start);
    setDraft(start);
    setError(null);
    setConfirming(false);
    setPendingFocus(null);
    setUndoRemoval(null);
    setFolderName('');
    setFolderError(null);
    setCreatedFolders([]);
  }, [open]);

  useEffect(() => {
    if (busy || !error) return;
    const target = restoreAfterSave.current;
    restoreAfterSave.current = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, [busy, error]);

  useEffect(() => {
    if (!pendingFocus) return;
    const field = editorBody.current?.querySelector<HTMLElement>(pendingFocus);
    // Row actions may precede inputs visually/semantically (for example URL
    // delete in its label line). Add/undo should focus editable content first.
    const input = field?.matches('button,input,textarea,select') ? field
      : field?.querySelector<HTMLElement>('input:not([disabled]),textarea:not([disabled]),select:not([disabled])')
        ?? field?.querySelector<HTMLElement>('button:not([disabled])');
    if (input) { input.focus(); input.scrollIntoView?.({ block: 'nearest' }); setPendingFocus(null); }
  }, [pendingFocus, draft]);

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

  function addUrl() {
    const uris = draft.login?.uris.length ? draft.login.uris : [{ uri: '', match: null }];
    patchLogin({ uris: [...uris, { uri: '', match: null }] });
    setPendingFocus(`[data-editor-url="${uris.length}"]`);
  }

  function removeUrl(index: number) {
    setPendingFocus(`[data-editor-url="${Math.max(0, index - 1)}"]`);
    const removed = draft.login!.uris[index]!;
    patchLogin({ uris: removeLoginUri(draft.login!.uris, index) });
    setUndoRemoval({ label: '网址', run: () => {
      setDraft(current => {
        const uris = [...(current.login?.uris ?? [])]; uris.splice(index, 0, removed);
        return { ...current, login: { ...blankLogin(), ...current.login, uris } };
      });
      setPendingFocus(`[data-editor-url="${index}"]`);
    } });
  }

  function removeCustom(index: number) {
    setPendingFocus('[data-editor-add-more]');
    const removed = draft.customFields[index]!;
    patch({ customFields: draft.customFields.filter((_, i) => i !== index) });
    setUndoRemoval({ label: removed.name || '自定义字段', run: () => {
      setDraft(current => {
        const customFields = [...current.customFields]; customFields.splice(index, 0, removed);
        return { ...current, customFields };
      });
      setPendingFocus(`[data-editor-custom="${index}"]`);
    } });
  }

  async function createFolder() {
    if (!onCreateFolder || !folderName.trim() || viewStore.getState().busy || viewStore.getState().creatingFolder) return;
    setCreatingFolder(true); setFolderError(null);
    try {
      const folder = await onCreateFolder(folderName.trim());
      setCreatedFolders(current => [...current.filter(existing => existing.id !== folder.id), folder]);
      patch({ folderId: folder.id }); setFolderName('');
    } catch (error) { setFolderError(messageOf(error)); }
    finally { setCreatingFolder(false); }
  }

  function renderNative(field: NativeEditorField) {
    const value = String(nativeFieldValue(draft, field.id) ?? '');
    if (field.kind === 'compound') return <CompoundFieldRow key={field.id} editor label={field.label} fieldId={field.id}>
        {field.keys.map((key, index) => <label key={key} data-compound-cell className={FIELD_ROW_CLASS}>
          <span data-field-label className={FIELD_LABEL_CLASS}>{field.labels?.[index]}</span>
          <div data-field-value className="min-w-0 w-full">
            <input value={String(nativeFieldValue(draft, key) ?? '')} className="field min-w-0 w-full"
              aria-label={field.labels?.[index]} autoComplete="off" spellCheck={false}
              onChange={event => setDraft(current => updateNativeField(current, key, event.target.value))} />
          </div>
        </label>)}
    </CompoundFieldRow>;
    return <Row key={field.id} label={field.label} fieldId={field.id} hideLabel={field.id === 'notes' || field.kind === 'urls'}>
      {field.kind === 'urls' ? <EditorUrls uris={draft.login?.uris ?? []}
        onChange={uris => patchLogin({ uris })} onRemove={removeUrl} onAdd={addUrl} />
      : field.kind === 'date' ? <EditorDateField value={value} label={field.label}
        onChange={value => setDraft(current => updateNativeField(current, field.id, value))} />
      : field.kind === 'expiry' ? <EditorCardExpiry month={draft.card?.expMonth ?? ''} year={draft.card?.expYear ?? ''}
        onChange={(month, year) => setDraft(current => {
          let next = current;
          if (month !== (current.card?.expMonth ?? '')) next = updateNativeField(next, 'card.expMonth', month);
          if (year !== (current.card?.expYear ?? '')) next = updateNativeField(next, 'card.expYear', year);
          return next;
        })} />
      : field.id === 'card.brand' ? <select value={value} aria-label={field.label} className="field min-w-0"
        onChange={event => setDraft(current => updateNativeField(current, field.id, event.target.value))}>
        <option value="">选择卡片品牌</option>
        {value && !CARD_BRANDS.some(([brand]) => brand === value) && <option value={value}>已保存：{value}</option>}
        {CARD_BRANDS.map(([brand, label]) => <option key={brand} value={brand}>{label}</option>)}
      </select>
      : field.kind === 'multiline' ? <textarea value={value} rows={field.id === 'sshKey.publicKey' ? 2 : 4}
        aria-label={field.label} autoComplete="off" spellCheck={false}
        placeholder={field.id === 'sshKey.privateKey' ? '-----BEGIN OPENSSH PRIVATE KEY-----' : field.id === 'sshKey.publicKey' ? 'ssh-ed25519 AAAA…' : '需要记下来的其他事情'}
        className={`field resize-y leading-[var(--lh-prose)] ${field.id.startsWith('sshKey.') ? 'secret' : ''}`}
        onChange={event => setDraft(current => updateNativeField(current, field.id, event.target.value))} />
      : <>
        <div className="relative min-w-0">
          <input value={value} aria-label={field.label} autoComplete="off" spellCheck={false}
            {...(field.id === 'login.totp' ? { placeholder: 'otpauth://totp/…' } : {})}
            className={`field ${field.kind === 'secret' ? 'secret' : ''} ${field.id === 'login.password' ? 'pr-[76px]' : ''}`}
            onChange={event => setDraft(current => updateNativeField(current, field.id, event.target.value))} />
          {field.id === 'login.password' && <button type="button" title="生成随机密码"
            onClick={() => setDraft(current => updateNativeField(current, field.id, generatePassword({ length: 20 })))}
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded-[var(--radius-sm)] px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--accent-tint)]">生成</button>}
        </div>
        {field.id === 'login.password' && <StrengthMeter value={value} />}
        {field.id === 'login.totp' && <p className="mt-1 text-xs text-[var(--ink-tertiary)]">otpauth:// 链接，或直接填 base32 密钥</p>}
      </>}
    </Row>;
  }
  const shownFields = nativeEditorFields(draft.type);
  const nativeGroups = [...new Set(shownFields.map(field => field.group))];
  const allFolders = [...folders, ...createdFolders.filter(folder => !folders.some(existing => existing.id === folder.id))];


  async function save() {
    if (viewStore.getState().busy || viewStore.getState().creatingFolder) return;
    const draft = viewStore.getState().draft;
    restoreAfterSave.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setBusy(true);
    setError(null);
    try {
      // 名是必填的 —— 一条没有名字的记录在列表里是一片空白，用户找不回来
      if (draft.name.trim().length === 0) throw new Error('名称不能为空');
      // An unused newly added URL row is a UI placeholder, never a saved URL.
      const savedDraft = draft.login ? {
        ...draft, login: { ...draft.login, uris: savedLoginUris(draft.login.uris, isNew ? [] : initial.login?.uris ?? []) },
      } : draft;
      onDone(await onSave(savedDraft));
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  }

  const requestClose = useCallback(() => {
    // 保存中不给关：这时候关掉，用户无从知道到底存上没有
    if (busy || creatingFolder) return;
    if (!dirty) { onCancel(); return; }
    setConfirming(true);
  }, [busy, creatingFolder, dirty, onCancel]);

  /*
   * 浮层要的 onClose：Esc、点遮罩都走这里。
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
      footer={<div className="@container min-w-0 w-full py-2">
        <div className="flex min-w-0 flex-col gap-2 @[420px]:flex-row @[420px]:items-center @[420px]:justify-between">
        {confirming ? (
        <>
          <span className="min-w-0 break-words text-[var(--ink-secondary)]">有未保存的改动，关掉就没了</span>
          <span className="flex shrink-0 items-center gap-2 self-end @[420px]:self-auto">
            <button onClick={() => setConfirming(false)} className="btn btn-quiet">继续编辑</button>
            <button onClick={onCancel} className="btn btn-danger">放弃改动</button>
          </span>
        </>
      ) : (
        <>
          {/* 保存的结果贴着保存按钮说 —— 长表单里用户早就滚到底了，
              报错放在表单顶部等于没报 */}
          {error
            ? <span role="alert" className="min-w-0 break-words whitespace-pre-wrap [overflow-wrap:anywhere] text-[var(--risk)]">{error}</span>
            : <span className="min-w-0 break-words">{isNew ? '新条目会加密后存到服务器' : '改动会加密后存到服务器'}</span>}
          <span className="flex shrink-0 items-center gap-2 self-end @[420px]:self-auto">
            <button onClick={requestClose} disabled={busy || creatingFolder} className="btn btn-quiet">取消</button>
            <button onClick={save} disabled={busy || creatingFolder} className="btn btn-primary">
              {busy && <IconSpinner size={14} />}
              {busy ? '保存中…' : '保存'}
            </button>
          </span>
        </>
        )}
        </div>
      </div>}
    >
      <div className="panel-head">
        <h2 id="editor-title" className="min-w-0 flex-1 truncate text-md font-medium">
          {isNew ? '新建条目' : '编辑条目'}
        </h2>
        <button
          type="button"
          disabled={busy}
          onClick={() => patch({ favorite: !draft.favorite })}
          title={draft.favorite ? '取消收藏' : '加入收藏'}
          aria-pressed={draft.favorite}
          className={`rounded-[var(--radius-sm)] p-1.5 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] ${
            draft.favorite ? 'text-[var(--caution)]' : 'text-[var(--ink-tertiary)]'
          }`}
        >
          <IconStar size={16} filled={draft.favorite} />
        </button>
      </div>

      {/* inert blocks all pointer/keyboard edits while saving. A fieldset here
          makes Edge omit layout for reused native-field rows when opening an
          existing item; keep the regular scrolling container instead. */}
      <div ref={editorBody} inert={busy} aria-busy={busy}
        className={`min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-5${busy ? ' opacity-70' : ''}`}>
        {isNew && <Group title="类型">
          <div className="grid grid-cols-2 gap-2 py-3 @[400px]:grid-cols-4">
            {TYPE_ORDER.map(type => <button key={type} type="button" aria-pressed={draft.type === type}
              onClick={() => {
                if (type === draft.type) return;
                const next = itemWithType(draft, type);
                setDraft(next); setUndoRemoval(null);
              }}
              className={`flex min-w-0 flex-col items-center gap-1.5 rounded-[var(--radius-md)] border px-1 py-3 text-xs ${
                draft.type === type ? 'border-[var(--accent)] bg-[var(--accent-tint)] text-[var(--ink-primary)]'
                  : 'border-[var(--border-subtle)] text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]'}`}>
              <span className={draft.type === type ? 'text-[var(--accent)]' : 'text-[var(--ink-tertiary)]'}><TypeIcon type={type} size={17} /></span>{TYPE_LABEL[type]}
            </button>)}
          </div>
        </Group>}
        <Group>
          <Row label="名称">
            <input value={draft.name} aria-label="名称" onChange={event => patch({ name: event.target.value })}
              className="field" placeholder="例如 GitHub" />
          </Row>
        </Group>
        {nativeGroups.map(group => <Group key={group} title={group}>
          {shownFields.filter(field => field.group === group).map(renderNative)}
        </Group>)}
        {draft.customFields.length > 0 && <Group title="自定义字段">
          <div className="py-3"><EditorCustomFields fields={draft.customFields} itemType={draft.type}
            onChange={customFields => patch({ customFields })} onRemove={removeCustom} /></div>
        </Group>}
        {undoRemoval && <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2 text-xs text-[var(--ink-tertiary)]" role="status">
          <span className="min-w-0 truncate">已移除 {undoRemoval.label}</span>
          <button type="button" className="btn btn-quiet" onClick={() => { undoRemoval.run(); setUndoRemoval(null); }}>撤销移除</button>
        </div>}
        <EditorAddMore key={`${open}-${draft.type}`} itemType={draft.type}
          onCustom={type => {
            const field = createCustomField(type, draft.type);
            if (!field) return;
            const index = draft.customFields.length;
            patch({ customFields: [...draft.customFields, field] });
            setPendingFocus(`[data-editor-custom="${index}"]`);
          }} />
        {draft.type === 'login' && <details className="mb-4 text-xs text-[var(--ink-tertiary)]">
          <summary className="cursor-pointer py-2">高级设置{draft.login?.autofillOnPageLoad == null ? '' : ` · 自动填充${draft.login.autofillOnPageLoad ? '开启' : '关闭'}`}</summary>
          <div className="@container card px-4"><Row label="自动填充">
            <Select label="自动填充" value={draft.login?.autofillOnPageLoad == null ? '' : String(draft.login.autofillOnPageLoad)}
              onChange={value => patchLogin({ autofillOnPageLoad: value === '' ? null : value === 'true' })}
              options={[{ value: '', label: '使用默认设置' }, { value: 'true', label: '开启' }, { value: 'false', label: '关闭' }]} />
          </Row></div>
        </details>}
        <details className="text-xs text-[var(--ink-tertiary)]">
          <summary className="cursor-pointer py-2">文件夹 · {allFolders.find(folder => folder.id === draft.folderId)?.name ?? (draft.folderId ? '现有文件夹' : '无')}</summary>
          <div className="@container card px-4"><Row label="文件夹">
            <Select label="文件夹" value={draft.folderId ?? ''} onChange={value => patch({ folderId: value || null })}
              options={[{ value: '', label: '（无）' },
                ...(draft.folderId && !allFolders.some(folder => folder.id === draft.folderId) ? [{ value: draft.folderId, label: '现有文件夹' }] : []),
                ...allFolders.map(folder => ({ value: folder.id, label: 'nameFailed' in folder && folder.nameFailed ? '无法解密' : folder.name }))]} />
            {onCreateFolder && <div className="mt-2">
              <div className="flex min-w-0 flex-wrap gap-2">
                <input className="field min-w-0 flex-1" value={folderName} aria-label="新文件夹名称" placeholder="新文件夹名称"
                  disabled={creatingFolder} onChange={event => setFolderName(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void createFolder(); } }} />
                <button type="button" className="btn btn-quiet" disabled={creatingFolder || !folderName.trim()}
                  onClick={() => void createFolder()}>{creatingFolder ? '创建中…' : '创建文件夹'}</button>
              </div>
              {folderError && <p className="mt-1 text-[var(--risk)]" role="alert">{folderError}</p>}
            </div>}
          </Row></div>
        </details>
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
        <h3 className="mb-2 text-xs font-medium text-[var(--ink-tertiary)]">{title}</h3>
      )}
      <div className="@container card px-4">{children}</div>
    </section>
  );
}

/**
 * 独立字段：标签在上、控件在下，与详情页共享相同的单列阅读顺序。
 * 小操作仍与其输入放在内容层，不让长标签挤占输入空间。
 */
function Row({ label, fieldId, hideLabel = false, children }: {
  label: string; fieldId?: string; hideLabel?: boolean; children: React.ReactNode;
}) {
  return <div data-editor-field={fieldId}
    className={EDITOR_ROW_CLASS}>
    {!hideLabel && <span data-field-label className={FIELD_LABEL_CLASS}>{label}</span>}
    <div data-field-value className="flex min-w-0 w-full items-start gap-2">
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  </div>;
}

/** 原生下拉框的箭头又大又靠边 —— 关掉它，自己画一个 */
function Select({ value, onChange, options, label }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        aria-label={label}
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
 * （见 @1warden/vault 的 health 模块），否则字典密码会被报成安全。
 *
 * 说法与颜色取自 `@1warden/ui` 的 `strength.ts` —— 生成器那边说的是同一套话。
 */
function StrengthMeter({ value }: { value: string }) {
  if (value.length === 0) return null;
  const { score, entropyBits } = passwordStrength(value);

  return (
    <span className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
      <span className="flex min-w-0 max-w-full gap-1" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="h-1 min-w-0 w-7 rounded-full transition-colors duration-[var(--dur-base)]"
            style={{ background: i <= score ? STRENGTH_COLORS[score] : 'var(--border-subtle)' }} />
        ))}
      </span>
      <span className="text-xs tabular-nums text-[var(--ink-tertiary)]">
        {STRENGTH_LABELS[score]} · 约 {Math.round(entropyBits)} 位熵
      </span>
    </span>
  );
}

function newEditorItem(): VaultItem {
  return blankEditorItem();
}

function itemWithType(draft: VaultItem, type: ItemType): VaultItem {
  const rawType = { login: 1, secureNote: 2, card: 3, identity: 4, sshKey: 5, bankAccount: 6, driversLicense: 7, passport: 8, unknown: -1 }[type];
  return {
    ...draft, type, rawType, customFields: customFieldsForItemType(draft.customFields, type),
    login: type === 'login' ? blankLogin() : null,
    card: type === 'card' ? blankCard() : null,
    identity: type === 'identity' ? blankIdentity() : null,
    secureNote: type === 'secureNote' ? { type: 0 } : null,
    sshKey: type === 'sshKey' ? blankSshKey() : null,
    bankAccount: type === 'bankAccount' ? emptyBankAccount() : null,
    driversLicense: type === 'driversLicense' ? emptyDriversLicense() : null,
    passport: type === 'passport' ? emptyPassport() : null,
  };
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
