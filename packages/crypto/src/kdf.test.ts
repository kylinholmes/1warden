import { describe, it, expect } from 'vitest';
import { argon2id } from 'hash-wasm';
import { deriveMasterKey, hashMasterPassword, KDF_TYPE_PBKDF2, KDF_TYPE_ARGON2ID } from './kdf';
import { toBase64, utf8Encode, sha256 } from './bytes';

describe('deriveMasterKey / PBKDF2', () => {
  // 独立已知答案：由 Python 的 hashlib.pbkdf2_hmac 算出，不是本实现自拍。
  // 不一致 = 我们的 PBKDF2 有 bug（参数顺序、盐归一化、迭代次数、输出长度任一）。
  it('matches an independently computed known-answer vector', async () => {
    const key = await deriveMasterKey('password123', 'user@example.com', {
      kdf: KDF_TYPE_PBKDF2, iterations: 600_000,
    });
    expect(toBase64(key)).toBe('GDXK63CPUGr01h0oTuJVwH/Ogk+t4Dl9zA5qvY/nKZQ=');
  }, 30_000);

  it('matches at a low iteration count too', async () => {
    const key = await deriveMasterKey('password123', 'user@example.com', {
      kdf: KDF_TYPE_PBKDF2, iterations: 1000,
    });
    expect(toBase64(key)).toBe('sTgd3faR0hkVuXzCFmViqVofOSqY/TE9lX7u8jY8sPQ=');
  });

  it('normalises the email salt (trim + lowercase)', async () => {
    const a = await deriveMasterKey('pw', '  User@Example.COM  ', { kdf: KDF_TYPE_PBKDF2, iterations: 1000 });
    const b = await deriveMasterKey('pw', 'user@example.com', { kdf: KDF_TYPE_PBKDF2, iterations: 1000 });
    expect(a).toEqual(b);
  });

  it('produces different keys for different passwords', async () => {
    const cfg = { kdf: KDF_TYPE_PBKDF2, iterations: 1000 } as const;
    expect(await deriveMasterKey('a', 'u@e.com', cfg)).not.toEqual(await deriveMasterKey('b', 'u@e.com', cfg));
  });

  it('handles a Chinese master password', async () => {
    const key = await deriveMasterKey('我的密码🔐', 'user@example.com', { kdf: KDF_TYPE_PBKDF2, iterations: 1000 });
    expect(key).toHaveLength(32);
  });

  it('rejects an unsupported kdf type', async () => {
    // @ts-expect-error 故意传入非法值
    await expect(deriveMasterKey('pw', 'u@e.com', { kdf: 99, iterations: 1 })).rejects.toThrow(/Unsupported KDF/);
  });
});

describe('deriveMasterKey / Argon2id', () => {
  it('derives a 32-byte key', async () => {
    const key = await deriveMasterKey('password123', 'user@example.com', {
      kdf: KDF_TYPE_ARGON2ID, iterations: 3, memory: 64, parallelism: 4,
    });
    expect(key).toHaveLength(32);
  }, 30_000);

  it('is deterministic for the same parameters', async () => {
    const cfg = { kdf: KDF_TYPE_ARGON2ID, iterations: 3, memory: 64, parallelism: 4 } as const;
    const a = await deriveMasterKey('pw', 'u@e.com', cfg);
    const b = await deriveMasterKey('pw', 'u@e.com', cfg);
    expect(a).toEqual(b);
  }, 60_000);

  // ⚠️ 最关键的一个断言：Argon2id 的盐是 SHA-256(邮箱)，不是邮箱原文。
  // 用同一个 argon2id 库独立复算两条路径，断言实现走的是「盐先哈希」那条。
  // 若有人把 sha256() 去掉，这里会立刻变红。
  it('salts with SHA-256(email), not the raw email', async () => {
    const email = 'user@example.com';
    const emailSalt = utf8Encode(email);
    const shared = {
      password: utf8Encode('pw'),
      parallelism: 4, iterations: 3,
      memorySize: 64 * 1024,          // 64 MiB → KiB
      hashLength: 32, outputType: 'binary',
    } as const;

    const withHashedSalt = await argon2id({ ...shared, salt: await sha256(emailSalt) });
    const withRawSalt = await argon2id({ ...shared, salt: emailSalt });

    // 先确认两条路径确实不同 —— 否则这个测试证明不了任何事
    expect(withHashedSalt).not.toEqual(withRawSalt);

    const actual = await deriveMasterKey('pw', email, {
      kdf: KDF_TYPE_ARGON2ID, iterations: 3, memory: 64, parallelism: 4,
    });
    expect(actual).toEqual(withHashedSalt);
  }, 60_000);
});

describe('hashMasterPassword', () => {
  it('matches an independently computed vector', async () => {
    const mk = await deriveMasterKey('password123', 'user@example.com', {
      kdf: KDF_TYPE_PBKDF2, iterations: 600_000,
    });
    expect(await hashMasterPassword(mk, 'password123')).toBe('8gYcnKGz+3ENJ9Ur2P1VfnFaE7wlyxJqtMNwi1gXqg4=');
  }, 30_000);

  it('is base64 of 32 bytes', async () => {
    const mk = new Uint8Array(32).fill(7);
    expect(Buffer.from(await hashMasterPassword(mk, 'password123'), 'base64')).toHaveLength(32);
  });

  it('differs from the master key itself', async () => {
    const mk = await deriveMasterKey('password123', 'user@example.com', { kdf: KDF_TYPE_PBKDF2, iterations: 1000 });
    expect(await hashMasterPassword(mk, 'password123')).not.toBe(toBase64(mk));
  });
});
