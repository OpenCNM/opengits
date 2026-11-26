import { ENGINE_CONFIG } from '@/lib/config';

export type ScoutStatusCode =
  | 'INVALID_FORMAT'
  | 'UNSUPPORTED_DOMAIN'
  | 'UNSUPPORTED_RESOURCE'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'DUPLICATE_SHELF'
  | 'DUPLICATE_EXPLORE'
  | 'IS_FORK'
  | 'BLOB_INTENT'
  | 'WEB_DOC_URL'
  | 'SUCCESS';

export type GitHubResourceType =
  | 'repo'
  | 'blob'
  | 'tree'
  | 'issue'
  | 'pull'
  | 'release'
  | 'action'
  | 'commit'
  | 'unsupported_domain'
  | 'invalid_syntax'
  | 'web-doc';

export interface InspectionResult {
  status: ScoutStatusCode;
  isValid: boolean;
  owner: string | null;
  repo: string | null;
  branch: string | null;
  filePath: string | null;
  isBlobUrl: boolean;
  resourceType: GitHubResourceType;
  webUrl?: string;
  diagnosticTitle?: string;
  diagnosticDescription?: string;
  suggestedFormat?: string;
}

const UNSUPPORTED_PATH_PATTERNS = [
  { pattern: /^\/issues(\/|$)/i, type: 'issue' as const, name: 'Issues 讨论页' },
  { pattern: /^\/pulls?(\/|$)/i, type: 'pull' as const, name: 'Pull Request 合并请求页' },
  { pattern: /^\/releases?(\/|$)/i, type: 'release' as const, name: 'Releases 发行包页面' },
  { pattern: /^\/actions(\/|$)/i, type: 'action' as const, name: 'Actions 工作流页面' },
  { pattern: /^\/commits?(\/|$)/i, type: 'commit' as const, name: 'Commit 提交历史页' },
];

export const GITHUB_RESERVED_NAMESPACES = new Set([
  'orgs',
  'settings',
  'marketplace',
  'explore',
  'topics',
  'collections',
  'trending',
  'events',
  'sponsors',
  'login',
  'signup',
  'features',
  'pricing',
  'about',
  'security',
  'contact',
  'site',
  'enterprise',
  'organizations',
  'account',
  'team',
  'dashboard',
  'pulls',
  'issues',
  'search',
  'notifications',
  'stars',
  'codespaces',
  'new',
]);

function isPrivateIpV4(ip: number): boolean {
  if (ip >= 0x00000000 && ip <= 0x00ffffff) return true;
  if (ip >= 0x0a000000 && ip <= 0x0affffff) return true;
  if (ip >= 0x64400000 && ip <= 0x647fffff) return true;
  if (ip >= 0x7f000000 && ip <= 0x7fffffff) return true;
  if (ip >= 0xa9fe0000 && ip <= 0xa9feffff) return true;
  if (ip >= 0xac100000 && ip <= 0xac1fffff) return true;
  if (ip >= 0xc0000000 && ip <= 0xc00000ff) return true;
  if (ip >= 0xc0000200 && ip <= 0xc00002ff) return true;
  if (ip >= 0xc0586300 && ip <= 0xc05863ff) return true;
  if (ip >= 0xc0a80000 && ip <= 0xc0a8ffff) return true;
  if (ip >= 0xc6336400 && ip <= 0xc63364ff) return true;
  if (ip >= 0xcb007100 && ip <= 0xcb0071ff) return true;
  if (ip >= 0xe0000000 && ip <= 0xffffffff) return true;
  return false;
}

function parseIpv4ToUint32(host: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const val = parseInt(host, 16);
    if (!Number.isNaN(val) && val >= 0 && val <= 0xffffffff) {
      return val >>> 0;
    }
  }
  if (/^0[0-7]+$/.test(host)) {
    const val = parseInt(host, 8);
    if (!Number.isNaN(val) && val >= 0 && val <= 0xffffffff) {
      return val >>> 0;
    }
  }
  if (/^(?:[1-9][0-9]*|0)$/.test(host)) {
    const val = parseInt(host, 10);
    if (!Number.isNaN(val) && val >= 0 && val <= 0xffffffff) {
      return val >>> 0;
    }
  }

  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;

  const nums: number[] = [];
  for (const p of parts) {
    if (!p) return null;
    let val: number;
    if (/^0x[0-9a-f]+$/i.test(p)) {
      val = parseInt(p, 16);
    } else if (/^0[0-7]+$/.test(p)) {
      val = parseInt(p, 8);
    } else if (/^[0-9]+$/.test(p)) {
      val = parseInt(p, 10);
    } else {
      return null;
    }
    if (Number.isNaN(val) || val < 0) return null;
    nums.push(val);
  }

  let ip = 0;
  if (nums.length === 4) {
    if (nums.some((n) => n > 255)) return null;
    ip = ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
  } else if (nums.length === 3) {
    if (nums[0] > 255 || nums[1] > 255 || nums[2] > 0xffff) return null;
    ip = ((nums[0] << 24) | (nums[1] << 16) | nums[2]) >>> 0;
  } else if (nums.length === 2) {
    if (nums[0] > 255 || nums[1] > 0xffffff) return null;
    ip = ((nums[0] << 24) | nums[1]) >>> 0;
  } else if (nums.length === 1) {
    if (nums[0] > 0xffffffff) return null;
    ip = nums[0] >>> 0;
  }
  return ip;
}

