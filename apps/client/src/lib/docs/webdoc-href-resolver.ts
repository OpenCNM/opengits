import {
  allChaptersInTeachingOrder,
  docPathToSlug,
  outlineNodeUrl,
  type OutlineView,
} from '@/lib/outline-reader';
import type { NavNode } from '@/engine/structurizer';

/**
 * WebDoc 站内超链接双栖重映射上下文（Phase 3：单一事实源，禁止 TS 复刻 .md 路径推导）。
 * 直接复用渲染期已在内存中的 outline + repoProfile（originalUrl / navOrderUrls）。
 */
export interface WebDocLinkContext {
  owner: string;
  repo: string;
  originalUrl?: string | null;
  currentDocPath?: string | null;
  edition?: string | null;
  /** 归一化站内 pathname（含 raw encoded 与 decoded）-> 站内 OpenGits 路由 URL */
  knownPageRoutes: Record<string, string>;
  /** 来自 repoProfile.navOrderUrls 的目录尾斜杠集合（辅助相对路径如 ./sub 解析） */
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
    // 容错降级: 非法百分号序列跳过 decoded 变体注册，保留 raw 匹配键
  }
  try {
    const encoded = normalizePathname(encodeURI(decodeURIComponent(norm)));
    if (encoded && !map[encoded]) {
      map[encoded] = routeUrl;
    }
  } catch {
    // 容错降级: 非法百分号序列跳过 encoded 变体注册
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

/**
 * 从渲染期已有的 outline / navTree / repoProfile 构建站内路由索引（无任何 DB 查询）。
 */
export function buildWebDocLinkContext(params: BuildWebDocLinkContextParams): WebDocLinkContext {
  const { owner, repo, outline, navTree, repoProfile, currentDocPath, edition } = params;
  const knownPageRoutes: Record<string, string> = {};

  // 1. 权威索引源 A：outline 中已实际导入落盘的 docPath 集合（与 outlineNodeUrl 同源）
  if (outline) {
    for (const ch of allChaptersInTeachingOrder(outline)) {
      for (const n of ch.nodes || []) {
        if (n.docPath) {
          registerDocPathEntry(knownPageRoutes, owner, repo, n.docPath);
        }
      }
    }
  }

  // 兜底：无激活大纲的存量仓回落 navTree
  if (Object.keys(knownPageRoutes).length === 0 && Array.isArray(navTree)) {
    for (const p of collectNavTreeDocPaths(navTree)) {
      registerDocPathEntry(knownPageRoutes, owner, repo, p);
    }
  }

  // 2. 权威索引源 B：repoProfile.navOrderUrls 源站成员索引
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
      // 仅当 outline 与 navTree 均为空时，才允许从作用域过滤后的 navOrderUrls 建立路由索引，
      // 避免把侧栏中存在但被 excludePrefixes 拦截的链接误标为站内已导入页面。
      if (Object.keys(knownPageRoutes).length === 0) {
        const normPath = normalizePathname(parsed.pathname);
        const target = normPath === '/' ? `/docs/${owner}/${repo}` : `/docs/${owner}/${repo}${normPath}`;
        registerPathVariants(knownPageRoutes, normPath, target);
      }
    } catch {
      // 容错降级: 忽略 navOrderUrls 中个别畸形 URL
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
      // 容错降级: 非法百分号编码忽略 decoded 尝试
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
    // 容错降级: 极端畸形 URL 解析失败时回退原始 href
    return rawHref;
  }
}

/**
 * WebDoc 站内超链接解析纯函数：
 * 1. 纯 #anchor / http(s):// / // / mailto: / tel: / code: / javascript: -> 原样放行；
 * 2. 站内相对路径（含 ?query#hash）用 URL / URLSearchParams 规范拆解，命中 knownPageRoutes ->
 *    重映射至 `/docs/{owner}/{repo}/{slug}` 并安全合并 `?edition=...` 与原有 query/hash；
 * 3. 未命中抓取范围的站内路径（如 /templates、/pricing）-> 复用 DocsModuleTabs 同源逻辑跳回源站，0 404 死链。
 */
export function resolveWebDocHref(
  rawHref: string | undefined | null,
  ctx?: WebDocLinkContext | null
): string | undefined {
  if (typeof rawHref !== 'string') return rawHref ?? undefined;
  const trimmed = rawHref.trim();
  if (!trimmed || !ctx) return rawHref;

  // 1. 纯锚点、绝对外链、协议外链原样放行
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('//') ||
    /^(?:https?|mailto|tel|code|javascript|data|vbscript):/i.test(trimmed)
  ) {
    return rawHref;
  }

  // 2. 用 URL / URLSearchParams 拆解站内或文档相对路径
  const sentinelOrigin = 'https://opengits.local';
  const currentUpstreamPath = resolveCurrentDocUpstreamPath(ctx);
  let parsed: URL;
  try {
    const base = trimmed.startsWith('/') ? sentinelOrigin : `${sentinelOrigin}${currentUpstreamPath}`;
    parsed = new URL(trimmed, base);
  } catch {
    // 容错降级: 非法相对路径回退源站拼接或原样
    return resolveUpstreamFallback(trimmed, ctx);
  }

  let targetRoute = matchKnownRoute(parsed.pathname, ctx.knownPageRoutes);

  // 对无尾斜杠的 docPath（如 docs/channels.md）下的相对子链接（如 ./whatsapp），
  // 若按父级目录未命中，补查目录形式（/docs/channels/whatsapp）防漏配
  if (!targetRoute && !trimmed.startsWith('/') && !currentUpstreamPath.endsWith('/') && currentUpstreamPath !== '/') {
    try {
      const dirParsed = new URL(trimmed, `${sentinelOrigin}${currentUpstreamPath}/`);
      const dirRoute = matchKnownRoute(dirParsed.pathname, ctx.knownPageRoutes);
      if (dirRoute) {
        parsed = dirParsed;
        targetRoute = dirRoute;
      }
    } catch {
      // 容错降级: 忽略二次目录尝试中的异常 URL
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

  // 3. 不在抓取范围内的站内路径（如 /templates, /pricing）-> 跳回源站
  return resolveUpstreamFallback(trimmed, ctx);
}
