import { describe, it, expect } from 'vitest';
import { classifyFields, isLikelyLoginForm, type FieldDescriptor } from './form-fields';

/**
 * 描述一个输入框。刻意不依赖 DOM —— 读取 DOM 是另一层的事，
 * 这里只做「拿到这些线索之后，哪个框该填什么」的判断。
 */
function field(over: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return {
    type: 'text', name: '', id: '', autocomplete: '', placeholder: '',
    ariaLabel: '', labelText: '', isVisible: true, isDisabled: false, isReadOnly: false,
    ...over,
  };
}

const pw = (over: Partial<FieldDescriptor> = {}) => field({ type: 'password', ...over });

describe('isLikelyLoginForm', () => {
  it('is true when there is a password field', () => {
    expect(isLikelyLoginForm([field({ type: 'email' }), pw()])).toBe(true);
  });

  it('is false when there is no password field', () => {
    expect(isLikelyLoginForm([field({ name: 'search' }), field({ name: 'q' })])).toBe(false);
  });

  it('is false for an empty field list', () => {
    expect(isLikelyLoginForm([])).toBe(false);
  });

  it('is false when every password field is disabled or readonly', () => {
    expect(isLikelyLoginForm([pw({ isDisabled: true })])).toBe(false);
    expect(isLikelyLoginForm([pw({ isReadOnly: true })])).toBe(false);
  });

  /**
   * 多步登录（先填邮箱、下一步才出密码）在第一屏没有 password 字段。
   * 只凭「有没有 password」会漏掉，所以要认 autocomplete=username 这种明确信号。
   */
  it('is true for a username-only step that declares itself as such', () => {
    expect(isLikelyLoginForm([field({ type: 'email', autocomplete: 'username' })])).toBe(true);
  });
});

describe('classifyFields —— 单密码框（最常见的登录表单）', () => {
  it('picks the password field and the text field before it as username', () => {
    const r = classifyFields([
      field({ type: 'email', name: 'email' }),
      pw({ name: 'password' }),
    ]);
    expect(r.username).toBe(0);
    expect(r.password).toBe(1);
    expect(r.newPassword).toBeUndefined();
  });

  it('ignores text fields that come after the password', () => {
    const r = classifyFields([
      field({ name: 'user' }),
      pw({ name: 'pass' }),
      field({ name: 'search' }),
    ]);
    expect(r.username).toBe(0);
    expect(r.password).toBe(1);
  });

  /** 显式声明优先于位置猜测 —— autocomplete 是网页作者给的确定信息 */
  it('prefers an explicit autocomplete=username over position', () => {
    const r = classifyFields([
      field({ name: 'search', autocomplete: 'off' }),
      field({ name: 'login', autocomplete: 'username' }),
      pw({ name: 'pass', autocomplete: 'current-password' }),
    ]);
    expect(r.username).toBe(1);
    expect(r.password).toBe(2);
  });
});

describe('classifyFields —— 注册表单（两个密码框）', () => {
  it('treats the first password as the new password and the second as confirmation', () => {
    const r = classifyFields([
      field({ name: 'email', autocomplete: 'username' }),
      pw({ name: 'password', autocomplete: 'new-password' }),
      pw({ name: 'password2', autocomplete: 'new-password' }),
    ]);
    expect(r.username).toBe(0);
    expect(r.newPassword).toBe(1);
    expect(r.confirmPassword).toBe(2);
    // 注册表单里没有「当前密码」可填
    expect(r.password).toBeUndefined();
  });

  /** 没有 autocomplete 提示时靠标签文字判断 */
  it('recognises a confirmation field by its label', () => {
    const r = classifyFields([
      pw({ name: 'pw' }),
      pw({ name: 'pw2', labelText: '确认密码' }),
    ]);
    expect(r.newPassword).toBe(0);
    expect(r.confirmPassword).toBe(1);
  });
});

