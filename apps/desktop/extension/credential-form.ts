import { classifyFields, type FieldDescriptor } from '@1warden/vault';
import { sha256Portable } from '@1warden/crypto';
import type { FormCapture } from './capture-service';
import type { CredentialDocumentBridge, GenerationTarget } from './credential-protocol';

export function sameOriginDocument(view: Window): boolean {
  try { return /^https?:\/\//.test(view.location.origin) && view.top?.location.origin === view.location.origin; }
  catch { return false; }
}

/** getRandomValues is also available on HTTP documents where randomUUID is absent. */
export function credentialIdentity(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function visibleCredentialField(field: HTMLInputElement): boolean {
  if (!field.isConnected || field.disabled || field.readOnly || field.type === 'hidden' || field.closest('[hidden], [inert]')) return false;
  for (let el: Element | null = field; el; el = el.parentElement) {
    const style = field.ownerDocument.defaultView!.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
  }
  return field.getClientRects().length > 0;
}

export interface CredentialGroup {
  element: Element; id: string; fields: HTMLInputElement[];
  username: HTMLInputElement | null; password: HTMLInputElement | null; confirm: HTMLInputElement | null;
  current: HTMLInputElement | null; intent: FormCapture['intent'];
}

const semantic = '[role="form"], fieldset, section, article, [role="group"][aria-label]';
const otpHint = /\b(?:otp|totp|mfa|2fa)\b|one[\s-]*time|verification[\s-]*code|security[\s-]*code|auth[\s-]*code|验证码|动态码|令牌/i;
const fieldHints = (field: FieldDescriptor) => `${field.name} ${field.id} ${field.labelText} ${field.ariaLabel} ${field.autocomplete}`;
const isPasswordDescriptor = (field: FieldDescriptor) => !field.autocomplete.split(/\s+/).includes('one-time-code')
  && (field.type === 'password' || field.autocomplete.split(/\s+/).some(token => token === 'new-password' || token === 'current-password'));
const tokens = (field: HTMLInputElement) => (field.autocomplete || '').toLowerCase().split(/\s+/);

/** Element identity and generated-value digests stay in this ISOLATED world. */
export class CredentialForms {
  private ids = new WeakMap<Element, string>();
  private seenPasswords = new WeakSet<HTMLInputElement>();
  private generated = new WeakMap<HTMLInputElement, string>();
  private identities = new WeakMap<HTMLInputElement, string>();
  constructor(private document: Document) {}

  private descriptor(field: HTMLInputElement): FieldDescriptor {
    const labelText = [Array.from(field.labels ?? []).map(l => l.textContent ?? '').join(' '),
      (field.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => this.document.getElementById(id)?.textContent ?? '').join(' ')].join(' ').trim().slice(0, 200);
    if (field.type === 'password') this.seenPasswords.add(field);
    const type = field.type === 'text' && this.seenPasswords.has(field) ? 'password' : field.type;
    const autocomplete = otpHint.test(`${field.name} ${field.id} ${labelText} ${field.placeholder} ${field.getAttribute('aria-label') ?? ''}`)
      ? `${field.autocomplete} one-time-code` : field.autocomplete;
    return { type, id: field.id, name: field.name, autocomplete, placeholder: field.placeholder,
      ariaLabel: field.getAttribute('aria-label') ?? '', labelText, isVisible: visibleCredentialField(field),
      isDisabled: field.disabled, isReadOnly: field.readOnly, value: field.value ? ' ' : '' };
  }

  group(target: Element): CredentialGroup | null {
    let element: Element | null;
    if (target instanceof HTMLFormElement) element = target;
    else if (target instanceof HTMLInputElement || target instanceof HTMLButtonElement) element = target.form ?? target.closest(semantic);
    else {
      const associated = target.closest('button, input');
      element = (associated instanceof HTMLButtonElement || associated instanceof HTMLInputElement ? associated.form : null)
        ?? target.closest('form') ?? target.closest(semantic);
    }
    if (!element) return null;
    if (target instanceof HTMLInputElement && !visibleCredentialField(target)) return null;
    const fields = Array.from(this.document.querySelectorAll<HTMLInputElement>('input')).filter(field =>
      element instanceof HTMLFormElement ? field.form === element : field.form === null && field.closest(semantic) === element);
    const descriptors = fields.map(field => this.descriptor(field));
    const usable = descriptors.filter(f => f.isVisible && !f.isDisabled && !f.isReadOnly);
    const passwords = usable.filter(isPasswordDescriptor);
    if (passwords.length > 3
      || usable.filter(f => f.autocomplete.split(/\s+/).includes('username')).length > 1) return null;
    if (!(element instanceof HTMLFormElement)) {
      const hints = passwords.map(fieldHints);
      const confirmation = /confirm|repeat|again|retype|确认|再次|重复|再输/i;
      const fresh = /new-password|new|create|choose|设置|新密码/i;
      const current = /current-password|current|old|existing|当前|原密码|旧/i;
      // Without a form owner, multiple anonymous password pairs are ambiguous.
      if (passwords.length === 2 && !confirmation.test(hints[1]!) && !fresh.test(hints[0]!)
        && !(current.test(hints[0]!) && fresh.test(hints[1]!))) return null;
      if (passwords.length === 3 && !(current.test(hints[0]!) && fresh.test(hints[1]!)
        && (confirmation.test(hints[2]!) || fresh.test(hints[2]!)))) return null;
      const explicitUser = usable.some(f => f.autocomplete.split(/\s+/).includes('username'));
      if (!explicitUser && usable.filter(f => !isPasswordDescriptor(f) && ['text', 'email', 'tel'].includes(f.type)
        && /email|user|login|account|phone|邮箱|用户|账号|手机/i.test(fieldHints(f))).length > 1) return null;
    }
    const plan = classifyFields(descriptors);
    const at = (index: number | undefined) => index === undefined ? null : fields[index] ?? null;
    let intent: FormCapture['intent'] = plan.newPassword === undefined ? 'login' : plan.password === undefined ? 'signup' : 'change';
    if (intent === 'login' && passwords.length === 1 && !passwords[0]!.autocomplete.split(/\s+/).includes('current-password')) {
      const headings = Array.from(element.querySelectorAll('h1, h2, h3, legend')).map(node => node.textContent ?? '').join(' ');
      const buttons = Array.from(this.document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input[type="submit"]'))
        .filter(button => element instanceof HTMLFormElement ? button.form === element : button.form === null && button.closest(semantic) === element)
        .map(button => `${button.textContent ?? ''} ${button instanceof HTMLInputElement ? button.value : ''} ${button.getAttribute('aria-label') ?? ''}`).join(' ');
      if (/sign[\s-]*up|register|create[\s-]*(?:an?[\s-]*)?account|注册|创建账号|创建账户/i.test(`${headings} ${buttons}`)) intent = 'signup';
    }
    let id = this.ids.get(element);
    if (!id) { id = credentialIdentity(); this.ids.set(element, id); }
    return { element, id, fields, username: at(plan.username), current: intent === 'signup' ? null : at(plan.password),
      password: at(plan.newPassword ?? plan.password), confirm: at(plan.confirmPassword),
      intent };
  }

  snapshot(target: Element, submitted: boolean): FormCapture | null {
    const group = this.group(target);
    if (!group?.password || !group.password.value || group.password.value.length > 4096) return null;
    if (group.confirm && (!group.confirm.value || group.confirm.value !== group.password.value)) return null;
    return { formId: group.id, username: group.username?.value.trim().slice(0, 1024) || null,
      password: group.password.value, intent: group.intent, submitted };
  }

  /** A confirm field opens the generator for the group's new-password field. */
  generationField(field: HTMLInputElement): HTMLInputElement | null {
    const group = this.group(field);
    if (!group?.password || (group.password !== field && group.confirm !== field)) return null;
    return group.password;
  }

  index(field: HTMLInputElement): number { return Array.from(this.document.querySelectorAll('input, textarea')).indexOf(field); }

  private async digest(value: string): Promise<string> {
    const bytes = await sha256Portable(new TextEncoder().encode(value));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  private fieldIdentity(field: HTMLInputElement): string {
    let id = this.identities.get(field);
    if (!id) { id = credentialIdentity(); this.identities.set(field, id); }
    return id;
  }
  private targetIdentity(fields: HTMLInputElement[]): string { return fields.map(field => this.fieldIdentity(field)).join(':'); }

  private async target(index: number): Promise<{ description: GenerationTarget; fields: HTMLInputElement[]; values: string[] } | null> {
    const field = this.document.querySelectorAll('input, textarea')[index];
    if (!(field instanceof HTMLInputElement)) return null;
    const group = this.group(field);
    if (!group?.password || group.password !== field || tokens(field).includes('one-time-code')) return null;
    const fields = [field, ...(group.confirm ? [group.confirm] : [])];
    const minLength = Math.max(8, ...fields.map(el => Math.max(0, el.minLength)));
    const maxLength = Math.min(64, ...fields.map(el => el.maxLength < 0 ? 64 : el.maxLength));
    if (!fields.every(visibleCredentialField)) return null;
    const values = fields.map(el => el.value);
    let needsReplacement = false;
    for (const [i, el] of fields.entries()) if (values[i] && this.generated.get(el) !== await this.digest(values[i]!)) needsReplacement = true;
    return { description: { formId: group.id, targetId: this.targetIdentity(fields), passwordIndex: index, confirmIndex: group.confirm ? this.index(group.confirm) : null,
      minLength, maxLength, needsReplacement }, fields, values };
  }

  bridge(nonce: string, authorized: (token: string) => string | number | boolean | null): CredentialDocumentBridge {
    return { nonce,
      describe: async index => (await this.target(index))?.description ?? null,
      fill: async (index, password, replace, expected) => {
        const grant = expected ? authorized(expected.token) : null;
        const active = () => !!expected && grant !== null && grant !== false && authorized(expected.token) === grant;
        if (!active()) return { ok: false, error: '保险库已锁定或网页授权已失效' };
        const target = await this.target(index);
        const fail = (error: string) => ({ ok: false, error });
        if (!active() || !target || target.description.formId !== expected.formId || target.description.targetId !== expected.targetId) return fail('密码输入框或授权已改变，请重新选择');
        if (target.description.needsReplacement && !replace) return fail('输入框已有内容，请确认替换');
        if (password.length < target.description.minLength || password.length > target.description.maxLength) return fail('密码长度不符合网页要求');
        for (const field of target.fields) {
          if (field.pattern) {
            try { if (!new RegExp(`^(?:${field.pattern})$`, 'v').test(password)) return fail('密码不符合网页格式要求'); }
            catch { return fail('无法确认网页密码格式要求'); }
          }
        }
        // Digesting is asynchronous: recheck live grouping and values before mutation.
        const live = await this.target(index);
        if (!active() || !live || live.description.formId !== target.description.formId || live.description.targetId !== expected.targetId || live.fields.some((field, i) => field !== target.fields[i])
          || (!replace && live.description.needsReplacement)) return fail('网页已改变，请重新操作');
        const current = this.group(live.fields[0]!);
        if (!current || current.id !== live.description.formId || current.password !== live.fields[0]
          || current.confirm !== (live.fields[1] ?? null) || this.document.querySelectorAll('input, textarea')[index] !== current.password
          || live.fields.some((field, i) => !visibleCredentialField(field) || field.value !== live.values[i])) return fail('网页已改变，请重新操作');
        const minLength = Math.max(8, ...live.fields.map(field => field.minLength));
        const maxLength = Math.min(64, ...live.fields.map(field => field.maxLength < 0 ? 64 : field.maxLength));
        if (password.length < minLength || password.length > maxLength) return fail('网页密码长度要求已改变');
        for (const field of live.fields) {
          if (field.pattern) {
            try { if (!new RegExp(`^(?:${field.pattern})$`, 'v').test(password)) return fail('网页密码格式要求已改变'); }
            catch { return fail('无法确认网页密码格式要求'); }
          }
        }
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (!setter) return fail('浏览器不支持填充此输入框');
        for (const field of live.fields) {
          const currentGroup = this.group(field);
          if (!active() || !currentGroup || currentGroup.id !== live.description.formId || this.targetIdentity(live.fields) !== expected.targetId || currentGroup.password !== live.fields[0]
            || currentGroup.confirm !== (live.fields[1] ?? null) || !visibleCredentialField(field)) return fail('网页已改变，请重新操作');
          setter.call(field, password);
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (!active() || !live.fields.every(field => field.isConnected && visibleCredentialField(field) && field.value === password
          && this.group(field)?.id === live.description.formId)) return fail('网页未接受生成的密码');
        const hash = await this.digest(password);
        if (!active()) return fail('保险库已锁定或网页授权已失效');
        for (const field of live.fields) this.generated.set(field, hash);
        return { ok: true };
      },
    };
  }
}
