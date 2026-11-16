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

describe('POST /api/user/preferences (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function callSetPreferences(body: Record<string, unknown>) {
    const { POST } = await import('@/app/api/user/preferences/route');
    const req = new NextRequest('http://localhost/api/user/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return POST(req);
  }

  it('未登录时返回 401', async () => {
    getSessionHelperMock.mockResolvedValue(null);
    const res = await callSetPreferences({ fontSize: 'medium' });
    expect(res.status).toBe(401);
  });

  it('正常更新偏好设置并返回 user 对象', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });

    const mockUpdatedUser = {
      id: 'usr-123',
      name: 'Alice',
      preferredLang1: 'zh',
      fontSize: 'large',
      hasPreferencesSet: true,
      disabledMcpRepoIds: ['repo-1'],
    };

    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      user: mockUpdatedUser,
    });

    const res = await callSetPreferences({
      preferredLang1: 'zh',
      fontSize: 'large',
      disabledMcpRepoIds: ['repo-1'],
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      success: true,
      data: { user: mockUpdatedUser },
    });

    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/user/preferences/set',
      {
        userId: 'usr-123',
        preferredLang1: 'zh',
        preferredLang2: null,
        preferredLang3: null,
        industry: null,
        primaryProgLang: null,
        secondaryProgLang: null,
        fontSize: 'large',
        disabledMcpRepoIds: ['repo-1'],
        hasDisabledRepos: true,
      },
      expect.objectContaining({ label: 'user-preferences /v1/user/preferences/set' })
    );
  });

  it('sidecar 返回失败时报 500', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });

    callSidecarMock.mockResolvedValueOnce({
      ok: false,
      error: 'db failure',
    });

    const res = await callSetPreferences({ fontSize: 'small' });
    expect(res.status).toBe(500);
  });
});
