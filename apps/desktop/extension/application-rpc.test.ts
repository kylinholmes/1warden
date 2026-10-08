import { describe, expect, it } from 'vitest';
import type { ApplicationService } from '../src/application/types';
import { authorizeRequest, createApplicationDispatcher, createSerialRunner, serializeError } from './application-rpc';

const runtime = { id: 'onewarden-id', getURL: (path: string) => `moz-extension://installed-uuid/${path}` };
const page = { id: 'onewarden-id', url: runtime.getURL('popup.html') };
const content = { id: 'onewarden-id', url: 'https://example.com', tab: { id: 7 } };

describe('application message authority', () => {
  it('accepts only the installed extension UI page for vault operations', () => {
    expect(() => authorizeRequest('1warden:application', page, runtime)).not.toThrow();
    for (const sender of [content, { ...page, id: 'other' }, { ...page, url: 'moz-extension://other/popup.html' },
      { ...page, url: runtime.getURL('offscreen.html') }, { id: 'onewarden-id' },
      { ...page, url: 'https://installed-uuid/popup.html' }]) {
      expect(() => authorizeRequest('1warden:application', sender, runtime)).toThrow();
      expect(() => authorizeRequest('1warden:list', sender, runtime)).toThrow();
      expect(() => authorizeRequest('1warden:copy', sender, runtime)).toThrow();
    }
  });

  it('limits content scripts to field reports, submissions and WebAuthn', () => {
    for (const type of ['1warden:fields', '1warden:submitted', '1warden:webauthn']) {
      expect(() => authorizeRequest(type, content, runtime)).not.toThrow();
      expect(() => authorizeRequest(type, { ...content, id: 'foreign' }, runtime)).toThrow();
      expect(() => authorizeRequest(type, { ...content, url: 'file:///etc/passwd' }, runtime)).toThrow();
    }
    expect(() => authorizeRequest('1warden:clipboard-copied', content, runtime)).toThrow();
  });
});

