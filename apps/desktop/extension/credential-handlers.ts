import { generatePassword } from '@1warden/crypto';
import { ext } from './ext-api';
import { CaptureService, type CaptureOwner, type CaptureSource, CAPTURE_STATE_KEY } from './capture-service';
import { GeneratedPasswordStore } from './generated-password-store';
import { credentialDocumentMatches, inspectGeneration, injectGeneratedPassword, type CredentialRequest, type CredentialDocumentReply } from './credential-protocol';
import type { StorageArea } from './session-store';

const REVIEW_KEY = '1warden.credential-review';
interface Dependencies {
  session: StorageArea & { set(items: Record<string, unknown>, assertCurrent?: () => void): Promise<void> };
  local: Pick<StorageArea, 'get' | 'remove'> & { set(items: Record<string, unknown>, assertCurrent?: () => void): Promise<void> };
  owner(): CaptureOwner;
  changed(): void;
  persist(): Promise<void>;
}

export function createCredentialController(deps: Dependencies) {
  const captures = new CaptureService(deps.session);
  const history = new GeneratedPasswordStore(deps.local);

  function sourceOf(sender: chrome.runtime.MessageSender, nonce: string): CaptureSource {
    if (!sender.url || sender.tab?.id === undefined || !Number.isInteger(sender.frameId)
      || typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 128) throw new Error('无效的网页来源');
    const url = new URL(sender.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('不支持此网页来源');
    return { tabId: sender.tab.id, frameId: sender.frameId!, url: sender.url, nonce,
      ...(sender.documentId ? { documentId: sender.documentId } : {}) };
  }
  async function requireLive(source: CaptureSource): Promise<void> {
    const tab = await ext.tabs.get(source.tabId);
    if (!tab.url || new URL(tab.url).origin !== new URL(source.url).origin) throw new Error('网页已改变或 iframe 与主页面来源不同');
    if (source.frameId === 0 && tab.url !== source.url) {
      // Runtime sender.url remains the original document URL after history.pushState.
      // Accept its new browser URL only while the same isolated document still exists.
      const target = source.documentId ? { tabId: source.tabId, documentIds: [source.documentId] }
        : { tabId: source.tabId, frameIds: [source.frameId] };
      const [proof] = await ext.scripting.executeScript({ target, func: credentialDocumentMatches, args: [source.nonce] });
      if (proof?.result !== true) throw new Error('网页已改变，请重新操作');
      source.url = tab.url;
    }
  }
  async function notify(): Promise<void> {
    deps.changed();
    const tabs = await ext.tabs.query({});
    // Frozen tabs must not hold up saving or locking the vault.
    for (const tab of tabs) if (tab.id !== undefined) void ext.tabs.sendMessage(tab.id,
      { type: '1warden:credential-refresh' }).catch(() => {});
  }
  async function handle(req: CredentialRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
    // Locked documents receive only state; they never get a capture grant.
    if (req.type === '1warden:credential-document') {
      const source = sourceOf(sender, req.nonce);
      await requireLive(source);
      let owner: CaptureOwner;
      try { owner = deps.owner(); } catch { return { unlocked: false, token: null, notices: [] } satisfies CredentialDocumentReply; }
      const token = await captures.register(owner, source);
      const notices = (await captures.notices(owner, source)).filter(r => !r.snoozed)
        .map(({ id, revision, url, username, action }) => ({ id, revision, url, username, action }));
      return { unlocked: true, token, notices } satisfies CredentialDocumentReply;
    }
    const owner = deps.owner();
    if ('nonce' in req) {
      const source = sourceOf(sender, req.nonce);
      const granted = await captures.authorize(owner, source, req.token);
      source.url = granted.url;
      if (req.type === '1warden:credential-capture') {
        const result = await captures.capture(owner, source, req.token, req.input);
        if (result || req.input.submitted) {
          const pending = await captures.notices(owner, source);
          await ext.action.setBadgeText({ tabId: source.tabId, text: pending.length ? '●' : '' }).catch(() => {});
          void notify().catch(() => {});
        }
        return { ok: true };
      }
      if (req.type === '1warden:credential-username') {
        await captures.username(owner, source, req.token, req.username); return { ok: true };
      }
      await requireLive(source); owner.assertCurrent();
      if (req.type === '1warden:credential-generate') {
        const s = req.settings;
        if (!s || !Number.isInteger(s.length) || s.length < 8 || s.length > 64 || typeof s.digits !== 'boolean'
          || typeof s.symbols !== 'boolean' || !Number.isInteger(req.passwordIndex) || req.passwordIndex < 0
          || typeof req.replace !== 'boolean' || typeof req.formId !== 'string' || typeof req.targetId !== 'string') throw new Error('无效的生成器设置');
        const target = source.documentId ? { tabId: source.tabId, documentIds: [source.documentId] }
          : { tabId: source.tabId, frameIds: [source.frameId] };
        const [probe] = await ext.scripting.executeScript({ target, func: inspectGeneration, args: [source.nonce, req.passwordIndex] });
        owner.assertCurrent();
        const fields = probe?.result;
        if (!fields || fields.formId !== req.formId || fields.targetId !== req.targetId || fields.passwordIndex !== req.passwordIndex) throw new Error('密码框已改变，请重新选择');
        if (fields.needsReplacement && !req.replace) throw new Error('请先确认替换当前输入的密码');
        const min = Math.max(8, fields.minLength);
        const max = Math.min(64, fields.maxLength > 0 ? fields.maxLength : 64);
        if (min > max) throw new Error('网站长度要求超出简易生成器范围，请使用完整生成器');
        const password = generatePassword({ length: Math.min(max, Math.max(min, s.length)), lowercase: true, uppercase: true,
          digits: s.digits, symbols: s.symbols });
        // Persist recovery before the first assignment; failed fill remains recoverable too.
        await history.add(owner, source.url, password);
        await requireLive(source); owner.assertCurrent();
        const [filled] = await ext.scripting.executeScript({ target, func: injectGeneratedPassword,
          args: [source.nonce, req.passwordIndex, password, req.replace, { formId: fields.formId, targetId: fields.targetId, token: req.token }] });
        owner.assertCurrent();
        if (!filled?.result?.ok) throw new Error(filled?.result?.error ?? '未能填入密码，请检查表单');
        return { ok: true };
      }
      if (req.type === '1warden:credential-review' || req.type === '1warden:credential-snooze') {
        const record = (await captures.notices(owner, source)).find(r => r.id === req.id);
        if (!record) throw new Error('待保存信息已过期');
        if (req.type === '1warden:credential-snooze') {
          await captures.dismiss(owner, req.id, true); return { ok: true };
        }
        await deps.session.set({ [REVIEW_KEY]: { account: owner.account, id: req.id } }, () => owner.assertCurrent()); owner.assertCurrent();
        try {
          if (!ext.action.openPopup) throw new Error('unsupported');
          await ext.action.openPopup();
        } catch {
          owner.assertCurrent();
          await ext.tabs.create({ url: ext.runtime.getURL(`popup.html#capture=${encodeURIComponent(req.id)}`) });
        }
        return { ok: true };
      }
    }
    switch (req.type) {
      case '1warden:credential-list': {
        const records = await captures.list(owner);
        if (req.captureId !== undefined && !records.some(row => row.id === req.captureId)) {
          throw Object.assign(new Error('这条待保存信息已过期，重试可查看其他待保存项'), { kind: 'captureExpired' });
        }
        const review = (await deps.session.get(REVIEW_KEY))[REVIEW_KEY] as { account: string; id: string } | undefined;
        owner.assertCurrent();
        const preferred = req.captureId ?? (review?.account === owner.account ? review.id : undefined);
        return records.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
      }
      case '1warden:credential-save':
        if (!req.choice || typeof req.choice.captureId !== 'string') throw new Error('无效的保存请求');
        await captures.save(owner, req.choice); await deps.persist(); await notify(); return;
      case '1warden:credential-dismiss':
        await captures.dismiss(owner, req.id); await notify(); return;
      case '1warden:credential-history': return history.list(owner);
      case '1warden:credential-reveal-history': return history.reveal(owner, req.id);
      case '1warden:credential-delete-history': await history.remove(owner, req.id); return;
      case '1warden:credential-recover-history': return captures.recover(owner, await history.record(owner, req.id));
      default: throw new Error('不支持的密码操作');
    }
  }
  return { handle, notify,
    clearSession: async () => { await deps.session.remove([CAPTURE_STATE_KEY, REVIEW_KEY]); await notify(); },
    clearAccount: (account: string) => history.clear(account),
    closeTab: async (tabId: number) => {
      let owner: CaptureOwner; try { owner = deps.owner(); } catch { return; }
      await captures.clearTab(owner, tabId);
    },
  };
}
