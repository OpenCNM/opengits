export interface ImportedRepoRouteInfo {
  owner: string;
  repo: string;
  landingPath?: string | null;
  edition?: string | null;
}

export function buildImportedTutorialHref(info: ImportedRepoRouteInfo): string {
  const cleanLanding = info.landingPath
    ? info.landingPath.replace(/\.(md|mdx|markdown)$/i, '')
    : undefined;
  const isRootLanding =
    !cleanLanding ||
    cleanLanding.toLowerCase() === 'index' ||
    cleanLanding.toLowerCase() === 'readme';
  const editionParam = info.edition ? `?edition=${encodeURIComponent(info.edition)}` : '';

  return !isRootLanding
    ? `/docs/${info.owner}/${info.repo}/${cleanLanding}${editionParam}`
    : `/docs/${info.owner}/${info.repo}${editionParam}`;
}

export interface WebDocDisplayTarget {
  hostname: string;
  endpoint: string;
}

export function formatWebDocTargetDisplay(rawUrl: string): WebDocDisplayTarget {
  const trimmed = rawUrl.trim();
  if (!trimmed) return { hostname: '', endpoint: '' };
  try {
    const parsed = new URL(trimmed);
    const endpoint = `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    return { hostname: parsed.hostname, endpoint };
  } catch {
    return { hostname: trimmed, endpoint: trimmed };
  }
}
