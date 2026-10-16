import { classifyFields, type FieldDescriptor, type FieldPlan } from '@1warden/vault';

export interface InlineField extends FieldDescriptor {
  formIndex?: number;
  maxLength?: number;
}

export interface InlineTarget { index: number; kind: 'login' | 'totp' }
export interface FocusedPlan { kind: InlineTarget['kind']; plan: FieldPlan; otp: number[] }

const otherCode = /recovery|backup.?code|sms|text.?message|email|e-mail|coupon|promo|captcha|恢复|备用|短信|邮件|邮箱|优惠|图形/;
const hints = (field: InlineField): string => [field.name, field.id, field.placeholder, field.ariaLabel, field.labelText].join(' ').toLowerCase();
const usable = (field: InlineField): boolean => field.isVisible && !field.isDisabled && !field.isReadOnly;

/** Classify only the focused form; never carry new passwords into saved fill. */
export function focusedPlan(fields: readonly InlineField[], index: number): FocusedPlan | null {
  const anchor = fields[index];
  if (!anchor || !usable(anchor)) return null;
  const scoped = fields.map((field, i) => ({ field, i }))
    .filter(({ field }) => field.formIndex === anchor.formIndex);
  const local = scoped.map(({ field }) => classifyFields([field]).totp !== undefined && otherCode.test(hints(field))
    ? { ...field, autocomplete: field.autocomplete.replace(/one-time-code/gi, ''), isVisible: false } : field);
  const classified = classifyFields(local);
  const plan: FieldPlan = {};
  for (const key of ['username', 'password'] as const) {
    const position = classified[key];
    if (position !== undefined) plan[key] = scoped[position]!.i;
  }
  // Explicit username/email login steps without a password. Ordinary contact or
  // newsletter inputs are deliberately not enough evidence for account hints.
  if (plan.username === undefined && ['text', 'email', ''].includes(anchor.type)
    && /(^|[^a-z])(username|user.?name|login.?email|login.?id)([^a-z]|$)|登录邮箱|用户名/.test(hints(anchor))) {
    plan.username = index;
  }
  const otp: number[] = [];
  if (classified.totp !== undefined) {
    const start = classified.totp;
    const first = local[start]!;
    if (first.maxLength === 1) {
      let left = start;
      let right = start;
      const cell = (position: number): boolean => {
        const f = local[position];
        return !!f && usable(f) && f.maxLength === 1 && ['text', 'tel', 'number', 'password'].includes(f.type);
      };
      while (cell(left - 1)) left--;
      while (cell(right + 1)) right++;
      if (right - left + 1 >= 4 && right - left + 1 <= 10) {
        for (let i = left; i <= right; i++) otp.push(scoped[i]!.i);
      }
    } else otp.push(scoped[start]!.i);
  }
  if (otp.includes(index)) return { kind: 'totp', plan: {}, otp };
  if (index === plan.username || index === plan.password) return { kind: 'login', plan, otp: [] };
  return null;
}

/** Self-contained: also serialized by scripting.executeScript in background. */
export function readPageFields(): InlineField[] {
  const forms = Array.from(document.forms);
  return Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).map(el => {
    const labelledBy = el.getAttribute('aria-labelledby')?.split(/\s+/)
      .map(id => document.getElementById(id)?.textContent ?? '').join(' ');
    const style = getComputedStyle(el);
    return {
      type: (el.getAttribute('type') ?? 'text').toLowerCase(), name: el.name, id: el.id,
      autocomplete: el.getAttribute('autocomplete') ?? '', placeholder: el.getAttribute('placeholder') ?? '',
      ariaLabel: el.getAttribute('aria-label') ?? '',
      labelText: (labelledBy || Array.from(el.labels ?? []).map(label => label.textContent ?? '').join(' ')).trim().slice(0, 200),
      isVisible: el.getClientRects().length > 0 && !el.closest('[hidden], [inert]')
        && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && el.type !== 'hidden',
      isDisabled: el.matches(':disabled'), isReadOnly: el.readOnly, value: el.value.length ? ' ' : '',
      formIndex: el.form ? forms.indexOf(el.form) : -1, maxLength: el.maxLength,
    };
  });
}
