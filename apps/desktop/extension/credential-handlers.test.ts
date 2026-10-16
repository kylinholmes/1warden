import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeUserKey } from '@1warden/crypto';
import { createCredentialController } from './credential-handlers';
import { authorizeRequest } from './application-rpc';
import type { CaptureOwner } from './capture-service';
import type { StorageArea } from './session-store';
import type { CredentialDocumentBridge, CredentialDocumentReply, CredentialRequest, GenerationTarget, GenerationFillGrant } from './credential-protocol';

interface ScriptRequest {
  target: { tabId: number; documentIds?: string[]; frameIds?: number[] };
  func: typeof import('./credential-protocol').inspectGeneration | typeof import('./credential-protocol').injectGeneratedPassword | typeof import('./credential-protocol').credentialDocumentMatches;
  args: unknown[];
}
const browser = vi.hoisted(() => ({
  getTab: vi.fn(), queryTabs: vi.fn(), sendMessage: vi.fn(), executeScript: vi.fn<(request: ScriptRequest) => Promise<{ result: unknown }[]>>(),
  badge: vi.fn(), openPopup: vi.fn(), createTab: vi.fn(),
}));
const runtime = { id: 'installed-extension', getURL: (path: string) => `chrome-extension://installed-extension/${path}` };
vi.mock('./ext-api', () => ({ ext: {
  tabs: { get: browser.getTab, query: browser.queryTabs, sendMessage: browser.sendMessage, create: browser.createTab },
  action: { setBadgeText: browser.badge, openPopup: browser.openPopup },
  scripting: { executeScript: browser.executeScript },
  runtime: { id: 'installed-extension', getURL: (path: string) => `chrome-extension://installed-extension/${path}` },
} }));

