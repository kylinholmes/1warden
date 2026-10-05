import type { SessionStatus } from '@coffer/vault';

export type Screen = 'connect' | 'unlock' | 'loading' | 'vault';

/**
 * 会话状态 → 该显示哪一屏。
 *
 * 抽成纯函数是因为这里的判断曾经错过一次，而错了以后**很难看出来**：
 * 原来用的是「`session.account` 是否存在」——
 *
 *   - `account` 在登录**一成功**就置上了，而同步还要再跑好几秒；
 *   - 那几秒里界面会先闪一下解锁屏（账户已知、等你输主密码的样子）；
 *   - 更糟的是，如果同步在这期间出错，错误会设到**已经被卸载的**连接屏上，
 *     用户停在解锁屏，看不到任何原因，只知道「连不上」。
 *
 * 改用状态机之后这些都不成立：`unlocking` 明确地属于「还在连接」。
 */
export function screenFor(status: SessionStatus): Screen {
  if (status === 'unlocked') return 'vault';
  if (status === 'locked') return 'unlock';
  /*
   * ⚠️ `unlocking` **不是**「还在连接」—— 它已经是连接成功了。
   *
   * 这一步在同步整个保险库（拉全部密文 + 逐条解密），可能是几秒。
   * 原先把它归到 connect，于是那几秒里用户盯着的是**自己刚提交过的
   * 那个登录表单**，一动不动 —— 反馈「登录很慢」的直接来源。
   *
   * 它也不该归到 vault：那时会话里一条数据都还没有，
   * 渲染主界面会先闪一个空保险库（`doSync` 的注释里写着这件事）。
   */
  if (status === 'unlocking') return 'loading';
  return 'connect';
}
