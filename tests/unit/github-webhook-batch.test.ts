import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';

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

describe('GitHub Webhook Batch & Case-Insensitive Matching', () => {
  const secret = 'test-secret';

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_WEBHOOK_SECRET = secret;
  });

  it('POST /api/webhooks/github: 大小写不敏感匹配并将更新操作合并为 $transaction 批处理', async () => {
    const payload = {
      ref: 'refs/heads/main',
      after: '1234567890123456789012345678901234567890',
      repository: { full_name: 'FaceBook/React', name: 'React', owner: { login: 'FaceBook' } },
    };
    const bodyStr = JSON.stringify(payload);
    const signature = 'sha256=' + createHmac('sha256', secret).update(bodyStr).digest('hex');

    findManyMock.mockResolvedValueOnce([
      { id: 'repo_1', gitSha: '0000000000000000000000000000000000000000' }, // needs update
      { id: 'repo_2', gitSha: '1234567890123456789012345678901234567890' }, // already same
    ]);
    callSidecarMock.mockResolvedValue({ ok: true, count: 1 });

    const { POST } = await import('@/app/api/webhooks/github/route');
    const req = new NextRequest('http://localhost:3000/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-hub-signature-256': signature,
        'x-github-event': 'push',
        'x-github-delivery': 'del_123',
        'Content-Type': 'application/json',
      },
      body: bodyStr,
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          owner: { equals: 'facebook', mode: 'insensitive' },
          repo: { equals: 'react', mode: 'insensitive' },
          branch: 'main',
        },
      })
    );

    expect(callSidecarMock).toHaveBeenCalledTimes(2);
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/repos/batch-patch',
      expect.objectContaining({ ids: ['repo_1'], hasUpstreamUpdate: true }),
      expect.anything()
    );
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/repos/batch-patch',
      expect.objectContaining({ ids: ['repo_2'], hasUpstreamUpdate: false }),
      expect.anything()
    );
  });
});