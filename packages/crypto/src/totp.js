const HASH_BY_ALGORITHM = { 'SHA-1': 'SHA-1', 'SHA-256': 'SHA-256', 'SHA-512': 'SHA-512' };
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEAM_ALPHABET = '23456789BCDFGHJKMNPQRTVWXY';
/**
 * ⚠️ Bitwarden 的 base32 解码器**刻意不是标准实现** —— 见 `bitwarden-vault/src/totp.rs`
 * 中 `decode_b32` 的注释原文：「not technically a correct base32 decoder since we
 * filter out various characters, and use exact chunking」。它的实际行为是：
 *   1. 整个字符串转大写
 *   2. **字母表外的字符被静默丢弃**（而不是报错）—— `=`、`-`、空格、`0/1/8/9` 都会被丢掉
 *   3. 每个保留字符出 5 bit
 *   4. 末尾不足 8 位的残余 bit **被丢弃**
 *
 * 结果：`"PIUD1IS!EQYA="` 与 `"PIUDISEQYA"` 必须解出完全相同的值。
 * 如果照抄标准 base32（遇到非法字符就抛错），一部分用户的验证码会直接算不出来。
 */
export function base32Decode(input) {
    const kept = input.toUpperCase().split('').filter((c) => BASE32_ALPHABET.includes(c));
    const out = new Uint8Array(Math.floor((kept.length * 5) / 8));
    let acc = 0, bits = 0, o = 0;
    for (const ch of kept) {
        acc = (acc << 5) | BASE32_ALPHABET.indexOf(ch);
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (acc >>> bits) & 0xff;
        }
    }
    return out.subarray(0, o); // 末尾残余 bit 自然被丢弃
}
/**
 * 生成 TOTP 验证码。`secretOrUri` 支持官方实现的三种输入形态：
 *   - `steam://<base32>`            → Steam Guard（5 位、自定义字母表、强制 SHA-1）
 *   - `otpauth://totp/...?secret=`  → 按 URI 里的参数
 *   - 裸 base32                     → 按 `opts`（默认 6 位 / 30 秒 / SHA-1）
 */
export async function generateTotp(secretOrUri, at = Date.now(), opts = {}) {
    const lower = secretOrUri.toLowerCase(); // 官方实现先判断前缀，大小写不敏感
    if (lower.startsWith('steam://')) {
        return computeCode(secretOrUri.slice('steam://'.length), at, {
            digits: 5, period: 30, algorithm: 'SHA-1', steam: true,
        });
    }
    if (lower.startsWith('otpauth://')) {
        const p = parseOtpauthUri(secretOrUri);
        return computeCode(p.secret, at, {
            digits: p.digits, period: p.period, algorithm: p.algorithm, steam: p.isSteam,
        });
    }
    return computeCode(secretOrUri, at, {
        digits: opts.digits ?? 6,
        period: opts.period ?? 30,
        algorithm: opts.algorithm ?? 'SHA-1',
        steam: false,
    });
}
async function computeCode(secret, at, o) {
    const key = base32Decode(secret);
    const counter = Math.floor(at / 1000 / o.period);
    // 64 位大端计数（JS 位运算只有 32 位，拆成高低位写入）
    const cb = new Uint8Array(8);
    const dv = new DataView(cb.buffer);
    dv.setUint32(0, Math.floor(counter / 2 ** 32));
    dv.setUint32(4, counter >>> 0);
    // Steam Guard 强制 SHA-1，忽略 URI 里写的 algorithm
    const mac = await hmacWith(o.steam ? 'SHA-1' : o.algorithm, key, cb);
    // 动态截断（RFC 4226 §5.3）
    const offset = mac[mac.length - 1] & 0x0f;
    const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
    const code = o.steam
        ? steamCode(binary, o.digits)
        : String(binary % 10 ** o.digits).padStart(o.digits, '0');
    return { code, period: o.period, remaining: o.period - (Math.floor(at / 1000) % o.period) };
}
/** Steam Guard 字母表：从最低位开始取，逐位整除 */
function steamCode(binary, digits) {
    let full = binary & 0x7fffffff;
    let out = '';
    for (let i = 0; i < digits; i++) {
        out += STEAM_ALPHABET[full % STEAM_ALPHABET.length];
        full = Math.floor(full / STEAM_ALPHABET.length);
    }
    return out;
}
/**
 * HMAC，哈希算法由 TOTP 的 algorithm 参数决定。
 *
 * ⚠️ 绝不能对 SHA-1 分支「图省事」去调用 HMAC-SHA256 的封装 ——
 * SHA-1 是 TOTP 的**默认**算法（RFC 6238 的测试向量也全是 SHA-1），
 * 用错哈希会让绝大多数验证码算错，而只测 SHA-256 的话还发现不了。
 */
