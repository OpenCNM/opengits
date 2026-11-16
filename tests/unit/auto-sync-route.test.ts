import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * auto-sync 维护者开关路由单测：鉴权 / payload 校验 / 维护者判定 / 写库。
 */

const repoFindFirstMock = vi.fn();
const callSidecarMock = vi.fn();
const importRecordFindFirstMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: { findFirst: repoFindFirstMock },
    importRecord: { findFirst: importRecordFindFirstMock },
  },
}));

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

const getSessionHelperMock = vi.fn();
vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: (...args: unknown[]) => getSessionHelperMock(...args),
  getAdminUserHelper: (...args: unknown[]) => getSessionHelperMock(...args),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
  clientIpFromRequest: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/observability/errors', () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

function makeRequest(body: unknown) {
  return { json: async () => body } as any;
}

const PARAMS = Promise.resolve({ owner: 'o', repo: 'r' });

/** 动态 import：避开 vi.mock 提升与顶层 const 初始化的顺序问题 */
async function callPatch(body: unknown) {
  const { PATCH } = await import('@/app/api/repos/[owner]/[repo]/auto-sync/route');
  return PATCH(makeRequest(body), { params: PARAMS });
}

describe('PATCH /api/repos/[owner]/[repo]/auto-sync 维护者开关', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionHelperMock.mockResolvedValue({ user: { id: 'user-1' } });
    repoFindFirstMock.mockResolvedValue({ id: 'repo-1' });
    importRecordFindFirstMock.mockResolvedValue({ userId: 'user-1' });
    callSidecarMock.mockResolvedValue({ ok: true });
  });

  it('未登录 → 401', async () => {
    getSessionHelperMock.mockResolvedValue(null);
    const res = await callPatch({ enabled: true });
    expect(res.status).toBe(401);
  });

  it('非法 payload → 400', async () => {
    const res = await callPatch({ enabled: 'yes' });
    expect(res.status).toBe(400);
    const res2 = await callPatch(null);
    expect(res2.status).toBe(400);
  });

  it('仓库不存在 → 404', async () => {
    repoFindFirstMock.mockResolvedValue(null);
    const res = await callPatch({ enabled: true });
    expect(res.status).toBe(404);
  });

  it('非维护者（最早导入者是他人）→ 403', async () => {
    importRecordFindFirstMock.mockResolvedValue({ userId: 'someone-else' });
    const res = await callPatch({ enabled: true });
    expect(res.status).toBe(403);
    expect(callSidecarMock).not.toHaveBeenCalled();
  });

  it('无任何导入记录 → 403（无维护者即无人可开）', async () => {
    importRecordFindFirstMock.mockResolvedValue(null);
    const res = await callPatch({ enabled: true });
    expect(res.status).toBe(403);
  });

  it('维护者本人 → 写库并返回新状态（统一信封 data 字段）', async () => {
    const res = await callPatch({ enabled: true });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ success: true, data: { autoSyncEnabled: true } });
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/repos/patch',
      {
        id: 'repo-1',
        autoSyncEnabled: true,
      },
      expect.objectContaining({ label: 'auto-sync-repo-patch' })
    );
  });
});