describe('application dispatcher', () => {
  it('returns the authoritative folder ID so the caller can assign an item', async () => {
    const folder = { id: 'server-folder-id', name: 'Work', nameFailed: false, updatedAt: '2026-10-09' };
    const dispatch = createApplicationDispatcher({ createFolder: async () => folder } as unknown as ApplicationService);
    await expect(dispatch({ method: 'createFolder', args: ['Work'] })).resolves.toEqual(folder);
  });

  it('search and detail remain available while a webpage operation holds the shared queue', async () => {
    const run = createSerialRunner();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const webpage = run(async () => { started(); await new Promise<void>((resolve) => { release = resolve; }); });
    await entered;
    const dispatch = createApplicationDispatcher({
      search: async () => [{ id: 'github' }],
      getItem: async () => ({ summary: { id: 'github' } }),
    } as unknown as ApplicationService, { run });
    try {
      await expect(Promise.race([
        Promise.all([dispatch({ method: 'search', args: ['github'] }), dispatch({ method: 'getItem', args: ['github'] })]),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ])).resolves.toEqual([[{ id: 'github' }], { summary: { id: 'github' } }]);
    } finally { release(); await webpage; }
  });

  it('rejects an in-flight local read when the account changes', async () => {
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const dispatch = createApplicationDispatcher({
      getItem: async () => { started(); await new Promise<void>((resolve) => { finish = resolve; }); return { secret: 'old' }; },
      switchAccount: async () => {},
    } as unknown as ApplicationService);
    const reading = dispatch({ method: 'getItem', args: ['github'] });
    const rejected = expect(reading).rejects.toThrow(/取消/);
    await entered;
    await dispatch({ method: 'switchAccount', args: [null] });
    finish(); await rejected;
  });

  it('returns snapshots while authentication is waiting for the server', async () => {
    let finish!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const service = {
      connect: async () => { await new Promise<void>((resolve) => { finish = resolve; markStarted(); }); },
      snapshot: async () => ({ status: 'loggedOut' }),
    } as unknown as ApplicationService;
    const dispatch = createApplicationDispatcher(service);
    const connecting = dispatch({ method: 'connect', args: [{ serverUrl: 'https://vault.test', email: 'a@b.com', masterPassword: 'test' }] });
    await started;
    try {
      await expect(Promise.race([
        dispatch({ method: 'snapshot', args: [] }),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ])).resolves.toEqual({ status: 'loggedOut' });
    } finally { finish(); await connecting; }
  });

  it('waits for durable lock cleanup before returning a concurrent snapshot', async () => {
    let finish!: () => void;
    const cleanup = new Promise<void>((resolve) => { finish = resolve; });
    let read = false;
    const dispatch = createApplicationDispatcher({
      lock: async () => {},
      snapshot: async () => { read = true; return { status: 'locked' }; },
    } as unknown as ApplicationService, { afterMutation: async () => cleanup });
    const locking = dispatch({ method: 'lock', args: [] });
    const snapshot = dispatch({ method: 'snapshot', args: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read).toBe(false);
    finish();
    await locking;
    await expect(snapshot).resolves.toEqual({ status: 'locked' });
  });

  it('discards a snapshot started before logout and reads the current generation', async () => {
    let finish!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let status = 'unlocked';
    const dispatch = createApplicationDispatcher({
      snapshot: async () => {
        const captured = status;
        if (captured === 'unlocked') await new Promise<void>((resolve) => { finish = resolve; markStarted(); });
        return { status: captured };
      },
      logout: async () => { status = 'loggedOut'; },
    } as unknown as ApplicationService);
    const snapshot = dispatch({ method: 'snapshot', args: [] });
    await started;
    await dispatch({ method: 'logout', args: [] });
    finish();
    await expect(snapshot).resolves.toEqual({ status: 'loggedOut' });
  });

  it('rejects inherited or unlisted methods and malformed arguments', async () => {
    const dispatch = createApplicationDispatcher({} as ApplicationService);
    for (const method of ['constructor', 'toString', 'exportState', '__proto__']) {
      await expect(dispatch({ method, args: [] })).rejects.toThrow();
    }
    await expect(dispatch({ method: 'snapshot', args: {} })).rejects.toThrow();
    await expect(dispatch({ method: 'getDraft', args: [7] })).rejects.toThrow();
  });

  it('locks immediately during a stalled write and discards its late result and persistence', async () => {
    let finishWrite!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let state = 'unlocked';
    let persisted = 'old';
    const events: string[] = [];
    const service = {
      saveItem: async () => { await new Promise<void>((r) => { finishWrite = r; markStarted(); }); state = 'edited'; return { id: '1' }; },
      lock: async () => { state = 'locked'; },
      snapshot: async () => ({ status: state }),
    } as unknown as ApplicationService;
    const dispatch = createApplicationDispatcher(service, {
      afterMutation: async () => { persisted = state; events.push(persisted); },
      onChanged: () => { events.push('changed'); },
    });
    const saving = dispatch({ method: 'saveItem', args: [{ id: '1' }] });
    const cancelled = expect(saving).rejects.toThrow();
    await started;
    await dispatch({ method: 'lock', args: [] });
    expect(persisted).toBe('locked');
    await expect(dispatch({ method: 'snapshot', args: [] })).resolves.toEqual({ status: 'locked' });
    finishWrite();
    await cancelled;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(persisted).toBe('locked');
    expect(events).toEqual(['locked', 'changed']);
  });

  it('does not make logout or later snapshots wait for a hanging breach query', async () => {
    let finishRead!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let status = 'unlocked';
    const service = {
      checkBreaches: async () => { await new Promise<void>((resolve) => { finishRead = resolve; markStarted(); }); return [{ itemId: 'secret', count: 1 }]; },
      logout: async () => { status = 'loggedOut'; },
      snapshot: async () => ({ status }),
    } as unknown as ApplicationService;
    const dispatch = createApplicationDispatcher(service);
    const reading = dispatch({ method: 'checkBreaches', args: [] });
    const cancelled = expect(reading).rejects.toThrow();
    await started;
    const loggingOut = dispatch({ method: 'logout', args: [] });
    const snapshot = dispatch({ method: 'snapshot', args: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(status).toBe('loggedOut');
    await expect(snapshot).resolves.toEqual({ status: 'loggedOut' });
    await loggingOut;
    finishRead();
    await cancelled;
  });

  it('persists partial imports on failure and continues accepting lock requests', async () => {
    let count = 0;
    let persisted = 0;
    const service = {
      importData: async () => { count = 2; throw new Error('network'); },
      lock: async () => { count = 0; },
    } as unknown as ApplicationService;
    const dispatch = createApplicationDispatcher(service, { afterMutation: async () => { persisted = count; } });
    await expect(dispatch({ method: 'importData', args: [{ name: 'a.json', dataBase64: '', format: 'bitwarden-json' }] })).rejects.toThrow('network');
    expect(persisted).toBe(2);
    await dispatch({ method: 'lock', args: [] });
    expect(persisted).toBe(0);
  });

  it('retains structured authentication errors without serializing arbitrary fields', () => {
    const error = Object.assign(new Error('OTP required'), {
      kind: 'auth', twoFactorRequired: true, providers: [0, 1], providersInfo: { 0: { Email: 'a***@b.com' } }, secret: 'never serialize',
    });
    expect(serializeError(error)).toEqual({
      message: 'OTP required', kind: 'auth', twoFactorRequired: true, providers: [0, 1], providersInfo: { 0: { Email: 'a***@b.com' } },
    });
  });
});

it('switch account cancels queued writes before selecting the next identity', async () => {
  let finish!: () => void;
  let start!: () => void;
  const started = new Promise<void>((r) => { start = r; });
  const events: string[] = [];
  const dispatch = createApplicationDispatcher({
    saveProfile: async () => { start(); await new Promise<void>((r) => { finish = r; }); },
    switchAccount: async () => { events.push('switch'); },
    createFolder: async () => { events.push('queued-write'); },
  } as unknown as ApplicationService);
  const writing = dispatch({ method: 'saveProfile', args: [{ displayName: 'A', avatarDataUrl: null }, null] });
  const cancelled = expect(writing).rejects.toThrow(/取消/);
  await started;
  const queued = dispatch({ method: 'createFolder', args: ['old-account-folder'] });
  const queueCancelled = expect(queued).rejects.toThrow(/取消/);
  await dispatch({ method: 'switchAccount', args: [{ serverUrl: 'https://next.example', email: 'next@example.com' }] });
  finish(); await cancelled; await queueCancelled;
  expect(events).toEqual(['switch']);
});

const resourceCalls = [
  ['uploadAttachment', ['record', 'file.bin', 'AID/']],
  ['deleteAttachment', ['record', 'attachment']],
  ['removePasskey', ['record', 'credential']],
  ['clearPasswordHistory', ['record']],
] as const;

describe('resource operation RPC contracts', () => {
  it.each(resourceCalls)('validates the exact %s argument list before invoking the service', async (method, valid) => {
    let invocations = 0;
    const dispatch = createApplicationDispatcher({ [method]: async () => { invocations++; } } as unknown as ApplicationService);
    const args = [...valid];
    const invalidTypes = args.map((_, index) => args.map((value, position) => position === index ? 7 : value));
    for (const malformed of [[], args.slice(0, -1), [...args, 'extra'], ...invalidTypes, [null, ...args.slice(1)], {}]) {
      await expect(dispatch({ method, args: malformed })).rejects.toThrow(/无效/);
    }
    expect(invocations).toBe(0);
    await dispatch({ method, args });
    expect(invocations).toBe(1);
  });

  it.each(resourceCalls)('routes %s and persists its resulting mutation before publishing a change', async (method, args) => {
    let state = 'before';
    let persisted = 'before';
    const events: string[] = [];
    const dispatch = createApplicationDispatcher({ [method]: async (...received: unknown[]) => {
      expect(received).toEqual([...args]);
      state = method;
    } } as unknown as ApplicationService, {
      afterMutation: async (called, succeeded) => {
        expect(called).toBe(method); expect(succeeded).toBe(true);
        persisted = state; events.push('persist');
      },
      onChanged: () => { expect(persisted).toBe(method); events.push('publish'); },
    });
    await dispatch({ method, args: [...args] });
    expect(persisted).toBe(method);
    expect(events).toEqual(['persist', 'publish']);
  });

  it.each(resourceCalls)('persists partial cleanup state when %s fails and reports the failure', async (method, args) => {
    let persisted = '';
    let state = 'before';
    const dispatch = createApplicationDispatcher({ [method]: async () => {
      state = 'cleaned-up'; throw Error('server rejected operation');
    } } as unknown as ApplicationService, { afterMutation: async (called, succeeded) => {
      expect(called).toBe(method); expect(succeeded).toBe(false); persisted = state;
    } });
    await expect(dispatch({ method, args: [...args] })).rejects.toThrow('server rejected operation');
    expect(persisted).toBe('cleaned-up');
  });

  it.each(resourceCalls)('discards late %s completion and persistence after account lock', async (method, args) => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const persisted: string[] = [];
    const dispatch = createApplicationDispatcher({
      [method]: async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); },
      lock: async () => {},
    } as unknown as ApplicationService, { afterMutation: async (called) => { persisted.push(called); } });
    const pending = dispatch({ method, args: [...args] });
    const cancelled = expect(pending).rejects.toThrow(/取消/);
    await started;
    await dispatch({ method: 'lock', args: [] });
    release();
    await cancelled;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(persisted).toEqual(['lock']);
  });
});

it.each(resourceCalls)('serializes %s behind an existing vault write', async (method, args) => {
  const run = createSerialRunner();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const blocking = run(async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); });
  await started;
  let called = false;
  const dispatch = createApplicationDispatcher({ [method]: async () => { called = true; } } as unknown as ApplicationService, { run });
  const resource = dispatch({ method, args: [...args] });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(called).toBe(false);
  } finally { release(); }
  await Promise.all([blocking, resource]);
  expect(called).toBe(true);
});
