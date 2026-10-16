import { describe, expect, it } from 'vitest';
import { focusedPlan, type InlineField } from './inline-fields';

const field = (extra: Partial<InlineField> = {}): InlineField => ({
  type: 'text', id: '', name: '', autocomplete: '', placeholder: '', ariaLabel: '', labelText: '',
  isVisible: true, isDisabled: false, isReadOnly: false, formIndex: 0, maxLength: -1, ...extra,
});

describe('focused authentication suggestions', () => {
  it('recognizes a standalone GitHub-style authenticator step', () => {
    expect(focusedPlan([field({ name: 'app_otp', id: 'app_totp', autocomplete: 'one-time-code' })], 0))
      .toMatchObject({ kind: 'totp', otp: [0] });
  });
  it('offers the same code from any cell of a six-cell verification input', () => {
    const fields = Array.from({ length: 6 }, (_, i) => field({ maxLength: 1, autocomplete: i === 0 ? 'one-time-code' : '' }));
    expect(focusedPlan(fields, 4)).toMatchObject({ kind: 'totp', otp: [0, 1, 2, 3, 4, 5] });
  });
  it('does not offer TOTP for recovery, SMS, email, or promo codes', () => {
    for (const name of ['recovery_code', 'sms_otp', 'email_verification_code', 'coupon_code']) {
      expect(focusedPlan([field({ name, autocomplete: 'one-time-code' })], 0)).toBeNull();
    }
  });
  it('does not mistake an unlabelled row of digits for a TOTP challenge', () => {
    expect(focusedPlan(Array.from({ length: 6 }, () => field({ maxLength: 1 })), 0)).toBeNull();
  });
  it('keeps suggestions within the focused form, excluding hidden fields', () => {
    const fields = [field({ autocomplete: 'username' }), field({ type: 'password' }),
      field({ autocomplete: 'username', formIndex: 1 }), field({ type: 'password', formIndex: 1 }),
      field({ autocomplete: 'one-time-code', isVisible: false, formIndex: 1 })];
    expect(focusedPlan(fields, 3)).toMatchObject({ kind: 'login', plan: { username: 2, password: 3 } });
    expect(focusedPlan(fields, 4)).toBeNull();
  });
  it('keeps new passwords with the generator and excludes them from saved account fill', () => {
    const fields = [field({ type: 'password', autocomplete: 'current-password' }),
      field({ type: 'password', autocomplete: 'new-password' }), field({ type: 'password', name: 'confirm_password' })];
    expect(focusedPlan(fields, 0)).toMatchObject({ kind: 'login', plan: { password: 0 } });
    expect(focusedPlan(fields, 0)?.plan).not.toHaveProperty('newPassword');
    expect(focusedPlan(fields, 1)).toBeNull();
  });
  it('recognizes username-only sign-in but leaves newsletter email fields alone', () => {
    expect(focusedPlan([field({ type: 'email', name: 'email', autocomplete: 'username' })], 0)?.kind).toBe('login');
    expect(focusedPlan([field({ type: 'email', name: 'login_email' })], 0)?.kind).toBe('login');
    expect(focusedPlan([field({ type: 'email', autocomplete: 'email', name: 'newsletter' })], 0)).toBeNull();
  });
});
