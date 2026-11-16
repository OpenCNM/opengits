import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';

let mockPathname = '/docs/web-docs/eve-dev/docs/getting-started';

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href, ...props }, children),
}));

import { DocsModuleTabs } from '@/components/docs/DocsModuleTabs';
import {
  collectImportedDocPaths,
  detectHasChangelogDoc,
  pickActiveModuleTabId,
  resolveModuleTabEntries,
} from '@/lib/docs/webdoc-module-tabs';
import type { ModuleTab } from '@/lib/schemas/webdoc-topology';
import type { OutlineView } from '@/lib/outline-reader';
import type { NavNode } from '@/engine/structurizer';

const EVE_TABS: ModuleTab[] = [
  { id: 'docs', kind: 'doc', path: '/docs', label: 'Docs' },
  { id: 'integrations', kind: 'doc', path: '/integrations', label: 'Integrations' },
  { id: 'changelog', kind: 'changelog', path: '/changelog', label: 'Changelog' },
];

describe('webdoc-module-tabs projection & DocsModuleTabs UI', () => {
  beforeEach(() => {
    mockPathname = '/docs/web-docs/eve-dev/docs/getting-started';
  });

  it('filters out non-imported modules for single-prefix eve-dev import and hides switcher completely', () => {
    const resolved = resolveModuleTabEntries({
      owner: 'web-docs',
      repo: 'eve-dev',
      moduleTabs: EVE_TABS,
      allowedPrefixes: ['/docs'],
      importedDocPaths: ['docs/getting-started.md', 'docs/use-cases.md'],
      hasOpenApi: false,
      hasChangelogDoc: false,
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      id: 'docs',
      label: 'Docs',
      href: '/docs/web-docs/eve-dev/docs/getting-started',
    });

    const html = renderToString(
      React.createElement(DocsModuleTabs, {
        owner: 'web-docs',
        repo: 'eve-dev',
        resolvedTabs: resolved,
      }),
    );

    expect(html).toBe('');
  });

  it('strips external links and modules without any imported docs or OpenAPI spec', () => {
    const tabs: ModuleTab[] = [
      ...EVE_TABS,
      { id: 'api', kind: 'api', path: '/api-reference', label: 'API Reference' },
      { id: 'templates', kind: 'external', path: 'https://eve.dev/templates', label: 'Templates' },
    ];

    const resolved = resolveModuleTabEntries({
      owner: 'web-docs',
      repo: 'eve-dev',
      moduleTabs: tabs,
      allowedPrefixes: [],
      importedDocPaths: ['docs/getting-started.md'],
      hasOpenApi: false,
      hasChangelogDoc: false,
    });

    expect(resolved.map((t) => t.id)).toEqual(['docs']);
  });

  it('assigns distinct hrefs and highlights only one active module across multi-prefix imports', () => {
    const resolved = resolveModuleTabEntries({
      owner: 'web-docs',
      repo: 'eve-dev',
      moduleTabs: EVE_TABS,
      allowedPrefixes: ['/docs', '/integrations'],
      importedDocPaths: ['docs/getting-started.md', 'integrations/slack.md'],
      hasOpenApi: false,
      hasChangelogDoc: false,
    });

    expect(resolved).toHaveLength(2);
    expect(resolved[0].href).toBe('/docs/web-docs/eve-dev/docs/getting-started');
    expect(resolved[1].href).toBe('/docs/web-docs/eve-dev/integrations/slack');

    expect(
      pickActiveModuleTabId(
        resolved,
        '/docs/web-docs/eve-dev/integrations/slack',
        'web-docs',
        'eve-dev',
        '/docs',
      ),
    ).toBe('integrations');

    expect(
      pickActiveModuleTabId(
        resolved,
        '/docs/web-docs/eve-dev/docs/use-cases',
        'web-docs',
        'eve-dev',
        '/docs',
      ),
    ).toBe('docs');

    expect(
      pickActiveModuleTabId(
        resolved,
        '/docs/web-docs/eve-dev',
        'web-docs',
        'eve-dev',
        '/docs',
      ),
    ).toBe('docs');

    mockPathname = '/docs/web-docs/eve-dev/integrations/slack';
    const html = renderToString(
      React.createElement(DocsModuleTabs, {
        owner: 'web-docs',
        repo: 'eve-dev',
        resolvedTabs: resolved,
        primaryDocPrefix: '/docs',
      }),
    );

    // Collapsed Popover trigger renders only the active module label & chevron icon in header
    expect(html).toContain('Integrations');
    expect(html).not.toContain('>Docs<');
    expect(html).toContain('aria-expanded="false"');
  });

  it('keeps Docs and OpenAPI tabs together when hasOpenApi is true even under /docs prefix scope', () => {
    const tabs: ModuleTab[] = [
      { id: 'docs', kind: 'doc', path: '/docs', label: 'Docs' },
      { id: 'api', kind: 'api', path: '/api-reference', label: 'API' },
    ];

    const resolved = resolveModuleTabEntries({
      owner: 'web-docs',
      repo: 'acme',
      moduleTabs: tabs,
      allowedPrefixes: ['/docs'],
      importedDocPaths: ['docs/intro.md'],
      hasOpenApi: true,
      hasChangelogDoc: false,
    });

    expect(resolved.map((t) => ({ id: t.id, href: t.href }))).toEqual([
      { id: 'docs', href: '/docs/web-docs/acme/docs/intro' },
      { id: 'api', href: '/docs/web-docs/acme/api-reference' },
    ]);

    expect(
      pickActiveModuleTabId(resolved, '/docs/web-docs/acme/api-reference', 'web-docs', 'acme'),
    ).toBe('api');
    expect(
      pickActiveModuleTabId(resolved, '/docs/web-docs/acme/docs/intro', 'web-docs', 'acme'),
    ).toBe('docs');
  });

  it('inspects OutlineView parts/chapters and nested NavNode[] accurately for paths and changelog', () => {
    const outline: OutlineView = {
      outlineId: 'o1',
      version: 1,
      learningGoal: null,
      prerequisites: [],
      parts: [
        {
          id: 'p1',
          title: 'Release Notes',
          orderIndex: 1,
          chapters: [
            {
              id: 'c2',
              partId: 'p1',
              title: 'Changelog',
              summary: null,
              difficulty: null,
              estimatedMinutes: 5,
              learningObjectives: [],
              keyTakeaways: [],
              teachingOrder: 2,
              nodes: [
                {
                  id: 'n2',
                  title: 'v1.0',
                  summary: null,
                  docPath: 'changelog/v1.md',
                  orderIndex: 1,
                  codeAnchors: [],
                },
              ],
            },
          ],
        },
      ],
      chapters: [
        {
          id: 'c1',
          partId: null,
          title: 'Intro',
          summary: null,
          difficulty: null,
          estimatedMinutes: 5,
          learningObjectives: [],
          keyTakeaways: [],
          teachingOrder: 1,
          nodes: [
            {
              id: 'n1',
              title: 'Getting Started',
              summary: null,
              docPath: 'docs/getting-started.md',
              orderIndex: 1,
              codeAnchors: [],
            },
          ],
        },
      ],
    };

    const navTree: NavNode[] = [
      {
        title: 'Docs',
        path: 'docs',
        type: 'directory',
        children: [{ title: 'Getting Started', path: 'docs/getting-started.md', type: 'file' }],
      },
      {
        title: 'History',
        path: 'history',
        type: 'directory',
        children: [{ title: 'Product Updates', path: 'updates/2026.md', type: 'file' }],
      },
    ];

    expect(detectHasChangelogDoc(outline, null)).toBe(true);
    expect(detectHasChangelogDoc(null, navTree)).toBe(false);
    expect(collectImportedDocPaths(outline, navTree)).toEqual([
      'docs/getting-started.md',
      'changelog/v1.md',
      'updates/2026.md',
    ]);
  });
});
