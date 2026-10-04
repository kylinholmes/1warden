import { describe, it, expect } from 'vitest';
import { generateTotp, parseOtpauthUri, base32Decode } from './totp';

// RFC 6238 附录 B 的官方测试向量。
// 密钥 "12345678901234567890" 的 base32 编码：
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32Decode', () => {
  it('decodes the RFC 6238 secret to ASCII digits', () => {
    expect(new TextDecoder().decode(base32Decode(RFC_SECRET))).toBe('12345678901234567890');
  });

  // 官方单元测试向量 —— 来源：bitwarden-vault/src/totp.rs
  it('matches the official decode vectors', () => {
    expect([...base32Decode('ABCD123')]).toEqual([0, 68, 61]);
    expect([...base32Decode('WQIQ25BRKZYCJVYP')])
      .toEqual([180, 17, 13, 116, 49, 86, 112, 36, 215, 15]);
  });

  it('silently drops characters outside the alphabet', () => {
    // '1'、'!'、'=' 都不在字母表里，会被丢掉 —— 官方行为就是如此，不是 bug
    expect(base32Decode('PIUD1IS!EQYA=')).toEqual(base32Decode('PIUDISEQYA'));
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq=='))
      .toEqual(base32Decode(RFC_SECRET));
  });

  it('is case-insensitive', () => {
    expect(base32Decode('wqiq25brkzycjvyp')).toEqual(base32Decode('WQIQ25BRKZYCJVYP'));
  });
});

describe('generateTotp — RFC 6238 官方测试向量 (SHA-1, 8 位)', () => {
  const cases: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  for (const [time, expected] of cases) {
    it(`T=${time} → ${expected}`, async () => {
      const { code } = await generateTotp(RFC_SECRET, time * 1000, { digits: 8 });
      expect(code).toBe(expected);
    });
  }
});

// 🔑 官方 Bitwarden 测试向量 —— 覆盖裸 base32 / 小写 / 含非法字符 / steam:// / 前导零补齐
// 来源：bitwarden-vault/src/totp.rs 的单元测试
describe('generateTotp — 官方 Bitwarden 测试向量', () => {
  const T = Date.UTC(2023, 0, 1); // 2023-01-01T00:00:00.000Z

  const cases: Array<[string, string]> = [
    ['WQIQ25BRKZYCJVYP', '194506'],
    ['wqiq25brkzycjvyp', '194506'],
    ['PIUDISEQYA', '829846'],
    ['PIUD1IS!EQYA=', '829846'],
    ['steam://HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ', '7W6CJ'],
    ['steam://ABCD123', 'N26DF'],
    ['HJSGFJHDFDJDJKSDFD', '000034'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, async () => {
      expect((await generateTotp(input, T)).code).toBe(expected);
    });
  }
});

describe('generateTotp — 6 位（默认）', () => {
  it('produces 6-digit codes by default', async () => {
    expect((await generateTotp(RFC_SECRET, 59_000)).code).toBe('287082');
    expect((await generateTotp(RFC_SECRET, 1111111109_000)).code).toBe('081804');
    expect((await generateTotp(RFC_SECRET, 1234567890_000)).code).toBe('005924');
  });

  it('reports the seconds remaining in the current window', async () => {
    const r = await generateTotp(RFC_SECRET, 60_000); // 窗口 [60,90)，剩 30 秒
    expect(r.period).toBe(30);
    expect(r.remaining).toBe(30);
  });

  it('pads codes shorter than the digit count with leading zeros', async () => {
    expect((await generateTotp(RFC_SECRET, 1234567890_000)).code).toHaveLength(6);
  });
});

describe('generateTotp — SHA-256 (RFC 6238 向量)', () => {
  it('T=59 → 46119246', async () => {
    const s = base32Encode(new TextEncoder().encode('12345678901234567890123456789012'));
    expect((await generateTotp(s, 59_000, { digits: 8, algorithm: 'SHA-256' })).code).toBe('46119246');
  });
});

