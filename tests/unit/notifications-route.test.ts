import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * 站内通知 API 单测：分页 envelope / 未读数 / 已读标记 / 鉴权。
 * 路由已经由 defineRoute 统一封装（auth/schema/envelope），鉴权依赖 auth-helper mock。
 */

const findManyMock = vi.fn();
const countMock = vi.fn();
const updateManyMock = vi.fn();
const callSidecarMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    notification: {
      findMany: findManyMock,
      count: countMock,
      updateMany: updateManyMock,
    },
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

vi.mock('@/lib/observability/errors', () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

async function callGet(search = '') {
  const { GET } = await import('@/app/api/notifications/route');
  const request = new NextRequest(`http://localhost/api/notifications${search}`);
  return GET(request, { params: Promise.resolve({}) });
}

async function callPatch(body: unknown) {
  const { PATCH } = await import('@/app/api/notifications/read/route');
  const request = new NextRequest('http://localhost/api/notifications/read', {
    method: 'PATCH',
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : {}),
  });
  return PATCH(request, { params: Promise.resolve({}) });
}

async function callDelete() {
  const { DELETE } = await import('@/app/api/notifications/route');
  const request = new NextRequest('http://localhost/api/notifications', {
    method: 'DELETE',
  });
  return DELETE(request, { params: Promise.resolve({}) });
}

describe('GET /api/notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionHelperMock.mockResolvedValue({ user: { id: 'user-1' } });
    findManyMock.mockResolvedValue([]);
    countMock.mockResolvedValue(0);
  });

  it('未登录 → 401 失败信封', async () => {
    getSessionHelperMock.mockResolvedValue(null);
    const res = await callGet();
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe('UNAUTHORIZED');
  });

  it('分页 envelope + 未读数（统一信封 data 字段）', async () => {
    callSidecarMock.mockResolvedValue({
      ok: true,
      items: [{ id: 'n1', title: 't', readAt: null }],
      total: 31,
      unreadCount: 4,
    });

    const res = await callGet('?page=2&pageSize=15');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.items).toHaveLength(1);
    expect(json.data.pagination).toEqual({ total: 31, totalPages: 3, page: 2, pageSize: 15 });
    expect(json.data.unreadCount).toBe(4);
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/notifications/list',
      { userId: 'user-1', page: 2, pageSize: 15 },
      expect.anything()
    );
  });
});

describe('PATCH /api/notifications/read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionHelperMock.mockResolvedValue({ user: { id: 'user-1' } });
    callSidecarMock.mockResolvedValue({ ok: true, updated: 2 });
  });

  it('未登录 → 401', async () => {
    getSessionHelperMock.mockResolvedValue(null);
    const res = await callPatch({ all: true });
    expect(res.status).toBe(401);
  });

  it('空 payload → 400（路由级 refine：ids 与 all 至少其一）', async () => {
    expect((await callPatch(null)).status).toBe(400);
    expect((await callPatch({})).status).toBe(400);
  });

  it('按 id 列表标记（限定本人，data 信封）', async () => {
    const res = await callPatch({ ids: ['n1', 'n2'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { updated: 2 } });
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/notifications/read',
      { userId: 'user-1', ids: ['n1', 'n2'], all: false },
      expect.objectContaining({ label: 'notifications-read /v1/notifications/read' })
    );
  });

  it('all=true 仅更新未读行', async () => {
    const res = await callPatch({ all: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { updated: 2 } });
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/notifications/read',
      { userId: 'user-1', ids: [], all: true },
      expect.objectContaining({ label: 'notifications-read /v1/notifications/read' })
    );
  });
});

describe('DELETE /api/notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionHelperMock.mockResolvedValue({ user: { id: 'user-1' } });
    callSidecarMock.mockResolvedValue({ ok: true, deleted: 5 });
  });

  it('未登录 → 401', async () => {
    getSessionHelperMock.mockResolvedValue(null);
    const res = await callDelete();
    expect(res.status).toBe(401);
  });

  it('清空本人全部通知（data 信封）', async () => {
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { deleted: 5 } });
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/notifications/clear',
      { userId: 'user-1' },
      expect.objectContaining({ label: 'notifications-clear /v1/notifications/clear' })
    );
  });
});

describe('NotificationItemSchema & NOTIFICATION_TYPES', () => {
  it('验证受支持类型与失败闭环字段均能通过解析', async () => {
    const { NotificationItemSchema, NOTIFICATION_TYPES } = await import('@/lib/schemas/notification');
    expect(NOTIFICATION_TYPES.TRANSCRIPTION_FAILED).toBe('transcription_failed');
    expect(NOTIFICATION_TYPES.TUTORIAL_REJECTED).toBe('tutorial_rejected');

    const item = NotificationItemSchema.parse({
      id: 'notif-1',
      type: NOTIFICATION_TYPES.TRANSCRIPTION_FAILED,
      title: '教程转录中断',
      body: 'owner/repo · 遇到异常已暂停',
      payload: { owner: 'owner', repo: 'repo', error: 'LLM context timeout' },
      readAt: null,
      createdAt: new Date(),
    });
    expect(item.type).toBe('transcription_failed');
  });
});