function area() {
  const data: Record<string, unknown> = {};
  const storage: StorageArea = {
    async get(keys) {
      return structuredClone(keys === null ? data : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])));
    },
    async set(items) { Object.assign(data, structuredClone(items)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    async clear() { for (const key of Object.keys(data)) delete data[key]; },
  };
  return { data, storage };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const session = area(); const local = area(); const operations: string[] = [];
  let unlocked = true; let selected = 'account-a'; let currentUrl = 'https://example.test/signup';
  const owner: CaptureOwner = {
    account: 'account-a', key: makeUserKey(),
    assertCurrent() { if (!unlocked || selected !== owner.account) throw Error('Owner locked or changed'); },
    items: () => [], save: vi.fn(async item => item), sync: async () => {},
  };
  const controller = createCredentialController({ session: session.storage, local: local.storage,
    owner() { owner.assertCurrent(); return owner; }, changed: vi.fn(), persist: vi.fn(async () => {}),
  });
  const sender: chrome.runtime.MessageSender = {
    id: runtime.id, url: currentUrl, frameId: 0, documentId: 'document-a', tab: { id: 7 } as chrome.tabs.Tab,
  };
  const popup: chrome.runtime.MessageSender = { id: runtime.id, url: runtime.getURL('popup.html') };
  const nonce = 'document-nonce-a';
  const target: GenerationTarget = { formId: 'form-a', targetId: 'password-a:confirm-a', passwordIndex: 0, confirmIndex: 1,
    minLength: 8, maxLength: 64, needsReplacement: false };
  const describe = vi.fn(async () => target);
  const fill = vi.fn(async (_index: number, _password: string, _replace: boolean, expected: GenerationFillGrant): Promise<{ ok: boolean; error?: string }> => {
    if (expected.targetId !== target.targetId || expected.formId !== target.formId) return { ok: false, error: '密码输入框已改变' };
    operations.push('fill'); return { ok: true };
  });
  const bridge: CredentialDocumentBridge = { nonce, describe, fill };
  vi.stubGlobal('__onewardenCredential', bridge);
  browser.getTab.mockImplementation(async () => ({ id: 7, url: currentUrl }));
  browser.executeScript.mockImplementation(async request => {
    operations.push(request.args.length === 2 ? 'inspect' : 'inject');
    const invoke = request.func as (...args: unknown[]) => Promise<unknown>;
    return [{ result: structuredClone(await invoke(...request.args)) }];
  });
  const dispatch = (request: CredentialRequest, from = sender) => {
    authorizeRequest(request.type, from, runtime);
    return controller.handle(request, from);
  };
  const document = async (from = sender) => await dispatch({ type: '1warden:credential-document', nonce }, from) as CredentialDocumentReply;
  const generation = (token: string): Extract<CredentialRequest, { type: '1warden:credential-generate' }> => ({
    type: '1warden:credential-generate', token, nonce, formId: 'form-a', targetId: 'password-a:confirm-a', passwordIndex: 0,
    settings: { length: 20, digits: true, symbols: false }, replace: false,
  });
  return { controller, dispatch, document, generation, sender, popup, owner, nonce, target, bridge, describe, fill,
    local, session, operations, lock: () => { unlocked = false; }, switchAccount: () => { selected = 'account-b'; },
    navigate: (url: string) => { currentUrl = url; } };
}
beforeEach(() => {
  vi.clearAllMocks(); browser.queryTabs.mockResolvedValue([{ id: 7 }]); browser.sendMessage.mockResolvedValue(undefined);
  browser.badge.mockResolvedValue(undefined); browser.openPopup.mockResolvedValue(undefined); browser.createTab.mockResolvedValue({ id: 8 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('credential controller browser authority', () => {
  it('rejects an expired explicit review link instead of showing an unrelated capture', async () => {
    const f = fixture();
    await expect(f.dispatch({ type: '1warden:credential-list', captureId: 'expired' }, f.popup)).rejects.toThrow(/过期/);
    await expect(f.dispatch({ type: '1warden:credential-list' }, f.popup)).resolves.toEqual([]);
  });
  it('rejects foreign extension senders and content requests for recovery secrets before executing the controller', async () => {
    const f = fixture();
    expect(() => f.dispatch({ type: '1warden:credential-document', nonce: f.nonce }, { ...f.sender, id: 'foreign' })).toThrow();
    expect(() => f.dispatch({ type: '1warden:credential-reveal-history', id: 'history-id' })).toThrow();
    expect(() => f.dispatch({ type: '1warden:credential-list' })).toThrow();
    expect(browser.executeScript).not.toHaveBeenCalled(); expect(f.session.data).toEqual({});
  });
  it.each([
    { frameId: undefined }, { frameId: 0.5 }, { tab: undefined }, { url: undefined },
    { url: 'file:///private' }, { url: 'https://user:password@example.test/signup' },
  ])('rejects missing or invalid browser document identity %j', async patch => {
    const f = fixture();
    const sender = { ...f.sender, ...patch } as chrome.runtime.MessageSender;
    // Exercise controller-side source validation as well as outer RPC authorization.
    await expect(f.controller.handle({ type: '1warden:credential-document', nonce: f.nonce }, sender)).rejects.toThrow();
    expect(f.session.data).toEqual({});
  });
  it.each(['short', 'x'.repeat(129)])('rejects an invalid document nonce', async nonce => {
    const f = fixture(); await expect(f.dispatch({ type: '1warden:credential-document', nonce })).rejects.toThrow();
    expect(f.session.data).toEqual({});
  });
  it('rejects a navigated top-level document and cross-origin iframe while allowing a same-origin iframe', async () => {
    const f = fixture();
    f.bridge.nonce = 'different-live-document';
    await expect(f.document({ ...f.sender, url: 'https://example.test/old-page' })).rejects.toThrow(/网页已改变/);
    f.bridge.nonce = f.nonce;
    browser.executeScript.mockClear();
    await expect(f.document({ ...f.sender, frameId: 3, url: 'https://foreign.test/frame' })).rejects.toThrow(/iframe/);
    const iframe = { ...f.sender, frameId: 3, url: 'https://example.test/frame', documentId: 'frame-document' };
    const grant = await f.document(iframe);
    await f.dispatch(f.generation(grant.token!), iframe);
    expect(browser.executeScript.mock.calls[0]![0].target).toEqual({ tabId: 7, documentIds: ['frame-document'] });
  });
  it('accepts a same-document SPA URL change only after verifying the live isolated nonce', async () => {
    const f = fixture();
    await f.document(); f.navigate('https://example.test/new-step');
    const grant = await f.document();
    await f.dispatch({ type: '1warden:credential-capture', nonce: f.nonce, token: grant.token!, input: {
      formId: 'form', username: 'alice', password: 'synthetic', intent: 'login', submitted: true,
    } });
    expect(await f.dispatch({ type: '1warden:credential-list' }, f.popup)).toMatchObject([{ url: 'https://example.test/new-step' }]);
  });
  it.each([
    { frameId: 1 }, { documentId: 'replaced-document' },
    { tab: { id: 9 } as chrome.tabs.Tab }, { url: 'https://foreign.test/signup' },
  ])('binds a document grant to its browser tab, frame, document and origin %j', async patch => {
    const f = fixture(); const grant = await f.document();
    await expect(f.dispatch(f.generation(grant.token!), { ...f.sender, ...patch })).rejects.toThrow();
    expect(browser.executeScript).not.toHaveBeenCalled(); expect(f.local.data).toEqual({});
  });
  it('uses an explicit frame target on browsers without document IDs', async () => {
    const f = fixture(); const { documentId: _documentId, ...sender } = f.sender;
    const grant = await f.document(sender); await f.dispatch(f.generation(grant.token!), sender);
    expect(browser.executeScript.mock.calls.every(([request]) => JSON.stringify(request.target) === JSON.stringify({ tabId: 7, frameIds: [0] }))).toBe(true);
  });
  it('reports a locked document without granting capture or returning account data', async () => {
    const f = fixture(); f.lock();
    await expect(f.document()).resolves.toEqual({ unlocked: false, token: null, notices: [] });
    expect(f.session.data).toEqual({}); expect(browser.executeScript).not.toHaveBeenCalled();
  });
});

describe('credential controller generation and recovery', () => {
  it('commits encrypted history before the first password assignment and returns only success to content', async () => {
    const f = fixture(); const grant = await f.document();
    const write = f.local.storage.set;
    vi.spyOn(f.local.storage, 'set').mockImplementation(async items => { f.operations.push('persist-history'); await write(items); });
    f.fill.mockImplementation(async (_index, password) => {
      f.operations.push('fill');
      expect(Object.keys(f.local.data)).toEqual(['1warden.generated-passwords:account-a']);
      expect(JSON.stringify(f.local.data)).not.toContain(password);
      expect(JSON.stringify(f.local.data)).not.toContain('example.test');
      return { ok: true };
    });
    await expect(f.dispatch(f.generation(grant.token!))).resolves.toEqual({ ok: true });
    expect(f.operations).toEqual(['inspect', 'persist-history', 'inject', 'fill']);
    const password = f.fill.mock.calls[0]![1]; expect(password).toHaveLength(20);
    const history = await f.dispatch({ type: '1warden:credential-history' }, f.popup) as Array<{ id: string }>;
    expect(history).toHaveLength(1); expect(JSON.stringify(history)).not.toContain(password);
    await expect(f.dispatch({ type: '1warden:credential-reveal-history', id: history[0]!.id }, f.popup)).resolves.toBe(password);
  });
  it('forbids filling if encrypted recovery cannot be persisted', async () => {
    const f = fixture(); const grant = await f.document();
    vi.spyOn(f.local.storage, 'set').mockRejectedValue(Error('Disk quota denied'));
    await expect(f.dispatch(f.generation(grant.token!))).rejects.toThrow('Disk quota denied');
    expect(f.fill).not.toHaveBeenCalled(); expect(browser.executeScript).toHaveBeenCalledTimes(1);
  });
  it('retains encrypted recovery if the field cannot be filled after generation', async () => {
    const f = fixture(); const grant = await f.document();
    f.fill.mockResolvedValue({ ok: false, error: 'Field is no longer available' });
    await expect(f.dispatch(f.generation(grant.token!))).rejects.toThrow('Field is no longer available');
    const history = await f.dispatch({ type: '1warden:credential-history' }, f.popup) as Array<{ id: string }>;
    expect(history).toHaveLength(1);
    await expect(f.dispatch({ type: '1warden:credential-reveal-history', id: history[0]!.id }, f.popup)).resolves.toBe(f.fill.mock.calls[0]![1]);
  });
  it('clamps a requested length to the actual field constraints and requires explicit replacement confirmation', async () => {
    const f = fixture(); const grant = await f.document(); f.target.minLength = 24; f.target.maxLength = 28; f.target.needsReplacement = true;
    await expect(f.dispatch(f.generation(grant.token!))).rejects.toThrow(/确认替换/);
    expect(f.local.data).toEqual({}); expect(f.fill).not.toHaveBeenCalled();
    await f.dispatch({ ...f.generation(grant.token!), replace: true });
    expect(f.fill.mock.calls[0]![1]).toHaveLength(24); expect(f.fill.mock.calls[0]![2]).toBe(true);
  });
  it.each([
    { settings: { length: 7, digits: true, symbols: false } }, { settings: { length: 65, digits: true, symbols: false } },
    { settings: { length: 12.5, digits: true, symbols: false } }, { settings: { length: 20, digits: 'yes', symbols: false } },
    { settings: { length: 20, digits: true, symbols: null } }, { passwordIndex: -1 }, { passwordIndex: 0.5 },
    { formId: null }, { replace: 'yes' },
  ])('rejects invalid generator settings without inspecting or writing a field %j', async patch => {
    const f = fixture(); const grant = await f.document();
    await expect(f.dispatch({ ...f.generation(grant.token!), ...patch } as CredentialRequest)).rejects.toThrow(/无效/);
    expect(browser.executeScript).not.toHaveBeenCalled(); expect(f.local.data).toEqual({});
  });
  it.each(['form', 'index', 'constraints'] as const)('rejects a mismatched generation target or unsupported constraints: %s', async kind => {
    const f = fixture(); const grant = await f.document();
    if (kind === 'form') f.target.formId = 'another-form';
    if (kind === 'index') f.target.passwordIndex = 4;
    if (kind === 'constraints') { f.target.minLength = 80; f.target.maxLength = 90; }
    await expect(f.dispatch(f.generation(grant.token!))).rejects.toThrow(kind === 'constraints' ? /长度要求/ : /密码框已改变/);
    expect(f.fill).not.toHaveBeenCalled(); expect(f.local.data).toEqual({});
  });
});

describe('credential controller asynchronous guards', () => {
  it('rejects a request carrying an obsolete isolated-world nonce before generating a password', async () => {
    const f = fixture(); const grant = await f.document(); f.bridge.nonce = 'replacement-nonce';
    await expect(f.dispatch(f.generation(grant.token!))).rejects.toThrow(/密码框已改变/);
    expect(f.describe).not.toHaveBeenCalled(); expect(f.fill).not.toHaveBeenCalled(); expect(f.local.data).toEqual({});
  });
  it.each(['lock', 'switch'] as const)('does not persist or fill if the owner changes during field inspection: %s', async kind => {
    const f = fixture(); const grant = await f.document(); const started = deferred(); const release = deferred();
    f.describe.mockImplementation(async () => { started.resolve(); await release.promise; return f.target; });
    const operation = f.dispatch(f.generation(grant.token!)); const rejected = expect(operation).rejects.toThrow(/Owner locked or changed/);
    await started.promise; if (kind === 'lock') f.lock(); else f.switchAccount(); release.resolve(); await rejected;
    expect(f.local.data).toEqual({}); expect(f.fill).not.toHaveBeenCalled();
  });
  it('does not assign a password if the owner locks while encrypted history is being written', async () => {
    const f = fixture(); const grant = await f.document(); const started = deferred(); const release = deferred(); const write = f.local.storage.set;
    vi.spyOn(f.local.storage, 'set').mockImplementation(async items => { started.resolve(); await release.promise; await write(items); });
    const operation = f.dispatch(f.generation(grant.token!)); const rejected = expect(operation).rejects.toThrow(/Owner locked or changed/);
    await started.promise; f.lock(); release.resolve(); await rejected;
    expect(browser.executeScript).toHaveBeenCalledTimes(1); expect(f.fill).not.toHaveBeenCalled();
    expect(Object.keys(f.local.data)).toEqual(['1warden.generated-passwords:account-a']);
  });
  it('keeps recovery but refuses replacing input identities while encrypted history persistence is deferred', async () => {
    const f = fixture(); const grant = await f.document(); const started = deferred(); const release = deferred(); const write = f.local.storage.set;
    vi.spyOn(f.local.storage, 'set').mockImplementation(async items => { started.resolve(); await release.promise; await write(items); });
    const operation = f.dispatch(f.generation(grant.token!)); const rejected = expect(operation).rejects.toThrow(/密码输入框已改变/);
    await started.promise; f.target.targetId = 'replacement-password:replacement-confirm'; release.resolve(); await rejected;
    expect(f.fill.mock.calls[0]![3]).toMatchObject({ formId: 'form-a', targetId: 'password-a:confirm-a', token: grant.token });
    expect(f.operations).not.toContain('fill');
    expect(Object.keys(f.local.data)).toEqual(['1warden.generated-passwords:account-a']);
  });
  it.each(['navigation', 'nonce'] as const)('keeps recovery but refuses stale document assignment after history persistence: %s', async kind => {
    const f = fixture(); const grant = await f.document(); const write = f.local.storage.set;
    vi.spyOn(f.local.storage, 'set').mockImplementation(async items => {
      await write(items); if (kind === 'navigation') f.navigate('https://example.test/next');
      f.bridge.nonce = 'new-document-nonce';
    });
    await expect(f.dispatch(f.generation(grant.token!))).rejects.toThrow(/网页已改变/);
    expect(f.fill).not.toHaveBeenCalled(); expect(Object.keys(f.local.data)).toEqual(['1warden.generated-passwords:account-a']);
  });
  it('permits a late submission from an authorized old document but never returns its captured password to content', async () => {
    const f = fixture(); const grant = await f.document(); f.navigate('https://example.test/success');
    const secret = 'synthetic-captured-password';
    await expect(f.dispatch({ type: '1warden:credential-capture', nonce: f.nonce, token: grant.token!,
      input: { formId: 'form-a', username: 'person', password: secret, intent: 'login', submitted: true } })).resolves.toEqual({ ok: true });
    const next = await f.document({ ...f.sender, url: 'https://example.test/success', documentId: 'document-b' });
    expect(next.notices).toHaveLength(1); expect(JSON.stringify(next)).not.toContain(secret);
    expect(Object.keys(next.notices[0]!).sort()).toEqual(['action', 'id', 'revision', 'url', 'username']);
    expect(browser.sendMessage.mock.calls.every(call => !JSON.stringify(call).includes(secret))).toBe(true);
  });
});
