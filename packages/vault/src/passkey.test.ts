import { describe, it, expect } from 'vitest';
import { createPasskey, assertPasskey, coseEs256 } from './passkey';
import { encodeCbor } from './cbor';

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64url');
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64url'));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** ⚠️ TS 5.7 起 `Uint8Array` 带 buffer 类型参数，裸的 `Uint8Array` 是 `<ArrayBufferLike>`，
 *  而 WebCrypto 要 `<ArrayBuffer>`。仓库的约定是就地断言（见 @coffer/crypto 的 bytes.ts）。 */
const bs = (u: Uint8Array): BufferSource => u as BufferSource;
const digest = async (d: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', bs(d)));

/**
 * 测试用的小 CBOR 解码器。
 *
 * ⚠️ **必须有它**。只断言「这几段字节拼起来等于某串十六进制」是自证：
 * 期望值是照着自己的实现写出来的，实现错了期望值也一起错。
 * 解出来再按语义检查（这是一个映射、键 3 的值是 -7、x 坐标是 32 字节……），
 * 才验证的是「结构对不对」而不是「和上次输出一样」。
 */
function cborDecode(b: Uint8Array, at = { i: 0 }): unknown {
  const first = b[at.i++]!;
  const major = first >> 5;
  let len = first & 0x1f;
  if (len === 24) len = b[at.i++]!;
  else if (len === 25) { len = (b[at.i]! << 8) | b[at.i + 1]!; at.i += 2; }
  else if (len === 26) { len = (b[at.i]! << 24) | (b[at.i + 1]! << 16) | (b[at.i + 2]! << 8) | b[at.i + 3]!; at.i += 4; }

  switch (major) {
    case 0: return len;
    case 1: return -1 - len;
    case 2: { const out = b.slice(at.i, at.i + len); at.i += len; return out; }
    case 3: { const out = new TextDecoder().decode(b.slice(at.i, at.i + len)); at.i += len; return out; }
    case 4: { const out = []; for (let n = 0; n < len; n++) out.push(cborDecode(b, at)); return out; }
    case 5: {
      const out = new Map<unknown, unknown>();
      for (let n = 0; n < len; n++) out.set(cborDecode(b, at), cborDecode(b, at));
      return out;
    }
    default: throw new Error(`测试解码器不支持 major=${major}`);
  }
}

/**
 * 从 attestationObject 里取出 RP 会拿到的那把公钥。
 *
 * 断言测试就用它来验签 —— 走的是和真实 RP 完全一样的路径：
 * 注册时发出去的那把公钥，必须能验过之后每一次断言。
 * 换成「从私钥重新导出公钥」的话，验证的就不是发出去的那把了。
 */
async function publicKeyFrom(attestationObject: Uint8Array): Promise<CryptoKey> {
  const obj = cborDecode(attestationObject) as Map<string, unknown>;
  const auth = obj.get('authData') as Uint8Array;
  const credIdLen = (auth[53]! << 8) | auth[54]!;
  const cose = cborDecode(auth.slice(55 + credIdLen)) as Map<number, unknown>;

  const raw = new Uint8Array(65);   // 未压缩点：04 || x || y
  raw[0] = 4;
  raw.set(cose.get(-2) as Uint8Array, 1);
  raw.set(cose.get(-3) as Uint8Array, 33);
  return crypto.subtle.importKey('raw', bs(raw), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

const RP_ID = 'example.com';

describe('coseEs256 —— COSE 公钥编码', () => {
  it('produces the five required COSE keys with the right values', async () => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    expect(raw).toHaveLength(65);   // 未压缩点：04 || x(32) || y(32)

    const key = cborDecode(encodeCbor(coseEs256(raw.slice(1, 33), raw.slice(33)))) as Map<number, unknown>;
    expect(key.get(1)).toBe(2);      // kty = EC2
    expect(key.get(3)).toBe(-7);     // alg = ES256
    expect(key.get(-1)).toBe(1);     // crv = P-256
    expect((key.get(-2) as Uint8Array)).toHaveLength(32);
    expect((key.get(-3) as Uint8Array)).toHaveLength(32);
  });

  it('refuses a coordinate that is not 32 bytes', () => {
    // 坐标长度错了编出来的公钥永远验不过，不如当场报错
    expect(() => coseEs256(new Uint8Array(31), new Uint8Array(32))).toThrow();
    expect(() => coseEs256(new Uint8Array(32), new Uint8Array(33))).toThrow();
  });
});

describe('createPasskey —— attestationObject', () => {
  async function make() {
    return createPasskey({ rpId: RP_ID, rpName: '示例', userName: 'me@example.com' });
  }

  it('produces fmt "none" with an empty attStmt', async () => {
    const { attestationObject } = await make();
    const obj = cborDecode(attestationObject) as Map<string, unknown>;
    expect(obj.get('fmt')).toBe('none');
    expect((obj.get('attStmt') as Map<unknown, unknown>).size).toBe(0);
  });

  it('lays out authData as rpIdHash || flags || counter || attestedCredentialData', async () => {
    const { attestationObject, credentialId } = await make();
    const obj = cborDecode(attestationObject) as Map<string, unknown>;
    const auth = obj.get('authData') as Uint8Array;

    // rpIdHash 必须是 SHA-256(rpId)
    expect([...auth.slice(0, 32)]).toEqual([...(await digest(utf8(RP_ID)))]);

    const flags = auth[32]!;
    expect(flags & 0x01).toBe(0x01);   // UP：用户在场
    expect(flags & 0x40).toBe(0x40);   // AT：带 attestedCredentialData

    // signCount 初始为 0
    expect([...auth.slice(33, 37)]).toEqual([0, 0, 0, 0]);

    // attestedCredentialData: aaguid(16) || credIdLen(2) || credId || COSE 公钥
    expect(auth.slice(37, 53).every((b) => b === 0)).toBe(true);   // aaguid 全零
    const credIdLen = (auth[53]! << 8) | auth[54]!;
    expect(credIdLen).toBe(credentialId.length);
    expect([...auth.slice(55, 55 + credIdLen)]).toEqual([...credentialId]);
  });

  it('embeds a COSE key that actually verifies signatures from the stored private key', async () => {
    const { attestationObject, stored } = await make();
    const pub = await publicKeyFrom(attestationObject);

    // 用存起来的私钥签一个东西，从 attestationObject 里解出的公钥必须能验过 ——
    // 这一步才真正证明「存下来的私钥」与「发出去的公钥」是同一对
    const priv = await crypto.subtle.importKey(
      'pkcs8', bs(fromB64(stored.keyValue)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const msg = utf8('probe');
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, bs(msg)));
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, bs(sig), bs(msg))).toBe(true);
  });

  it('gives each credential a distinct id and key', async () => {
    const a = await make();
    const b = await make();
    expect(b64(a.credentialId)).not.toBe(b64(b.credentialId));
    expect(a.stored.keyValue).not.toBe(b.stored.keyValue);
  });

  it('records the metadata Bitwarden expects', async () => {
    const { stored } = await make();
    expect(stored.keyType).toBe('public-key');
    expect(stored.keyAlgorithm).toBe('ECDSA');
    expect(stored.keyCurve).toBe('P-256');
    expect(stored.rpId).toBe(RP_ID);
    expect(stored.counter).toBe('0');
    expect(stored.discoverable).toBe('true');
    expect(() => new Date(stored.creationDate)).not.toThrow();
  });
});

