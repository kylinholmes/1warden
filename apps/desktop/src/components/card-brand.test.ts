import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ItemIcon, iconPropsOf, summarise } from '@1warden/ui';
import { emptyCard, type VaultItem } from '@1warden/vault';

const item = (brand: string): VaultItem => ({
  id: 'card', type: 'card', rawType: 3, name: 'Personal card', nameFailed: false,
  notes: null, notesFailed: false, favorite: false, folderId: null, reprompt: 0,
  createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, wrappedKey: null,
  login: null, card: { ...emptyCard(), brand, number: '4111111111111111', code: '987' },
  identity: null, secureNote: null, sshKey: null, customFields: [], passwordHistory: [], attachments: [],
});

it.each(['Visa', 'Master Card', 'American Express', '银联', 'JCB', 'Discover', 'Diners Club', 'Maestro', 'RuPay'])(
  'shows a bundled real logo for %s using safe summary metadata', brand => {
    const summary = summarise(item(brand));
    expect(summary).toHaveProperty('cardBrand', brand);
    expect(JSON.stringify(summary)).not.toContain('4111111111111111');
    expect(JSON.stringify(summary)).not.toContain('987');
    const html = renderToStaticMarkup(createElement(ItemIcon, { ...iconPropsOf(item(brand)), store: null }));
    expect(html).toContain('data-card-brand=');
    expect(html).toContain('<img');
    expect(html).not.toMatch(/src="https?:/);
  },
);

it('uses the generic card icon for an unknown brand, without guessing from the card number', () => {
  const html = renderToStaticMarkup(createElement(ItemIcon, { ...iconPropsOf(item('My local bank')), store: null }));
  expect(html).not.toContain('data-card-brand=');
  expect(html).toContain('tile-glyph');
});
