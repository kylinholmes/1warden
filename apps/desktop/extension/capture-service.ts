import { decideCapture, emptyLogin, matchItemsByUrl, type VaultItem } from '@1warden/vault';
import type { CaptureChoice, CapturePreview } from '../src/application/browser-credentials';
import type { HistoryOwner } from './generated-password-store';

export const CAPTURE_STATE_KEY = '1warden.credential-captures';
export interface CaptureOwner extends HistoryOwner {
  items(): readonly VaultItem[];
  save(item: VaultItem): Promise<VaultItem>;
  sync(): Promise<void>;
}
export interface CaptureSource { tabId: number; frameId: number; url: string; nonce: string; documentId?: string }
export interface FormCapture { formId: string; username: string | null; password: string; intent: 'login' | 'signup' | 'change'; submitted: boolean }
interface CaptureRecord extends FormCapture {
  id: string; revision: number; account: string; source: CaptureSource | null; url: string;
  createdAt: number; snoozed: boolean; uncertain: boolean;
}
interface DocumentGrant { source: CaptureSource; token: string; account: string; createdAt: number }
interface UsernameStep { account: string; tabId: number; origin: string; username: string; createdAt: number }
interface State { records: CaptureRecord[]; documents: DocumentGrant[]; usernames: UsernameStep[]; done: { id: string; account: string; createdAt: number }[] }
interface Area { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>, assertCurrent?: () => void): Promise<void>; remove(key: string): Promise<void> }
const sameDocument = (a: CaptureSource, b: CaptureSource) => a.tabId === b.tabId && a.frameId === b.frameId
  && a.nonce === b.nonce && a.documentId === b.documentId && new URL(a.url).origin === new URL(b.url).origin;
