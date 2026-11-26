import { describe, it, expect } from 'vitest';
import { buildWebNavTree, formatTitleFromSegment } from '@/engine/web-doc/structurizer';
import { DocumentItem } from '@/engine/web-doc/types';
import { inspectGithubUrl } from '@/lib/url-inspector';
import { buildWebDocLinkContext, resolveWebDocHref } from '@/lib/docs/webdoc-href-resolver';
import { type OutlineView } from '@/lib/outline-reader';

describe('webdoc-engine-and-href', () => {
  const doc = (path: string, title: string, url: string): DocumentItem => ({
    path,
    title,
    markdown: '# ' + title,
    url,
    contentHash: path,
    headings: [],
  });

  it('formatTitleFromSegment & buildWebNavTree 层级构建、空集合与同名段晋升', () => {
    expect(formatTitleFromSegment('01-getting-started')).toBe('Getting Started');
    expect(formatTitleFromSegment('02_grpc_service')).toBe('gRPC Service');
    expect(formatTitleFromSegment('ios_sdk_guide')).toBe('iOS SDK Guide');

    expect(buildWebNavTree([])).toEqual([]);

    const tree = buildWebNavTree([
      doc('index.md', 'Introduction', 'https://example.com/docs'),
      doc('guide/01-installation.md', 'Installation Guide', 'https://example.com/docs/guide/installation'),
      doc('api/core.md', 'Core API', 'https://example.com/docs/api/core'),
    ]);
    expect(tree.map((n) => n.name)).toEqual(['index', 'guide', 'api']);

    // 同名段冲突正/反序晋升为目录
    for (const pair of [
      [doc('docs.md', 'Docs Home', 'https://example.com/docs'), doc('docs/installation.md', 'Install', 'https://example.com/docs/installation')],
      [doc('docs/installation.md', 'Install', 'https://example.com/docs/installation'), doc('docs.md', 'Docs Home', 'https://example.com/docs')],
    ]) {
      const n = buildWebNavTree(pair).find((x) => x.name === 'docs')!;
      expect(n.type).toBe('directory');
      expect(n.children?.map((c) => c.name)).toEqual(['installation']);
    }

    // 自然数字序 1.1 -> 1.2 -> 1.10
    const numTree = buildWebNavTree([
      doc('guide/1.10-advanced.md', 'Advanced', 'https://example.com/guide/1.10'),
      doc('guide/1.2-config.md', 'Config', 'https://example.com/guide/1.2'),
      doc('guide/1.1-setup.md', 'Setup', 'https://example.com/guide/1.1'),
    ]);
    expect(numTree.find((n) => n.name === 'guide')?.children?.map((c) => c.name)).toEqual(['1.1-setup', '1.2-config', '1.10-advanced']);
  });

  it('url-inspector 网页文档分流与 buildWebNavTree orderUrls 主序信号', () => {
    expect(inspectGithubUrl('https://docs.astro.build/en/getting-started/')).toMatchObject({
      isValid: true,
      status: 'WEB_DOC_URL',
      resourceType: 'web-doc',
    });
    expect(inspectGithubUrl('https://github.com/vercel/next.js')).toMatchObject({ resourceType: 'repo', isValid: true });
    expect(inspectGithubUrl('ftp://example.com/docs')).toMatchObject({ isValid: false, status: 'UNSUPPORTED_DOMAIN' });

    const ordered = buildWebNavTree(
      [
        doc('basic-syntax.md', 'basic', 'https://x.com/basic-syntax'),
        doc('getting-started.md', 'start', 'https://x.com/getting-started'),
        doc('tools/index.md', 'tools', 'https://x.com/tools/'),
      ],
      { orderUrls: ['https://x.com/getting-started', 'https://x.com/basic-syntax', 'https://x.com/tools/'] }
    );
    expect(ordered.map((n) => n.name)).toEqual(['getting-started', 'basic-syntax', 'tools']);
  });

  it('resolveWebDocHref: 站内路径映射、相对路径、中文编码对拍、未索引外链回源与 legacy 回退', () => {
    const sampleOutline: OutlineView = {
      outlineId: 'out-1',
      version: 1,
      mode: 'doc',
      parts: [],
      chapters: [
        {
          id: 'ch-1',
          title: 'Basics',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [
            { id: 'n-root', title: 'Home', nodeType: 'doc', headingPath: null, documentId: 'd-root', docPath: 'index.md', docStatus: 'PROCESSED' },
            { id: 'n-qs', title: 'Quickstart', nodeType: 'doc', headingPath: null, documentId: 'd-qs', docPath: 'docs/quickstart.md', docStatus: 'PROCESSED' },
            { id: 'n-ch', title: 'Channels', nodeType: 'doc', headingPath: null, documentId: 'd-ch', docPath: 'docs/channels.md', docStatus: 'PROCESSED' },
            { id: 'n-wa', title: 'WhatsApp', nodeType: 'doc', headingPath: null, documentId: 'd-wa', docPath: 'docs/channels/whatsapp.md', docStatus: 'PROCESSED' },
            { id: 'n-cjk', title: '中文指南', nodeType: 'doc', headingPath: null, documentId: 'd-cjk', docPath: 'docs/%E4%B8%AD%E6%96%87/%E5%85%A5%E9%97%A8.md', docStatus: 'PROCESSED' },
          ],
        },
      ],
    };

    const ctx = buildWebDocLinkContext({
      owner: 'acme',
      repo: 'eve-docs',
      outline: sampleOutline,
      repoProfile: { originalUrl: 'https://eve.dev/docs', navOrderUrls: ['https://eve.dev/docs/channels/', 'https://eve.dev/templates'] },
      currentDocPath: 'docs/channels.md',
      edition: 'deep-dive',
    });

    expect(resolveWebDocHref('#overview', ctx)).toBe('#overview');
    expect(resolveWebDocHref('https://github.com/eve-dev/eve', ctx)).toBe('https://github.com/eve-dev/eve');
    expect(resolveWebDocHref('code:src/engine/main.ts', ctx)).toBe('code:src/engine/main.ts');
    expect(resolveWebDocHref('/docs/quickstart?tab=ts#install', ctx)).toBe('/docs/acme/eve-docs/docs/quickstart?tab=ts&edition=deep-dive#install');
    expect(resolveWebDocHref('/docs/quickstart.html', ctx)).toBe('/docs/acme/eve-docs/docs/quickstart?edition=deep-dive');
    expect(resolveWebDocHref('./whatsapp', ctx)).toBe('/docs/acme/eve-docs/docs/channels/whatsapp?edition=deep-dive');
    expect(resolveWebDocHref('../quickstart?mode=fast#step1', ctx)).toBe('/docs/acme/eve-docs/docs/quickstart?mode=fast&edition=deep-dive#step1');
    expect(resolveWebDocHref('/', ctx)).toBe('/docs/acme/eve-docs?edition=deep-dive');
    expect(resolveWebDocHref('/docs/中文/入门', ctx)).toBe(resolveWebDocHref('/docs/%E4%B8%AD%E6%96%87/%E5%85%A5%E9%97%A8', ctx));
    expect(resolveWebDocHref('/templates', ctx)).toBe('https://eve.dev/templates');
    expect(resolveWebDocHref('/pricing?plan=enterprise#faq', ctx)).toBe('https://eve.dev/pricing?plan=enterprise#faq');

    const legacyCtx = buildWebDocLinkContext({
      owner: 'acme',
      repo: 'legacy-docs',
      outline: null,
      navTree: null,
      repoProfile: { originalUrl: 'https://legacy.example.com/docs/', navOrderUrls: ['https://legacy.example.com/docs/guides/setup/'] },
      currentDocPath: 'docs/intro.md',
    });
    expect(resolveWebDocHref('/docs/guides/setup#env', legacyCtx)).toBe('/docs/acme/legacy-docs/docs/guides/setup#env');
    expect(resolveWebDocHref('/changelog', legacyCtx)).toBe('https://legacy.example.com/changelog');
  });
});
