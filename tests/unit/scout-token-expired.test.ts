import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn();
const githubFetchMock = vi.fn();

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: () => getSessionMock(),
}));

vi.mock('@/lib/github/client', () => ({
  githubFetch: (...args: unknown[]) => githubFetchMock(...args),
}));

vi.mock('@/lib/github/token-resolver', () => ({
  resolveGithubToken: vi.fn().mockResolvedValue('gho_token'),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/tiers', () => ({
  checkRepoLimit: vi.fn().mockResolvedValue({ allowed: true }),
  repoLimitErrorResponse: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'u1', tier: null, role: null }),
    },
  },
}));

vi.mock('@/lib/url-inspector', () => ({
  inspectGithubUrl: vi.fn().mockReturnValue({
    isValid: true,
    platform: 'github',
    owner: 'testowner',
    repo: 'testrepo',
    branch: 'main',
    url: 'https://github.com/testowner/testrepo',
  }),
}));

describe('Scout OAuth Token 401 Handling (Item 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({ user: { id: 'u1' } });
  });

  it('returns 401 with GITHUB_TOKEN_EXPIRED code when GitHub API returns 401 in STAGE 1', async () => {
    githubFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    const { POST } = await import('@/app/api/scout/route');
    const req = new NextRequest('http://localhost/api/scout', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://github.com/testowner/testrepo' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe('GITHUB_TOKEN_EXPIRED');
    expect(json.error).toContain('你绑定的 GitHub 授权已失效，请到设置中重新绑定后再导入');
  });
});
