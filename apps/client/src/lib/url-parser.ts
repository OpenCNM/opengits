/**
 * GitHub URL Parser & Intent Inspector
 *
 * Parses raw GitHub URLs to extract owner, repo, branch, file path,
 * and detects whether the URL points to a single blob file (e.g. chapter2.md).
 */

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

  // 1. Length limit (MAX 2048 chars)
  if (rawUrl.length > 2048) return null;

  // 2. Strip null bytes & control chars
  const trimmed = rawUrl.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!trimmed) return null;

  // 3. Security guard: reject path traversal in raw URL (e.g. /../ or /./)
  const pathPart = trimmed.split('?')[0];
  if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(pathPart) || /(?:^|[/\\])\.(?:[/\\]|$)/.test(pathPart)) {
    return null;
  }

  // Case 1: Short syntax "owner/repo"
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

  // Normalize raw.githubusercontent.com format: https://raw.githubusercontent.com/owner/repo/branch/path -> https://github.com/owner/repo/blob/branch/path
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

  // SSH protocol: git@github.com:owner/repo.git
  if (normalized.startsWith('git@github.com:')) {
    normalized = 'https://github.com/' + normalized.slice('git@github.com:'.length);
  } else if (normalized.startsWith('git://github.com/')) {
    normalized = 'https://github.com/' + normalized.slice('git://github.com/'.length);
  }

  // Ensure it's a valid URL with github.com
  let urlObj: URL;
  try {
    const urlWithProtocol = normalized.startsWith('http://') || normalized.startsWith('https://') 
      ? normalized 
      : `https://${normalized}`;
    urlObj = new URL(urlWithProtocol);
  } catch {
    return null;
  }

  // Only allow http and https
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    return null;
  }

  const hostname = urlObj.hostname.toLowerCase();
  if (hostname !== 'github.com' && !hostname.endsWith('.github.com')) {
    return null;
  }

  // Basic auth stripping for security
  urlObj.username = '';
  urlObj.password = '';

  // Path parts: /owner/repo/blob/main/book/chapter2.md
  const parts = urlObj.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');

  // Reject traversal or invalid identifiers
  if (!/^[a-zA-Z0-9_.-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo)) {
    return null;
  }
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    return null;
  }
  if (GITHUB_RESERVED_NAMESPACES.has(owner.toLowerCase())) {
    return null;
  }

  // Default: root repo URL
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

  const actionType = parts[2]; // 'blob' or 'tree'
  const remainingParts = parts.slice(3);

  // Parse branch and filePath with support for:
  // 1. URL-encoded slashes: feature%2Fv2.0 -> feature/v2.0
  // 2. Multi-segment branch namespaces: feature/xxx, release/xxx, fix/xxx, hotfix/xxx, v/xxx
  // 3. Query parameter ?ref=...
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

  // Allow ?ref= query parameter to override branch if specified
  const refQuery = urlObj.searchParams.get('ref');
  if (refQuery && !refQuery.includes('..') && !refQuery.includes('\\')) {
    branch = decodeSafe(refQuery);
  }

  // Security guard against path traversal in resolved filePath
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
