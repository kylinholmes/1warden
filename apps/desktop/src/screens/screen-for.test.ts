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
   * 这条是关键。`unlocking` 期间账户**已经**知道了，但同步还没跑完 ——
   * 曾经用 `session.account` 判断，于是这几秒会闪出一个解锁屏；
   * 同步若在此期间出错，错误还会被那个屏吞掉，用户只看到「连不上」。
   */
  it('keeps showing the connect screen while unlocking', () => {
    expect(screenFor('unlocking')).toBe('connect');
  });
});
