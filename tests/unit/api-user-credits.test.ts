import { test, expect, describe, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn();
const getDailyCreditsUsageMock = vi.fn();

const getDynamicCreditsConfigMock = vi.fn();

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: () => getSessionMock(),
}));

vi.mock('@/lib/credits-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/credits-config')>();
  return {
    ...actual,
    getDynamicCreditsConfig: () => getDynamicCreditsConfigMock(),
  };
});

vi.mock('@/lib/credits-ledger', () => ({
  getDailyCreditsUsage: (...args: unknown[]) => getDailyCreditsUsageMock(...args),
  getResetWindowBounds: (date = new Date(), intervalHours = 24) => ({
    start: new Date('2026-08-26T00:00:00.000Z'),
    end: new Date('2026-08-26T23:59:59.999Z'),
    nextResetAt: new Date('2026-08-27T00:00:00.000Z'),
  }),
}));

vi.mock('@/lib/observability/errors', () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

async function callGet() {
  const { GET } = await import('@/app/api/user/credits/route');
  return GET(new NextRequest('http://localhost/api/user/credits'), { params: Promise.resolve({}) });
}

describe('GET /api/user/credits API 单测', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDynamicCreditsConfigMock.mockResolvedValue({
      defaultDailyCredits: 1000,
      resetIntervalHours: 24,
      maxCreditsPerImport: 300,
    });
  });

  test('未登录用户：200 信封返回默认 1,000 积分与未登录状态', async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await callGet();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.loggedIn).toBe(false);
    expect(json.data.dailyLimit).toBe(1000);
    expect(json.data.availableCredits).toBe(1000);
    expect(json.data.usedCredits).toBe(0);
    expect(json.data.frozenCredits).toBe(0);
    expect(json.data.maxPerImport).toBe(300);
  });

  test('登录用户：返回当日真实积分账本数据', async () => {
    getSessionMock.mockResolvedValue({ user: { id: 'u123' } });
    getDailyCreditsUsageMock.mockResolvedValue({
      dailyLimit: 1000,
      usedCredits: 120,
      frozenCredits: 50,
      availableCredits: 830,
      isUnlimited: false,
      maxPerImport: 300,
    });

    const res = await callGet();
    const json = await res.json();

    expect(json.data.loggedIn).toBe(true);
    expect(json.data.dailyLimit).toBe(1000);
    expect(json.data.usedCredits).toBe(120);
    expect(json.data.frozenCredits).toBe(50);
    expect(json.data.availableCredits).toBe(830);
    expect(json.data.isUnlimited).toBe(false);
    expect(getDailyCreditsUsageMock).toHaveBeenCalledWith('u123');
  });

  test('企业/管理用户：返回无限算力', async () => {
    getSessionMock.mockResolvedValue({ user: { id: 'admin_u1' } });
    getDailyCreditsUsageMock.mockResolvedValue({
      dailyLimit: 0,
      usedCredits: 0,
      frozenCredits: 0,
      availableCredits: 999999,
      isUnlimited: true,
      maxPerImport: 0,
    });

    const res = await callGet();
    const json = await res.json();

    expect(json.data.loggedIn).toBe(true);
    expect(json.data.isUnlimited).toBe(true);
  });

});
