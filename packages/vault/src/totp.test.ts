import { describe, it, expect } from 'vitest';
import { readTotpSecret, writeTotpSecret, totpCode, TOTP_FIELD_NAME } from './totp';
import { emptyLogin } from './model';
import type { VaultItem } from './model';

function item(over: Partial<VaultItem> = {}): VaultItem {
  return {
    id: 'x', type: 'login', rawType: 1, name: 'n', nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: 'x', updatedAt: 'x', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: { ...emptyLogin() }, card: null, identity: null, secureNote: null, sshKey: null,
    customFields: [], passwordHistory: [], attachments: [],
    ...over,
  };
}

const SECRET = 'WQIQ25BRKZYCJVYP';
const T = Date.UTC(2023, 0, 1);

describe('readTotpSecret — 双路径', () => {
  it('prefers the native login.totp field', () => {
    expect(readTotpSecret(item({ login: { ...emptyLogin(), totp: SECRET } }))).toBe(SECRET);
  });

  // 1Password 允许把 OTP 加在任意条目类型上，自定义字段这条路必须支持
  it('falls back to a custom field for a non-login item', () => {
    const it_ = item({
      type: 'secureNote', rawType: 2, login: null,
      customFields: [{ name: TOTP_FIELD_NAME, value: SECRET, type: 1, linkedId: null }],
    });
    expect(readTotpSecret(it_)).toBe(SECRET);
  });

  it('accepts the English field name too', () => {
    const it_ = item({
      type: 'secureNote', rawType: 2, login: null,
      customFields: [{ name: 'one-time password', value: SECRET, type: 1, linkedId: null }],
    });
    expect(readTotpSecret(it_)).toBe(SECRET);
  });

  it('prefers native when both exist', () => {
    const it_ = item({
      login: { ...emptyLogin(), totp: SECRET },
      customFields: [{ name: TOTP_FIELD_NAME, value: 'OTHER', type: 1, linkedId: null }],
    });
    expect(readTotpSecret(it_)).toBe(SECRET);
  });

  it('returns null when there is none, or when it is an empty string', () => {
    expect(readTotpSecret(item())).toBeNull();
    expect(readTotpSecret(item({ login: { ...emptyLogin(), totp: '' } }))).toBeNull();
  });
});

describe('writeTotpSecret — 原生优先', () => {
  // ⚠️ 写进自定义字段的话，用户在**官方 App 里看不到验证码**，互操作性受损
  it('writes to login.totp for a login item and clears any custom field', () => {
    const it_ = item({ customFields: [{ name: TOTP_FIELD_NAME, value: 'stale', type: 1, linkedId: null }] });
    const out = writeTotpSecret(it_, SECRET);
    expect(out.loginTotp).toBe(SECRET);
    expect(out.customFields.find((f) => f.name === TOTP_FIELD_NAME)).toBeUndefined();
  });

  it('writes to a custom field for a non-login item', () => {
    const out = writeTotpSecret(item({ type: 'secureNote', rawType: 2, login: null }), SECRET);
    expect(out.loginTotp).toBeNull();
    expect(out.customFields.find((f) => f.name === TOTP_FIELD_NAME)?.value).toBe(SECRET);
  });

  it('clears the secret when passed null', () => {
    expect(writeTotpSecret(item({ login: { ...emptyLogin(), totp: SECRET } }), null).loginTotp).toBeNull();
  });

  it('preserves unrelated custom fields', () => {
    const it_ = item({ customFields: [{ name: 'PIN', value: '1234', type: 1, linkedId: null }] });
    expect(writeTotpSecret(it_, SECRET).customFields.find((f) => f.name === 'PIN')?.value).toBe('1234');
  });

  it('does not mutate the input item', () => {
    const it_ = item();
    writeTotpSecret(it_, SECRET);
    expect(it_.login?.totp).toBeNull();
    expect(it_.customFields).toEqual([]);
  });
});

describe('totpCode — 用官方向量验证', () => {
  it('generates from a bare base32 secret', async () => {
    expect((await totpCode(item({ login: { ...emptyLogin(), totp: SECRET } }), T))?.code).toBe('194506');
  });

  it('generates from an otpauth URI', async () => {
    const uri = `otpauth://totp/GitHub:k?secret=${SECRET}`;
    expect((await totpCode(item({ login: { ...emptyLogin(), totp: uri } }), T))?.code).toBe('194506');
  });

  it('generates a Steam code from a steam:// URI', async () => {
    const r = await totpCode(item({ login: { ...emptyLogin(), totp: 'steam://HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ' } }), T);
    expect(r?.code).toBe('7W6CJ');
    expect(r?.code).toHaveLength(5);
  });

  it('generates from a custom field on a non-login item', async () => {
    const it_ = item({
      type: 'secureNote', rawType: 2, login: null,
      customFields: [{ name: TOTP_FIELD_NAME, value: SECRET, type: 1, linkedId: null }],
    });
    expect((await totpCode(it_, T))?.code).toBe('194506');
  });

  it('returns null when there is no secret', async () => {
    expect(await totpCode(item(), T)).toBeNull();
  });

  // 用户从别处粘贴来的种子可能是坏的 —— 不该让整个条目详情页崩掉
  it('returns null for a malformed secret rather than throwing', async () => {
    expect(await totpCode(item({ login: { ...emptyLogin(), totp: 'otpauth://totp/x' } }), T)).toBeNull();
  });

  it('reports the period and remaining seconds for the countdown ring', async () => {
    const r = await totpCode(item({ login: { ...emptyLogin(), totp: SECRET } }), T);
    expect(r?.period).toBe(30);
    expect(r?.remaining).toBeGreaterThan(0);
    expect(r?.remaining).toBeLessThanOrEqual(30);
  });
});
