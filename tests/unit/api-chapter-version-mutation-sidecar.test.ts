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

describe('PATCH & DELETE /api/chapter-versions/[id] (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionHelperMock.mockResolvedValue({ user: { id: 'usr-1' } });
  });

  async function callPatch(id: string) {
    const { PATCH } = await import('@/app/api/chapter-versions/[id]/route');
    const req = new NextRequest(`http://localhost/api/chapter-versions/${id}`, { method: 'PATCH' });
    return PATCH(req, { params: Promise.resolve({ id }) });
  }

  async function callDelete(id: string) {
    const { DELETE } = await import('@/app/api/chapter-versions/[id]/route');
    const req = new NextRequest(`http://localhost/api/chapter-versions/${id}`, { method: 'DELETE' });
    return DELETE(req, { params: Promise.resolve({ id }) });
  }

  describe('PATCH (Publish)', () => {
    it('未登录时返回 401', async () => {
      getSessionHelperMock.mockResolvedValue(null);
      const res = await callPatch('v-1');
      expect(res.status).toBe(401);
    });

    it('版本不存在时返回 404', async () => {
      callSidecarMock.mockResolvedValueOnce({
        ok: false,
        notFound: true,
      });

      const res = await callPatch('v-nonexistent');
      expect(res.status).toBe(404);
    });

    it('正常公开私有版本', async () => {
      callSidecarMock.mockResolvedValueOnce({
        ok: true,
        base: 0,
      });

      const res = await callPatch('v-1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        success: true,
        data: { baseGranted: 0 },
      });

      expect(callSidecarMock).toHaveBeenCalledWith(
        '/v1/chapter-versions/publish',
        { versionId: 'v-1', userId: 'usr-1' },
        expect.anything()
      );
    });
  });

  describe('DELETE', () => {
    it('未登录时返回 401', async () => {
      getSessionHelperMock.mockResolvedValue(null);
      const res = await callDelete('v-1');
      expect(res.status).toBe(401);
    });

    it('版本不存在时返回 404', async () => {
      callSidecarMock.mockResolvedValueOnce({
        ok: false,
        notFound: true,
      });

      const res = await callDelete('v-nonexistent');
      expect(res.status).toBe(404);
    });

    it('非作者删除时返回 404 (防嗅探隐匿)', async () => {
      callSidecarMock.mockResolvedValueOnce({
        ok: false,
        forbidden: true,
      });

      const res = await callDelete('v-other');
      expect(res.status).toBe(404);
    });

    it('公开版本不可删除时返回 403', async () => {
      callSidecarMock.mockResolvedValueOnce({
        ok: false,
        invalidState: true,
      });

      const res = await callDelete('v-public');
      expect(res.status).toBe(403);
    });

    it('正常删除私有草稿版本', async () => {
      callSidecarMock.mockResolvedValueOnce({
        ok: true,
      });

      const res = await callDelete('v-1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        success: true,
        data: {},
      });

      expect(callSidecarMock).toHaveBeenCalledWith(
        '/v1/chapter-versions/delete',
        { versionId: 'v-1', userId: 'usr-1' },
        expect.anything()
      );
    });
  });
});
