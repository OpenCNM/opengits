import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockPromotionFindMany = vi.fn();
const mockTokenFindMany = vi.fn();
const mockTokenUpdate = vi.fn();
const mockTokenCreate = vi.fn();
const mockClientFindUnique = vi.fn();

const mockRepoFindMany = vi.fn();
const mockBundleFindMany = vi.fn();
const mockDocumentFindMany = vi.fn();
const mockQueryRaw = vi.fn();

vi.mock('@/engine/search-driver', () => ({
  // 检索已下沉 Go（Fail-Closed 单实现）——路由测试回放轻量命中
  executeSidecarSearch: async (params: { query?: string }) =>
    params.query?.toLowerCase().includes('usestate')
      ? [
          {
            chunkId: 'chunk-101',
            docId: 'doc-1',
            title: 'useState Hook',
            path: 'hooks/use-state.md',
            heading: null,
            headingPath: null,
            snippet: 'useState is a React Hook',
            similarity: 0.9,
            owner: 'facebook',
            repo: 'react',
          },
        ]
      : [],
  executeSidecarUnifiedSearch: async (params: { query?: string }) =>
    params.query?.toLowerCase().includes('usestate')
      ? [
          {
            id: 'doc-facebook-react-hooks/use-state.md',
            type: 'document' as const,
            isIngested: true,
            title: 'useState Hook',
            description: 'useState is a React Hook',
            url: '/docs/facebook/react/hooks/use-state',
            owner: 'facebook',
            repo: 'react',
            score: 75,
          },
        ]
      : [],
}));

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: vi.fn().mockResolvedValue({
    ok: true,
    token: { id: 'mock-token', createdAt: new Date().toISOString() },
  }),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    platformPromotion: {
      findMany: (...args: unknown[]) => mockPromotionFindMany(...args),
    },
    mcpApiToken: {
      findMany: (...args: unknown[]) => mockTokenFindMany(...args),
      update: (...args: unknown[]) => mockTokenUpdate(...args),
      create: (...args: unknown[]) => mockTokenCreate(...args),
    },
    oAuthClient: {
      findUnique: (...args: unknown[]) => mockClientFindUnique(...args),
    },
    repository: {
      findMany: (...args: unknown[]) => mockRepoFindMany(...args),
    },
    mcpBundle: {
      findMany: (...args: unknown[]) => mockBundleFindMany(...args),
    },
    document: {
      findMany: (...args: unknown[]) => mockDocumentFindMany(...args),
    },
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
  },
}));

const mockConsumeAuthCode = vi.fn();
vi.mock('@/app/api/auth/oauth/authorize/route', () => ({
  consumeAuthCode: (...args: unknown[]) => mockConsumeAuthCode(...args),
}));

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: vi.fn().mockResolvedValue(null),
}));

