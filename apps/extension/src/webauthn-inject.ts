/**
 * MAIN world 的 WebAuthn 拦截 —— 我们替浏览器回答 `navigator.credentials`。
 *
 * ## 为什么必须在 MAIN world
 *
 * 页面的 JS 调的是**页面自己那份** `navigator.credentials`。隔离世界（content
 * script 所在的那个）有独立的全局对象，在那里改 `navigator` 页面根本看不到。
 * 所以这份代码必须在 `world: "MAIN"` + `run_at: "document_start"` 下跑 ——
 * 晚一步页面就已经把原生的那个函数存进变量了。
 *
 * ## 它**看不到任何私钥**
 *
 * 这里只做「翻译」：把页面的参数序列化送出去，把结果重新包装成页面期望的对象。
 * 私钥、签名、会话密钥全在 background 里，从不进入页面。
 *
 * ## ⚠️ 这份代码在**页面自己的** JS 环境里运行
 *
 * 页面可以：改 `window.postMessage`、伪造回复、覆写我们的函数。所以
 * **不能信任这里送出去的任何东西** —— 尤其是 origin。background 一律以
 * `sender.origin`（浏览器给的）为准，页面在消息里怎么说都不作数。
 */

/** 消息标记。带前缀是为了不和页面自己的 postMessage 撞上 */
const TAG = 'coffer:webauthn';
const REPLY = 'coffer:webauthn-reply';

interface Reply {
  id: number;
  ok: boolean;
  /** 失败原因 */
  error?: string;
  /** 成功时的字段，全部是 base64url */
  credentialId?: string;
  clientDataJSON?: string;
  attestationObject?: string;
  authenticatorData?: string;
  signature?: string;
  userHandle?: string | null;
}

const pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
let nextId = 1;

function b64urlToBuf(s: string): ArrayBuffer {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function bufToB64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * ⚠️ 只认来自**本窗口**的回复。
 *
 * 嵌套 iframe 也能往父窗口 postMessage。不检查 `event.source` 的话，
 * 一个被嵌进来的广告 frame 就能伪造我们发出去的凭据字节。
 */
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as Reply & { tag?: string };
  if (!data || data.tag !== REPLY || typeof data.id !== 'number') return;

  const waiter = pending.get(data.id);
  if (!waiter) return;
  pending.delete(data.id);
  waiter.resolve(data);
});

function ask(payload: Record<string, unknown>): Promise<Reply> {
  const id = nextId++;
  return new Promise<Reply>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const message = { tag: TAG, id, ...payload };

    /**
     * ⚠️ **重发**，不是发一次就等。
     *
     * 这份脚本在 `document_start` 跑，而承载转发的 content script 在
     * `document_idle` —— 页面若在两者之间调用 WebAuthn（很常见：
     * 首屏就发登录挑战），第一次 postMessage 会打在空气里。
     *
     * 转发是幂等的（background 按 id 处理，重发只是重建同一个请求），
     * 所以重发安全。
     */
    window.postMessage(message, window.location.origin);
    const retry = setInterval(() => {
      if (!pending.has(id)) { clearInterval(retry); return; }
      window.postMessage(message, window.location.origin);
    }, 250);

    // 隔离世界始终没起来（扩展被禁用）时不能永远挂着 ——
    // 页面那边会表现为一个永不 settle 的 Promise，比抛错更难查
    setTimeout(() => {
      clearInterval(retry);
      if (!pending.delete(id)) return;
      reject(new Error('Coffer 没有响应，请确认扩展已启用并解锁'));
    }, 30_000);
  });
}

