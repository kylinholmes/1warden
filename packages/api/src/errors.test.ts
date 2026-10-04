import { describe, it, expect } from 'vitest';
import { ApiError, classifyStatus, messageFor } from './errors';

describe('ApiError', () => {
  it('carries kind, status and body', () => {
    const e = new ApiError('auth', '用户名或密码错误', { status: 400, body: { message: 'x' } });
    expect(e.kind).toBe('auth');
    expect(e.status).toBe(400);
    expect(e.body).toEqual({ message: 'x' });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ApiError');
  });

  it('allows an undefined status for transport failures', () => {
    expect(new ApiError('network', '连不上').status).toBeUndefined();
  });
});

describe('classifyStatus', () => {
  it('maps HTTP status to a kind', () => {
    expect(classifyStatus(400)).toBe('auth');
    expect(classifyStatus(401)).toBe('auth');
    expect(classifyStatus(404)).toBe('notFound');
    expect(classifyStatus(409)).toBe('conflict');
    expect(classifyStatus(429)).toBe('rateLimited');
    expect(classifyStatus(500)).toBe('server');
    expect(classifyStatus(503)).toBe('server');
  });
});

describe('messageFor', () => {
  it('extracts the human message from a Vaultwarden error body', () => {
    expect(messageFor({ message: 'Username or password is incorrect. Try again' }))
      .toBe('Username or password is incorrect. Try again');
  });

  it('falls back to errorModel.message', () => {
    expect(messageFor({ errorModel: { message: 'Out of date' } })).toBe('Out of date');
  });

  it('falls back to a generic message for an unknown shape', () => {
    expect(messageFor(null)).toBeTruthy();
    expect(messageFor('a plain string')).toBeTruthy();
    expect(messageFor(undefined)).toBeTruthy();
    expect(messageFor(42)).toBeTruthy();
  });

  it('handles a plain-text body (Vaultwarden 401s are not JSON)', () => {
    expect(messageFor('Invalid claim')).toBe('Invalid claim');
  });

  // 错误消息会被渲染到 UI 上，绝不能把 token / 密钥带出去
  it('never echoes a value that looks like an EncString or a JWT', () => {
    expect(messageFor({ message: 'failed for 2.abcdefghijklmnop|qrstuvwxyz|0123456789' })).not.toContain('2.');
    expect(messageFor({ message: 'token eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9 dead' })).not.toContain('eyJ');
  });

  it('truncates an absurdly long body rather than rendering it', () => {
    expect(messageFor('x'.repeat(5000)).length).toBeLessThan(300);
  });
});