export function isPrivateOrLoopbackHost(hostname: string): boolean {
  if (!hostname) return true;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (
    host === 'localhost' ||
    host === 'localhost.localdomain' ||
    host === 'ip6-localhost' ||
    host === 'ip6-loopback'
  ) {
    return true;
  }
  if (
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan')
  ) {
    return true;
  }

  if (
    host === '::' ||
    host === '::1' ||
    host === '0:0:0:0:0:0:0:0' ||
    host === '0:0:0:0:0:0:0:1'
  ) {
    return true;
  }
  if (/^(fe80|fc00|fd00)/i.test(host)) return true;

  if (host.startsWith('::ffff:')) {
    const v4Part = host.slice('::ffff:'.length);
    const parsedV4 = parseIpv4ToUint32(v4Part);
    if (parsedV4 !== null) return isPrivateIpV4(parsedV4);
    if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(v4Part)) {
      const [high, low] = v4Part.split(':');
      const ip = ((parseInt(high, 16) << 16) | parseInt(low, 16)) >>> 0;
      return isPrivateIpV4(ip);
    }
  }

  const parsedIp = parseIpv4ToUint32(host);
  if (parsedIp !== null) {
    return isPrivateIpV4(parsedIp);
  }

  if (!host.includes('.')) return true;

  return false;
}

const FORBIDDEN_SSRF_PORTS = new Set([
  '21', '22', '23', '25', '53', '69', '110', '111', '135', '137', '138', '139',
  '143', '389', '445', '636', '1433', '1521', '2049', '2375', '2376', '3306',
  '3389', '5432', '5984', '6379', '9042', '11211', '27017', '27018', '28017'
]);

