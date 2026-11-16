import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockCookieGetAll = vi.fn();
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    getAll: mockCookieGetAll,
    get: (name: string) => mockCookieGetAll().find((c: { name: string; value: string }) => c.name === name),
  })),
  headers: vi.fn(async () => new Headers()),
}));

const mockGetServerSession = vi.fn();
vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

const mockGetToken = vi.fn();
vi.mock('next-auth/jwt', () => ({
  getToken: (...args: unknown[]) => mockGetToken(...args),
}));

const mockAdminUserFindUnique = vi.fn();
const mockRepoFindFirst = vi.fn();
const mockDocFindFirst = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: {
    adminUser: {
      findUnique: (...args: unknown[]) => mockAdminUserFindUnique(...args),
      upsert: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    repository: {
      findFirst: (...args: unknown[]) => mockRepoFindFirst(...args),
    },
    document: {
      findFirst: (...args: unknown[]) => mockDocFindFirst(...args),
    },
  },
}));

const mockCallSidecar = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => mockCallSidecar(...args),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
  clientIpFromRequest: vi.fn().mockReturnValue('192.168.1.100'),
}));

vi.mock('@/lib/mcp/repo-resolve-cache', () => ({
  cachedDefaultBranchRepository: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/engine/asset-driver', () => ({
  executeSidecarAssetServe: vi.fn().mockResolvedValue(null),
  pipeSidecarAssetResponse: vi.fn(),
  activeStorageDriverName: vi.fn().mockReturnValue('local'),
}));

vi.mock('@/lib/github/client', () => ({
  githubFetch: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
}));

import {
  getSessionHelper,
  getAdminUserHelper,
  sessionJweCache,
  adminCache,
  extractSessionCookieHash,
} from '@/lib/auth-helper';
import { cachedDefaultBranchRepository } from '@/lib/mcp/repo-resolve-cache';
import { GET as getAssetsRoute } from '@/app/api/assets/[owner]/[repo]/[...path]/route';
import { GET as getDocsContentRoute } from '@/app/api/docs-content/[owner]/[repo]/[...slug]/route';
import { POST as postVerifySessionRoute } from '@/app/api/internal/auth/verify-session/route';

