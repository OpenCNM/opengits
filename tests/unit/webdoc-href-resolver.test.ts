import { describe, expect, it } from 'vitest';
import {
  buildWebDocLinkContext,
  resolveWebDocHref,
} from '@/lib/docs/webdoc-href-resolver';
import type { OutlineView } from '@/lib/outline-reader';

describe('WebDoc on-site href resolver & Go CanonicalDocPathFromUrl parity', () => {
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
          {
            id: 'n-root',
            title: 'Home',
            nodeType: 'doc',
            headingPath: null,
            documentId: 'd-root',
            docPath: 'index.md',
            docStatus: 'PROCESSED',
          },
          {
            id: 'n-qs',
            title: 'Quickstart',
            nodeType: 'doc',
            headingPath: null,
            documentId: 'd-qs',
            docPath: 'docs/quickstart.md',
            docStatus: 'PROCESSED',
          },
          {
            id: 'n-ch',
            title: 'Channels',
            nodeType: 'doc',
            headingPath: null,
            documentId: 'd-ch',
            docPath: 'docs/channels.md',
            docStatus: 'PROCESSED',
          },
          {
            id: 'n-wa',
            title: 'WhatsApp',
            nodeType: 'doc',
            headingPath: null,
            documentId: 'd-wa',
            docPath: 'docs/channels/whatsapp.md',
            docStatus: 'PROCESSED',
          },
          {
            id: 'n-cjk-enc',
            title: '中文指南',
            nodeType: 'doc',
            headingPath: null,
            documentId: 'd-cjk-enc',
            docPath: 'docs/%E4%B8%AD%E6%96%87/%E5%85%A5%E9%97%A8.md',
            docStatus: 'PROCESSED',
          },
        ],
      },
    ],
  };

  const ctx = buildWebDocLinkContext({
    owner: 'acme',
    repo: 'eve-docs',
    outline: sampleOutline,
    repoProfile: {
      originalUrl: 'https://eve.dev/docs',
      navOrderUrls: [
        'https://eve.dev/docs/channels/',
        // Intentionally present in raw sidebar navOrderUrls, NOT in outline (excluded scope):
        'https://eve.dev/templates',
      ],
    },
    currentDocPath: 'docs/channels.md',
    edition: 'deep-dive',
  });

  it('passes through anchors, external links, protocol URIs, and code links untouched', () => {
    expect(resolveWebDocHref('#overview', ctx)).toBe('#overview');
    expect(resolveWebDocHref('https://github.com/eve-dev/eve', ctx)).toBe(
      'https://github.com/eve-dev/eve'
    );
    expect(resolveWebDocHref('//cdn.eve.dev/logo.png', ctx)).toBe('//cdn.eve.dev/logo.png');
    expect(resolveWebDocHref('mailto:support@eve.dev', ctx)).toBe('mailto:support@eve.dev');
    expect(resolveWebDocHref('code:src/engine/main.ts', ctx)).toBe('code:src/engine/main.ts');
  });

  it('remaps on-site paths and merges query + hash + active edition cleanly', () => {
    expect(resolveWebDocHref('/docs/quickstart?tab=ts#install', ctx)).toBe(
      '/docs/acme/eve-docs/docs/quickstart?tab=ts&edition=deep-dive#install'
    );
    expect(resolveWebDocHref('/docs/quickstart/#top', ctx)).toBe(
      '/docs/acme/eve-docs/docs/quickstart?edition=deep-dive#top'
    );
    expect(resolveWebDocHref('/docs/quickstart.html', ctx)).toBe(
      '/docs/acme/eve-docs/docs/quickstart?edition=deep-dive'
    );
  });

  it('resolves relative ./ and ../ links against currentDocPath and trailingSlashDirs', () => {
    expect(resolveWebDocHref('./whatsapp', ctx)).toBe(
      '/docs/acme/eve-docs/docs/channels/whatsapp?edition=deep-dive'
    );
    expect(resolveWebDocHref('../quickstart?mode=fast#step1', ctx)).toBe(
      '/docs/acme/eve-docs/docs/quickstart?mode=fast&edition=deep-dive#step1'
    );
  });

  it('maintains Go CanonicalDocPathFromUrl parity for root index and percent-encoded CJK paths', () => {
    expect(resolveWebDocHref('/', ctx)).toBe('/docs/acme/eve-docs?edition=deep-dive');
    expect(resolveWebDocHref('/docs/%E4%B8%AD%E6%96%87/%E5%85%A5%E9%97%A8', ctx)).toBe(
      '/docs/acme/eve-docs/docs/%E4%B8%AD%E6%96%87/%E5%85%A5%E9%97%A8?edition=deep-dive'
    );
    // Decoded Chinese path should resolve to the exact same outline route
    expect(resolveWebDocHref('/docs/中文/入门', ctx)).toBe(
      resolveWebDocHref('/docs/%E4%B8%AD%E6%96%87/%E5%85%A5%E9%97%A8', ctx)
    );
  });

  it('redirects excluded/unindexed on-site paths upstream instead of producing local 404s', () => {
    expect(resolveWebDocHref('/templates', ctx)).toBe('https://eve.dev/templates');
    expect(resolveWebDocHref('/pricing?plan=enterprise#faq', ctx)).toBe(
      'https://eve.dev/pricing?plan=enterprise#faq'
    );
  });

  it('falls back to filtered navOrderUrls when both outline and navTree are empty', () => {
    const legacyCtx = buildWebDocLinkContext({
      owner: 'acme',
      repo: 'legacy-docs',
      outline: null,
      navTree: null,
      repoProfile: {
        originalUrl: 'https://legacy.example.com/docs/',
        navOrderUrls: ['https://legacy.example.com/docs/guides/setup/'],
      },
      currentDocPath: 'docs/intro.md',
    });

    expect(resolveWebDocHref('/docs/guides/setup#env', legacyCtx)).toBe(
      '/docs/acme/legacy-docs/docs/guides/setup#env'
    );
    expect(resolveWebDocHref('/changelog', legacyCtx)).toBe('https://legacy.example.com/changelog');
  });
});
