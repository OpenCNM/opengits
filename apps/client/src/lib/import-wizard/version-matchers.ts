export interface ScoutVersionLike {
  prefix: string;
  totalFiles?: number;
  isOversized?: boolean;
  role?: string;
  lang?: string;
}

export interface VersionMatchContext {
  filePath?: string | null;
}

const stripTrailingSlash = (p: string): string => p.replace(/\/$/, '');

export function byExplicitPath(versions: ScoutVersionLike[], ctx: VersionMatchContext): ScoutVersionLike | null {
  if (!ctx.filePath) return null;
  const normPath = stripTrailingSlash(ctx.filePath);
  if (!normPath) return null;
  return (
    versions.find((v) => {
      const normV = stripTrailingSlash(v.prefix);
      if (normV === normPath) return true;
      if (!normV) return false;
      return normV.endsWith(normPath) || normPath.endsWith(normV);
    }) ?? null
  );
}

export function byPrimaryRole(versions: ScoutVersionLike[]): ScoutVersionLike | null {
  return versions.find((v) => v.role === 'primary') ?? null;
}

export const VERSION_MATCHERS: Array<(versions: ScoutVersionLike[], ctx: VersionMatchContext) => ScoutVersionLike | null> = [
  byExplicitPath,
  byPrimaryRole,
];

export function fallbackPrefix(filePath?: string | null): string {
  if (filePath) {
    return filePath.endsWith('/') ? filePath : filePath + '/';
  }
  return '';
}

export function matchScoutVersion(
  versions: ScoutVersionLike[],
  ctx: VersionMatchContext
): ScoutVersionLike | null {
  for (const matcher of VERSION_MATCHERS) {
    const matched = matcher(versions, ctx);
    if (matched) return matched;
  }
  return null;
}
