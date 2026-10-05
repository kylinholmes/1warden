import { describe, it, expect } from 'vitest';
import { screenFor } from './screen-for';

describe('screenFor', () => {
  it('shows the vault once unlocked', () => {
    expect(screenFor('unlocked')).toBe('vault');
  });

  it('shows the unlock screen when locked with a known account', () => {
    expect(screenFor('locked')).toBe('unlock');
  });

  it('shows the connect screen when logged out', () => {
    expect(screenFor('loggedOut')).toBe('connect');
  });

  /**
   * 这条改过一次，两次的理由都值得留着。
   *
   * **第一版**用 `session.account` 是否存在来判断，于是 `unlocking` 期间
   * （账户已知道、同步没跑完）会闪出一个解锁屏；同步若在此期间出错，
   * 错误还会被那个屏吞掉，用户只看到「连不上」。
   * 所以改成按状态机判断，`unlocking` → `connect`。
   *
   * **现在**改成 `loading`。因为「归到 connect」虽然修好了上面那件事，
   * 却留下了另一个：这几秒里用户盯着的是**自己刚提交过的那个登录表单**，
   * 一动不动。那是「登录很慢」的直接来源 —— 慢的不只是加载，
   * 还有完全看不到它在做事。
   *
   * 也不该归到 `vault`：那时会话里一条数据都还没有，会先闪一个空保险库。
   */
  it('shows a loading screen while unlocking', () => {
    expect(screenFor('unlocking')).toBe('loading');
  });

  /** 三态必须互不相同 —— 塌掉任何一个都会退回到上面那些问题 */
  it('maps every status to a distinct screen', () => {
    const screens = (['loggedOut', 'locked', 'unlocking', 'unlocked'] as const).map(screenFor);
    expect(new Set(screens).size).toBe(4);
  });
});