describe('classifyFields —— 改密码表单（三个密码框）', () => {
  it('maps current / new / confirm in order', () => {
    const r = classifyFields([
      pw({ name: 'old', autocomplete: 'current-password' }),
      pw({ name: 'new', autocomplete: 'new-password' }),
      pw({ name: 'confirm', autocomplete: 'new-password' }),
    ]);
    expect(r.password).toBe(0);
    expect(r.newPassword).toBe(1);
    expect(r.confirmPassword).toBe(2);
  });
});

describe('classifyFields —— 验证码字段', () => {
  it('recognises autocomplete=one-time-code', () => {
    const r = classifyFields([
      field({ name: 'user' }),
      pw({ name: 'pass' }),
      field({ name: 'x', autocomplete: 'one-time-code' }),
    ]);
    expect(r.totp).toBe(2);
  });

  it('recognises common names', () => {
    for (const name of ['otp', 'totp', '2fa', 'mfa', 'verificationCode', 'authcode']) {
      const r = classifyFields([pw({ name: 'pass' }), field({ name })]);
      expect(r.totp, `name=${name}`).toBe(1);
    }
  });

  /** ⚠️ 把验证码填进用户名框会直接毁掉这次登录 —— 必须要求它是文本框而非密码框 */
  it('does not treat a password field as the code field', () => {
    const r = classifyFields([field({ name: 'user' }), pw({ name: 'otp' })]);
    expect(r.totp).toBeUndefined();
    expect(r.password).toBe(1);
  });

  /** 邮箱验证码那种「输 code」的框不该被误当成 TOTP */
  it('does not treat a search box as the code field', () => {
    const r = classifyFields([pw({ name: 'pass' }), field({ type: 'search', name: 'code' })]);
    expect(r.totp).toBeUndefined();
  });
});

describe('classifyFields —— 不该填的框', () => {
  it('never selects hidden, disabled or readonly fields', () => {
    const r = classifyFields([
      field({ name: 'user', isVisible: false }),
      pw({ name: 'pass', isDisabled: true }),
      pw({ name: 'pass2', isReadOnly: true }),
      field({ type: 'hidden', name: 'csrf' }),
    ]);
    expect(r.username).toBeUndefined();
    expect(r.password).toBeUndefined();
    expect(r.newPassword).toBeUndefined();
  });

  it('does not treat submit buttons or checkboxes as text fields', () => {
    const r = classifyFields([
      field({ type: 'checkbox', name: 'remember' }),
      field({ type: 'submit', name: 'go' }),
      pw({ name: 'pass' }),
    ]);
    expect(r.username).toBeUndefined();
    expect(r.password).toBe(2);
  });

  /** 搜索框在密码框之前时不该被当成用户名 */
  it('skips obvious search boxes when looking for the username', () => {
    const r = classifyFields([
      field({ type: 'search', name: 'q', placeholder: '搜索' }),
      field({ type: 'email', name: 'email' }),
      pw({ name: 'password' }),
    ]);
    expect(r.username).toBe(1);
  });

  it('skips fields that already hold a value when picking the username', () => {
    const r = classifyFields([
      field({ type: 'text', name: 'search', placeholder: '站内搜索', value: '已经输了' }),
      field({ type: 'email', name: 'email' }),
      pw({ name: 'password' }),
    ]);
    expect(r.username).toBe(1);
  });
});

describe('classifyFields —— 边界', () => {
  it('returns nothing for an empty form', () => {
    expect(classifyFields([])).toEqual({});
  });

  it('treats tel/number inputs as username candidates', () => {
    const r = classifyFields([field({ type: 'tel', name: 'phone' }), pw({ name: 'pass' })]);
    expect(r.username).toBe(0);
  });

  /** 有的网站手机号登录用 number 型输入框 */
  it('accepts a number input as the username when nothing better exists', () => {
    const r = classifyFields([field({ type: 'number', name: 'mobile' }), pw({ name: 'pass' })]);
    expect(r.username).toBe(0);
  });
});