describe('assertPasskey —— 断言签名', () => {
  const CLIENT_DATA = utf8(JSON.stringify({ type: 'webauthn.get', challenge: 'abc', origin: 'https://example.com' }));

  async function setup() {
    const { stored, attestationObject } = await createPasskey({
      rpId: RP_ID, rpName: '示例', userName: 'me@example.com',
    });
    return { stored, pub: await publicKeyFrom(attestationObject) };
  }

  it('signs authData || SHA-256(clientDataJSON) and verifies with the registered public key', async () => {
    const { stored, pub } = await setup();
    const { authenticatorData, signature } = await assertPasskey({
      stored, clientDataJSON: CLIENT_DATA, userVerified: true,
    });

    const signed = new Uint8Array([...authenticatorData, ...(await digest(CLIENT_DATA))]);
    expect(await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, pub, bs(signature), bs(signed))).toBe(true);
  });

  /** ⚠️ WebAuthn 要的是**裸的 r||s**（64 字节），不是 DER —— 签成 DER 的话有些 RP 能读、有些不能 */
  it('produces a raw 64-byte signature, not DER', async () => {
    const { stored } = await setup();
    const { signature } = await assertPasskey({ stored, clientDataJSON: CLIENT_DATA, userVerified: true });
    expect(signature).toHaveLength(64);
  });

  it('omits attestedCredentialData from the assertion authData', async () => {
    const { stored } = await setup();
    const { authenticatorData } = await assertPasskey({ stored, clientDataJSON: CLIENT_DATA, userVerified: true });
    // 断言时只有 rpIdHash(32) + flags(1) + counter(4)
    expect(authenticatorData).toHaveLength(37);
    expect(authenticatorData[32]! & 0x40).toBe(0);    // AT 位必须是 0
    expect(authenticatorData[32]! & 0x01).toBe(0x01); // UP
  });

  it('sets the UV flag only when the user was verified', async () => {
    const { stored } = await setup();
    const no = await assertPasskey({ stored, clientDataJSON: CLIENT_DATA, userVerified: false });
    const yes = await assertPasskey({ stored, clientDataJSON: CLIENT_DATA, userVerified: true });
    expect(no.authenticatorData[32]! & 0x04).toBe(0);
    expect(yes.authenticatorData[32]! & 0x04).toBe(0x04);
  });

  it('uses the rpIdHash of the credential, not of the caller', async () => {
    const { stored } = await setup();
    const { authenticatorData } = await assertPasskey({ stored, clientDataJSON: CLIENT_DATA, userVerified: true });
    expect([...authenticatorData.slice(0, 32)]).toEqual([...(await digest(utf8(RP_ID)))]);
  });

  it('increments the counter on each assertion', async () => {
    const { stored } = await setup();
    const first = await assertPasskey({ stored, clientDataJSON: CLIENT_DATA, userVerified: true });
    expect(stored.counter).toBe('1');
    const second = await assertPasskey({ stored, clientDataJSON: CLIENT_DATA, userVerified: true });
    expect(stored.counter).toBe('2');
    // 计数写进 authData 的第 33–36 字节（大端）
    expect([...first.authenticatorData.slice(33, 37)]).toEqual([0, 0, 0, 1]);
    expect([...second.authenticatorData.slice(33, 37)]).toEqual([0, 0, 0, 2]);
  });

  it('refuses a corrupted private key instead of producing a bad signature', async () => {
    const { stored } = await setup();
    await expect(assertPasskey({
      stored: { ...stored, keyValue: 'bm90LWEta2V5' }, clientDataJSON: CLIENT_DATA, userVerified: true,
    })).rejects.toThrow();
  });
});
