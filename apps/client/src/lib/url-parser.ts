import { ENGINE_CONFIG } from '@/lib/config';
import { GITHUB_RESERVED_NAMESPACES } from '@/lib/url-inspector';

export interface ParsedGithubUrl {
  owner: string;
  repo: string;
  branch: string;
  filePath: string | null;
  isBlobUrl: boolean;
  rawUrl: string;
}

export function parseGithubUrl(rawUrl: string): ParsedGithubUrl | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  if (rawUrl.length > 2048) return null;

  const trimmed = rawUrl.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!trimmed) return null;

  const pathPart = trimmed.split('?')[0];
  if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(pathPart) || /(?:^|[/\\])\.(?:[/\\]|$)/.test(pathPart)) {
    return null;
  }

  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(trimmed)) {
    const [owner, repo] = trimmed.split('/');
    const cleanRepo = repo.replace(/\.git$/, '');
    if (owner === '.' || owner === '..' || cleanRepo === '.' || cleanRepo === '..') return null;
    if (GITHUB_RESERVED_NAMESPACES.has(owner.toLowerCase())) return null;
    return {
      owner,
      repo: cleanRepo,
      branch: ENGINE_CONFIG.defaultBranch,
      filePath: null,
      isBlobUrl: false,
      rawUrl: trimmed,
    };
  }

  let normalized = trimmed;

  if (normalized.includes('raw.githubusercontent.com/')) {
    const rawParts = normalized.split('raw.githubusercontent.com/')[1]?.split('/').filter(Boolean);
    if (rawParts && rawParts.length >= 3) {
      const rawOwner = rawParts[0];
      const rawRepo = rawParts[1];
      const rawBranch = rawParts[2];
      const rawFile = rawParts.slice(3).join('/');
      normalized = `https://github.com/${rawOwner}/${rawRepo}/blob/${rawBranch}/${rawFile}`;
    }
  }

  if (normalized.startsWith('git@github.com:')) {
    normalized = 'https://github.com/' + normalized.slice('git@github.com:'.length);
  } else if (normalized.startsWith('git://github.com/')) {
    normalized = 'https://github.com/' + normalized.slice('git://github.com/'.length);
  }

  let urlObj: URL;
  try {
    const urlWithProtocol = normalized.startsWith('http://') || normalized.startsWith('https://') 
      ? normalized 
      : `https://${normalized}`;
    urlObj = new URL(urlWithProtocol);
  } catch {
    return null;
  }

  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    return null;
  }

  const hostname = urlObj.hostname.toLowerCase();
  if (hostname !== 'github.com' && !hostname.endsWith('.github.com')) {
    return null;
  }

  urlObj.username = '';
  urlObj.password = '';

  const parts = urlObj.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');

  if (!/^[a-zA-Z0-9_.-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo)) {
    return null;
  }
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    return null;
  }
  if (GITHUB_RESERVED_NAMESPACES.has(owner.toLowerCase())) {
    return null;
  }

  if (parts.length === 2) {
    return {
      owner,
      repo,
      branch: ENGINE_CONFIG.defaultBranch,
      filePath: null,
      isBlobUrl: false,
      rawUrl: trimmed,
    };
  }

  const actionType = parts[2];
  const remainingParts = parts.slice(3);

  let branch = ENGINE_CONFIG.defaultBranch;
  let filePath: string | null = null;

  if (remainingParts.length > 0) {
    let firstPart = decodeSafe(remainingParts[0]);
    if (firstPart.includes('/')) {
      branch = firstPart;
      filePath = remainingParts.slice(1).map(decodeSafe).join('/') || null;
    } else {
      const knownBranchPrefixes = new Set([
        'feature', 'feat', 'fix', 'hotfix', 'release', 'bugfix',
        'chore', 'refactor', 'version', 'v'
      ]);
      if (knownBranchPrefixes.has(firstPart.toLowerCase()) && remainingParts.length >= 2) {
        branch = `${firstPart}/${decodeSafe(remainingParts[1])}`;
        filePath = remainingParts.slice(2).map(decodeSafe).join('/') || null;
      } else {
        branch = firstPart;
        filePath = remainingParts.slice(1).map(decodeSafe).join('/') || null;
      }
    }
  }

  const refQuery = urlObj.searchParams.get('ref');
  if (refQuery && !refQuery.includes('..') && !refQuery.includes('\\')) {
    branch = decodeSafe(refQuery);
  }

  if (filePath) {
    const normalizedPath = filePath.replace(/\\/g, '/');
    if (normalizedPath.split('/').some((seg) => seg === '..' || seg === '.')) {
      return null;
    }
    filePath = normalizedPath;
  }

  if (actionType === 'blob' && filePath) {
    return {
      owner,
      repo,
      branch,
      filePath,
      isBlobUrl: true,
      rawUrl: trimmed,
    };
  }

  return {
    owner,
    repo,
    branch,
    filePath: filePath || null,
    isBlobUrl: false,
    rawUrl: trimmed,
  };
}

function decodeSafe(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
