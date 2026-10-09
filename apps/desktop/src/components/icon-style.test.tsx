import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ItemIcon } from '@1warden/ui';
import css from '../../../../packages/ui/src/components.css?raw';

const icon = (domain: string) => renderToStaticMarkup(createElement(ItemIcon, {
  type: 'login', iconDomain: domain, text: 'Site', hue: 220, store: null,
}));
it('adapts only dark monochrome library paths, retaining official images and colored paths', () => {
  expect(icon('github.com')).toContain('brand-monochrome');
  expect(icon('google.com')).toContain('<img');
  expect(icon('google.com')).not.toContain('brand-monochrome');
  expect(icon('gitlab.com')).not.toContain('brand-monochrome');
  expect(icon('gitlab.com')).toContain('fill="#FC6D26"');
});
it('keeps undecorated artwork as the default and gates plates on the preference', () => {
  expect(css).toContain(":root[data-icon-style='plate'] .tile-service-brand");
  expect(css).toMatch(/\.tile-img,\s*\.tile-card-brand,\s*\.tile-service-brand\s*\{[^}]*background: transparent;[^}]*border-radius: 0;[^}]*overflow: visible;/);
  expect(css).not.toMatch(/\.tile-(?:img|service-brand|card-brand)[^{]*\{[^}]*filter:/);
});
