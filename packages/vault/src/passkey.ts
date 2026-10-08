/**
 * Passkey（WebAuthn 凭据）—— 我们自己做认证器。
 *
 * ## 位置
 *
 * 浏览器扩展拦截 `navigator.credentials.create/get`，用**本地**的密钥完成仪式，
 * 再把结果交回页面。私钥从不出扩展，也从不进页面。
 * 存进保险库时按 Bitwarden 的 `login.fido2Credentials[]` 结构，
 * 这样别的 Bitwarden 客户端也能读到（见 docs/reference/bitwarden-api-notes.md）。
 *
 * ## ⚠️ 这里最容易错的三处
 *
 * 1. **签名必须是裸的 r||s（64 字节）**，不是 DER。WebCrypto 的 ECDSA 恰好返回裸格式，
 *    所以只要不去手工转 DER 就是对的 —— 但反过来，如果哪天换成别的库签名，
 *    很可能会拿到 DER，而**有些 RP 两种都能读**，于是只在部分站点上失败。
 * 2. **authData 的布局**：创建时比断言时多一整段 attestedCredentialData，
 *    AT 标志位也要跟着变。多写或少写一段，签名照样能算出来，
 *    但 RP 解出来的 rpIdHash / counter 全都错位。
 * 3. **COSE 公钥的 x、y 必须是定长 32 字节**（左补零，不是去掉前导零）。
 *    大整数编码偶尔会掉一个前导零字节，那对密钥就废了。
 */

import { concatBytes, randomBytes, sha256, toBase64Url, fromBase64Url, utf8Encode } from '@1warden/crypto';
import { cborBytes, cborInt, cborMap, cborText, encodeCbor, type CborValue } from './cbor';

/** 认证器数据里的标志位（WebAuthn §6.1） */
const FLAG_UP = 0x01;   // User Present：用户在场（按了确认）
const FLAG_UV = 0x04;   // User Verified：用户身份已验证（输过主密码 / 生物识别）
const FLAG_AT = 0x40;   // Attested Credential Data：后面跟着凭据数据

/** AAGUID 全零 = 「不声明具体型号的认证器」。我们不是硬件认证器，就该是全零。 */
const AAGUID = new Uint8Array(16);

/** 凭据 ID 的长度。规范允许 16–1023 字节，取 32 与应用密码同宽。 */
const CREDENTIAL_ID_BYTES = 32;

/** COSE 里 P-256 坐标的固定长度 */
const P256_COORD_BYTES = 32;

/**
 * 一条 passkey 的持久化形态 —— 与 Bitwarden 的 `login.fido2Credentials[]` 一一对应。
 *
 * ⚠️ `counter` 和 `discoverable` 是**字符串**，不是数字/布尔。
 * 这是 Bitwarden 的类型选择（大概为了跨语言序列化不丢精度），照抄即可 ——
 * 写成数字的话，官方客户端读回来做严格类型检查会失败。
 */
export interface StoredPasskey {
  /** Opaque row identity for lossless editing. */
  sourceId?: string;
  /** base64url 编码的凭据 ID */
  credentialId: string;
  keyType: 'public-key';
  keyAlgorithm: 'ECDSA';
  keyCurve: 'P-256';
  /** base64url 编码的 **PKCS#8** 私钥 */
  keyValue: string;
  rpId: string;
  rpName?: string;
  userHandle?: string;
  userName?: string;
  userDisplayName?: string;
  /** 断言次数，用于 RP 侧的克隆检测。每断言一次 +1。 */
  counter: string;
  /** 可发现凭据（常驻凭据）—— 可以不用用户名就登录 */
  discoverable: string;
  creationDate: string;
}

export interface CreatePasskeyOptions {
  rpId: string;
  rpName: string;
  /** base64url 的 user handle。缺省时由 userName 派生 —— RP 没给就只能这样。 */
  userHandle?: string;
  userName?: string;
  userDisplayName?: string;
  /** 用户是否已通过验证（解锁了保险库）。默认 true。 */
  userVerified?: boolean;
}

export interface CreatedPasskey {
  stored: StoredPasskey;
  /** 给 RP 的 attestationObject（CBOR） */
  attestationObject: Uint8Array;
  credentialId: Uint8Array;
}

export interface AssertPasskeyOptions {
  /** ⚠️ 会被就地修改：counter 自增。见 assertPasskey 的说明。 */
  stored: StoredPasskey;
  /** 页面给的 clientDataJSON 原文 —— 签名覆盖的是它的 SHA-256，不是它本身 */
  clientDataJSON: Uint8Array;
  userVerified: boolean;
}

export interface PasskeyAssertion {
  authenticatorData: Uint8Array;
  signature: Uint8Array;
  /** 自增后的计数，方便调用方拼出要持久化的记录 */
  counter: number;
}

/**
 * COSE_Key —— 只支持 ES256 / P-256，这是所有平台都认的那一种。
 *
 * 键的含义（RFC 9052 §7.1）：1=kty(2 即 EC2)、3=alg(-7 即 ES256)、
 * -1=crv(1 即 P-256)、-2=x、-3=y。负数的键是 COSE 的惯例，不是笔误。
 */
