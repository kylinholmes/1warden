import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NavRail, type NavGroup } from '../../../../packages/ui/src/NavRail';

describe('collapsible navigation sections', () => {
  it('links a native toggle to hidden contents and keeps a separate section action', () => {
    const group = {
      key: 'folders', title: '文件夹', collapsed: true, onToggleCollapsed() {},
      action: createElement('button', { 'aria-label': '新建文件夹' }, '+'),
      entries: [{ key: 'folder:a', label: '私密资料', icon: null }],
    } as NavGroup;
    const html = renderToStaticMarkup(createElement(NavRail, { groups: [group], current: 'folder:a', onSelect() {}, expanded: true }));
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="([^"]+)"/);
    const controls = html.match(/aria-controls="([^"]+)"/)![1];
    expect(html).toContain(`id="${controls}" hidden=""`);
    expect(html).toMatch(/文件夹<\/span>[\s\S]*?<\/button><button aria-label="新建文件夹"/);
    expect(html).toContain('aria-current="page"');
  });
});
