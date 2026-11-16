/**
 * 构建导入完成后进入阅读页面的目标路径（GitHub 仓与 WebDoc 共用，Single Source of Truth）。
 */
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

/** 提取网页文档站点的展示域名与路径（ImportWizard 标题与 WebDocScopeStep 共用，SSOT）。 */
export function formatWebDocTargetDisplay(rawUrl: string): WebDocDisplayTarget {
  const trimmed = rawUrl.trim();
  if (!trimmed) return { hostname: '', endpoint: '' };
  try {
    const parsed = new URL(trimmed);
    const endpoint = `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    return { hostname: parsed.hostname, endpoint };
  } catch {
    // 降级：输入中非完整 URL 仅作展示回退，不阻断导入流程
    return { hostname: trimmed, endpoint: trimmed };
  }
}
