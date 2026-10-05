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
   * 这条**改过两回**，三次的理由都值得留着 —— 每一次都是在修
   * 「让用户等一件他不需要等的事」的不同变体。
   *
   * **第一版**用 `session.account` 是否存在判断，于是 `unlocking` 期间
   * （账户已知、同步没完）会闪出一个解锁屏；同步若出错，错误还被那个屏
   * 吞掉，用户只看到「连不上」。→ 改成按状态机，`unlocking` → `connect`。
   *
   * **第二版**归到 `connect`：那几秒里用户盯着的是**自己刚提交过的登录表单**。
   * → 改成独立的 `loading` 屏。
   *
   * **第三版（现在）**归到 `vault`：走到 `unlocking` 时登录已经成功、
   * 密钥已经拿到，缺的只是数据 —— 而数据是**后台**在补。再挡一整屏
   * 就是让用户等一件他不需要等的事，而那时候他要的是立刻看到保险库。
   *
   * 列表那栏自己会区分「真的空」和「还在载入」，不会因为这条改动而报假信。
   */
  it('goes straight to the vault while unlocking', () => {
    expect(screenFor('unlocking')).toBe('vault');
  });

  /**
   * ⚠️ `unlocking` 与 `unlocked` **允许**映射到同一屏。
   *
   * 这条第一版写的是「四态必须映射到四个不同的屏」，并在注释里断言
   * 「塌掉任何一个都会退回到上面那些问题」。现在它被推翻了：
   * 两者共用 vault 是**要的** —— 区别在列表栏里（有没有转圈、
   * 空状态说不说「正在载入」），不在换不换屏。
   *
   * 保留这条是为了记住：那个断言当时听起来很有道理，但它是从
   * 「四态五屏」这个实现细节倒推出来的，不是从用户看到什么推出来的。
   */
  it('may share a screen between unlocking and unlocked', () => {
    expect(screenFor('unlocking')).toBe(screenFor('unlocked'));
  });
});