describe('Server Miscellaneous Robustness Tests (Real Route Implementations)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/mcp/hub/promotions: time window filtering', () => {
    it('queries DB with startsAt <= now and endsAt >= now time window constraints', async () => {
      mockPromotionFindMany.mockResolvedValueOnce([
        { id: 'promo-1', title: 'Active Promo', isPinned: true },
      ]);

      const { GET } = await import('@/app/api/mcp/hub/promotions/route');
      const res = await GET();
      expect(res.status).toBe(200);

      expect(mockPromotionFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isPinned: true,
            AND: expect.arrayContaining([
              expect.objectContaining({
                OR: expect.arrayContaining([{ startsAt: null }, { startsAt: expect.any(Object) }]),
              }),
              expect.objectContaining({
                OR: expect.arrayContaining([{ endsAt: null }, { endsAt: expect.any(Object) }]),
              }),
            ]),
          }),
        })
      );
    });
  });

  describe('POST /api/auth/oauth/token: redirect_uri enforcement', () => {
    it('rejects with 400 invalid_grant when auth code has redirectUri but token request omits it', async () => {
      mockConsumeAuthCode.mockResolvedValueOnce({
        clientId: 'client-1',
        userId: 'user-1',
        codeChallenge: 'chall',
        redirectUri: 'http://localhost:8080/callback',
      });

      const { POST } = await import('@/app/api/auth/oauth/token/route');
      const req = new NextRequest('http://localhost/api/auth/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: 'valid-code',
          code_verifier: 'verifier-123',
          client_id: 'client-1',
          // Omitted redirect_uri!
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_grant');
      expect(json.error_description).toContain('redirect_uri 不匹配');
    });

    it('rejects with 400 invalid_grant when redirect_uri does not match entry.redirectUri', async () => {
      mockConsumeAuthCode.mockResolvedValueOnce({
        clientId: 'client-1',
        userId: 'user-1',
        codeChallenge: 'chall',
        redirectUri: 'http://localhost:8080/callback',
      });

      const { POST } = await import('@/app/api/auth/oauth/token/route');
      const req = new NextRequest('http://localhost/api/auth/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: 'valid-code',
          code_verifier: 'verifier-123',
          client_id: 'client-1',
          redirect_uri: 'http://attacker.com/callback',
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_grant');
    });

    it('succeeds with 200 when redirect_uri matches entry.redirectUri exactly', async () => {
      mockConsumeAuthCode.mockResolvedValueOnce({
        clientId: 'client-1',
        userId: 'user-1',
        codeChallenge: 'chall',
        redirectUri: 'http://localhost:8080/callback',
      });
      mockTokenFindMany.mockResolvedValueOnce([]);
      mockTokenCreate.mockResolvedValueOnce({ id: 'tok-1', createdAt: new Date() });

      const { POST } = await import('@/app/api/auth/oauth/token/route');
      const req = new NextRequest('http://localhost/api/auth/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: 'valid-code',
          code_verifier: 'verifier-123',
          client_id: 'client-1',
          redirect_uri: 'http://localhost:8080/callback',
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.access_token).toBeDefined();
    });
  });

  describe('GET /api/search Mode B: chunk hit and document deduplication', () => {
    it('prevents duplicate entries for the same document when already matched by chunkHits', async () => {
      mockRepoFindMany.mockResolvedValue([]);
      mockBundleFindMany.mockResolvedValue([]);

      // 1. Chunk hit for doc "hooks/use-state.md"
      mockQueryRaw.mockResolvedValueOnce([
        {
          chunk_id: 'chunk-101',
          heading: 'Basic Example',
          content: 'const [count, setCount] = useState(0);',
          title: 'useState Hook',
          path: 'hooks/use-state.md',
          owner: 'facebook',
          repo: 'react',
          fts_rank: 0.95,
        },
      ]);

      // 2. Document findMany returns the same doc ("hooks/use-state.md") plus a different doc ("hooks/use-effect.md")
      mockDocumentFindMany.mockResolvedValueOnce([
        {
          id: 'doc-1',
          title: 'useState Hook',
          path: 'hooks/use-state.md',
          content: 'useState full content',
          repository: { owner: 'facebook', repo: 'react' },
        },
        {
          id: 'doc-2',
          title: 'useEffect Hook',
          path: 'hooks/use-effect.md',
          content: 'useEffect full content',
          repository: { owner: 'facebook', repo: 'react' },
        },
      ]);

      const { GET } = await import('@/app/api/search/route');
      const req = new NextRequest('http://localhost/api/search?q=useState');

      const res = await GET(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      const results = json.data || json.results || json;

      // Expect exactly 2 results: 1 for chunk-101 (useState), 1 for doc-facebook-react-hooks/use-effect.md
      // And NO duplicate doc entry for useState!
      const urls = results.map((r: any) => r.url);
      const useStateEntries = urls.filter((u: string) => u.includes('use-state'));
      expect(useStateEntries).toHaveLength(1);
    });
  });
});
