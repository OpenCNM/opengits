import {
  allChaptersInTeachingOrder,
  docPathToSlug,
  flattenNavTreeEntries,
  outlineNodeUrl,
  type OutlineView,
} from '@/lib/outline-reader';
import { isUnderPrefix } from '@/lib/import-wizard/webdoc-scope';
import type { ModuleTab, ModuleTabKind } from '@/lib/schemas/webdoc-topology';
import type { NavNode } from '@/engine/structurizer';

export interface ResolvedModuleTab {
  id: string;
  label: string;
  kind: ModuleTabKind;
  tabPath: string;
  href: string;
  matchPrefix: string;
}

export interface ResolveModuleTabsParams {
  owner: string;
  repo: string;
  moduleTabs?: ModuleTab[] | null;
  allowedPrefixes?: string[] | null;
  importedDocPaths?: string[] | null;
  hasOpenApi?: boolean;
  hasChangelogDoc?: boolean;
}

function normalizeRoutePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === '/') return '/';
  const collapsed = trimmed.replace(/\/+/g, '/');
  const withLeading = collapsed.startsWith('/') ? collapsed : `/${collapsed}`;
  return withLeading.length > 1 ? withLeading.replace(/\/+$/, '') : '/';
}

function docPathToRoutePath(docPath: string): string {
  const slug = docPathToSlug(docPath).replace(/^\/+|\/+$/g, '');
  const lower = slug.toLowerCase();
  if (!slug || lower === 'index' || lower === 'readme') return '/';
  return normalizeRoutePath(`/${slug}`);
}

export function collectImportedDocPaths(
  outline?: OutlineView | null,
  navTree?: NavNode[] | null,
): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];

  if (outline) {
    for (const chapter of allChaptersInTeachingOrder(outline)) {
      for (const node of chapter.nodes || []) {
        if (node.docPath && !seen.has(node.docPath)) {
          seen.add(node.docPath);
          paths.push(node.docPath);
        }
      }
    }
  }

  for (const entry of flattenNavTreeEntries(navTree)) {
    if (entry.path && !seen.has(entry.path)) {
      seen.add(entry.path);
      paths.push(entry.path);
    }
  }

  return paths;
}

export function detectHasChangelogDoc(
  outline?: OutlineView | null,
  navTree?: NavNode[] | null,
): boolean {
  if (outline) {
    for (const chapter of allChaptersInTeachingOrder(outline)) {
      if (chapter.title?.toLowerCase().includes('changelog')) return true;
      for (const node of chapter.nodes || []) {
        if (
          node.docPath?.toLowerCase().includes('changelog') ||
          node.title?.toLowerCase().includes('changelog')
        ) {
          return true;
        }
      }
    }
  }

  return flattenNavTreeEntries(navTree).some(
    (entry) =>
      entry.path.toLowerCase().includes('changelog') ||
      entry.title.toLowerCase().includes('changelog'),
  );
}

function isTabAllowedByScope(tabPath: string, allowedPrefixes: string[]): boolean {
  if (allowedPrefixes.length === 0) return true;
  const normalized = allowedPrefixes
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map(normalizeRoutePath);

  if (normalized.length === 0 || normalized.includes('/')) return true;

  return normalized.some(
    (prefix) =>
      isUnderPrefix(tabPath, prefix) || (tabPath !== '/' && isUnderPrefix(prefix, tabPath)),
  );
}

function findFirstDocUnderPrefix(importedDocPaths: string[], tabPath: string): string | null {
  if (importedDocPaths.length === 0) return null;
  if (tabPath === '/') {
    const rootDoc = importedDocPaths.find((docPath) => docPathToRoutePath(docPath) === '/');
    return rootDoc ?? importedDocPaths[0];
  }
  return importedDocPaths.find((docPath) => isUnderPrefix(docPathToRoutePath(docPath), tabPath)) ?? null;
}

function isExternalTab(tab: ModuleTab): boolean {
  return (
    tab.kind === 'external' ||
    tab.path.startsWith('http://') ||
    tab.path.startsWith('https://')
  );
}