describe('parseOtpauthUri', () => {
  it('parses a standard TOTP URI', () => {
    const u = parseOtpauthUri('otpauth://totp/GitHub:kylin?secret=ABCDEFGH&issuer=GitHub&digits=6&period=30');
    expect(u.secret).toBe('ABCDEFGH');
    expect(u.digits).toBe(6);
    expect(u.period).toBe(30);
    expect(u.issuer).toBe('GitHub');
    expect(u.account).toBe('kylin');
    expect(u.isSteam).toBe(false);
  });

  it('accepts an uppercase scheme and missing options', () => {
    const u = parseOtpauthUri('OTPAUTH://TOTP/x?secret=ABCDEFGH');
    expect(u.digits).toBe(6);
    expect(u.period).toBe(30);
    expect(u.algorithm).toBe('SHA-1');
  });

  it('does NOT infer Steam from an otpauth URI (matches official behaviour)', () => {
    // 官方只用字面量 `steam://` 前缀识别 Steam。跟随官方，
    // 否则同一条目我们算 5 位、官方客户端算 6 位，产生分歧。
    const u = parseOtpauthUri('otpauth://totp/Steam:kylin?secret=ABCDEFGH&encoder=steam');
    expect(u.isSteam).toBe(false);
  });

  it('matches parameter names case-insensitively, but preserves value casing', () => {
    // 官方实现靠「整体小写」达到大小写不敏感，副作用是把展示用的 issuer/account
    // 也变成小写（UI 上 "GitHub" 显示成 "github"）。只把参数名小写、保留原值，
    // 效果相同但显示不受损。
    const u = parseOtpauthUri('otpauth://totp/x?SECRET=ABCDEFGH&DIGITS=8&PERIOD=60');
    expect(u.secret).toBe('ABCDEFGH');
    expect(u.digits).toBe(8);
    expect(u.period).toBe(60);
  });

  it('preserves the issuer and account casing from the label', () => {
    const u = parseOtpauthUri('otpauth://totp/GitHub:Someone%40Example.com?secret=AB');
    expect(u.issuer).toBe('GitHub');
    expect(u.account).toBe('Someone@Example.com');
  });

  // 官方实现只在参数 **> 0** 时才采纳，否则保留默认值：
  //   const d = parseInt(...); if (d > 10) digits = 10; else if (d > 0) digits = d;
  //   if (p > 0) period = p;
  // 若写成「钳制到 0」，?digits=0 会让我们输出单字符 "0"，而官方输出正常的 6 位码 ——
  // 正是 R5 想避免的「同一账号两边算出不同码」。
  it('keeps the default when digits/period are not positive (matches official)', () => {
    expect(parseOtpauthUri('otpauth://totp/x?secret=AB&digits=0').digits).toBe(6);
    expect(parseOtpauthUri('otpauth://totp/x?secret=AB&digits=-5').digits).toBe(6);
    expect(parseOtpauthUri('otpauth://totp/x?secret=AB&digits=').digits).toBe(6);
    expect(parseOtpauthUri('otpauth://totp/x?secret=AB&period=0').period).toBe(30);
    expect(parseOtpauthUri('otpauth://totp/x?secret=AB&period=-1').period).toBe(30);
    expect(parseOtpauthUri('otpauth://totp/x?secret=AB&period=').period).toBe(30);
  });

  it('clamps digits above the maximum but below the minimum', () => {
    expect(parseOtpauthUri('otpauth://totp/x?secret=AB&digits=999').digits).toBe(10);
    expect(parseOtpauthUri('otpauth://totp/x?secret=AB&digits=7').digits).toBe(7);
  });

  it('throws a descriptive error for a malformed percent-escape in the label', () => {
    // decodeURIComponent('100%discount') 会抛 URIError —— 那是实现细节，不该泄漏给调用方
    expect(() => parseOtpauthUri('otpauth://totp/100%discount?secret=AB'))
      .toThrow(/百分号|转义/);
  });

  it('still produces a usable code for those degenerate URIs', async () => {
    const r = await generateTotp('otpauth://totp/x?secret=WQIQ25BRKZYCJVYP&digits=0', Date.UTC(2023, 0, 1));
    expect(r.code).toBe('194506');
    expect(r.code).toHaveLength(6);
  });

  it('falls back to SHA-1 for an unknown algorithm', () => {
    expect(parseOtpauthUri('otpauth://totp/x?secret=AB&algorithm=md5').algorithm).toBe('SHA-1');
  });

  it('rejects a non-totp URI', () => {
    expect(() => parseOtpauthUri('https://example.com')).toThrow(/otpauth/i);
  });

  it('rejects a URI with no secret', () => {
    expect(() => parseOtpauthUri('otpauth://totp/x?issuer=GitHub')).toThrow(/secret/i);
  });
});

// 测试辅助：base32 编码（仅测试用）
function base32Encode(bytes: Uint8Array): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '', acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out += A[(acc >>> bits) & 31]; }
  }
  if (bits > 0) out += A[(acc << (5 - bits)) & 31];
  return out;
}
