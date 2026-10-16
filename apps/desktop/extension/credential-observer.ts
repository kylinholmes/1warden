import type { CredentialDocumentBridge, CredentialDocumentReply, CredentialRequest, GeneratorSettings } from './credential-protocol';
import { CredentialForms, credentialIdentity, sameOriginDocument } from './credential-form';
import { ext } from './ext-api';

interface ObservedEvent { type: string; target: EventTarget | null; isTrusted: boolean; key?: string }
type Send = (request: CredentialRequest) => Promise<unknown>;
const empty = (): CredentialDocumentReply => ({ unlocked: false, token: null, notices: [] });
const submitHint = /log.?in|sign.?in|sign.?up|register|create.?account|change.*password|update.*password|save.*password|登录|登入|注册|修改.*密码|保存.*密码|更改.*密码|继续|next|continue/i;

/** Captures only credential form boundaries after a document grant and trusted interaction. */
export class CredentialObserver {
  readonly nonce = credentialIdentity();
  readonly forms: CredentialForms;
  readonly bridge: CredentialDocumentBridge;
  status: CredentialDocumentReply = empty();
  private interaction = new WeakMap<Element, number>();
  private listeners = new Set<(status: CredentialDocumentReply) => void>();
  private refreshing: Promise<void> | null = null;
  private url: string;
  private generation = 0;

  constructor(private document: Document, private send: Send, private now = Date.now) {
    this.forms = new CredentialForms(document);
    this.bridge = this.forms.bridge(this.nonce, token => this.status.unlocked && this.status.token === token ? this.generation : null);
    this.url = document.location.href;
  }

