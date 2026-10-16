// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { CredentialForms, sameOriginDocument } from './credential-form';

beforeEach(() => {
  document.body.innerHTML = '';
  Object.defineProperty(HTMLElement.prototype, 'getClientRects', { configurable: true, value() { return [{ width: 100, height: 30 }]; } });
});
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
function grantedBridge(forms: CredentialForms, nonce: string) {
  const bridge = forms.bridge(nonce, () => true);
  return { describe: bridge.describe, fill: async (index: number, password: string, replace: boolean) => {
    const target = await bridge.describe(index);
    return bridge.fill(index, password, replace, { formId: target?.formId ?? '', targetId: target?.targetId ?? '', token: 't' });
  } };
}
describe('credential form boundaries', () => {
  it('includes form-associated controls and populated usernames, tokenized autocomplete, labels and shown passwords', () => {
    document.body.innerHTML = '<form id="f"><label for="u">Account</label><input id="u" autocomplete="section-a username" value="alice"><input id="p" type="text" autocomplete="section-a new-password"></form><input id="c" form="f" type="password" name="confirm">';
    const forms = new CredentialForms(document);
    const group = forms.group(input('p'))!;
    expect(group.fields).toHaveLength(3);
    expect(group.username).toBe(input('u'));
    expect(group.password).toBe(input('p'));
    expect(group.confirm).toBe(input('c'));
    expect(group.intent).toBe('signup');
    expect(forms.snapshot(input('p'), false)).toBeNull();
    input('p').value = input('c').value = 'new password';
    expect(forms.snapshot(input('p'), true)).toMatchObject({ username: 'alice', password: 'new password', submitted: true });
    expect(forms.group(input('c'))!.id).toBe(group.id);
  });
  it('refuses hidden, disabled, OTP fields, ambiguous containers and mismatching confirmation', () => {
    document.body.innerHTML = '<section><input id="p" type="password"><input type="password"><input type="password"><input type="password"></section><form><input id="otp" type="password" autocomplete="one-time-code"><input id="hidden" type="password" style="display:none"><input type="password" disabled></form>';
    const forms = new CredentialForms(document);
    expect(forms.group(input('p'))).toBeNull();
    expect(forms.group(input('otp'))?.password ?? null).toBeNull();
    expect(forms.group(input('hidden'))).toBeNull();
    document.body.innerHTML = '<fieldset><input id="p" type="password" autocomplete="new-password" value="one"><input id="c" type="password" name="confirm" value="two"></fieldset>';
    expect(forms.snapshot(input('p'), true)).toBeNull();
  });
  it('refuses ambiguous formless login pairs while allowing explicit signup and password-change roles', () => {
    document.body.innerHTML = '<section><input name="email"><input id="p" type="password"><input name="email"><input type="password"></section>';
    const forms = new CredentialForms(document);
    expect(forms.group(input('p'))).toBeNull();
    document.body.innerHTML = '<section><input id="p" type="password" autocomplete="current-password"><input type="password" autocomplete="new-password"></section>';
    expect(forms.group(input('p'))?.intent).toBe('change');
    document.body.innerHTML = '<section><input id="p" type="password"><input type="password" name="confirmPassword"></section>';
    expect(forms.group(input('p'))?.intent).toBe('signup');
  });
  it('does not capture a password-masked OTP identified by its accessible name', () => {
    document.body.innerHTML = '<form><input id="p" type="password" aria-label="One time verification code" value="123456"></form>';
    expect(new CredentialForms(document).snapshot(input('p'), true)).toBeNull();
  });
  it('does not promote a never-password text note from its name or label', () => {
    document.body.innerHTML = '<form><label for="password-note">Password note</label><input id="password-note" type="text" value="plain note"></form>';
    expect(new CredentialForms(document).snapshot(input('password-note'), true)).toBeNull();
  });
  it('infers signup for a generic single password only from registration semantics in that same group', () => {
    document.body.innerHTML = '<h1>Register</h1><form><input id="login" type="password"><button>Login</button></form><form><h2>Create account</h2><input id="p" type="password"><button>Register</button></form>';
    const forms = new CredentialForms(document);
    expect(forms.group(input('login'))?.intent).toBe('login');
    expect(forms.group(input('p'))?.intent).toBe('signup');
  });
  it('keeps independent forms and safe semantic formless groups separate', () => {
    document.body.innerHTML = '<form><input id="a" type="password"></form><section><input id="b" type="password"></section><div><input id="c" type="password"></div>';
    const forms = new CredentialForms(document);
    expect(forms.group(input('a'))!.id).not.toBe(forms.group(input('b'))!.id);
    expect(forms.group(input('c'))).toBeNull();
  });
  it('resolves nested content of associated submit buttons and remembers show-password toggles', () => {
    document.body.innerHTML = '<form id="f"><input id="p" type="password" value="secret"></form><button form="f"><span id="s">Login</span></button>';
    const forms = new CredentialForms(document);
    const group = forms.group(input('p'))!;
    expect(forms.group(document.getElementById('s')!)?.id).toBe(group.id);
    input('p').type = 'text';
    expect(forms.snapshot(input('p'), true)?.password).toBe('secret');
  });
  it('rejects opaque or cross-origin frame documents', () => {
    expect(sameOriginDocument({ location: { origin: 'https://a.test' }, top: { location: { origin: 'https://a.test' } } } as Window)).toBe(true);
    expect(sameOriginDocument({ location: { origin: 'null' }, top: { location: { origin: 'null' } } } as Window)).toBe(false);
    expect(sameOriginDocument({ location: { origin: 'https://b.test' }, top: { get location() { throw new Error('cross origin'); } } } as unknown as Window)).toBe(false);
  });
});

