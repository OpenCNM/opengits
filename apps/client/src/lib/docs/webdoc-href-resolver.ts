import {
  allChaptersInTeachingOrder,
  docPathToSlug,
  outlineNodeUrl,
  type OutlineView,
} from '@/lib/outline-reader';
import type { NavNode } from '@/engine/structurizer';

export interface WebDocLinkContext {
  owner: string;
  repo: string;
  originalUrl?: string | null;
  currentDocPath?: string | null;
  edition?: string | null;
  knownPageRoutes: Record<string, string>;
  trailingSlashDirs?: string[];
}

export interface BuildWebDocLinkContextParams {
  owner: string;
  repo: string;
  outline?: OutlineView | null;
  navTree?: NavNode[] | null;
  repoProfile?: Record<string, unknown> | null;
  currentDocPath?: string | null;
  edition?: string | null;
}

function normalizePathname(p: string): string {
  if (!p || p === '/') return '/';
  const withLeading = p.startsWith('/') ? p : `/${p}`;
  return withLeading.length > 1 ? withLeading.replace(/\/+$/, '') : '/';
}

function registerPathVariants(map: Record<string, string>, rawPathname: string, routeUrl: string): void {
  const norm = normalizePathname(rawPathname);
  if (!map[norm]) {
    map[norm] = routeUrl;
  }
  try {
    const decoded = normalizePathname(decodeURIComponent(norm));
    if (decoded && !map[decoded]) {
      map[decoded] = routeUrl;
    }
  } catch {
  }
  try {
    const encoded = normalizePathname(encodeURI(decodeURIComponent(norm)));
    if (encoded && !map[encoded]) {
      map[encoded] = routeUrl;
    }
  } catch {
  }
}

function registerDocPathEntry(
  map: Record<string, string>,
  owner: string,
  repo: string,
  docPath: string
): void {
  if (!docPath) return;
  const routeUrl = outlineNodeUrl(owner, repo, docPath);
  if (!routeUrl) return;

  const slug = docPathToSlug(docPath).replace(/^\/+|\/+$/g, '');
  const lowerSlug = slug.toLowerCase();

  if (!slug || lowerSlug === 'index' || lowerSlug === 'readme') {
    registerPathVariants(map, '/', routeUrl);
    if (slug) {
      registerPathVariants(map, `/${slug}`, routeUrl);
    }
    return;
  }

  registerPathVariants(map, `/${slug}`, routeUrl);
  if (lowerSlug.endsWith('/index') || lowerSlug.endsWith('/readme')) {
    const parentSlug = slug.slice(0, slug.lastIndexOf('/'));
    if (parentSlug) {
      registerPathVariants(map, `/${parentSlug}`, routeUrl);
    }
  }
}

function collectNavTreeDocPaths(nodes: NavNode[] | null | undefined, acc: string[] = []): string[] {
  if (!Array.isArray(nodes)) return acc;
  for (const node of nodes) {
    if (!node) continue;
    if (node.type === 'file' && node.path) {
      acc.push(node.path);
    }
    if (Array.isArray(node.children)) {
      collectNavTreeDocPaths(node.children, acc);
    }
  }
  return acc;
}

export function buildWebDocLinkContext(params: BuildWebDocLinkContextParams): WebDocLinkContext {
  const { owner, repo, outline, navTree, repoProfile, currentDocPath, edition } = params;
  const knownPageRoutes: Record<string, string> = {};

  if (outline) {
    for (const ch of allChaptersInTeachingOrder(outline)) {
      for (const n of ch.nodes || []) {
        if (n.docPath) {
          registerDocPathEntry(knownPageRoutes, owner, repo, n.docPath);
        }
      }
    }
  }

  if (Object.keys(knownPageRoutes).length === 0 && Array.isArray(navTree)) {
    for (const p of collectNavTreeDocPaths(navTree)) {
      registerDocPathEntry(knownPageRoutes, owner, repo, p);
    }
  }

  const profile = (repoProfile && typeof repoProfile === 'object' ? repoProfile : {}) as Record<string, unknown>;
  const originalUrl = typeof profile.originalUrl === 'string' ? profile.originalUrl : null;
  const rawNavUrls = Array.isArray(profile.navOrderUrls) ? profile.navOrderUrls : [];
  const trailingSlashDirs: string[] = [];

  for (const item of rawNavUrls) {
    if (typeof item !== 'string' || !item.trim()) continue;
    try {
      const parsed = new URL(item.trim(), originalUrl || 'https://opengits.local');
      if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
        const norm = normalizePathname(parsed.pathname);
        if (!trailingSlashDirs.includes(norm)) {
          trailingSlashDirs.push(norm);
        }
      }
      // Only fall back to navOrderUrls when outline and navTree are both empty so excluded sidebar links never resolve as local pages.
      if (Object.keys(knownPageRoutes).length === 0) {
        const normPath = normalizePathname(parsed.pathname);
        const target = normPath === '/' ? `/docs/${owner}/${repo}` : `/docs/${owner}/${repo}${normPath}`;
        registerPathVariants(knownPageRoutes, normPath, target);
      }
    } catch {
    }
  }

  return {
    owner,
    repo,
    originalUrl,
    currentDocPath,
    edition: edition?.trim() || null,
    knownPageRoutes,
    trailingSlashDirs,
  };
}

