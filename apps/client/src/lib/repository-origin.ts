import { WEB_DOC_OWNER, WEB_DOC_PREFIX } from '@/lib/constants';

export function isWebDocRepository(repo: {
  owner?: string | null;
  repo?: string | null;
  category?: string | null;
  repoProfile?: unknown;
} | null | undefined): boolean {
  if (!repo) return false;
  if (repo.owner === WEB_DOC_OWNER || repo.owner === 'web-doc') return true;
  if (repo.category === 'Web Docs') return true;
  if (repo.repoProfile && typeof repo.repoProfile === 'object') {
    const profile = repo.repoProfile as Record<string, unknown>;
    if (profile.sourceType === 'web') return true;
  }
  return false;
}

export function isNativeWebDocMirror(repo: {
  owner?: string | null;
  repo?: string | null;
  category?: string | null;
  repoProfile?: unknown;
  edition?: string | null;
} | null | undefined): boolean {
  if (!isWebDocRepository(repo)) return false;
  return !(typeof repo?.edition === 'string' && repo.edition.trim() !== '');
}

const GENERIC_WEBDOC_TITLES = new Set([
  'introduction',
  'intro',
  'getting started',
  'get started',
  'quick start',
  'quickstart',
  'overview',
  'welcome',
  'home',
  'index',
  'docs',
  'documentation',
  'guide',
  'guides',
  'manual',
  'reference',
  'api reference',
  'readme',
  'about',
  'changelog',
  'untitled',
  '简介',
  '介绍',
  '快速开始',
  '快速上手',
  '入门',
  '开始使用',
  '起步',
  '概览',
  '概述',
  '总览',
  '首页',
  '文档',
  '使用文档',
  '说明',
  '指南',
  '目录',
  '未命名',
]);

const INVISIBLE_TITLE_CHARS_RE = /[\u200B-\u200D\uFEFF\u00AD]/g;
const HOST_TLDS_AND_SUBS = new Set(['www', 'com', 'org', 'net', 'io', 'dev', 'ai', 'app', 'docs', 'doc']);

export function cleanWebDocTitleText(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(INVISIBLE_TITLE_CHARS_RE, '').replace(/\s+/g, ' ').trim();
}

function normalizeTitleToken(raw: string | null | undefined): string {
  return cleanWebDocTitleText(raw)
    .toLowerCase()
    .replace(/[:：.!！。]+$/, '')
    .trim();
}

function isUrlLeafSlugCollision(normalizedTitle: string, pageUrl?: string | null): boolean {
  if (!normalizedTitle || !pageUrl) return false;
  try {
    const parsed = new URL(pageUrl.trim());
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return false;
    const rawLeaf = decodeURIComponent(segments[segments.length - 1] || '');
    const leafToken = rawLeaf
      .replace(/\.(html?|mdx?)$/i, '')
      .replace(/[-_]+/g, ' ')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (!leafToken || leafToken !== normalizedTitle) return false;

    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    const hostLabels = new Set(
      host.split('.').filter((part) => part.length > 1 && !HOST_TLDS_AND_SUBS.has(part))
    );
    hostLabels.add(host);
    return !hostLabels.has(normalizedTitle);
  } catch {
    return false;
  }
}

export function isGenericWebDocTitle(raw: string | null | undefined, pageUrl?: string | null): boolean {
  const normalized = normalizeTitleToken(raw);
  if (normalized === '' || GENERIC_WEBDOC_TITLES.has(normalized)) {
    return true;
  }
  return isUrlLeafSlugCollision(normalized, pageUrl);
}

export interface WebDocOriginInfo {
  host: string;
  endpoint: string;
}

export function extractWebDocOrigin(repo: {
  owner?: string | null;
  repo?: string | null;
  repoProfile?: unknown;
} | null | undefined): WebDocOriginInfo {
  if (!repo?.repoProfile || typeof repo.repoProfile !== 'object') {
    return { host: '', endpoint: '' };
  }
  const originalUrl = (repo.repoProfile as Record<string, unknown>).originalUrl;
  if (typeof originalUrl !== 'string' || !originalUrl.trim()) {
    return { host: '', endpoint: '' };
  }
  try {
    const parsed = new URL(originalUrl.trim());
    const host = parsed.hostname.replace(/^www\./i, '');
    const pathname = parsed.pathname.replace(/\/+$/, '');
    const endpoint = pathname && pathname !== '/' ? `${host}${pathname}` : host;
    return { host, endpoint };
  } catch {
    return { host: '', endpoint: '' };
  }
}

export function resolveRepositoryDisplayName(repo: {
  owner: string;
  repo: string;
  title?: string | null;
  repoProfile?: unknown;
  category?: string | null;
}): string {
  if (isWebDocRepository(repo)) {
    const profile = (repo.repoProfile && typeof repo.repoProfile === 'object' ? repo.repoProfile : {}) as Record<string, unknown>;
    const originalUrl = typeof profile.originalUrl === 'string' ? profile.originalUrl : '';
    const siteTitle = typeof profile.siteTitle === 'string' ? cleanWebDocTitleText(profile.siteTitle) : '';
    if (siteTitle && !isGenericWebDocTitle(siteTitle, originalUrl)) return siteTitle;
    const rawTitle = repo.title ? cleanWebDocTitleText(repo.title) : '';
    if (rawTitle && !isGenericWebDocTitle(rawTitle, originalUrl)) return rawTitle;
    const { host } = extractWebDocOrigin(repo);
    if (host) return host;
    return repo.repo.replace(new RegExp(`^${WEB_DOC_PREFIX}`), '').replace(/-/g, ' ');
  }
  return `${repo.owner}/${repo.repo}`;
}

export function resolveLocalizedRepoDescription(
  repo: {
    description?: string | null;
    descriptionZh?: string | null;
    descriptionEn?: string | null;
    repoProfile?: unknown;
  },
  locale?: string | null
): string {
  const profile = (repo?.repoProfile && typeof repo.repoProfile === 'object' ? repo.repoProfile : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');

  const isEn = typeof locale === 'string' && locale.toLowerCase().startsWith('en');
  const descZh = str(repo.descriptionZh) || str(profile.descriptionZh);
  const descEn = str(repo.descriptionEn) || str(profile.descriptionEn);
  const fallback = str(repo.description) || str(profile.description) || str(profile.summary);

  if (isEn) {
    return descEn || fallback || descZh;
  }
  return descZh || fallback || descEn;
}