async function hmacWith(alg, key, data) {
    const k = await globalThis.crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: HASH_BY_ALGORITHM[alg] }, false, ['sign']);
    return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', k, data));
}
function normaliseAlgorithm(raw) {
    switch ((raw ?? 'SHA1').toUpperCase()) {
        case 'SHA256': return 'SHA-256';
        case 'SHA512': return 'SHA-512';
        default: return 'SHA-1'; // 未知值回退到 SHA-1（与官方一致）
    }
}
export function parseOtpauthUri(input) {
    let url;
    try {
        url = new URL(input);
    }
    catch {
        throw new Error(`无法解析 otpauth URI: ${input.slice(0, 40)}`);
    }
    if (url.protocol.toLowerCase() !== 'otpauth:')
        throw new Error('不是 otpauth:// URI');
    if (url.host.toLowerCase() !== 'totp')
        throw new Error(`仅支持 totp，收到 ${url.host}`);
    // 参数名大小写不敏感。官方实现靠「把整个 URI 小写」达到同样效果，副作用是把
    // 展示用的 issuer/account 也变成小写（UI 上 "GitHub" 会显示成 "github"）。
    // 只把参数名小写、保留值的原样，效果相同但显示不受损。
    const params = new Map();
    for (const [k, v] of url.searchParams)
        params.set(k.toLowerCase(), v);
    const get = (k) => params.get(k);
    const secret = get('secret');
    if (!secret)
        throw new Error('otpauth URI 缺少 secret 参数');
    let label;
    try {
        label = decodeURIComponent(url.pathname.replace(/^\//, ''));
    }
    catch {
        // decodeURIComponent 对 '100%discount' 这类标签会抛 URIError —— 那是实现细节，
        // 不该作为错误类型泄漏给调用方
        throw new Error(`otpauth URI 的标签含非法的百分号转义: ${input.slice(0, 40)}`);
    }
    const sep = label.indexOf(':');
    const labelIssuer = sep >= 0 ? label.slice(0, sep) : undefined;
    const labelAccount = sep >= 0 ? label.slice(sep + 1) : label;
    // ⚠️ 官方实现只在参数 **> 0** 时才采纳，否则保留默认值：
    //   const d = parseInt(...); if (d > 10) digits = 10; else if (d > 0) digits = d;
    //   if (p > 0) period = p;
    // 若写成「钳制到 0」，`?digits=0` 会让我们输出单字符 "0"、官方输出 6 位码 ——
    // 正是 R5 要避免的「同一账号两边算出不同码」。上限 10 是因为 10**10 会溢出 32 位。
    const rawDigits = Number(get('digits'));
    const digits = Number.isFinite(rawDigits) && rawDigits > 0 ? Math.min(10, rawDigits) : 6;
    const rawPeriod = Number(get('period'));
    const period = Number.isFinite(rawPeriod) && rawPeriod > 0 ? rawPeriod : 30;
    return {
        secret,
        digits,
        period,
        algorithm: normaliseAlgorithm(get('algorithm')),
        issuer: get('issuer') ?? labelIssuer,
        account: labelAccount || undefined,
        // ⚠️ 官方实现**只**通过字面量 `steam://` 前缀识别 Steam，
        // 不会从 `otpauth://totp/Steam:...` 或 `encoder=steam` 推断。
        // 这里保持一致 —— 否则同一条目我们算出 5 位、官方客户端算出 6 位，产生分歧。
        isSteam: false,
    };
}
//# sourceMappingURL=totp.js.map