const validText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/** Caller serializes mutations and validates browser sender identity before invoking this store. */
export class CaptureService {
  constructor(private area: Area, private now = Date.now) {}
  private async read(): Promise<State> {
    const stored = (await this.area.get(CAPTURE_STATE_KEY))[CAPTURE_STATE_KEY] as State | undefined;
    const state: State = stored ?? { records: [], documents: [], usernames: [], done: [] };
    state.records = state.records.filter(r => this.now() - r.createdAt < (r.submitted ? 30 : 2) * 60_000);
    state.documents = state.documents.filter(r => this.now() - r.createdAt < 30 * 60_000);
    state.usernames = state.usernames.filter(r => this.now() - r.createdAt < 5 * 60_000);
    state.done = state.done.filter(r => this.now() - r.createdAt < 30 * 60_000).slice(-100);
    return state;
  }
  private async write(owner: HistoryOwner, state: State): Promise<void> {
    owner.assertCurrent();
    await this.area.set({ [CAPTURE_STATE_KEY]: state }, () => owner.assertCurrent());
    owner.assertCurrent();
  }
  async register(owner: HistoryOwner, source: CaptureSource): Promise<string> {
    owner.assertCurrent();
    const state = await this.read();
    const existing = state.documents.find(d => d.account === owner.account && sameDocument(d.source, source));
    if (existing) { existing.createdAt = this.now(); existing.source = source; await this.write(owner, state); return existing.token; }
    const token = crypto.randomUUID();
    // Keep earlier grants briefly: a submission can arrive after the next page's handshake.
    // They authorize receipt of the old form only; injection also verifies a live nonce.
    state.documents.push({ source, token, account: owner.account, createdAt: this.now() });
    state.documents = state.documents.slice(-200);
    await this.write(owner, state);
    return token;
  }
  async authorize(owner: HistoryOwner, source: CaptureSource, token: string): Promise<CaptureSource> {
    owner.assertCurrent();
    const state = await this.read();
    const grant = state.documents.find(d => d.account === owner.account && d.token === token && sameDocument(d.source, source));
    if (!grant)
      throw new Error('页面或保险库状态已改变，请重新操作');
    owner.assertCurrent();
    return grant.source;
  }
  async username(owner: HistoryOwner, source: CaptureSource, token: string, username: string): Promise<void> {
    await this.authorize(owner, source, token);
    if (!validText(username, 1024) || !username.trim()) return;
    const state = await this.read(); const origin = new URL(source.url).origin;
    state.usernames = state.usernames.filter(r => r.account !== owner.account || r.tabId !== source.tabId || r.origin !== origin);
    state.usernames.push({ account: owner.account, tabId: source.tabId, origin, username: username.trim(), createdAt: this.now() });
    await this.write(owner, state);
  }
  async capture(owner: CaptureOwner, source: CaptureSource, token: string, input: FormCapture): Promise<CapturePreview | null> {
    await this.authorize(owner, source, token);
    if (!input || !validText(input.formId, 128) || !validText(input.password, 4096)
      || !(input.username === null || validText(input.username, 1024))
      || !['login', 'signup', 'change'].includes(input.intent) || typeof input.submitted !== 'boolean') throw new Error('无效的表单信息');
    const state = await this.read();
    const username = input.username?.trim() || state.usernames.find(r => r.account === owner.account
      && r.tabId === source.tabId && r.origin === new URL(source.url).origin)?.username || null;
    const decision = decideCapture({ url: source.url, username, password: input.password }, owner.items());
    if (decision.kind === 'none') {
      if (input.submitted) {
        state.records = state.records.filter(r => !(r.account === owner.account && r.source && sameDocument(r.source, source)
          && r.formId === input.formId && r.username === username));
        await this.write(owner, state);
      }
      return null;
    }
    const existing = state.records.find(r => r.account === owner.account && r.source && sameDocument(r.source, source)
      && r.formId === input.formId && r.username === username && r.submitted === input.submitted);
    if (existing && existing.password === input.password) return existing.submitted ? this.preview(owner, existing) : null;
    const record: CaptureRecord = { ...input, username, id: existing?.id ?? crypto.randomUUID(), revision: (existing?.revision ?? 0) + 1,
      source, url: source.url, account: owner.account, createdAt: this.now(), snoozed: false, uncertain: false };
    state.records = state.records.filter(r => r.id !== record.id && !(input.submitted && !r.submitted && r.source
      && sameDocument(r.source, source) && r.formId === input.formId));
    state.records.push(record);
    const thisTab = state.records.filter(r => r.source?.tabId === source.tabId && r.submitted).slice(-3).map(r => r.id);
    state.records = state.records.filter(r => r.source?.tabId !== source.tabId || !r.submitted || thisTab.includes(r.id)).slice(-200);
    await this.write(owner, state);
    return input.submitted ? this.preview(owner, record) : null;
  }
  private preview(owner: CaptureOwner, record: CaptureRecord): CapturePreview {
    const decision = decideCapture({ url: record.url, username: record.username, password: record.password }, owner.items());
    const targets = matchItemsByUrl(owner.items(), record.url).filter(i => i.type === 'login').map(i => ({
      id: i.id, title: i.name, username: i.login?.username ?? '', updatedAt: i.updatedAt,
    }));
    const action = decision.kind === 'none' ? 'save' : record.intent === 'signup' && decision.kind === 'update' ? 'review' : decision.kind;
    return { id: record.id, revision: record.revision, url: record.url, username: record.username, action,
      itemId: action === 'update' && decision.kind === 'update' ? decision.itemId : null, targets,
      tabId: record.source?.tabId ?? null, createdAt: record.createdAt, snoozed: record.snoozed, source: record.source ? 'form' : 'history' };
  }
  async list(owner: CaptureOwner): Promise<CapturePreview[]> {
    const state = await this.read(); owner.assertCurrent();
    return state.records.filter(r => r.account === owner.account && r.submitted).reverse().map(r => this.preview(owner, r));
  }
  async notices(owner: CaptureOwner, source: CaptureSource): Promise<CapturePreview[]> {
    const state = await this.read(); owner.assertCurrent();
    return state.records.filter(r => r.account === owner.account && r.submitted && r.source?.tabId === source.tabId
      && r.source.frameId === source.frameId && new URL(r.url).origin === new URL(source.url).origin)
      .reverse().map(r => this.preview(owner, r));
  }
  async recover(owner: CaptureOwner, row: { id: string; url: string; password: string }): Promise<CapturePreview> {
    const state = await this.read();
    const record: CaptureRecord = { id: crypto.randomUUID(), revision: 1, account: owner.account, source: null,
      url: row.url, formId: row.id, username: null, password: row.password, intent: 'login', submitted: true,
      createdAt: this.now(), snoozed: true, uncertain: false };
    state.records.push(record); await this.write(owner, state); return this.preview(owner, record);
  }
  async dismiss(owner: HistoryOwner, id: string, snooze = false): Promise<void> {
    const state = await this.read(); const row = state.records.find(r => r.id === id && r.account === owner.account);
    if (!row) return;
    if (snooze) row.snoozed = true; else state.records = state.records.filter(r => r !== row);
    await this.write(owner, state);
  }
  async save(owner: CaptureOwner, choice: CaptureChoice): Promise<void> {
    const state = await this.read(); owner.assertCurrent();
    if (state.done.some(r => r.account === owner.account && r.id === choice.captureId)) return;
    const record = state.records.find(r => r.account === owner.account && r.id === choice.captureId && r.submitted);
    if (!record) throw new Error('待保存信息已过期，请重新提交');
    if (record.revision !== choice.revision) throw new Error('提交内容已变化，请重新检查');
    if (!['save', 'update'].includes(choice.action) || (choice.username !== undefined && !validText(choice.username, 1024))) throw new Error('无效的保存选择');
    const username = choice.username?.trim() || record.username;
    if (record.uncertain) {
      await owner.sync(); owner.assertCurrent();
      const found = matchItemsByUrl(owner.items(), record.url).some(i => i.login?.password === record.password
        && (choice.action === 'update' ? i.id === choice.itemId : i.login?.username === username));
      if (!found) throw new Error('上次保存结果尚未确认，请先同步并检查保险库，避免重复创建');
    } else {
      const matches = matchItemsByUrl(owner.items(), record.url).filter(i => i.type === 'login');
      let item: VaultItem;
      if (choice.action === 'update') {
        const existing = matches.find(i => i.id === choice.itemId);
        if (!existing?.login) throw new Error('请选择此网站的有效登录条目');
        if (existing.updatedAt !== choice.targetUpdatedAt) throw new Error('目标条目已变化，请重新检查');
        item = { ...existing, login: { ...existing.login, password: record.password,
          username: existing.login.username || (choice.username !== undefined ? choice.username.trim() || null : existing.login.username) } };
        if (existing.login.password === record.password && existing.login.username === item.login?.username) {
          await this.finish(owner, state, record); return;
        }
      } else {
        if (matches.some(i => i.login?.username === username && i.login.password === record.password)) {
          await this.finish(owner, state, record); return;
        }
        item = newCapturedLogin(record.url, username, record.password);
      }
      // Record intent before network I/O, so worker restart cannot blindly replay a create.
      record.uncertain = true; await this.write(owner, state);
      try { await owner.save(item); owner.assertCurrent(); }
      catch (error) {
        // A known server rejection is safe to correct and retry. Network loss is ambiguous.
        if (typeof error === 'object' && error !== null && 'status' in error && Number(error.status) >= 400) {
          record.uncertain = false; await this.write(owner, state);
          if (Number(error.status) === 409 || Number(error.status) === 412) {
            await owner.sync(); owner.assertCurrent();
            throw new Error('目标条目已变化，请重新检查后保存');
          }
        }
        throw error;
      }
    }
    await this.finish(owner, state, record);
  }
  private async finish(owner: HistoryOwner, state: State, record: CaptureRecord): Promise<void> {
    state.records = state.records.filter(r => r.id !== record.id);
    state.done.push({ id: record.id, account: owner.account, createdAt: this.now() });
    await this.write(owner, state);
  }
  async clearTab(owner: HistoryOwner, tabId: number): Promise<void> {
    const state = await this.read();
    state.records = state.records.filter(r => r.source?.tabId !== tabId);
    state.documents = state.documents.filter(r => r.source.tabId !== tabId);
    state.usernames = state.usernames.filter(r => r.tabId !== tabId);
    await this.write(owner, state);
  }
}

export function newCapturedLogin(url: string, username: string | null, password: string): VaultItem {
  return { id: '', type: 'login', rawType: 1, name: new URL(url).hostname.replace(/^www\./, ''), nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: { ...emptyLogin(), username, password, uris: [{ uri: url, match: null }] },
    card: null, identity: null, secureNote: null, sshKey: null, customFields: [], passwordHistory: [], attachments: [] };
}
