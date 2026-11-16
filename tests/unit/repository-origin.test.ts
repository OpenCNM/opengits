import { describe, it, expect } from 'vitest';
import { WEB_DOC_OWNER } from '@/lib/constants';
import {
  extractWebDocOrigin,
  isGenericWebDocTitle,
  isNativeWebDocMirror,
  isWebDocRepository,
  resolveRepositoryDisplayName,
} from '@/lib/repository-origin';

describe('repository-origin (WebDoc 镜像与衍生讲法判定)', () => {
  it('recognizes WebDoc repositories by owner, category, or repoProfile.sourceType', () => {
    expect(isWebDocRepository({ owner: WEB_DOC_OWNER, repo: 'eve-dev' })).toBe(true);
    expect(isWebDocRepository({ owner: 'web-doc', repo: 'custom-site' })).toBe(true);
    expect(isWebDocRepository({ owner: 'org', repo: 'docs', category: 'Web Docs' })).toBe(true);
    expect(
      isWebDocRepository({
        owner: 'custom-owner',
        repo: 'site',
        repoProfile: { sourceType: 'web' },
      })
    ).toBe(true);
    expect(isWebDocRepository({ owner: 'vercel', repo: 'next.js', category: 'Frontend' })).toBe(false);
    expect(isWebDocRepository(null)).toBe(false);
  });

  it('isNativeWebDocMirror returns true only for base WebDoc without non-empty edition', () => {
    // 1. 原生 1:1 WebDoc 镜像（edition 为空、null、undefined 或纯空白）
    expect(isNativeWebDocMirror({ owner: WEB_DOC_OWNER, repo: 'eve-dev', edition: '' })).toBe(true);
    expect(isNativeWebDocMirror({ owner: WEB_DOC_OWNER, repo: 'eve-dev', edition: null })).toBe(true);
    expect(isNativeWebDocMirror({ owner: WEB_DOC_OWNER, repo: 'eve-dev' })).toBe(true);
    expect(isNativeWebDocMirror({ owner: WEB_DOC_OWNER, repo: 'eve-dev', edition: '   ' })).toBe(true);
    expect(
      isNativeWebDocMirror({
        owner: 'custom-org',
        repo: 'site',
        repoProfile: { sourceType: 'web' },
        edition: '',
      })
    ).toBe(true);

    // 2. AI 衍生教学讲法（edition 非空）恢复教学能力 -> 返回 false
    expect(
      isNativeWebDocMirror({
        owner: WEB_DOC_OWNER,
        repo: 'eve-dev',
        edition: 'quick-start-guide',
      })
    ).toBe(false);

    // 3. 普通 GitHub 代码仓库 -> 始终返回 false
    expect(isNativeWebDocMirror({ owner: 'vercel', repo: 'next.js', edition: '' })).toBe(false);
    expect(isNativeWebDocMirror({ owner: 'vercel', repo: 'next.js', edition: 'deep-dive' })).toBe(false);
  });

  it('resolves display names with Style B (brand priority + host fallback for generic headings)', () => {
    expect(
      resolveRepositoryDisplayName({
        owner: WEB_DOC_OWNER,
        repo: 'web-eve-dev',
        repoProfile: {
          sourceType: 'web',
          siteTitle: 'Eve Docs',
          originalUrl: 'https://eve.dev/docs/getting-started',
        },
      })
    ).toBe('Eve Docs');

    // 存量通用章节名与携带零宽空格的单页标题（Features \u200b / /guide/features）自动退回 clean host
    expect(
      resolveRepositoryDisplayName({
        owner: WEB_DOC_OWNER,
        repo: 'vite-dev',
        title: 'Features \u200b',
        repoProfile: {
          sourceType: 'web',
          siteTitle: 'Features \u200b',
          originalUrl: 'https://vite.dev/guide/features',
        },
      })
    ).toBe('vite.dev');

    // 当站点主标题恰好等于品牌域名首段时（如 svelte.dev/docs/svelte -> Svelte），不误杀品牌名
    expect(
      resolveRepositoryDisplayName({
        owner: WEB_DOC_OWNER,
        repo: 'svelte-dev',
        repoProfile: {
          sourceType: 'web',
          siteTitle: 'Svelte \u200b',
          originalUrl: 'https://svelte.dev/docs/svelte',
        },
      })
    ).toBe('Svelte');

    expect(
      resolveRepositoryDisplayName({
        owner: WEB_DOC_OWNER,
        repo: 'coss-com',
        title: 'Introduction',
        repoProfile: {
          sourceType: 'web',
          siteTitle: 'Introduction',
          originalUrl: 'https://www.coss.com/ui/docs',
        },
      })
    ).toBe('coss.com');

    expect(
      resolveRepositoryDisplayName({
        owner: WEB_DOC_OWNER,
        repo: 'eve-dev',
        title: 'Getting Started',
        repoProfile: {
          sourceType: 'web',
          siteTitle: '快速开始',
          originalUrl: 'https://docs.eve.dev/quickstart/',
        },
      })
    ).toBe('docs.eve.dev');

    expect(
      resolveRepositoryDisplayName({
        owner: 'vercel',
        repo: 'ai',
      })
    ).toBe('vercel/ai');
  });

  it('extracts clean WebDoc host and endpoint from originalUrl and detects generic titles', () => {
    expect(
      extractWebDocOrigin({
        repoProfile: { sourceType: 'web', originalUrl: 'https://www.coss.com/ui/docs/' },
      })
    ).toEqual({ host: 'coss.com', endpoint: 'coss.com/ui/docs' });

    expect(
      extractWebDocOrigin({ repoProfile: { sourceType: 'web', originalUrl: 'not-a-valid-url' } })
    ).toEqual({ host: '', endpoint: '' });

    expect(isGenericWebDocTitle('Introduction')).toBe(true);
    expect(isGenericWebDocTitle('Getting Started!')).toBe(true);
    expect(isGenericWebDocTitle('快速开始')).toBe(true);
    expect(isGenericWebDocTitle('Features \u200b', 'https://vite.dev/guide/features')).toBe(true);
    expect(isGenericWebDocTitle('coss ui')).toBe(false);
  });
});
