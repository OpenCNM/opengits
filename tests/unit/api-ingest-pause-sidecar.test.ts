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

vi.mock('@/lib/observability/errors', () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

// 需真实 PostgreSQL：鉴权/转发组经 resolveRepository 走真实 prisma.repository.findFirst
// 仓库解析（prisma 连接串读 DATABASE_URL）。门控沿用 go-sidecar job 同款惯例：
// 仅认显式注入的 WORKER_TEST_DATABASE_URL（未注入时该组自动 skip）——
// 不直接认 DATABASE_URL，因其会被 ai.ts 顶部的 dotenv.config(override) 从本地
// .env 静默注入（本机凭据未必可用，门形同虚设）。
// body 校验（400 短路）在触达 DB 前返回，不依赖 DB，无条件执行。
const HAS_TEST_DB = Boolean(process.env.WORKER_TEST_DATABASE_URL);

describe('POST /api/ingest/[owner]/[repo]/pause (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionHelperMock.mockResolvedValue({ user: { id: 'user-1' } });
    callSidecarMock.mockResolvedValue({ ok: true, paused: true });
  });

  async function callPause(params: { owner: string; repo: string }, body: unknown, search = '') {
    const { POST } = await import('@/app/api/ingest/[owner]/[repo]/pause/route');
    const request = new NextRequest(`http://localhost/api/ingest/${params.owner}/${params.repo}/pause${search}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
    return POST(request, { params: Promise.resolve(params) });
  }

  it('无效 body (缺少 paused) 返回 400', async () => {
    const res = await callPause({ owner: 'facebook', repo: 'react' }, {});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  // 以下用例经 resolveRepository 查询真实 PostgreSQL，未显式注入测试库时整组 skip
  describe.skipIf(!HAS_TEST_DB)('鉴权与转发（依赖 resolveRepository → Prisma 查询）', () => {
    it('有效调用转发至 sidecar /v1/repos/pause 并返回 paused 状态', async () => {
      const res = await callPause({ owner: 'facebook', repo: 'react' }, { paused: true });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toEqual({ paused: true });
      expect(callSidecarMock).toHaveBeenCalledWith(
        '/v1/repos/pause',
        expect.objectContaining({
          owner: 'facebook',
          repo: 'react',
          branch: 'main',
          userId: 'user-1',
          paused: true,
        }),
        expect.objectContaining({ label: 'repos-pause /v1/repos/pause' })
      );
    });

    it('仓库不存在时返回 404', async () => {
      callSidecarMock.mockResolvedValue({ ok: false, notFound: true });
      const res = await callPause({ owner: 'facebook', repo: 'unknown' }, { paused: false });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe('REPOSITORY_NOT_FOUND');
    });

    it('无权限访问时返回 403', async () => {
      callSidecarMock.mockResolvedValue({ ok: false, forbidden: true });
      const res = await callPause({ owner: 'private-org', repo: 'private-repo' }, { paused: true });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe('FORBIDDEN');
    });
  });
});
