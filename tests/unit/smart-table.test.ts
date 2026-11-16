import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import SmartTable from '@/components/mdx/SmartTable';
import { buildDocCustomComponents } from '@/components/docs/docs-mdx-runtime';

describe('SmartTable & Docs Table Runtime Component', () => {
  it('renders table within a prose-no-margin overflow container', () => {
    const tableElement = React.createElement(
      SmartTable,
      { id: 'test-table', className: 'custom-class', 'data-testid': 'table' },
      React.createElement(
        'thead',
        null,
        React.createElement('tr', null, React.createElement('th', null, 'gadget 分支'), React.createElement('th', null, '特化构造器'))
      ),
      React.createElement(
        'tbody',
        null,
        React.createElement('tr', null, React.createElement('td', null, 'dns'), React.createElement('td', null, 'generateDNSPayload'))
      )
    );

    const html = renderToString(tableElement);

    // 容器具备横向溢出滚动与防外边距膨胀类
    expect(html).toContain('prose-no-margin');
    expect(html).toContain('overflow-x-auto');
    expect(html).toContain('id="test-table"');
    expect(html).toContain('custom-class');
    expect(html).toContain('gadget 分支');
    expect(html).toContain('generateDNSPayload');
    // 杜绝旧的无用 theme-primary 类
    expect(html).not.toContain('class="theme-primary"');
  });

  it('registers table, SmartTable and smarttable aliases in buildDocCustomComponents', () => {
    const components = buildDocCustomComponents({
      owner: 'test-owner',
      repo: 'test-repo',
    });

    expect(components.table).toBe(SmartTable);
    expect(components.SmartTable).toBe(SmartTable);
    expect(components.smarttable).toBe(SmartTable);
    expect(components['smart-table']).toBe(SmartTable);
  });
});
