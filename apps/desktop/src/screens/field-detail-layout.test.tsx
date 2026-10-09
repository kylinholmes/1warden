// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { SecretField } from '@1warden/ui';
import { emptyIdentity, emptyDriversLicense, emptyPassport, emptyLogin, type VaultItem } from '@1warden/vault';
import { ItemDetail } from './VaultView';
import { itemDetail } from '../application/service';
import { EMPTY_SNAPSHOT, type ApplicationClient } from '../application/types';
import { blankEditorItem } from '../../../../packages/ui/src/item-editor-fields';
import { FIELD_LABEL_CLASS, FIELD_ROW_CLASS } from '../../../../packages/ui/src/CompoundFieldRow';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const client = {
  capabilities: { native: false, browser: true, saveAttachments: true },
  getSnapshot: () => EMPTY_SNAPSHOT, subscribe: () => () => {},
} satisfies Pick<ApplicationClient, 'capabilities' | 'getSnapshot' | 'subscribe'>;

// JSDOM checks the real mounted markup contract. Browser checks supply actual
// field geometry; changing viewport size in JSDOM would not test CSS layout.
describe('detail native/compound/custom shared label-value contract', () => {
  it.each([
    ['only given name and city', { type: 'identity', rawType: 4,
      identity: { ...emptyIdentity(), firstName: 'Only given name', city: 'Only city', company: 'Company', country: 'Country' } },
      [['identity.name', 1], ['identity.region', 1]]],
    ['all identity name/region children', { type: 'identity', rawType: 4,
      identity: { ...emptyIdentity(), lastName: 'Long surname', firstName: 'Long given name', middleName: 'Long middle name',
        state: 'Province', city: 'City', company: 'Company', country: 'Country' } },
      [['identity.name', 3], ['identity.region', 2]]],
    ['missing middle name leaves exactly two name cells', { type: 'identity', rawType: 4,
      identity: { ...emptyIdentity(), lastName: 'Herzog', firstName: 'Werner', middleName: '  ',
        state: 'Alaska', city: 'Anchorage', company: 'Company' } },
      [['identity.name', 2], ['identity.region', 2]]],
    ['only driving licence given name', { type: 'driversLicense', rawType: 7,
      driversLicense: { ...emptyDriversLicense(), firstName: 'Only given name', state: 'Province' } },
      [['driversLicense.name', 1]]],
    ['only passport given name', { type: 'passport', rawType: 8,
      passport: { ...emptyPassport(), givenName: 'Only given name', country: 'Country' } },
      [['passport.name', 1]]],
  ] as const)('%s uses the same stacked label/value pattern', async (_description, overrides, groups) => {
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const detail = itemDetail({ ...blankEditorItem(), login: null, ...overrides,
      customFields: [{ name: 'Custom field', value: 'Custom value', type: 0, linkedId: null }] } as VaultItem);
    try {
      await act(() => root.render(<ItemDetail client={client as unknown as ApplicationClient} item={detail} icons={null}
        onBack={() => {}} onEdit={() => {}} onDelete={() => {}} onToggleFavorite={() => {}} />));
      for (const [id, count] of groups) {
        const group = host.querySelector<HTMLElement>(`[data-compound-field="${id}"]`)!;
        expect(group).not.toBeNull();
        expect(group.style.gridTemplateColumns).toBe('');
        const cells = group.querySelector<HTMLElement>('[data-compound-cells]')!;
        expect(cells).not.toBeNull();
        expect(cells.children).toHaveLength(count);
        expect([...cells.children].every(child => child.getAttribute('data-field-layout') === 'inline')).toBe(true);
        // A surviving child must not gain a special column span, indentation,
        // missing-field placeholder or another visible group-name label.
        expect(group.querySelectorAll('[class*="col-span"]')).toHaveLength(0);
      }
      const rows = [...host.querySelectorAll<HTMLElement>('[data-field-layout]')];
      expect(rows.some(row => row.dataset.fieldLayout === 'row')).toBe(true);
      expect(rows.find(row => row.textContent?.includes('Custom field'))).toBeDefined();
      for (const row of rows) {
        const content = row.querySelector<HTMLElement>('[data-field-content]')!;
        expect(content).not.toBeNull();
        for (const token of FIELD_ROW_CLASS.split(' ')) expect(content.classList.contains(token)).toBe(true);
        const label = content.querySelector<HTMLElement>(':scope > [data-field-label]')!;
        expect(label.className).toBe(FIELD_LABEL_CLASS);
        expect(row.classList.contains('items-center')).toBe(true);
        expect(row.querySelector<HTMLButtonElement>(':scope > [data-field-copy]')?.type).toBe('button');
        expect(row.querySelector('[data-field-value]')?.classList.contains('min-w-0')).toBe(true);
        expect(row.querySelector('[data-field-value]')?.classList.contains('secret')).toBe(false);
        expect(label.nextElementSibling?.contains(row.querySelector('[data-field-value]'))).toBe(true);
      }
      expect(host.querySelector('span[title="姓名"]')).toBeNull();
      expect(host.querySelector('span[title="地区"]')).toBeNull();
    } finally { await act(() => root.unmount()); host.remove(); }
  });

  it('keeps login, OTP, passkeys and websites on the same stacked label contract', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    const detail = itemDetail({ ...blankEditorItem(), login: { ...emptyLogin(), username: 'Synthetic user',
      password: 'Synthetic password', totp: 'Synthetic seed', uris: [{ uri: 'https://example.invalid', match: null }] } });
    const loginClient = { ...client, totp: vi.fn(async () => ({ code: '123456', remaining: 20, period: 30 })) };
    try {
      await act(async () => root.render(<ItemDetail client={loginClient as unknown as ApplicationClient} item={detail} icons={null}
        onBack={() => {}} onEdit={() => {}} onDelete={() => {}} onToggleFavorite={() => {}} />));
      const labels = [...host.querySelectorAll<HTMLElement>('[data-field-label]')];
      expect(labels.map(label => label.textContent)).toEqual(['用户名', '密码', '验证码', '通行密钥', '网址']);
      for (const label of labels) {
        expect(label.className).toBe(FIELD_LABEL_CLASS);
        expect(label.parentElement!.classList.contains('flex-col')).toBe(true);
        expect(label.nextElementSibling!.matches('[data-field-value]')
          || label.nextElementSibling!.querySelector('[data-field-value]') !== null).toBe(true);
      }
      expect(host.querySelector('[data-field-layout="totp"] .secret')?.textContent).toBe('123 456');
      expect(host.querySelector('[data-login-passkeys] [data-field-value]')?.textContent).toBe('未保存');
      expect(host.textContent).not.toContain('Synthetic password');
    } finally { await act(() => root.unmount()); host.remove(); }
  });

  it('keeps secrets masked and monospaced without applying password typography to ordinary text', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    const reveal = vi.fn(async () => 'synthetic-secret');
    try {
      await act(() => root.render(<><SecretField label="姓名" value="A long human name" />
        <SecretField label="密码" value="********" masked revealValue={reveal} /></>));
      const values = host.querySelectorAll<HTMLElement>('[data-field-value]');
      expect(values[0]!.classList.contains('secret')).toBe(false);
      expect(values[0]!.classList.contains('truncate')).toBe(false);
      expect(values[1]!.classList.contains('secret')).toBe(true);
      expect(host.querySelectorAll('[data-field-label][title], [data-field-value][title]')).toHaveLength(0);
      expect(host.querySelector('[data-field-layout="row"]')!.classList.contains('py-2')).toBe(true);
      expect(host.querySelector('[data-field-content]')!.classList.contains('gap-1')).toBe(true);
      expect(host.textContent).not.toContain('synthetic-secret'); expect(reveal).not.toHaveBeenCalled();
      await act(() => host.querySelector<HTMLButtonElement>('[aria-label="显示"]')!.click());
      expect(host.textContent).toContain('synthetic-secret'); expect(reveal).toHaveBeenCalledTimes(1);
      await act(() => host.querySelector<HTMLButtonElement>('[aria-label="隐藏"]')!.click());
      expect(host.textContent).not.toContain('synthetic-secret');
    } finally { await act(() => root.unmount()); host.remove(); }
  });
});
