import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const callSidecarMock = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

const getSessionHelperMock = vi.fn();
vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: (...args: unknown[]) => getSessionHelperMock(...args),
  getAdminUserHelper: (...args: unknown[]) => getSessionHelperMock(...args),
}));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));

const getDynamicCreditsConfigMock = vi.fn();
vi.mock('@/lib/credits-config', () => ({
  getDynamicCreditsConfig: (...args: unknown[]) => getDynamicCreditsConfigMock(...args),
}));

const chargeShelfFeeAndSaveMock = vi.fn();
const isShelfFeeExemptMock = vi.fn();
vi.mock('@/lib/credits/shelf-fee', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/credits/shelf-fee')>();
  return {
    ...actual,
    chargeShelfFeeAndSave: (...args: unknown[]) => chargeShelfFeeAndSaveMock(...args),
    isShelfFeeExempt: (...args: unknown[]) => isShelfFeeExemptMock(...args),
  };
});

const mcpBundleFindManyMock = vi.fn();
const userFindUniqueMock = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: {
    mcpBundle: { findMany: (...args: unknown[]) => mcpBundleFindManyMock(...args) },
    user: { findUnique: (...args: unknown[]) => userFindUniqueMock(...args) },
  },
}));

describe('Starter Packs API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionHelperMock.mockResolvedValue({ user: { id: 'usr-1' } });
    checkRateLimitMock.mockResolvedValue(true);
    getDynamicCreditsConfigMock.mockResolvedValue({ shelfFeeMultiplier: 1 });
    isShelfFeeExemptMock.mockResolvedValue(false);
    chargeShelfFeeAndSaveMock.mockResolvedValue({
      ok: true,
      fee: 0,
      signupGift: 0,
      alreadySaved: false,
    });
    callSidecarMock.mockResolvedValue({ ok: true });
    userFindUniqueMock.mockResolvedValue({
      role: 'USER',
      hasPreferencesSet: false,
      savedRepos: [],
    });
  });

  it('GET /api/starter-packs 仅返回免费公开教程并剔除纯付费空包', async () => {
    mcpBundleFindManyMock.mockResolvedValueOnce([
      {
        id: 'b-web',
        slug: 'web-starter',
        title: 'Web 开发',
        description: 'Web',
        badge: '❖ 官方精选',
        starterCategory: 'Web 开发',
        repositories: [
          {
            id: 'r-free',
            owner: 'vercel',
            repo: 'next.js',
            branch: 'main',
            category: 'Web',
            shelfFeeOverride: 0,
            transcriptionCreditsEarned: 10,
            _count: { documents: 12 },
          },
          {
            id: 'r-paid',
            owner: 'paid',
            repo: 'book',
            branch: 'main',
            category: 'Web',
            shelfFeeOverride: null,
            transcriptionCreditsEarned: 15,
            _count: { documents: 10 },
          },
        ],
      },
      {
        id: 'b-paid-only',
        slug: 'paid-only',
        title: '纯付费包',
        description: null,
        badge: null,
        starterCategory: 'Paid',
        repositories: [
          {
            id: 'r-paid-2',
            owner: 'paid',
            repo: 'book2',
            branch: 'main',
            category: 'Web',
            shelfFeeOverride: null,
            transcriptionCreditsEarned: 8,
            _count: { documents: 8 },
          },
        ],
      },
    ]);

    const { GET } = await import('@/app/api/starter-packs/route');
    const req = new NextRequest('http://localhost/api/starter-packs', { method: 'GET' });
    const res = await GET(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.packs).toHaveLength(1);
    expect(json.data.packs[0].id).toBe('b-web');
    expect(json.data.packs[0].repos.map((r: { id: string }) => r.id)).toEqual(['r-free']);
  });

  it('POST /api/user/starter-packs/apply 未登录返回 401', async () => {
    getSessionHelperMock.mockResolvedValue(null);
    const { POST } = await import('@/app/api/user/starter-packs/apply/route');
    const req = new NextRequest('http://localhost/api/user/starter-packs/apply', {
      method: 'POST',
      body: JSON.stringify({ skip: true }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('POST /api/user/starter-packs/apply 支持 skip 跳过并置位偏好', async () => {
    const { POST } = await import('@/app/api/user/starter-packs/apply/route');
    const req = new NextRequest('http://localhost/api/user/starter-packs/apply', {
      method: 'POST',
      body: JSON.stringify({ skip: true }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.skipped).toBe(true);
    expect(chargeShelfFeeAndSaveMock).not.toHaveBeenCalled();
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/user/preferences/set',
      { userId: 'usr-1' },
      expect.any(Object)
    );
  });

  it('POST /api/user/starter-packs/apply 跨包去重且严格拦截非免费教程', async () => {
    mcpBundleFindManyMock.mockResolvedValueOnce([
      {
        id: 'b-1',
        title: 'Web 开发',
        starterCategory: 'Web 开发',
        repositories: [
          {
            id: 'r-free',
            shelfFeeOverride: 0,
            transcriptionCreditsEarned: 5,
            _count: { documents: 10 },
          },
          {
            id: 'r-paid',
            shelfFeeOverride: null,
            transcriptionCreditsEarned: 10,
            _count: { documents: 10 },
          },
        ],
      },
      {
        id: 'b-2',
        title: '全栈进阶',
        starterCategory: '全栈',
        repositories: [
          {
            id: 'r-free',
            shelfFeeOverride: 0,
            transcriptionCreditsEarned: 5,
            _count: { documents: 10 },
          },
        ],
      },
    ]);

    const { POST } = await import('@/app/api/user/starter-packs/apply/route');
    const req = new NextRequest('http://localhost/api/user/starter-packs/apply', {
      method: 'POST',
      body: JSON.stringify({ bundleIds: ['b-1', 'b-2'] }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.addedRepoIds).toEqual(['r-free']);
    expect(chargeShelfFeeAndSaveMock).toHaveBeenCalledTimes(1);
    expect(chargeShelfFeeAndSaveMock).toHaveBeenCalledWith('usr-1', 'r-free', true);
  });
});