function matchKnownRoute(pathname: string, knownPageRoutes: Record<string, string>): string | null {
  const candidates: string[] = [];
  const norm = normalizePathname(pathname);
  candidates.push(norm);
  if (/\.(?:html?|mdx?)$/i.test(norm)) {
    candidates.push(normalizePathname(norm.replace(/\.(?:html?|mdx?)$/i, '')));
  }
  if (norm.toLowerCase().endsWith('/index') && norm.length > 6) {
    candidates.push(normalizePathname(norm.slice(0, -6)));
  }

  for (const cand of candidates) {
    if (knownPageRoutes[cand]) return knownPageRoutes[cand];
    try {
      const decoded = normalizePathname(decodeURIComponent(cand));
      if (knownPageRoutes[decoded]) return knownPageRoutes[decoded];
    } catch {
    }
  }
  return null;
}

function resolveCurrentDocUpstreamPath(ctx: WebDocLinkContext): string {
  const docPath = (ctx.currentDocPath || '').trim();
  if (!docPath) return '/';
  const slug = docPathToSlug(docPath).replace(/^\/+|\/+$/g, '');
  if (!slug || slug.toLowerCase() === 'index' || slug.toLowerCase() === 'readme') {
    return '/';
  }
  if (slug.toLowerCase().endsWith('/index') || slug.toLowerCase().endsWith('/readme')) {
    return `/${slug.slice(0, slug.lastIndexOf('/'))}/`;
  }
  const asPath = `/${slug}`;
  if (ctx.trailingSlashDirs?.includes(asPath)) {
    return `${asPath}/`;
  }
  return asPath;
}

function resolveUpstreamFallback(rawHref: string, ctx: WebDocLinkContext): string {
  if (!ctx.originalUrl) return rawHref;
  try {
    if (rawHref.startsWith('/')) {
      return new URL(rawHref, ctx.originalUrl).href;
    }
    const currentPath = resolveCurrentDocUpstreamPath(ctx);
    const pageBase = new URL(currentPath, ctx.originalUrl).href;
    return new URL(rawHref, pageBase).href;
  } catch {
    return rawHref;
  }
}

export function resolveWebDocHref(
  rawHref: string | undefined | null,
  ctx?: WebDocLinkContext | null
): string | undefined {
  if (typeof rawHref !== 'string') return rawHref ?? undefined;
  const trimmed = rawHref.trim();
  if (!trimmed || !ctx) return rawHref;

  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('//') ||
    /^(?:https?|mailto|tel|code|javascript|data|vbscript):/i.test(trimmed)
  ) {
    return rawHref;
  }

  const sentinelOrigin = 'https://opengits.local';
  const currentUpstreamPath = resolveCurrentDocUpstreamPath(ctx);
  let parsed: URL;
  try {
    const base = trimmed.startsWith('/') ? sentinelOrigin : `${sentinelOrigin}${currentUpstreamPath}`;
    parsed = new URL(trimmed, base);
  } catch {
    return resolveUpstreamFallback(trimmed, ctx);
  }

  let targetRoute = matchKnownRoute(parsed.pathname, ctx.knownPageRoutes);

  // For extensionless paths like docs/channels.md, retry ./sub as directory-relative before falling back upstream.
  if (!targetRoute && !trimmed.startsWith('/') && !currentUpstreamPath.endsWith('/') && currentUpstreamPath !== '/') {
    try {
      const dirParsed = new URL(trimmed, `${sentinelOrigin}${currentUpstreamPath}/`);
      const dirRoute = matchKnownRoute(dirParsed.pathname, ctx.knownPageRoutes);
      if (dirRoute) {
        parsed = dirParsed;
        targetRoute = dirRoute;
      }
    } catch {
    }
  }

  if (targetRoute) {
    const outUrl = new URL(targetRoute, sentinelOrigin);
    parsed.searchParams.forEach((value, key) => {
      outUrl.searchParams.set(key, value);
    });
    if (ctx.edition) {
      outUrl.searchParams.set('edition', ctx.edition);
    }
    const qs = outUrl.searchParams.toString();
    return `${outUrl.pathname}${qs ? `?${qs}` : ''}${parsed.hash}`;
  }

  return resolveUpstreamFallback(trimmed, ctx);
}