/** 把 ArrayBuffer 转成能过 postMessage 的 base64url */
function b64(v: ArrayBuffer | ArrayBufferView | undefined): string | null {
  if (v === undefined || v === null) return null;
  if (v instanceof ArrayBuffer) return bufToB64url(v);
  return bufToB64url(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
}

interface SerializedDescriptor {
  id: string;
  type: string;
  transports?: string[];
}

function serializeAllow(list: unknown): SerializedDescriptor[] | null {
  if (!Array.isArray(list)) return null;
  const out: SerializedDescriptor[] = [];
  for (const entry of list) {
    const e = entry as { id?: unknown; type?: unknown; transports?: string[] };
    if (!(e?.id instanceof ArrayBuffer) && !ArrayBuffer.isView(e?.id)) continue;
    const id = b64(e.id as ArrayBuffer);
    if (id === null) continue;
    const d: SerializedDescriptor = { id, type: typeof e.type === 'string' ? e.type : 'public-key' };
    if (Array.isArray(e.transports)) d.transports = e.transports;
    out.push(d);
  }
  return out;
}

/** 造一个「长得像平台对象」的凭据。原型对上了 `instanceof` 才会通过 */
function wrap<T>(proto: { prototype: object } | undefined, props: Record<string, unknown>): unknown {
  const obj: Record<string, unknown> = {};
  const descs: Record<string, PropertyDescriptor> = {};
  for (const [k, v] of Object.entries(props)) descs[k] = { value: v, enumerable: true };
  Object.defineProperties(obj, descs);
  if (proto) Object.setPrototypeOf(obj, proto.prototype);
  return obj;
}

function makeResponse(
  base: { clientDataJSON: ArrayBuffer },
  extra: Record<string, unknown>,
  proto: { prototype: object } | undefined,
): unknown {
  return wrap(proto, {
    clientDataJSON: base.clientDataJSON,
    ...extra,
    toJSON: () => ({}),
  });
}

async function handleCreate(options: CredentialCreationOptions): Promise<unknown> {
  const pk = options.publicKey!;
  const reply = await ask({
    op: 'create',
    challenge: b64(pk.challenge),
    rp: { id: pk.rp?.id ?? null, name: pk.rp?.name ?? '' },
    user: {
      id: b64(pk.user?.id),
      name: pk.user?.name ?? '',
      displayName: pk.user?.displayName ?? '',
    },
    authenticatorSelection: pk.authenticatorSelection ?? null,
  });
  if (!reply.ok) throw new DOMException(reply.error ?? '创建 passkey 失败', 'NotAllowedError');
  if (!reply.attestationObject || !reply.clientDataJSON) {
    throw new DOMException('Coffer 返回的数据不完整', 'UnknownError');
  }

  const response = makeResponse(
    { clientDataJSON: b64urlToBuf(reply.clientDataJSON) },
    {
      attestationObject: b64urlToBuf(reply.attestationObject),
      // 这两条有些库会调。我们没有做认证器证明，算法固定是 ES256
      getTransports: () => ['internal'],
      getPublicKeyAlgorithm: () => -7,
      getPublicKey: () => null,
      getAuthenticatorData: () => null,
    },
    (globalThis as { AuthenticatorAttestationResponse?: { prototype: object } }).AuthenticatorAttestationResponse,
  );

  return wrap(
    (globalThis as { PublicKeyCredential?: { prototype: object } }).PublicKeyCredential,
    {
      id: reply.credentialId,
      rawId: b64urlToBuf(reply.credentialId!),
      type: 'public-key',
      response,
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({}),
    },
  );
}

async function handleGet(options: CredentialRequestOptions): Promise<unknown> {
  const pk = options.publicKey!;
  const reply = await ask({
    op: 'get',
    rpId: pk.rpId ?? null,
    challenge: b64(pk.challenge),
    allowCredentials: serializeAllow(pk.allowCredentials),
    userVerification: pk.userVerification ?? 'preferred',
  });
  if (!reply.ok) throw new DOMException(reply.error ?? '没有可用的 passkey', 'NotAllowedError');
  if (!reply.authenticatorData || !reply.signature || !reply.clientDataJSON) {
    throw new DOMException('Coffer 返回的数据不完整', 'UnknownError');
  }

  const response = makeResponse(
    { clientDataJSON: b64urlToBuf(reply.clientDataJSON) },
    {
      authenticatorData: b64urlToBuf(reply.authenticatorData),
      signature: b64urlToBuf(reply.signature),
      userHandle: reply.userHandle ? b64urlToBuf(reply.userHandle) : null,
    },
    (globalThis as { AuthenticatorAssertionResponse?: { prototype: object } }).AuthenticatorAssertionResponse,
  );

  return wrap(
    (globalThis as { PublicKeyCredential?: { prototype: object } }).PublicKeyCredential,
    {
      id: reply.credentialId,
      rawId: b64urlToBuf(reply.credentialId!),
      type: 'public-key',
      response,
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({}),
    },
  );
}

function intercept(): void {
  const container = navigator.credentials as CredentialsContainer | undefined;
  if (!container) return;

  const origCreate = container.create.bind(container);
  const origGet = container.get.bind(container);

  container.create = ((options?: CredentialCreationOptions) =>
    options?.publicKey ? handleCreate(options) : origCreate(options)) as CredentialsContainer['create'];

  container.get = ((options?: CredentialRequestOptions) =>
    options?.publicKey ? handleGet(options) : origGet(options)) as CredentialsContainer['get'];
}

intercept();