export function isPublicHttpEndpoint(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.port && FORBIDDEN_SSRF_PORTS.has(parsed.port)) {
      return false;
    }
    return !isPrivateOrLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function inspectGithubUrl(rawUrl: string): InspectionResult {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return {
      status: 'INVALID_FORMAT',
      isValid: false,
      owner: null,
      repo: null,
      branch: null,
      filePath: null,
      isBlobUrl: false,
      resourceType: 'invalid_syntax',
      diagnosticTitle: '链接为空或格式错误',
      diagnosticDescription: '请输入有效的 GitHub 开源项目或 Markdown 文档链接。',
      suggestedFormat: 'https://github.com/owner/repo',
    };
  }

  if (rawUrl.length > 2048) {
    return {
      status: 'INVALID_FORMAT',
      isValid: false,
      owner: null,
      repo: null,
      branch: null,
      filePath: null,
      isBlobUrl: false,
      resourceType: 'invalid_syntax',
      diagnosticTitle: '链接长度超出上限',
      diagnosticDescription: 'URL 长度超过 2048 字符限制，请检查是否包含冗余参数。',
      suggestedFormat: 'https://github.com/owner/repo',
    };
  }

  let trimmed = rawUrl.replace(/[\x00-\x1F\x7F]/g, '').trim();

  const rawPathPart = trimmed.split('?')[0];
  if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(rawPathPart) || /(?:^|[/\\])\.(?:[/\\]|$)/.test(rawPathPart)) {
    return {
      status: 'INVALID_FORMAT',
      isValid: false,
      owner: null,
      repo: null,
      branch: null,
      filePath: null,
      isBlobUrl: false,
      resourceType: 'invalid_syntax',
      diagnosticTitle: '检测到路径穿越字符',
      diagnosticDescription: 'URL 包含非法的相对路径跳转字符（.. 或 .）。',
      suggestedFormat: 'https://github.com/owner/repo',
    };
  }

  if (trimmed.startsWith('git@github.com:')) {
    trimmed = 'https://github.com/' + trimmed.slice('git@github.com:'.length);
  }

  if (trimmed.startsWith('git://github.com/')) {
    trimmed = 'https://github.com/' + trimmed.slice('git://github.com/'.length);
  }

  if (trimmed.includes('raw.githubusercontent.com/')) {
    const rawParts = trimmed.split('raw.githubusercontent.com/')[1]?.split('/').filter(Boolean);
    if (rawParts && rawParts.length >= 3) {
      const rawOwner = rawParts[0];
      const rawRepo = rawParts[1];
      const rawBranch = rawParts[2];
      const rawFile = rawParts.slice(3).join('/');
      trimmed = `https://github.com/${rawOwner}/${rawRepo}/blob/${rawBranch}/${rawFile}`;
    }
  }

  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(trimmed)) {
    const [owner, repo] = trimmed.split('/');
    const cleanRepo = repo.replace(/\.git$/, '');
    if (owner === '.' || owner === '..' || cleanRepo === '.' || cleanRepo === '..') {
      return {
        status: 'INVALID_FORMAT',
        isValid: false,
        owner: null,
        repo: null,
        branch: null,
        filePath: null,
        isBlobUrl: false,
        resourceType: 'invalid_syntax',
        diagnosticTitle: '无效的仓库名称',
        diagnosticDescription: '仓库路径包含非法保留字符。',
        suggestedFormat: 'https://github.com/owner/repo',
      };
    }
    return {
      status: 'SUCCESS',
      isValid: true,
      owner,
      repo: cleanRepo,
      branch: ENGINE_CONFIG.defaultBranch,
      filePath: null,
      isBlobUrl: false,
      resourceType: 'repo',
    };
  }

  let urlObj: URL;
  try {
    const urlWithProtocol = trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://${trimmed}`;
    urlObj = new URL(urlWithProtocol);
  } catch {
    return {
      status: 'INVALID_FORMAT',
      isValid: false,
      owner: null,
      repo: null,
      branch: null,
      filePath: null,
      isBlobUrl: false,
      resourceType: 'invalid_syntax',
      diagnosticTitle: 'URL 网址语法不正确',
      diagnosticDescription: '无法识别此链接格式，请检查拼写或直接输入 owner/repo。',
      suggestedFormat: 'https://github.com/owner/repo',
    };
  }

  urlObj.username = '';
  urlObj.password = '';

  const hostname = urlObj.hostname.toLowerCase();

  if (isPrivateOrLoopbackHost(hostname)) {
    return {
      status: 'UNSUPPORTED_DOMAIN',
      isValid: false,
      owner: null,
      repo: null,
      branch: null,
      filePath: null,
      isBlobUrl: false,
      resourceType: 'unsupported_domain',
      diagnosticTitle: '禁止访问内网或回环地址',
      diagnosticDescription: '出于系统安全策略，禁止探测本地回环 (localhost/127.0.0.1) 及私有局域网/云元数据 IP 地址。',
      suggestedFormat: 'https://github.com/owner/repo',
    };
  }

  if (hostname === 'raw.githubusercontent.com' || hostname.endsWith('.githubusercontent.com')) {
    const rawParts = urlObj.pathname.split('/').filter(Boolean);
    return {
      status: 'INVALID_FORMAT',
      isValid: false,
      owner: rawParts[0] || null,
      repo: rawParts[1] || null,
      branch: null,
      filePath: null,
      isBlobUrl: false,
      resourceType: 'invalid_syntax',
      diagnosticTitle: 'raw.githubusercontent.com 链接缺少分支或文件路径',
      diagnosticDescription: 'raw.githubusercontent.com 必须指定具体的分支与文件路径，例如 raw.githubusercontent.com/owner/repo/main/doc.md。',
      suggestedFormat: 'https://raw.githubusercontent.com/owner/repo/main/doc.md',
    };
  }

  const isGithub = hostname === 'github.com' || hostname.endsWith('.github.com');

  if (!isGithub) {
    if (/^https?:\/\//i.test(trimmed)) {
      return {
        status: 'WEB_DOC_URL',
        isValid: true,
        owner: null,
        repo: null,
        branch: null,
        filePath: null,
        isBlobUrl: false,
        resourceType: 'web-doc',
        webUrl: urlObj.href,
      };
    }
    return {
      status: 'UNSUPPORTED_DOMAIN',
      isValid: false,
      owner: null,
      repo: null,
      branch: null,
      filePath: null,
      isBlobUrl: false,
      resourceType: 'unsupported_domain',
      diagnosticTitle: '暂仅支持 GitHub 仓库或网页文档链接',
      diagnosticDescription: `检测到非 GitHub 域名 (${urlObj.hostname})。支持 GitHub 仓库导入与 http/https 文档站导入。`,
      suggestedFormat: 'https://github.com/owner/repo 或 https://docs.example.com',
    };
  }

  if (hostname === 'gist.github.com') {
    return {
      status: 'UNSUPPORTED_RESOURCE',
      isValid: false,
      owner: null,
      repo: null,
      branch: null,
      filePath: null,
      isBlobUrl: false,
      resourceType: 'unsupported_domain',
      diagnosticTitle: '暂不支持 Gist 代码片段',
      diagnosticDescription: '该链接指向 GitHub Gist 代码片段，平台仅支持导入完整 GitHub 代码仓库或网页文档。',
      suggestedFormat: 'https://github.com/owner/repo',
    };
  }

  const parts = urlObj.pathname.split('/').filter(Boolean);

  if (parts.length >= 1 && GITHUB_RESERVED_NAMESPACES.has(parts[0].toLowerCase())) {
    const owner = parts[0];
    return {
      status: 'UNSUPPORTED_RESOURCE',
      isValid: false,
      owner,
      repo: null,
      branch: null,
      filePath: null,
      isBlobUrl: false,
      resourceType: 'invalid_syntax',
      diagnosticTitle: '无效的仓库名称（系统保留路径）',
      diagnosticDescription: `"${owner}" 是 GitHub 官方系统功能页面，并非项目仓库。请输入具体开源项目链接。`,
      suggestedFormat: 'https://github.com/owner/repo',
    };
  }

  if (parts.length < 2) {
    return {
      status: 'INVALID_FORMAT',
      isValid: false,
      owner: null,
      repo: null,
      branch: null,
      filePath: null,
      isBlobUrl: false,
      resourceType: 'invalid_syntax',
      diagnosticTitle: 'GitHub 链接缺少 仓库名称',
      diagnosticDescription: '标准的 GitHub 仓库链接应包含用户名与仓库名，例如 github.com/facebook/react。',
      suggestedFormat: 'https://github.com/owner/repo',
    };
  }

  const owner = parts[0].toLowerCase();
  const repo = parts[1].replace(/\.git$/, '').toLowerCase();

  const subPath = '/' + parts.slice(2).join('/');

  for (const item of UNSUPPORTED_PATH_PATTERNS) {
    if (item.pattern.test(subPath)) {
      return {
        status: 'UNSUPPORTED_RESOURCE',
        isValid: false,
        owner,
        repo,
        branch: null,
        filePath: null,
        isBlobUrl: false,
        resourceType: item.type,
        diagnosticTitle: `暂不支持 ${item.name}`,
        diagnosticDescription: `该链接指向的是项目的 ${item.name}，并非文档源码。请输入该项目根目录或 Markdown 文件链接。`,
        suggestedFormat: `https://github.com/${owner}/${repo}`,
      };
    }
  }

  let branch = ENGINE_CONFIG.defaultBranch;
  let filePath: string | null = null;
  let isBlobUrl = false;
  let resourceType: GitHubResourceType = 'repo';

  if (parts.length >= 4 && (parts[2] === 'blob' || parts[2] === 'tree')) {
    const remainingParts = parts.slice(3);
    const firstPart = remainingParts[0];
    const knownBranchPrefixes = new Set([
      'feature', 'feat', 'fix', 'hotfix', 'release', 'bugfix',
      'chore', 'refactor', 'version', 'v'
    ]);

    if (firstPart.includes('%2F') || firstPart.includes('/')) {
      try {
        branch = decodeURIComponent(firstPart);
      } catch {
        branch = firstPart;
      }
      filePath = remainingParts.slice(1).map((s) => {
        try { return decodeURIComponent(s); } catch { return s; }
      }).join('/') || null;
    } else if (knownBranchPrefixes.has(firstPart.toLowerCase()) && remainingParts.length >= 2) {
      try {
        branch = `${firstPart}/${decodeURIComponent(remainingParts[1])}`;
      } catch {
        branch = `${firstPart}/${remainingParts[1]}`;
      }
      filePath = remainingParts.slice(2).map((s) => {
        try { return decodeURIComponent(s); } catch { return s; }
      }).join('/') || null;
    } else {
      try {
        branch = decodeURIComponent(firstPart);
      } catch {
        branch = firstPart;
      }
      filePath = remainingParts.slice(1).map((s) => {
        try { return decodeURIComponent(s); } catch { return s; }
      }).join('/') || null;
    }

    if (parts[2] === 'blob') {
      isBlobUrl = true;
      resourceType = 'blob';
    } else {
      resourceType = 'tree';
    }
  }

  const refQuery = urlObj.searchParams.get('ref');
  if (refQuery && !refQuery.includes('..') && !refQuery.includes('\\')) {
    try {
      branch = decodeURIComponent(refQuery);
    } catch {
      branch = refQuery;
    }
  }

  return {
    status: isBlobUrl ? 'BLOB_INTENT' : 'SUCCESS',
    isValid: true,
    owner,
    repo,
    branch,
    filePath,
    isBlobUrl,
    resourceType,
  };
}
