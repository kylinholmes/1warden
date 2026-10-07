import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ImportScreen } from './Import';
import { SecurityReportView } from './SecurityReport';
import { EMPTY_SNAPSHOT, type ApplicationClient } from '../application/types';

const client = {
  getSnapshot: () => EMPTY_SNAPSHOT,
  capabilities: { native: false, browser: true, saveAttachments: true },
} as ApplicationClient;

describe('full-width vault screens', () => {
  it('keeps navigation reachable from import on narrow screens', () => {
    const html = renderToStaticMarkup(createElement(ImportScreen, { client, onImported() {} }));
    expect(html).toContain('aria-label="导航"');
  });

  it('keeps navigation reachable from the security report on narrow screens', () => {
    const props = { client, items: [] };
    const html = renderToStaticMarkup(createElement(SecurityReportView, props));
    expect(html).toContain('aria-label="导航"');
  });
});
