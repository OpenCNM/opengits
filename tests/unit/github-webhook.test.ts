import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

/**
 * push webhook 单测：HMAC 签名校验（含伪造拒绝）/ secret 未配置停用 /
 * ping 握手 / push 红点与 ETag 失效 / delivery 幂等去重。
 */

const findManyMock = vi.fn();
const callSidecarMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}));

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

process.env.GITHUB_WEBHOOK_SECRET = 'whsec_test';

const SECRET = 'whsec_test';
function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

async function post(body: string, headers: Record<string, string>) {
  const m = await import('@/app/api/webhooks/github/route');
  const { NextRequest } = await import('next/server');
  return m.POST(
    new NextRequest('http://local/api/webhooks/github', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    }),
  );
}

describe('github push webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findManyMock.mockResolvedValue([]);
    callSidecarMock.mockResolvedValue({ ok: true, count: 1 });
  });
  afterEach(() => {
    vi.resetModules(); // 重置 delivery LRU 进程态
  });

  it('secret 未配置 → 503 停用', async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const res = await post('{}', {});
    expect(res.status).toBe(503);
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  });

  // 🧪 [5.1.2.1 · CRITICAL] 伪造 GitHub Webhook 请求触发非法更新与算力耗尽
  it('5.1.2.1 签名缺失/伪造 → 401；合法签名通过', async () => {
    const body = JSON.stringify({ ref: 'refs/heads/main' });

    const bad = await post(body, { 'x-hub-signature-256': 'sha256=deadbeef', 'x-github-event': 'push' });
    expect(bad.status).toBe(401);

    const good = await post(body, {
      'x-hub-signature-256': sign(body),
      'x-github-event': 'push',
      'x-github-delivery': `d-${Date.now()}-a`,
    });
    expect(good.status).toBe(200);
  });

  it('ping 事件握手返回 pong，不触库', async () => {
    const body = JSON.stringify({ zen: 'ok' });
    const res = await post(body, {
      'x-hub-signature-256': sign(body),
      'x-github-event': 'ping',
      'x-github-delivery': `d-ping`,
    });
    const json = await res.json();
    expect(json.pong).toBe(true);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  // 🧪 [5.1.3.1 · HIGH] 分支大小写不一致或非默认分支触发更新导致版本错乱
  it('5.1.3.1 push：同 owner/repo/branch 全讲法行置红点 + ETag 失效 (normalizeBranch 剥离 refs/heads/)', async () => {
    const sha = 'f'.repeat(40);
    findManyMock.mockResolvedValue([
      { id: 'r1', gitSha: 'a'.repeat(40) },
      { id: 'r2', gitSha: null }, // 从未导入内容 → 不置红点
    ]);
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      after: sha,
      repository: { full_name: 'Acme/Docs', name: 'Docs' },
    });
    const res = await post(body, {
      'x-hub-signature-256': sign(body),
      'x-github-event': 'push',
      'x-github-delivery': `d-push-1`,
    });

    expect(callSidecarMock).toHaveBeenCalledTimes(2);
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/repos/batch-patch',
      expect.objectContaining({
        ids: ['r1'],
        hasUpstreamUpdate: true,
        clearUpstreamEtag: true,
      }),
      expect.anything()
    );
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/repos/batch-patch',
      expect.objectContaining({
        ids: ['r2'],
        hasUpstreamUpdate: false,
        clearUpstreamEtag: true,
      }),
      expect.anything()
    );
    void res;
  });

  it('delivery 重复投递 → duplicate 短路不重复写库', async () => {
    vi.resetModules();
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    const sha = 'e'.repeat(40);
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      after: sha,
      repository: { full_name: 'acme/docs2' },
    });
    const headers = {
      'x-hub-signature-256': sign(body),
      'x-github-event': 'push',
      'x-github-delivery': 'dup-delivery-id',
    };

    await post(body, headers);
    const res2 = await post(body, headers);
    const json = await res2.json();
    expect(json.duplicate).toBe(true);
    expect(findManyMock).toHaveBeenCalledTimes(1); // 第二次未触库
  });
});
