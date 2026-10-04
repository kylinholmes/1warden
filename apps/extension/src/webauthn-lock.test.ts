import { describe, it, expect } from 'vitest';
import { serializeCreate } from './webauthn';

/**
 * ⚠️ 这一条守的是一个**数据丢失**的场景，不是性能优化。
 *
 * 页面只调了一次 create，它却执行了两次；第二次读到的是过期快照
 * （凭据列表还是空的），写回去就把第一次刚存的凭据覆盖掉了 ——
 * 用户看到「注册成功」，下次登录却被告知没有可用的 passkey，
 * 而 create 返回给页面的那个 ID 在库里根本不存在。
 *
 * 串行化把「覆盖」变成「追加」：第二个一定在第一个落盘之后才读。
 */
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('serializeCreate —— 同一个 rpId 的注册不能并发', () => {
  it('runs the second only after the first finished', async () => {
    const order: string[] = [];
    const first = serializeCreate('example.com', async () => {
      order.push('第一个开始');
      await tick(20);
      order.push('第一个落盘');
      return 1;
    });
    const second = serializeCreate('example.com', async () => {
      // 第一个落盘之后才轮到它 —— 所以它读到的会是**最新**的列表
      order.push('第二个读到的是最新的');
      return 2;
    });

    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(['第一个开始', '第一个落盘', '第二个读到的是最新的']);
  });

  /** 不同站点之间没有理由互相等 —— 那只会让用户无谓地等 */
  it('does not serialize across different rpIds', async () => {
    const order: string[] = [];
    const a = serializeCreate('a.test', async () => { await tick(20); order.push('a'); });
    const b = serializeCreate('b.test', async () => { order.push('b'); });
    await Promise.all([a, b]);
    expect(order).toEqual(['b', 'a']);
  });

  /** 一次失败不能把这个站点的注册永久卡死 —— 用户会再也注册不了 passkey */
  it('lets the queue continue after a failure', async () => {
    const bad = serializeCreate('x.test', async () => { throw new Error('boom'); });
    await expect(bad).rejects.toThrow('boom');
    // 前一个失败了，后面这个照样要能跑
    expect(await serializeCreate('x.test', async () => 'ok')).toBe('ok');
  });

  it('returns each caller its own result', async () => {
    const results = await Promise.all([
      serializeCreate('q.test', async () => 'one'),
      serializeCreate('q.test', async () => 'two'),
      serializeCreate('q.test', async () => 'three'),
    ]);
    expect(results).toEqual(['one', 'two', 'three']);
  });
});
