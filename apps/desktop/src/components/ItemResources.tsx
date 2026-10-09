import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import { toBase64 } from '@1warden/crypto';
import { FIELD_LABEL_CLASS, FIELD_ROW_CLASS, IconChevronDown, IconPlus, IconSpinner, IconTrash, SecretField, Section } from '@1warden/ui';
import type { ApplicationClient, ApplicationSnapshot, ItemDetailData } from '../application/types';
import { openWebsite } from '../open-website';

interface ItemResourceOptions {
  item: ItemDetailData;
  client: ApplicationClient;
  onError?: ((message: string) => void) | undefined;
  onBusyChange?: ((busy: boolean) => void) | undefined;
  disabled?: boolean;
}

type Confirmation = { kind: 'attachment'; id: string } | { kind: 'passkey'; id: string } | { kind: 'history' } | null;

// SecretField forwards both reveal and copy failures. A read reports at its own
// account boundary, then marks the rejection so the field does not report it again.
class HandledHistoryReadError extends Error {}

function accountIdentity(snapshot: ApplicationSnapshot): string {
  return JSON.stringify([snapshot.account?.serverUrl, snapshot.account?.email, snapshot.account?.userId]);
}

function formattedDate(value: string): string {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '未提供时间';
}

function siteUrl(item: ItemDetailData): string | null {
  for (const uri of item.login?.uris ?? []) {
    try {
      const url = new URL(uri.uri);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href;
    } catch { /* Native login URIs may contain non-web application addresses. */ }
  }
  const rpId = item.login?.passkeys?.find(passkey => passkey.rpId)?.rpId;
  if (!rpId) return null;
  try {
    const url = new URL(`https://${rpId}`);
    return url.hostname === rpId && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** One operation boundary for credentials and management, regardless of visual position. */
export function useItemResources({ item, client, onError, onBusyChange, disabled = false }: ItemResourceOptions) {
  const store = useLocalStore(() => ({ resources: item, busy: false, pending: null as Confirmation,
    error: null as string | null, notes: {} as Record<string, string>, historyOpen: false }));
  const [resources, setResources] = useStoreField(store, 'resources');
  const [busy, setBusy] = useStoreField(store, 'busy');
  const [pending, setPending] = useStoreField(store, 'pending');
  const [error, setError] = useStoreField(store, 'error');
  const [notes, setNotes] = useStoreField(store, 'notes');
  const [historyOpen, setHistoryOpen] = useStoreField(store, 'historyOpen');
  const historyId = useId();
  const historyToggle = useRef<HTMLButtonElement>(null);
  const selectingFile = useRef<HTMLInputElement>(null);
  const active = useRef(false);
  const blocked = useRef(disabled);
  blocked.current = disabled;
  const alive = useRef(true);
  const epoch = useRef(0);
  const itemId = useRef(item.summary.id);
  const displayedAccount = useRef(accountIdentity(client.getSnapshot()));
  itemId.current = item.summary.id;
  const callbacks = useRef({ onError, onBusyChange });
  callbacks.current = { onError, onBusyChange };
  const editable = resources.rawType >= 1 && resources.rawType <= 8 && resources.summary.type !== 'unknown';
  const controlsDisabled = busy || disabled;
  const website = siteUrl(resources);

  useEffect(() => { setResources(item); }, [item]);
  useEffect(() => {
    alive.current = true;
    let boundary = `${client.getSnapshot().status}:${accountIdentity(client.getSnapshot())}`;
    const unsubscribe = client.subscribe(() => {
      const snapshot = client.getSnapshot();
      const next = `${snapshot.status}:${accountIdentity(snapshot)}`;
      if (next !== boundary) {
        boundary = next;
        epoch.current++;
        setPending(null);
        setHistoryOpen(false);
      }
    });
    return () => {
      alive.current = false;
      epoch.current++;
      unsubscribe();
      callbacks.current.onBusyChange?.(false);
    };
  }, [client, item.summary.id]);

  function operationContext() {
    const started = client.getSnapshot();
    const version = epoch.current;
    const id = item.summary.id;
    const identity = accountIdentity(started);
    const sameAccount = () => started.status === 'unlocked' && client.getSnapshot().status === 'unlocked'
      && identity === accountIdentity(client.getSnapshot());
    return {
      id,
      sameAccount,
      valid: () => alive.current && version === epoch.current && itemId.current === id
        && sameAccount(),
    };
  }

  function report(cause: unknown) {
    if (cause instanceof HandledHistoryReadError) return;
    const snapshot = client.getSnapshot();
    if (!alive.current || snapshot.status !== 'unlocked' || accountIdentity(snapshot) !== displayedAccount.current) return;
    const message = typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : '无法读取历史密码';
    // The notification owner survives detail revisions and navigation. Standalone
    // views without that owner retain one inline fallback instead.
    if (callbacks.current.onError) callbacks.current.onError(message);
    else setError(message);
  }

  async function run(operation: (context: ReturnType<typeof operationContext>) => Promise<void>, fallback: string) {
    if (active.current || blocked.current) return;
    const context = operationContext();
    if (!context.valid()) { report('当前账户已变化，请重新打开条目'); return; }
    active.current = true;
    // This subscription belongs to the operation, so it survives a revision-driven
    // detail unmount and still detects lock/switch/return before the promise settles.
    let boundaryValid = true;
    const unsubscribeOperation = client.subscribe(() => {
      if (!context.sameAccount()) boundaryValid = false;
    });
    setBusy(true); setError(null);
    callbacks.current.onBusyChange?.(true);
    try {
      await operation(context);
    } catch (cause) {
      if (boundaryValid && context.sameAccount()) {
        const message = cause instanceof Error ? cause.message : fallback;
        if (callbacks.current.onError) callbacks.current.onError(message);
        else if (context.valid()) setError(message);
      }
    } finally {
      unsubscribeOperation();
      active.current = false;
      if (alive.current) {
        setBusy(false);
        callbacks.current.onBusyChange?.(false);
      }
    }
  }

  async function upload(file: File) {
    if (!editable) return;
    await run(async context => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let encoded = '';
      try {
        if (!context.valid() || blocked.current) return;
        encoded = toBase64(bytes);
        await client.uploadAttachment(context.id, file.name, encoded);
        // SelectedDetail reloads on the client's revision; do not race its refresh.
      } finally {
        bytes.fill(0);
        encoded = '';
      }
    }, '附件上传失败');
  }

  async function download(attachment: ItemDetailData['attachments'][number]) {
    await run(async context => {
      if (attachment.failed) throw new Error('附件信息无法解密，暂不能取回');
      const result = await client.downloadAttachment(context.id, attachment.id);
      if (!context.valid()) return;
      const saved = await client.saveFile(result.fileName || attachment.fileName || 'attachment', result.dataBase64);
      if (context.valid()) setNotes(previous => ({ ...previous, [attachment.id]: saved.path === null ? '' : `已保存 · ${saved.path}` }));
    }, '附件取回失败');
  }

  async function confirmRemoval() {
    if (!pending || !editable) return;
    const removal = pending;
    await run(async context => {
      if (removal.kind === 'attachment') await client.deleteAttachment(context.id, removal.id);
      else if (removal.kind === 'passkey') await client.removePasskey(context.id, removal.id);
      else await client.clearPasswordHistory(context.id);
      if (!context.valid()) return;
      // The service has finished the explicit operation; hide removed rows immediately.
      setResources(current => removal.kind === 'attachment' ? { ...current, attachments: current.attachments.filter(attachment => attachment.id !== removal.id) }
        : removal.kind === 'history' ? { ...current, passwordHistory: [] }
        : { ...current, login: current.login ? { ...current.login, passkeys: current.login.passkeys?.filter(passkey => passkey.credentialId !== removal.id) ?? [] } : null });
      setPending(null);
    }, '资源删除失败');
  }

  function confirmation(kind: NonNullable<Confirmation>['kind'], id?: string) {
    const shown = pending?.kind === kind && (kind === 'history' || ('id' in pending && pending.id === id));
    if (!shown) return null;
    return <div className="flex flex-wrap items-center justify-end gap-2 pb-3 text-xs text-[var(--ink-secondary)]">
      <span>{kind === 'history' ? '清空后无法恢复历史密码' : kind === 'passkey' ? '仅从密码库删除此通行密钥，网站上的注册仍会保留。若要撤销注册，请前往网站的安全设置。' : '删除后无法恢复此附件'}</span>
      <button type="button" className="btn btn-quiet" disabled={controlsDisabled} onClick={() => setPending(null)}>取消</button>
      <button type="button" className="btn btn-danger" disabled={controlsDisabled} onClick={() => { void confirmRemoval(); }}>
        {busy ? '处理中…' : kind === 'history' ? '确认清空' : '确认删除'}
      </button>
    </div>;
  }

  async function revealHistory(index: number) {
    if (blocked.current || active.current) throw new Error('请等待当前操作完成');
    const context = operationContext();
    if (!context.valid()) throw new Error('当前账户已变化，请重新打开条目');
    let boundaryValid = true;
    const unsubscribeOperation = client.subscribe(() => {
      if (!context.sameAccount()) boundaryValid = false;
    });
    try {
      const value = await client.reveal(context.id, { kind: 'history', index });
      // A departed view must never reveal or copy a secret that arrives late.
      if (!context.valid()) throw new HandledHistoryReadError('当前账户已变化，请重新打开条目');
      return value;
    } catch (cause) {
      if (cause instanceof HandledHistoryReadError) throw cause;
      const message = cause instanceof Error ? cause.message : '无法读取历史密码';
      if (boundaryValid && context.sameAccount()) {
        if (callbacks.current.onError) callbacks.current.onError(message);
        else if (context.valid()) setError(message);
      }
      throw new HandledHistoryReadError(message, { cause });
    } finally {
      unsubscribeOperation();
    }
  }

  return {
    resources, busy, controlsDisabled, editable, error, notes, pending, setPending,
    historyOpen, setHistoryOpen, historyId, historyToggle, selectingFile,
    upload, download, confirmation, revealHistory, report,
    canSaveAttachments: client.capabilities.saveAttachments, website,
    addPasskey: () => { if (editable && website) void run(async () => { await openWebsite(website); }, '无法打开网站'); },
  };
}

type ResourceControls = ReturnType<typeof useItemResources>;

/** Passkeys are login credentials, alongside passwords and OTPs, not item metadata. */
export function ItemPasskeys({ controls }: { controls: ResourceControls }) {
  const { resources, controlsDisabled, editable, busy, setPending, confirmation, website, addPasskey } = controls;
  if (!resources.login) return null;
  const passkeys = resources.login.passkeys ?? [];
  return <fieldset data-login-passkeys disabled={controlsDisabled} aria-busy={busy} aria-label="通行密钥"
    className="m-0 min-w-0 border-0 px-0 py-2">
    <div data-field-layout="passkeys" className="flex min-w-0 items-center gap-3">
      <div data-field-content className={`${FIELD_ROW_CLASS} flex-1`}>
        <span data-field-label className={FIELD_LABEL_CLASS}>通行密钥</span>
        <span data-field-value className="min-w-0 flex-1 text-sm text-[var(--ink-secondary)]">{passkeys.length > 0 ? `已保存 ${passkeys.length} 个` : '未保存'}</span>
      </div>
        {editable && <button data-field-actions data-field-persistent type="button" disabled={controlsDisabled || website === null}
          className="btn btn-ghost shrink-0 gap-1 text-xs" aria-label="前往网站添加通行密钥"
          title={website ? '前往支持通行密钥的网站，在安全设置中创建并通过 1Warden 扩展保存' : '请先为登录条目添加网站地址'}
          onClick={addPasskey}><IconPlus size={13} />添加</button>}
    </div>
    {passkeys.length > 0 && <div className="mt-2 divide-y divide-[var(--border-subtle)]">
      {passkeys.map(passkey => <div key={passkey.credentialId}>
        <div className="flex flex-wrap items-center gap-2 py-2">
          <div className="min-w-0 flex-1 basis-36">
            <p className="break-words text-sm">{passkey.rpName || passkey.rpId || '通行密钥'}</p>
            {passkey.rpName && passkey.rpId && <p className="mt-0.5 break-all text-xs text-[var(--ink-tertiary)]">{passkey.rpId}</p>}
            {(passkey.userDisplayName || passkey.userName) && <p className="mt-1 break-words text-xs text-[var(--ink-secondary)]">
              {passkey.userDisplayName || passkey.userName}{passkey.userDisplayName && passkey.userName && passkey.userDisplayName !== passkey.userName ? ` · ${passkey.userName}` : ''}
            </p>}
            <p className="mt-1 text-xs text-[var(--ink-tertiary)]">创建 · {formattedDate(passkey.creationDate)}</p>
          </div>
          {editable && <button data-field-actions data-field-persistent type="button" disabled={controlsDisabled} className="btn btn-ghost gap-1 text-xs hover:text-[var(--risk)]"
            aria-label={`删除通行密钥 ${passkey.rpName || passkey.rpId}`} onClick={() => setPending({ kind: 'passkey', id: passkey.credentialId })}>
            <IconTrash size={13} />删除
          </button>}
        </div>
        {confirmation('passkey', passkey.credentialId)}
      </div>)}
    </div>}
  </fieldset>;
}

/** Attachment/history/folder management stays below the item's content. */
export function ItemResources({ controls, children }: { controls: ResourceControls; children?: ReactNode }) {
  const { resources, busy, controlsDisabled, editable, error, notes, pending, setPending,
    historyOpen, setHistoryOpen, historyId, historyToggle, selectingFile,
    upload, download, confirmation, revealHistory, report, canSaveAttachments } = controls;
  return <fieldset data-item-resources aria-busy={busy} disabled={controlsDisabled} className="m-0 min-w-0 border-0 p-0">
    {error && <p role="alert" className="mb-3 text-sm text-[var(--risk)]">{error}</p>}
    {busy && <p role="status" className="mb-3 flex items-center gap-1.5 text-xs text-[var(--ink-secondary)]"><IconSpinner size={13} />处理中…</p>}
    {editable && <input ref={selectingFile} type="file" className="hidden" aria-label="上传附件文件" disabled={controlsDisabled}
      onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) { void upload(file); }
      }} />}
    {(editable || resources.attachments.length > 0 || resources.passwordHistory.length > 0 || children) && <Section title="条目管理">
      <div data-resource-actions className="divide-y divide-[var(--border-subtle)]">
        {(editable || resources.attachments.length > 0) && <div className="py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm">
              <span>附件</span>
              <span className="text-xs text-[var(--ink-tertiary)]">{resources.attachments.length > 0 ? `${resources.attachments.length} 个` : '暂无附件'}</span>
            </div>
            {editable && <button type="button" disabled={controlsDisabled} className="btn btn-ghost gap-1.5 text-xs"
              onClick={() => selectingFile.current?.click()}><IconPlus size={13} />上传附件</button>}
          </div>
          {resources.attachments.length > 0 && <div className="mt-2 divide-y divide-[var(--border-subtle)]">
            {resources.attachments.map(attachment => <div key={attachment.id}>
              <div className="flex flex-wrap items-center gap-2 py-2.5">
                <div className="min-w-0 flex-1 basis-32">
                  <p className="break-words text-sm">{attachment.fileName || '（没有文件名）'}</p>
                  <p className="mt-0.5 text-xs text-[var(--ink-tertiary)]">{attachment.sizeName}</p>
                  {attachment.failed && <p className="mt-1 text-xs text-[var(--risk)]">附件信息无法解密</p>}
                  {notes[attachment.id] && <p role="status" className="mt-1 break-all text-xs text-[var(--safe)]">{notes[attachment.id]}</p>}
                </div>
                <button type="button" disabled={controlsDisabled || attachment.failed || !canSaveAttachments}
                  className="btn btn-quiet" onClick={() => { void download(attachment); }}>取回</button>
                {editable && <button type="button" disabled={controlsDisabled} className="btn btn-ghost gap-1 text-xs hover:text-[var(--risk)]"
                  aria-label={`删除附件 ${attachment.fileName || attachment.id}`} onClick={() => setPending({ kind: 'attachment', id: attachment.id })}>
                  <IconTrash size={13} />删除
                </button>}
              </div>
              {confirmation('attachment', attachment.id)}
            </div>)}
          </div>}
        </div>}

        {resources.passwordHistory.length > 0 && <div data-password-history className="py-1"
          onKeyDown={event => {
            if (event.key === 'Escape' && historyOpen && !controlsDisabled) {
              event.preventDefault(); event.stopPropagation(); setHistoryOpen(false);
              if (pending?.kind === 'history') setPending(null);
              historyToggle.current?.focus();
            }
          }}>
          <button ref={historyToggle} type="button" disabled={controlsDisabled} aria-expanded={historyOpen} aria-controls={historyId}
            className="flex min-h-11 w-full items-center gap-2 rounded-[var(--radius-sm)] py-2 text-left text-sm hover:bg-[var(--surface-hover)]"
            onClick={() => { setHistoryOpen(!historyOpen); if (pending?.kind === 'history') setPending(null); }}>
            <span>历史密码</span><span className="text-xs text-[var(--ink-tertiary)]">{resources.passwordHistory.length} 条</span>
            <IconChevronDown size={14} className={`ml-auto text-[var(--ink-tertiary)] ${historyOpen ? 'rotate-180' : ''}`} />
          </button>
          <div id={historyId} hidden={!historyOpen}>
            {/* Unmount secrets on collapse so reopening never retains a revealed password. */}
            {historyOpen && <>
              <div className="divide-y divide-[var(--border-subtle)]">
                {resources.passwordHistory.map((history, index) => <div className="py-2" key={`${resources.summary.id}:${history.lastUsedDate}:${index}`}>
                  <p className="text-xs leading-relaxed text-[var(--ink-tertiary)]">最后使用 · {formattedDate(history.lastUsedDate)}</p>
                  <SecretField label="密码" value="••••••••" masked
                    getValue={() => revealHistory(index)} revealValue={() => revealHistory(index)}
                    onCopyError={report} />
                </div>)}
              </div>
              {editable && <div className="flex justify-end py-2">
                <button type="button" disabled={controlsDisabled} className="btn btn-ghost gap-1.5 text-xs hover:text-[var(--risk)]"
                  onClick={() => setPending({ kind: 'history' })}><IconTrash size={13} />清空历史密码</button>
              </div>}
              {confirmation('history')}
            </>}
          </div>
        </div>}

        {children}
      </div>
    </Section>}
  </fieldset>;
}