describe('generation bridge', () => {
  it('describes impossible simple-generator constraints so the panel can explain the full generator option', async () => {
    document.body.innerHTML = '<form><input id="p" type="password" autocomplete="new-password" minlength="80"></form>';
    expect(await new CredentialForms(document).bridge('n', () => true).describe(0)).toMatchObject({ minLength: 80, maxLength: 64 });
  });
  it('binds the approved password and confirmation elements when fields are replaced at the same indices', async () => {
    document.body.innerHTML = '<form><input id="p" type="password" autocomplete="new-password"><input id="c" type="password" name="confirm"></form>';
    const bridge = new CredentialForms(document).bridge('n', () => true);
    const approved = await bridge.describe(0); expect(approved).not.toBeNull();
    input('p').replaceWith(input('p').cloneNode());
    expect((await bridge.fill(0, 'generated-secret', false, { ...approved!, token: 't' })).ok).toBe(false);
    expect(input('p').value).toBe(''); expect(input('c').value).toBe('');
  });
  it('describes intersected constraints and refuses manual replacement until explicitly approved', async () => {
    document.body.innerHTML = '<form><input id="p" type="password" autocomplete="new-password" minlength="12" maxlength="30" value="manual"><input id="c" type="password" name="confirm" minlength="15" maxlength="24"></form>';
    const forms = new CredentialForms(document);
    const bridge = grantedBridge(forms, 'nonce');
    expect(await bridge.describe(0)).toMatchObject({ minLength: 15, maxLength: 24, needsReplacement: true, confirmIndex: 1 });
    expect((await bridge.fill(0, 'long-enough-generated', false)).ok).toBe(false);
    expect(input('p').value).toBe('manual');
    expect((await bridge.fill(0, 'long-enough-generated', true)).ok).toBe(true);
    expect(input('c').value).toBe('long-enough-generated');
    expect(await bridge.describe(0)).toMatchObject({ needsReplacement: false });
    expect((await bridge.fill(0, 'second-generated-value', false)).ok).toBe(true);
    input('c').value = 'manual change';
    expect(await bridge.describe(0)).toMatchObject({ needsReplacement: true });
  });
  it('rechecks role, visibility, patterns and readback and uses the native setter', async () => {
    document.body.innerHTML = '<form><input id="old" type="password" autocomplete="current-password"><input id="p" type="password" autocomplete="new-password" pattern="[A-Z]{8,64}"><input id="c" type="password" name="confirm"></form>';
    const forms = new CredentialForms(document); const bridge = grantedBridge(forms, 'n');
    expect(await bridge.describe(0)).toBeNull();
    expect((await bridge.fill(1, 'lowercase', false)).ok).toBe(false);
    const events: string[] = [];
    input('p').addEventListener('input', () => events.push('input'));
    Object.defineProperty(input('p'), 'value', { configurable: true, set() { throw new Error('framework setter'); }, get() { return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.get!.call(this); } });
    expect((await bridge.fill(1, 'ABCDEFGHIJKL', false)).ok).toBe(true);
    expect(events).toEqual(['input']);
    input('p').style.display = 'none';
    expect(await bridge.describe(1)).toBeNull();
  });
  it('refuses fill if a site changes constraints while target metadata is being read', async () => {
    document.body.innerHTML = '<form><input id="p" type="password" autocomplete="new-password"></form>';
    const forms = new CredentialForms(document); const bridge = grantedBridge(forms, 'n');
    const pending = bridge.fill(0, 'initially-valid-password', false);
    queueMicrotask(() => { input('p').maxLength = 8; });
    expect((await pending).ok).toBe(false);
    expect(input('p').value).toBe('');
  });
  it('does not fill a confirmation control whose form ownership changes after the first input event', async () => {
    document.body.innerHTML = '<form id="f"><input id="p" type="password" autocomplete="new-password"><input id="c" type="password" name="confirm"></form><form id="other"></form>';
    input('p').addEventListener('input', () => input('c').setAttribute('form', 'other'));
    const bridge = grantedBridge(new CredentialForms(document), 'n');
    expect((await bridge.fill(0, 'generated-password', false)).ok).toBe(false);
    expect(input('c').value).toBe('');
  });
  it('recognizes generated values and manual edits even on HTTP without WebCrypto subtle', async () => {
    const original = Object.getOwnPropertyDescriptor(crypto, 'subtle');
    Object.defineProperty(crypto, 'subtle', { configurable: true, value: undefined });
    try {
      document.body.innerHTML = '<form><input id="p" type="password" autocomplete="new-password"></form>';
      const bridge = grantedBridge(new CredentialForms(document), 'n');
      expect((await bridge.fill(0, 'generated-secret-value', false)).ok).toBe(true);
      expect(await bridge.describe(0)).toMatchObject({ needsReplacement: false });
      input('p').value = 'manual-edited-secret';
      expect(await bridge.describe(0)).toMatchObject({ needsReplacement: true });
    } finally {
      if (original) Object.defineProperty(crypto, 'subtle', original); else Reflect.deleteProperty(crypto, 'subtle');
    }
  });
});
