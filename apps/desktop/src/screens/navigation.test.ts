import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PageHeader } from '@1warden/ui';
import { ImportScreen } from './Import';
import { SecurityReportView } from './SecurityReport';
import { EMPTY_SNAPSHOT, type ApplicationClient } from '../application/types';

const client = {
  getSnapshot: () => EMPTY_SNAPSHOT,
  capabilities: { native: false, browser: true, saveAttachments: true },
} as ApplicationClient;

describe('full-width vault screens', () => {
  it('keeps navigation reachable from import on narrow screens', () => {
    const html = renderToStaticMarkup(createElement(ImportScreen, { client, onImported() {}, onBack() {} }));
    expect(html).toContain('aria-label="导航"');
    expect(html).toContain('aria-label="返回保险库"');
  });

  it('keeps navigation reachable from the security report on narrow screens', () => {
    const props = { client, items: [], onBack() {} };
    const html = renderToStaticMarkup(createElement(SecurityReportView, props));
    expect(html).toContain('aria-label="导航"');
    expect(html).toContain('aria-label="返回保险库"');
  });
});

it('PageHeader leaves heading level with its destination or dialog caller and adds no landmark', () => {
  const props = { title: 'Synthetic header', breadcrumbs: [{ label: 'Synthetic header' }] };
  const dialog = renderToStaticMarkup(createElement(PageHeader, props));
  const destination = renderToStaticMarkup(createElement(PageHeader, { ...props, headingLevel: 1 }));
  expect(dialog).toContain('<h2'); expect(dialog).not.toContain('<h1');
  expect(destination).toContain('<h1'); expect(destination).not.toContain('<h2');
  expect(dialog).not.toContain('<main'); expect(destination).not.toContain('<main');
});