  subscribe(listener: (status: CredentialDocumentReply) => void): () => void {
    this.listeners.add(listener); listener(this.status);
    return () => { this.listeners.delete(listener); };
  }
  private publish(status: CredentialDocumentReply): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
  clear(): void {
    this.generation++; this.refreshing = null; this.interaction = new WeakMap(); this.publish(empty());
  }
  navigation(): void {
    if (this.document.location.href !== this.url) {
      this.url = this.document.location.href; this.clear(); void this.refresh();
    }
  }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (!sameOriginDocument(this.document.defaultView!)) { this.clear(); return Promise.resolve(); }
    const generation = this.generation;
    const work = (async () => {
      try {
        const reply = await this.send({ type: '1warden:credential-document', nonce: this.nonce }) as CredentialDocumentReply | { error: string };
        if (generation !== this.generation) return;
        if (!reply || 'error' in reply || !reply.unlocked || !reply.token) { this.clear(); return; }
        const origin = this.document.location.origin;
        const notices = Array.isArray(reply.notices) ? reply.notices.filter(notice => {
          try { return new URL(notice.url).origin === origin; } catch { return false; }
        }) : [];
        this.publish({ unlocked: true, token: reply.token, notices });
      } catch { if (generation === this.generation) this.clear(); }
    })();
    this.refreshing = work;
    void work.finally(() => { if (this.refreshing === work) this.refreshing = null; });
    return work;
  }

  /** Event.isTrusted is checked here as well as in the listener. Tests pass explicit event records. */
  async handle(event: ObservedEvent): Promise<void> {
    if (event.type === 'keydown' && (!event.isTrusted || event.key !== 'Enter')) return;
    if (!this.status.token || !sameOriginDocument(this.document.defaultView!) || !(event.target instanceof Element)) return;
    this.navigation();
    if (!this.status.token) return;
    let target: Element = event.target;
    const group = this.forms.group(target);
    if (!group) return;
    const isCredential = target === group.username || target === group.password || target === group.confirm || target === group.current;
    if (event.type === 'input') {
      if (event.isTrusted && isCredential) this.interaction.set(group.element, this.now());
      return; // Never send values for input/keystrokes.
    }
    let submitted = false;
    if (event.type === 'click') {
      if (!event.isTrusted) return;
      const button = target.closest('button, input[type="submit"], input[type="image"], [role="button"]');
      if (!button) return;
      const isSubmit = (button instanceof HTMLButtonElement && button.type === 'submit')
        || (button instanceof HTMLInputElement && ['submit', 'image'].includes(button.type));
      if (!isSubmit && !submitHint.test(`${button.textContent ?? ''} ${button.getAttribute('aria-label') ?? ''}`)) return;
      target = button; submitted = true;
      this.interaction.set(group.element, this.now());
    } else if (event.type === 'keydown') {
      if (!event.isTrusted || event.key !== 'Enter' || !isCredential) return;
      submitted = true; this.interaction.set(group.element, this.now());
    } else if (event.type === 'submit') {
      if (!(target instanceof HTMLFormElement)) return;
      submitted = true;
    } else if (!['change', 'blur'].includes(event.type) || !event.isTrusted || !isCredential) return;
    const recent = this.interaction.get(group.element);
    if (recent === undefined || this.now() - recent > 60_000) return;
    const token = this.status.token;
    const input = this.forms.snapshot(target, submitted);
    try {
      if (input) {
        // Values live only in this short-lived runtime request, never UI state or DOM attributes.
        const reply = await this.send({ type: '1warden:credential-capture', nonce: this.nonce, token, input }) as { error?: string } | undefined;
        if (reply?.error) this.clear();
      } else if (submitted && !group.password && group.username?.value.trim()
        && group.username.autocomplete.toLowerCase().split(/\s+/).includes('username')) {
        const reply = await this.send({ type: '1warden:credential-username', nonce: this.nonce, token, username: group.username.value.trim().slice(0, 1024) }) as { error?: string } | undefined;
        if (reply?.error) this.clear();
      }
    } catch { this.clear(); }
  }

  async generate(index: number, settings: GeneratorSettings, replace: boolean): Promise<{ error?: string }> {
    const token = this.status.token; const generation = this.generation;
    if (!token) return { error: '请先解锁 1Warden' };
    const target = await this.bridge.describe(index);
    if (this.generation !== generation || this.status.token !== token) return { error: '保险库或网页授权已改变，请重新点击生成' };
    if (!target) return { error: '密码输入框已改变，请重新选择' };
    try {
      const reply = await this.send({ type: '1warden:credential-generate', nonce: this.nonce, token,
        formId: target.formId, targetId: target.targetId, passwordIndex: index, settings, replace }) as { error?: string } | undefined;
      return reply ?? { error: '扩展没有响应，请重试' };
    } catch { this.clear(); return { error: '扩展暂时无法连接，请重新操作' }; }
  }
  async notice(id: string, action: 'review' | 'snooze'): Promise<{ error?: string }> {
    if (!this.status.token || !this.status.notices.some(notice => notice.id === id)) return { error: '提示已失效，请重新操作' };
    try {
      const reply = await this.send({ type: action === 'review' ? '1warden:credential-review' : '1warden:credential-snooze',
        nonce: this.nonce, token: this.status.token, id }) as { error?: string } | undefined;
      if (!reply?.error) this.publish({ ...this.status, notices: this.status.notices.filter(notice => notice.id !== id) });
      return reply ?? { error: '扩展没有响应，请重试' };
    } catch { this.clear(); return { error: '扩展暂时无法连接，请重新操作' }; }
  }
}

export function installCredentialObserver(): CredentialObserver {
  const observer = new CredentialObserver(document, request => ext.runtime.sendMessage(request));
  if (!sameOriginDocument(window)) return observer;
  (globalThis as unknown as { __onewardenCredential: CredentialDocumentBridge }).__onewardenCredential = observer.bridge;
  // Synchronous listener registration at document_start precedes site clearing handlers.
  for (const type of ['input', 'change', 'blur', 'click', 'keydown', 'submit']) {
    document.addEventListener(type, event => { void observer.handle(event); }, true);
  }
  ext.runtime.onMessage.addListener((message: unknown) => {
    if ((message as { type?: string })?.type === '1warden:credential-refresh') {
      observer.clear(); void observer.refresh();
    }
  });
  window.addEventListener('focus', () => { observer.navigation(); void observer.refresh(); });
  window.addEventListener('pageshow', () => { observer.navigation(); void observer.refresh(); });
  window.addEventListener('pagehide', () => observer.clear());
  window.addEventListener('popstate', () => observer.navigation());
  window.addEventListener('hashchange', () => observer.navigation());
  document.addEventListener('focusin', () => { observer.navigation(); void observer.refresh(); }, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { observer.navigation(); void observer.refresh(); } });
  void observer.refresh();
  return observer;
}
