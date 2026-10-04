import { describe, it, expect } from 'vitest';
import {
  generatePassword, generatePassphrase, passwordStrength, estimateEntropyBits, POOLS,
} from './generator';

describe('generatePassword', () => {
  it('honours the requested length', () => {
    expect(generatePassword({ length: 24 })).toHaveLength(24);
    expect(generatePassword({ length: 1, lowercase: true, uppercase: false, digits: false, symbols: false }))
      .toHaveLength(1);
    expect(generatePassword({ length: 128 })).toHaveLength(128);
  });

  it('includes at least one character from every enabled class', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword({ length: 8, lowercase: true, uppercase: true, digits: true, symbols: true });
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[^a-zA-Z0-9]/);
    }
  });

  it('only uses enabled classes', () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePassword({ length: 32, lowercase: true, uppercase: false, digits: false, symbols: false }))
        .toMatch(/^[a-z]+$/);
      expect(generatePassword({ length: 32, lowercase: false, uppercase: false, digits: true, symbols: false }))
        .toMatch(/^[0-9]+$/);
    }
  });

  it('excludes ambiguous characters when asked', () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePassword({ length: 64, avoidAmbiguous: true })).not.toMatch(/[Il1O0o]/);
    }
  });

  it('is non-deterministic across calls', () => {
    const seen = new Set(Array.from({ length: 20 }, () => generatePassword({ length: 32 })));
    expect(seen.size).toBe(20);
  });

  it('rejects a length of 0 or negative', () => {
    expect(() => generatePassword({ length: 0 })).toThrow(/length/i);
    expect(() => generatePassword({ length: -1 })).toThrow(/length/i);
  });

  it('rejects when every class is disabled', () => {
    expect(() => generatePassword({ lowercase: false, uppercase: false, digits: false, symbols: false }))
      .toThrow(/至少要启用/);
  });

  it('rejects a length shorter than the number of enabled classes', () => {
    expect(() => generatePassword({ length: 2, lowercase: true, uppercase: true, digits: true, symbols: true }))
      .toThrow(/length/i);
  });

  // 模偏差回归测试，用卡方检验。
  //
  // 为什么不用「最大偏差 < X%」那种阈值：自然涨落本身就有几个百分点，
  // 阈值放宽到 15% 就抓不住真实的模偏差（26 字符池用 % 取模时最大偏差约 8.6%），
  // 收紧又会随机翻红。
  //
  // 卡方则把「每个格子的偏差」按期望值归一化后求和，判别力强得多：
  //   - 均匀分布（拒绝采样）：χ² ≈ 自由度 25，99.9% 分位约 52.6
  //   - 有模偏差（% 取模）：χ² ≈ 348
  // 取阈值 60，两边都离得很远。
  it('has no modulo bias across the pool (chi-square)', () => {
    const N = 260_000;
    const poolSize = POOLS.lowercase.length;
    const pw = generatePassword({ length: N, lowercase: true, uppercase: false, digits: false, symbols: false });

    const counts = new Map<string, number>();
    for (const ch of pw) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size, '每个字符都应出现').toBe(poolSize);

    const expected = N / poolSize;
    let chiSquare = 0;
    for (const ch of POOLS.lowercase) {
      const observed = counts.get(ch) ?? 0;
      chiSquare += ((observed - expected) ** 2) / expected;
    }
    expect(chiSquare, `卡方统计量 ${chiSquare.toFixed(1)} 偏高，分布不均匀`).toBeLessThan(60);
  });

  // 洗牌需要 bound = length，早期实现只支持 bound ≤ 256，长度一超就崩。
  it('supports lengths above 256 (shuffle bound exceeds one byte)', () => {
    expect(generatePassword({ length: 300 })).toHaveLength(300);
    expect(generatePassword({ length: 5000 })).toHaveLength(5000);
  });
});

describe('generatePassphrase', () => {
  it('produces the requested number of words', () => {
    expect(generatePassphrase({ words: 5 }).split('-')).toHaveLength(5);
  });

  it('honours a custom separator', () => {
    expect(generatePassphrase({ words: 4, separator: ' ' }).split(' ')).toHaveLength(4);
  });

  it('capitalises words when asked', () => {
    for (const w of generatePassphrase({ words: 4, capitalize: true }).split('-')) {
      if (!/^\d+$/.test(w)) expect(w[0]).toMatch(/[A-Z]/);
    }
  });

  it('appends a number when asked', () => {
    expect(generatePassphrase({ words: 4, includeNumber: true })).toMatch(/\d/);
  });

  it('rejects a word count of 0', () => {
    expect(() => generatePassphrase({ words: 0 })).toThrow(/words/i);
  });
});

describe('entropy & strength', () => {
  it('computes entropy from pool size and length', () => {
    expect(estimateEntropyBits('a'.repeat(10), 26)).toBeCloseTo(47.0, 0);
  });

  it('scores a long mixed password as the strongest bucket', () => {
    expect(passwordStrength('kJ8#mPq2$vXn9!wZt4&bR').score).toBe(4);
  });

  it('scores a short numeric password as the weakest bucket', () => {
    expect(passwordStrength('1234').score).toBe(0);
  });

  it('scores an empty password as weakest without throwing', () => {
    expect(passwordStrength('').score).toBe(0);
    expect(passwordStrength('').entropyBits).toBe(0);
  });
});