export function resolveModuleTabEntries({
  owner,
  repo,
  moduleTabs,
  allowedPrefixes,
  importedDocPaths,
  hasOpenApi = false,
  hasChangelogDoc = false,
}: ResolveModuleTabsParams): ResolvedModuleTab[] {
  if (!Array.isArray(moduleTabs) || moduleTabs.length === 0) return [];

  const baseDocsPath = `/docs/${owner}/${repo}`;
  const prefixes = Array.isArray(allowedPrefixes) ? allowedPrefixes : [];
  const docPaths = Array.isArray(importedDocPaths) ? importedDocPaths : [];
  const hasKnownDocInventory = docPaths.length > 0;

  const resolved: ResolvedModuleTab[] = [];
  const seenHrefs = new Set<string>();

  for (const tab of moduleTabs) {
    if (!tab || !tab.label || !tab.path || isExternalTab(tab)) continue;

    const tabPath = normalizeRoutePath(tab.path);
    const inScope = isTabAllowedByScope(tabPath, prefixes);
    let href: string | null = null;
    let matchPrefix: string = tabPath === '/' ? baseDocsPath : `${baseDocsPath}${tabPath}`;

    if (tab.kind === 'api') {
      if (hasOpenApi) {
        href = `${baseDocsPath}/api-reference`;
        matchPrefix = href;
      } else if (inScope && hasKnownDocInventory) {
        const matched = findFirstDocUnderPrefix(docPaths, tabPath);
        if (matched) {
          href = outlineNodeUrl(owner, repo, matched) || `${baseDocsPath}${tabPath === '/' ? '' : tabPath}`;
        }
      }
    } else if (tab.kind === 'changelog') {
      if (!inScope || !hasChangelogDoc) continue;
      const matched =
        findFirstDocUnderPrefix(docPaths, tabPath) ??
        docPaths.find((p) => p.toLowerCase().includes('changelog')) ??
        null;
      if (hasKnownDocInventory && !matched) continue;
      href = matched
        ? outlineNodeUrl(owner, repo, matched) || `${baseDocsPath}${tabPath === '/' ? '' : tabPath}`
        : `${baseDocsPath}${tabPath === '/' ? '' : tabPath}`;
    } else {
      if (!inScope) continue;
      if (hasKnownDocInventory) {
        const matched = findFirstDocUnderPrefix(docPaths, tabPath);
        if (!matched) continue;
        href =
          tabPath === '/'
            ? baseDocsPath
            : outlineNodeUrl(owner, repo, matched) || `${baseDocsPath}${tabPath}`;
      } else {
        href = tabPath === '/' ? baseDocsPath : `${baseDocsPath}${tabPath}`;
      }
    }

    if (!href || seenHrefs.has(href)) continue;
    seenHrefs.add(href);

    resolved.push({
      id: tab.id || tabPath,
      label: tab.label,
      kind: tab.kind,
      tabPath,
      href,
      matchPrefix,
    });
  }

  return resolved;
}

// Longest-prefix match prevents multiple doc-type tabs from highlighting simultaneously.
export function pickActiveModuleTabId(
  entries: ResolvedModuleTab[],
  pathname: string | null | undefined,
  owner: string,
  repo: string,
  primaryDocPrefix?: string | null,
): string | null {
  if (entries.length === 0) return null;

  const baseDocsPath = `/docs/${owner}/${repo}`;
  const currentPath = normalizeRoutePath(pathname || baseDocsPath);

  let bestMatch: ResolvedModuleTab | null = null;
  for (const entry of entries) {
    if (!isUnderPrefix(currentPath, entry.matchPrefix)) continue;
    if (!bestMatch || entry.matchPrefix.length > bestMatch.matchPrefix.length) {
      bestMatch = entry;
    }
  }

  if (bestMatch) {
    if (bestMatch.matchPrefix === baseDocsPath && currentPath === baseDocsPath && primaryDocPrefix) {
      const normalizedPrimary = normalizeRoutePath(primaryDocPrefix);
      const primaryEntry = entries.find((e) => e.tabPath === normalizedPrimary);
      if (primaryEntry) return primaryEntry.id;
    }
    return bestMatch.id;
  }

  if (primaryDocPrefix) {
    const normalizedPrimary = normalizeRoutePath(primaryDocPrefix);
    const primaryEntry = entries.find((e) => e.tabPath === normalizedPrimary);
    if (primaryEntry) return primaryEntry.id;
  }

  return entries.find((e) => e.kind === 'doc')?.id ?? entries[0].id;
}
