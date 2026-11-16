import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 发布扇出（Saga 式对账补偿）单测：
 * 失败隔离性（单步抛错不级联）、通知事实戳防重、relay 关闭跳过、落戳失败窄窗口语义。
 * 全部外部依赖（prisma / next:cache / 发奖 / 通知 / 观测）mock。
 */

const prismaMock = vi.hoisted(() => ({
  repository: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  savedRepo: {
    findMany: vi.fn(),
  },
}));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

const callSidecarMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/sidecar-client', () => ({ callSidecar: callSidecarMock }));

const revalidateTagMock = vi.hoisted(() => vi.fn());
vi.mock('next/cache', () => ({ revalidateTag: revalidateTagMock }));

const grantImportRewardMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/credits/import-reward', () => ({ grantImportReward: grantImportRewardMock }));

const invalidateL1Mock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/docs/web-outline-projection', () => ({
  invalidateWebL1Projection: invalidateL1Mock,
}));

const sendNotificationsMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/notifications/notification-sender', () => ({
  sendNotifications: sendNotificationsMock,
}));

const captureErrorMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/observability/errors', () => ({ captureError: captureErrorMock }));

import { publishFanout, sendRelayOpenNotificationsOnce } from '@/lib/review/publish-fanout';
import { PUBLIC_HOME_CACHE_TAG } from '@/lib/home/public-home-data';

const REPO = {
  id: 'repo-1',
  owner: 'octo',
  repo: 'kit',
  relayEnabled: true,
  relayNotifiedAt: null as Date | null,
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.repository.findUnique.mockResolvedValue({ ...REPO });
  callSidecarMock.mockResolvedValue({ ok: true });
  prismaMock.savedRepo.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
  revalidateTagMock.mockReturnValue(undefined);
  invalidateL1Mock.mockReturnValue(undefined);
  grantImportRewardMock.mockResolvedValue(10);
  sendNotificationsMock.mockResolvedValue(undefined);
});

describe('publishFanout（发布扇出统一幂等入口）', () => {
  it('四步全序执行且默认全 ok；通知发送后落事实戳', async () => {
    const result = await publishFanout('repo-1', 'publish');

    expect(result.hasFailures).toBe(false);
    expect(result.steps).toEqual({
      'revalidate-home': 'ok',
      'l1-invalidate': 'ok',
      'import-reward': 'ok',
      'relay-notify': 'ok',
    });
    expect(revalidateTagMock).toHaveBeenCalledTimes(1);
    expect(grantImportRewardMock).toHaveBeenCalledWith('repo-1');
    expect(sendNotificationsMock).toHaveBeenCalledTimes(1);
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/repos/patch',
      { id: 'repo-1', touchRelayNotifiedAt: true },
      expect.objectContaining({ label: 'publish-fanout-relay-notified' })
    );
  });

  it('失败隔离性：revalidate 抛错与发奖抛错不级联——后续步骤照常执行且不发错误给调用方', async () => {
    revalidateTagMock.mockImplementation(() => {
      throw new Error('cache down');
    });
    grantImportRewardMock.mockRejectedValue(new Error('reward down'));

    const result = await publishFanout('repo-1', 'reconcile');

    expect(result.hasFailures).toBe(true);
    expect(result.steps['revalidate-home']).toBe('failed');
    expect(result.steps['import-reward']).toBe('failed');
    // 未失败的步骤不受传染
    expect(result.steps['l1-invalidate']).toBe('ok');
    // 通知仍发送且落戳
    expect(result.steps['relay-notify']).toBe('ok');
    expect(sendNotificationsMock).toHaveBeenCalledTimes(1);
    // 两个失败均进入观测
    expect(captureErrorMock).toHaveBeenCalledTimes(2);
  });

  it('通知事实戳防重：relayNotifiedAt 已置位 → 发送与落戳均为 no-op（skipped）', async () => {
    prismaMock.repository.findUnique.mockResolvedValue({
      ...REPO,
      relayNotifiedAt: new Date('2026-10-01T00:00:00Z'),
    });

    const result = await publishFanout('repo-1', 'retry');

    expect(result.steps['relay-notify']).toBe('skipped');
    expect(sendNotificationsMock).not.toHaveBeenCalled();
    expect(callSidecarMock).not.toHaveBeenCalled();
  });

  it('relay 关闭时通知步骤显式 skipped（override 与仓库事实双通道）', async () => {
    const byOverride = await publishFanout('repo-1', 'publish', { relayEnabledOverride: false });
    expect(byOverride.steps['relay-notify']).toBe('skipped');
    expect(sendNotificationsMock).not.toHaveBeenCalled();

    prismaMock.repository.findUnique.mockResolvedValue({ ...REPO, relayEnabled: false });
    const byFact = await publishFanout('repo-1', 'publish');
    expect(byFact.steps['relay-notify']).toBe('skipped');
  });

  it('仓库不存在 → 整体 skipped、零副作用', async () => {
    prismaMock.repository.findUnique.mockResolvedValue(null);
    const result = await publishFanout('ghost', 'reconcile');
    expect(result.steps).toEqual({ overall: 'skipped' });
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });

  it('已知接缝登记：通知发送成功但落戳失败 → 该步 failed（下次重放会重发一次）', async () => {
    callSidecarMock.mockRejectedValue(new Error('patch down'));
    const result = await sendRelayOpenNotificationsOnce({ ...REPO });
    expect(result).toBe('failed');
    expect(sendNotificationsMock).toHaveBeenCalledTimes(1);
  });

  it('无跟随者：不发送但仍落戳（此后重放永远 no-op，杜绝空转查询）', async () => {
    prismaMock.savedRepo.findMany.mockResolvedValue([]);
    const result = await sendRelayOpenNotificationsOnce({ ...REPO });
    expect(result).toBe('ok');
    expect(sendNotificationsMock).not.toHaveBeenCalled();
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/repos/patch',
      { id: 'repo-1', touchRelayNotifiedAt: true },
      expect.anything()
    );
  });

  it('跨进程通知：当配置了 WEB_INTERNAL_URL 时，publishFanout 自动通知 client 端点失效缓存且归一化末尾斜杠', async () => {
    const originalUrl = process.env.WEB_INTERNAL_URL;
    const originalToken = process.env.INTERNAL_API_TOKEN;
    process.env.WEB_INTERNAL_URL = 'http://127.0.0.1:3000/';
    process.env.INTERNAL_API_TOKEN = 'secret-tok';

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const result = await publishFanout('repo-1', 'admin-approve');
      expect(result.steps['revalidate-home']).toBe('ok');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:3000/api/internal/revalidate',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'x-internal-token': 'secret-tok' }),
          body: JSON.stringify({ tags: [PUBLIC_HOME_CACHE_TAG], repositoryIds: ['repo-1'] }),
        })
      );
    } finally {
      process.env.WEB_INTERNAL_URL = originalUrl;
      process.env.INTERNAL_API_TOKEN = originalToken;
      vi.unstubAllGlobals();
    }
  });
});
