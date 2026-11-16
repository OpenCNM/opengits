import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/mcp/repo-resolve-cache', () => ({
  cachedDefaultBranchRepository: vi.fn(),
}));

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: vi.fn(),
}));

vi.mock('@/lib/auth-utils', () => ({
  verifyRepoAccessDirect: vi.fn(),
}));

vi.mock('@/engine/tarball/archive-store', () => ({
  readFileLocal: vi.fn(),
  getFileContentLocalFirst: vi.fn(),
}));

import { cachedDefaultBranchRepository } from '@/lib/mcp/repo-resolve-cache';
import { getSessionHelper } from '@/lib/auth-helper';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { readFileLocal } from '@/engine/tarball/archive-store';
import { GET, codeFileCache } from '@/app/api/code/[owner]/[repo]/file/route';

describe('GET /api/code/[owner]/[repo]/file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    codeFileCache.clear();
  });

  it('缺少 path 参数时应返回 400 Bad Request', async () => {
    const req = new Request('http://localhost/api/code/owner/repo/file');
    const resp = await GET(req, { params: Promise.resolve({ owner: 'owner', repo: 'repo' }) });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/Path query parameter is required/);
  });

  it('存在目录穿越 .. 或以 / 开头时应拦截返回 400', async () => {
    const req = new Request('http://localhost/api/code/owner/repo/file?path=../../etc/passwd');
    const resp = await GET(req, { params: Promise.resolve({ owner: 'owner', repo: 'repo' }) });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/Invalid or unsafe file path/);
  });

  it('仓库不存在时应返回 404', async () => {
    vi.mocked(cachedDefaultBranchRepository).mockResolvedValue(null as any);
    const req = new Request('http://localhost/api/code/owner/repo/file?path=src/index.ts');
    const resp = await GET(req, { params: Promise.resolve({ owner: 'owner', repo: 'repo' }) });
    expect(resp.status).toBe(404);
  });

  it('私有仓无权限时应返回 403', async () => {
    vi.mocked(cachedDefaultBranchRepository).mockResolvedValue({
      id: 'repo-1',
      isPublic: false,
      gitSha: 'sha-1',
      branch: 'main',
    } as any);
    vi.mocked(getSessionHelper).mockResolvedValue(null as any);
    vi.mocked(verifyRepoAccessDirect).mockResolvedValue(false);

    const req = new Request('http://localhost/api/code/owner/repo/file?path=src/index.ts');
    const resp = await GET(req, { params: Promise.resolve({ owner: 'owner', repo: 'repo' }) });
    expect(resp.status).toBe(403);
  });

  it('公开仓读取文件成功返回源码与元数据', async () => {
    vi.mocked(cachedDefaultBranchRepository).mockResolvedValue({
      id: 'repo-1',
      isPublic: true,
      gitSha: 'sha-123456',
      branch: 'main',
    } as any);
    vi.mocked(readFileLocal).mockResolvedValue('export const a = 1;\nexport const b = 2;\n');

    const req = new Request('http://localhost/api/code/owner/repo/file?path=src/index.ts');
    const resp = await GET(req, { params: Promise.resolve({ owner: 'owner', repo: 'repo' }) });
    expect(resp.status).toBe(200);

    const body = await resp.json();
    expect(body.data.ok).toBe(true);
    expect(body.data.filePath).toBe('src/index.ts');
    expect(body.data.sha).toBe('sha-123456');
    expect(body.data.totalLines).toBe(3);
    expect(body.data.language).toBe('typescript');
  });
});