export function coseEs256(x: Uint8Array, y: Uint8Array): CborValue {
  // 长度错了编出来的公钥永远验不过，而且报错只会在 RP 那边出现 —— 当场拦下
  if (x.length !== P256_COORD_BYTES || y.length !== P256_COORD_BYTES) {
    throw new Error(`P-256 坐标必须是 ${P256_COORD_BYTES} 字节，收到 x=${x.length} y=${y.length}`);
  }
  return cborMap([
    [cborInt(1), cborInt(2)],
    [cborInt(3), cborInt(-7)],
    [cborInt(-1), cborInt(1)],
    [cborInt(-2), cborBytes(x)],
    [cborInt(-3), cborBytes(y)],
  ]);
}

/** 把公钥的未压缩点（04 || x || y）拆成 COSE 要的两段 */
function splitUncompressedPoint(raw: Uint8Array): { x: Uint8Array; y: Uint8Array } {
  if (raw.length !== 1 + P256_COORD_BYTES * 2 || raw[0] !== 0x04) {
    throw new Error('P-256 公钥不是未压缩点格式');
  }
  return { x: raw.slice(1, 33), y: raw.slice(33) };
}

function counterBytes(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function flagsOf(userVerified: boolean, attested: boolean): number {
  let f = FLAG_UP;
  if (userVerified) f |= FLAG_UV;
  if (attested) f |= FLAG_AT;
  return f;
}

/** 只在值存在时写入 —— `exactOptionalPropertyTypes` 下不能赋 undefined */
function assign<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

async function importPrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/**
 * 新建一条 passkey。
 *
 * 私钥生成后立刻导出成 PKCS#8 存进 `stored.keyValue` ——
 * WebCrypto 的 `CryptoKey` 句柄不能持久化，保险库要的是可加密存储的字节。
 */
export async function createPasskey(opts: CreatePasskeyOptions): Promise<CreatedPasskey> {
  const userVerified = opts.userVerified ?? true;

  // extractable = true：必须能导出 PKCS#8 和公钥，否则存不下来
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const { x, y } = splitUncompressedPoint(rawPub);

  const credentialId = randomBytes(CREDENTIAL_ID_BYTES);

  // attestedCredentialData = aaguid(16) || credIdLen(2, 大端) || credId || COSE 公钥
  const credIdLen = new Uint8Array([(credentialId.length >> 8) & 0xff, credentialId.length & 0xff]);

  const authData = concatBytes(
    await sha256(utf8Encode(opts.rpId)),        // rpIdHash：⚠️ 哈希的是 rpId，不是 origin
    new Uint8Array([flagsOf(userVerified, true)]),
    counterBytes(0),                            // 新建时计数从 0 开始
    AAGUID,
    credIdLen,
    credentialId,
    encodeCbor(coseEs256(x, y)),
  );

  const attestationObject = encodeCbor(cborMap([
    [cborText('fmt'), cborText('none')],        // 不做认证器证明，我们不是硬件
    [cborText('attStmt'), cborMap([])],
    [cborText('authData'), cborBytes(authData)],
  ]));

  const stored: StoredPasskey = {
    credentialId: toBase64Url(credentialId),
    keyType: 'public-key',
    keyAlgorithm: 'ECDSA',
    keyCurve: 'P-256',
    keyValue: toBase64Url(pkcs8),
    rpId: opts.rpId,
    counter: '0',
    discoverable: 'true',
    creationDate: new Date().toISOString(),
  };
  assign(stored, 'rpName', opts.rpName);
  assign(stored, 'userHandle', opts.userHandle);
  assign(stored, 'userName', opts.userName);
  assign(stored, 'userDisplayName', opts.userDisplayName);

  return { stored, attestationObject, credentialId };
}

/**
 * 用已存的凭据回应一次断言挑战。
 *
 * ## ⚠️ 会就地修改 `stored.counter`
 *
 * 计数是 RP 侧检测「同一个凭据被复制到两台设备」的唯一手段。它**必须**随每次断言前进一步
 * 并且落到磁盘上。
 *
 * 选择就地自增而不是「返回新值让调用方自己更新」，是因为后者允许调用方忘记 ——
 * 忘了之后计数永远停在 0，本地怎么试都正常，只有在开了克隆检测的 RP 上才会被拦下，
 * 而那时用户看到的是一句「此密钥已被吊销」之类的模糊错误。
 * 就地改的话，调用方手上那个对象**就是**真相，照着存下去即可。
 */
export async function assertPasskey(opts: AssertPasskeyOptions): Promise<PasskeyAssertion> {
  const { stored, clientDataJSON, userVerified } = opts;

  // 先自增再写进 authData：RP 期望收到的计数**大于**上次见到的
  const counter = (Number.parseInt(stored.counter, 10) || 0) + 1;
  stored.counter = String(counter);

  // 断言时的 authData 只有三十二加一加四字节：没有 attestedCredentialData
  const authenticatorData = concatBytes(
    await sha256(utf8Encode(stored.rpId)),
    new Uint8Array([flagsOf(userVerified, false)]),
    counterBytes(counter),
  );

  // 签名覆盖 authenticatorData || SHA-256(clientDataJSON)
  const clientHash = await sha256(clientDataJSON);
  const signedData = concatBytes(authenticatorData, clientHash);

  // 私钥坏了要在这里就炸，不能返回一段验不过的签名
  const key = await importPrivateKey(fromBase64Url(stored.keyValue));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signedData as BufferSource));

  return { authenticatorData, signature, counter };
}