describe('Edge Auth Cache 校验下沉 (Node 进程级 LRU 与公开仓快速通道)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionJweCache.clear();
    adminCache.clear();
    process.env = { ...originalEnv, INTERNAL_API_TOKEN: 'test-internal-token' };
  });

  // 🧪 [8.1.6.1] Node 进程级 Session JWE 解密缓存 (sha256 摘要与 60s TTL)
  describe('🧪 [8.1.6.1] getSessionHelper 与 sessionJweCache', () => {
    it('无 session cookie 时短路返回 null，不触发 getServerSession', async () => {
      mockCookieGetAll.mockReturnValue([
        { name: 'theme', value: 'dark' },
        { name: 'locale', value: 'zh-CN' },
      ]);

      const session = await getSessionHelper();
      expect(session).toBeNull();
      expect(mockGetServerSession).not.toHaveBeenCalled();
      expect(sessionJweCache.size).toBe(0);
    });

    it('携带 session cookie 时首次触发解密，二次请求直接命中进程内内存缓存', async () => {
      mockCookieGetAll.mockReturnValue([
        { name: 'next-auth.session-token', value: 'encrypted_jwe_token_abc123' },
      ]);
      const mockSessionObj = {
        user: { id: 'usr_edge_1', email: 'edge@opengits.org', name: 'Edge Worker' },
        expires: '2026-09-15T00:00:00.000Z',
      };
      mockGetServerSession.mockResolvedValue(mockSessionObj);

      // 首次调用：冷启动打库/解密
      const first = await getSessionHelper();
      expect(first).toEqual(mockSessionObj);
      expect(mockGetServerSession).toHaveBeenCalledTimes(1);
      expect(sessionJweCache.size).toBe(1);

      // 第二次调用：相同 Cookie，命中 sessionJweCache
      const second = await getSessionHelper();
      expect(second).toEqual(mockSessionObj);
      // getServerSession 调用次数依然为 1，完全避免 HKDF + AES-GCM 重复解密开销
      expect(mockGetServerSession).toHaveBeenCalledTimes(1);
    });

    it('分片 cookie (__Secure-next-auth.session-token.0 / .1) 完整聚合计算摘要并命中缓存', async () => {
      mockCookieGetAll.mockReturnValue([
        { name: '__Secure-next-auth.session-token.0', value: 'chunk0_data' },
        { name: '__Secure-next-auth.session-token.1', value: 'chunk1_data' },
      ]);
      const mockSessionObj = { user: { id: 'usr_chunk', email: 'chunk@opengits.org' } };
      mockGetServerSession.mockResolvedValue(mockSessionObj);

      const res1 = await getSessionHelper();
      expect(res1).toEqual(mockSessionObj);
      expect(mockGetServerSession).toHaveBeenCalledTimes(1);

      const res2 = await getSessionHelper();
      expect(res2).toEqual(mockSessionObj);
      expect(mockGetServerSession).toHaveBeenCalledTimes(1);
    });

    it('损坏或伪造的 session cookie 导致解密异常时安全 fail-soft 并写入负缓存防击穿', async () => {
      mockCookieGetAll.mockReturnValue([
        { name: 'next-auth.session-token', value: 'corrupted_jwe_garbage_token' },
      ]);
      mockGetServerSession.mockRejectedValue(new Error('JWEDecryptionFailed: invalid ciphertext'));

      // 首次调用：抛出解密异常时安全捕获并返回 null，绝不触发 500 崩溃
      const first = await getSessionHelper();
      expect(first).toBeNull();
      expect(mockGetServerSession).toHaveBeenCalledTimes(1);
      expect(sessionJweCache.size).toBe(1);

      // 二次调用：负缓存生效，不再重复调用 getServerSession
      const second = await getSessionHelper();
      expect(second).toBeNull();
      expect(mockGetServerSession).toHaveBeenCalledTimes(1);
    });

    it('extractSessionCookieHash 对无 token 的 cookie 集合返回 null，对同集合有序输出恒定摘要', () => {
      const hash1 = extractSessionCookieHash([
        { name: 'b_next-auth.session-token.1', value: 'val1' },
        { name: 'a_next-auth.session-token.0', value: 'val0' },
      ]);
      const hash2 = extractSessionCookieHash([
        { name: 'a_next-auth.session-token.0', value: 'val0' },
        { name: 'b_next-auth.session-token.1', value: 'val1' },
      ]);
      expect(hash1).toBeTruthy();
      expect(hash1).toBe(hash2);

      const nullHash = extractSessionCookieHash([{ name: 'csrf', value: '123' }]);
      expect(nullHash).toBeNull();
    });
  });

  describe('getAdminUserHelper 与 adminCache', () => {
    it('同一管理员 email 60 秒内二次查询命中内存，不重复查询数据库', async () => {
      mockCookieGetAll.mockReturnValue([
        { name: 'next-auth.session-token', value: 'admin_cookie_token' },
      ]);
      mockGetServerSession.mockResolvedValue({
        user: { id: 'admin_1', email: 'admin@opengits.org' },
      });

      const mockAdminRecord = {
        id: 'adm_1',
        email: 'admin@opengits.org',
        name: 'Super Admin',
        role: 'SUPER_ADMIN',
        isActive: true,
      };
      mockAdminUserFindUnique.mockResolvedValue(mockAdminRecord);

      // 首次查询：查 DB
      const admin1 = await getAdminUserHelper();
      expect(admin1).toEqual(mockAdminRecord);
      expect(mockAdminUserFindUnique).toHaveBeenCalledTimes(1);
      expect(adminCache.size).toBe(1);

      // 第二次查询：命中 adminCache
      const admin2 = await getAdminUserHelper();
      expect(admin2).toEqual(mockAdminRecord);
      expect(mockAdminUserFindUnique).toHaveBeenCalledTimes(1);
    });
  });

  // 🧪 [1.19] verify-session 共享 sessionJweCache 鉴权校验
  describe('🧪 [1.19] verify-session 内部端点共享 sessionJweCache', () => {
    it('当 getSessionHelper 已缓存该 Cookie 时，verify-session 零解密直接返回已解密用户', async () => {
      const cookieValue = 'next-auth.session-token=shared_cookie_value';
      mockCookieGetAll.mockReturnValue([
        { name: 'next-auth.session-token', value: 'shared_cookie_value' },
      ]);
      mockGetServerSession.mockResolvedValue({
        user: { id: 'usr_shared', email: 'shared@test.org', name: 'Shared User' },
      });

      // 1. Web 侧先读取触发缓存
      const session = await getSessionHelper();
      expect(session?.user?.id).toBe('usr_shared');

      // 2. Go SSE 内部端点校验带相同 Cookie，直接命中内存缓存
      const req = new NextRequest('http://localhost/api/internal/auth/verify-session', {
        method: 'POST',
        headers: {
          'x-internal-token': 'test-internal-token',
          cookie: cookieValue,
        },
      });

      const res = await postVerifySessionRoute(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        valid: true,
        userId: 'usr_shared',
        email: 'shared@test.org',
        name: 'Shared User',
      });
      // 关键断言：getToken 完全不需要调用，进程内直出
      expect(mockGetToken).not.toHaveBeenCalled();
    });

    it('verify-session 首次解密成功后回写 sessionJweCache', async () => {
      const cookieValue = 'next-auth.session-token=new_sse_cookie';
      mockGetToken.mockResolvedValue({
        sub: 'usr_from_sse',
        email: 'sse@test.org',
        name: 'SSE Client',
      });

      const req = new NextRequest('http://localhost/api/internal/auth/verify-session', {
        method: 'POST',
        headers: {
          'x-internal-token': 'test-internal-token',
          cookie: cookieValue,
        },
      });

      const res = await postVerifySessionRoute(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.userId).toBe('usr_from_sse');
      expect(mockGetToken).toHaveBeenCalledTimes(1);

      // 此时 sessionJweCache 中已被回写
      expect(sessionJweCache.size).toBe(1);

      // 二次调用命中缓存
      const res2 = await postVerifySessionRoute(req);
      expect(res2.status).toBe(200);
      expect(mockGetToken).toHaveBeenCalledTimes(1);
    });
  });

  // 🧪 [8.1.6.2] 公开仓库静态资产与文档内容惰性鉴权 (跳过 session 解密)
  describe('🧪 [8.1.6.2] 公开仓库只读端点 Fast-Path 放行', () => {
    it('公开仓库请求静态资产时彻底跳过 getSessionHelper', async () => {
      // 模拟已缓存的公开仓
      const mockPublicRepo = {
        id: 'repo_public_1',
        owner: 'facebook',
        repo: 'react',
        isPublic: true,
        branch: 'main',
        gitSha: 'abcdef1234567890',
      };
      (cachedDefaultBranchRepository as ReturnType<typeof vi.fn>).mockResolvedValue(mockPublicRepo);

      const req = new Request('http://localhost/api/assets/facebook/react/logo.svg', {
        headers: { 'user-agent': 'Mozilla/5.0' },
      });

      const res = await getAssetsRoute(req, {
        params: Promise.resolve({
          owner: 'facebook',
          repo: 'react',
          path: ['logo.svg'],
        }),
      });

      // 未命中本地文件时因 mock 驱动返回 404，但关键断言：getSessionHelper 绝未被触发
      expect(mockGetServerSession).not.toHaveBeenCalled();
      expect(mockCookieGetAll).not.toHaveBeenCalled();
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it('公开仓库请求文档内容时彻底跳过 getSessionHelper 并通过 docVisibilityFilter 查共享文档', async () => {
      const mockPublicRepo = {
        id: 'repo_public_2',
        owner: 'vercel',
        repo: 'next.js',
        isPublic: true,
        branch: 'canary',
        gitSha: '1122334455667788',
      };
      (cachedDefaultBranchRepository as ReturnType<typeof vi.fn>).mockResolvedValue(mockPublicRepo);
      mockCallSidecar.mockResolvedValue({
        ok: true,
        document: {
          id: 'doc_1',
          content: '# Next.js Documentation\nWelcome to Next.js',
          repositoryId: 'repo_public_2',
        },
      });
      mockDocFindFirst.mockResolvedValue({
        id: 'doc_1',
        content: '# Next.js Documentation\nWelcome to Next.js',
        repositoryId: 'repo_public_2',
      });

      const req = new Request('http://localhost/api/docs-content/vercel/next.js/getting-started', {
        headers: { 'user-agent': 'Mozilla/5.0' },
      });

      const res = await getDocsContentRoute(req, {
        params: Promise.resolve({
          owner: 'vercel',
          repo: 'next.js',
          slug: ['getting-started'],
        }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('# Next.js Documentation');
      // 验证未调用 session 鉴权解密
      expect(mockGetServerSession).not.toHaveBeenCalled();
      expect(mockCookieGetAll).not.toHaveBeenCalled();
    });

    it('仓库不存在时返回 404 且不再发起冗余 DB 兜底查询', async () => {
      (cachedDefaultBranchRepository as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const req = new Request('http://localhost/api/docs-content/nonexistent/repo/readme', {
        headers: { 'user-agent': 'Mozilla/5.0' },
      });

      const res = await getDocsContentRoute(req, {
        params: Promise.resolve({
          owner: 'nonexistent',
          repo: 'repo',
          slug: ['readme'],
        }),
      });

      expect(res.status).toBe(404);
      // 关键断言：不再调用额外的 prisma.repository.findFirst 打扰 DB
      expect(mockRepoFindFirst).not.toHaveBeenCalled();
    });
  });
});
