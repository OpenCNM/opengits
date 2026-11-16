import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const importRecordFindManyMock = vi.fn();
// 2026-10-13 性能修复：最早导入记录（维护者判定）由 findMany 全量行改为
// DISTINCT ON 原生 SQL 下推——mock 面同步迁移（返回形状不变：{repositoryId, userId}[]）
const rawQueryMock = vi.fn();
const documentFindManyMock = vi.fn();
const userFindUniqueMock = vi.fn();
const userFindManyMock = vi.fn();
const repositoryFindManyMock = vi.fn();
const chapterUpdateJobFindManyMock = vi.fn();
const getSessionHelperMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => rawQueryMock(...args),
    importRecord: {
      findMany: (...args: unknown[]) => importRecordFindManyMock(...args),
    },
    document: {
      findMany: (...args: unknown[]) => documentFindManyMock(...args),
    },
    user: {
      findUnique: (...args: unknown[]) => userFindUniqueMock(...args),
      findMany: (...args: unknown[]) => userFindManyMock(...args),
    },
    repository: {
      findMany: (...args: unknown[]) => repositoryFindManyMock(...args),
    },
    chapterUpdateJob: {
      findMany: (...args: unknown[]) => chapterUpdateJobFindManyMock(...args),
    },
  },
}));

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: () => getSessionHelperMock(),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
  clientIpFromRequest: vi.fn(() => '10.0.0.1'),
}));

vi.mock('@/lib/observability/errors', () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

async function callGet() {
  const { GET } = await import('@/app/api/user/publications/route');
  return GET(new NextRequest('http://localhost/api/user/publications'), {
    params: Promise.resolve({}),
  });
}

describe('GET /api/user/publications 创作者发布管理接口', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'user-creator', email: 'creator@example.com' },
    });
    userFindUniqueMock.mockResolvedValue({ role: 'USER' });
    userFindManyMock.mockResolvedValue([]);
    importRecordFindManyMock.mockResolvedValue([]);
    rawQueryMock.mockResolvedValue([]);
    documentFindManyMock.mockResolvedValue([]);
    repositoryFindManyMock.mockResolvedValue([]);
    chapterUpdateJobFindManyMock.mockResolvedValue([]);
  });

  it('未登录用户访问：返回 401 UNAUTHORIZED', async () => {
    getSessionHelperMock.mockResolvedValue(null);

    const res = await callGet();
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.success).toBe(false);
  });

  it('用户没有任何导入或拥有教程：返回 200 且 publications 为空数组', async () => {
    importRecordFindManyMock.mockResolvedValueOnce([]);
    documentFindManyMock.mockResolvedValueOnce([]);

    const res = await callGet();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.publications).toEqual([]);
  });

  it('正确投影发布状态、转录就绪度、驳回理由与激励积分', async () => {
    // 用户有 3 个仓库导入记录
    importRecordFindManyMock.mockImplementation((args: any) => {
      // 首次为查询用户自己的仓库 ID
      if (args?.where?.userId) {
        return Promise.resolve([
          { repositoryId: 'repo-pub' },
          { repositoryId: 'repo-pending' },
          { repositoryId: 'repo-rejected' },
        ]);
      }
      return Promise.resolve([]);
    });
    // 最早导入记录（维护者判定）走 DISTINCT ON 原生 SQL
    rawQueryMock.mockResolvedValue([
      { repositoryId: 'repo-pub', userId: 'user-creator' },
      { repositoryId: 'repo-pending', userId: 'user-creator' },
      { repositoryId: 'repo-rejected', userId: 'user-creator' },
    ]);

    documentFindManyMock.mockImplementation((args: any) => {
      // 首次为查询用户拥有的私有文档所属仓库 ID
      if (args?.where?.ownerUserId) {
        return Promise.resolve([]);
      }
      // 第二次为查询各仓文档列表
      if (args?.where?.repositoryId) {
        return Promise.resolve([
          // repo-pub: 2 processed
          { repositoryId: 'repo-pub', path: 'ch1.md', status: 'PROCESSED', ownerUserId: null },
          { repositoryId: 'repo-pub', path: 'ch2.md', status: 'PROCESSED', ownerUserId: null },
          // repo-pending: 1 processed, 1 unprocessed
          { repositoryId: 'repo-pending', path: 'ch1.md', status: 'PROCESSED', ownerUserId: null },
          { repositoryId: 'repo-pending', path: 'ch2.md', status: 'UNPROCESSED', ownerUserId: null },
          // repo-rejected: 1 unprocessed
          { repositoryId: 'repo-rejected', path: 'ch1.md', status: 'UNPROCESSED', ownerUserId: null },
        ]);
      }
      return Promise.resolve([]);
    });

    repositoryFindManyMock.mockResolvedValue([
      {
        id: 'repo-pub',
        owner: 'org',
        repo: 'published-tutorial',
        branch: 'master',
        edition: '',
        isPublic: true,
        publishedAt: new Date('2026-09-01T10:00:00Z'),
        reviewStatus: 'APPROVED',
        rejectionReason: null,
        transcriptionCreditsEarned: 150,
        relayEnabled: false,
        repoProfile: { editionLabel: '官方正典' },
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-09-01T10:00:00Z'),
      },
      {
        id: 'repo-pending',
        owner: 'org',
        repo: 'pending-tutorial',
        branch: 'master',
        edition: 'ed_deep',
        isPublic: false,
        publishedAt: null,
        reviewStatus: 'PENDING',
        rejectionReason: null,
        transcriptionCreditsEarned: 0,
        relayEnabled: true,
        repoProfile: { editionLabel: '深度解析' },
        createdAt: new Date('2026-09-10T00:00:00Z'),
        updatedAt: new Date('2026-09-11T00:00:00Z'),
      },
      {
        id: 'repo-rejected',
        owner: 'org',
        repo: 'rejected-tutorial',
        branch: 'master',
        edition: '',
        isPublic: false,
        publishedAt: null,
        reviewStatus: 'REJECTED',
        rejectionReason: '缺少开源协议合规说明',
        transcriptionCreditsEarned: 0,
        relayEnabled: false,
        repoProfile: null,
        createdAt: new Date('2026-09-12T00:00:00Z'),
        updatedAt: new Date('2026-09-13T00:00:00Z'),
      },
    ]);

    const res = await callGet();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.publications).toHaveLength(3);

    // 验证 repo-pub
    const pub = json.data.publications.find((p: any) => p.id === 'repo-pub');
    expect(pub).toBeDefined();
    expect(pub.isPublic).toBe(true);
    expect(pub.reviewStatus).toBe('APPROVED');
    expect(pub.transcriptionCreditsEarned).toBe(150);
    expect(pub.chapterCount).toBe(2);
    expect(pub.processedDocsCount).toBe(2);
    expect(pub.unprocessedCount).toBe(0);
    expect(pub.isMaintainer).toBe(true);
    expect(pub.editionLabel).toBe('官方正典');
    expect(pub.docUrl).toBe('/docs/org/published-tutorial');

    // 验证 repo-pending
    const pending = json.data.publications.find((p: any) => p.id === 'repo-pending');
    expect(pending).toBeDefined();
    expect(pending.isPublic).toBe(false);
    expect(pending.reviewStatus).toBe('PENDING');
    expect(pending.relayEnabled).toBe(true);
    expect(pending.chapterCount).toBe(2);
    expect(pending.processedDocsCount).toBe(1);
    expect(pending.unprocessedCount).toBe(1);
    expect(pending.docUrl).toBe('/docs/org/pending-tutorial?edition=ed_deep');

    // 验证 repo-rejected
    const rejected = json.data.publications.find((p: any) => p.id === 'repo-rejected');
    expect(rejected).toBeDefined();
    expect(rejected.isPublic).toBe(false);
    expect(rejected.reviewStatus).toBe('REJECTED');
    expect(rejected.rejectionReason).toBe('缺少开源协议合规说明');
    expect(rejected.chapterCount).toBe(1);
    expect(rejected.processedDocsCount).toBe(0);
    expect(rejected.unprocessedCount).toBe(1);
  });

  it('普通用户非最早导入者时 isMaintainer 为 false，管理员则恒为 true', async () => {
    importRecordFindManyMock.mockImplementation((args: any) => {
      if (args?.where?.userId) {
        return Promise.resolve([{ repositoryId: 'repo-other' }]);
      }
      return Promise.resolve([]);
    });
    // 最早导入者是 user-original-maintainer
    rawQueryMock.mockResolvedValue([{ repositoryId: 'repo-other', userId: 'user-original-maintainer' }]);

    documentFindManyMock.mockResolvedValue([]);
    repositoryFindManyMock.mockResolvedValue([
      {
        id: 'repo-other',
        owner: 'someone',
        repo: 'other-repo',
        branch: 'master',
        edition: '',
        isPublic: false,
        publishedAt: null,
        reviewStatus: 'NONE',
        rejectionReason: null,
        transcriptionCreditsEarned: 0,
        relayEnabled: false,
        repoProfile: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    // 普通用户：isMaintainer 应为 false
    userFindUniqueMock.mockResolvedValueOnce({ role: 'USER' });
    const resUser = await callGet();
    const jsonUser = await resUser.json();
    expect(jsonUser.data.publications[0].isMaintainer).toBe(false);

    // 管理员：isMaintainer 应为 true
    userFindUniqueMock.mockResolvedValueOnce({ role: 'ADMIN' });
    const resAdmin = await callGet();
    const jsonAdmin = await resAdmin.json();
    expect(jsonAdmin.data.publications[0].isMaintainer).toBe(true);
  });

  it('用户私有文档状态优先覆盖正典共享文档状态，且不重复计入章节总数', async () => {
    importRecordFindManyMock.mockImplementation((args: any) => {
      if (args?.where?.userId) {
        return Promise.resolve([{ repositoryId: 'repo-override' }]);
      }
      return Promise.resolve([]);
    });
    rawQueryMock.mockResolvedValue([{ repositoryId: 'repo-override', userId: 'user-creator' }]);

    documentFindManyMock.mockImplementation((args: any) => {
      if (args?.where?.ownerUserId) return Promise.resolve([]);
      if (args?.where?.repositoryId) {
        return Promise.resolve([
          // 正典为未处理，但当前用户私有已转录
          { repositoryId: 'repo-override', path: 'chapter1.md', status: 'UNPROCESSED', ownerUserId: null },
          { repositoryId: 'repo-override', path: 'chapter1.md', status: 'PROCESSED', ownerUserId: 'user-creator' },
        ]);
      }
      return Promise.resolve([]);
    });

    repositoryFindManyMock.mockResolvedValue([
      {
        id: 'repo-override',
        owner: 'org',
        repo: 'custom-repo',
        branch: 'main',
        edition: '',
        isPublic: false,
        publishedAt: null,
        reviewStatus: 'NONE',
        rejectionReason: null,
        transcriptionCreditsEarned: 0,
        relayEnabled: false,
        repoProfile: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await callGet();
    const json = await res.json();
    expect(res.status).toBe(200);
    const pub = json.data.publications[0];
    expect(pub.chapterCount).toBe(1);
    expect(pub.processedDocsCount).toBe(1);
    expect(pub.unprocessedCount).toBe(0);
  });

  it('支持衍生讲法预设（preset）自动推导显示名与非默认分支 docUrl 组装', async () => {
    importRecordFindManyMock.mockImplementation((args: any) => {
      if (args?.where?.userId) {
        return Promise.resolve([{ repositoryId: 'repo-preset' }]);
      }
      return Promise.resolve([]);
    });
    rawQueryMock.mockResolvedValue([{ repositoryId: 'repo-preset', userId: 'user-creator' }]);

    documentFindManyMock.mockResolvedValue([]);
    repositoryFindManyMock.mockResolvedValue([
      {
        id: 'repo-preset',
        owner: 'org',
        repo: 'cool-lib',
        branch: 'feat/v2',
        edition: 'ed_preset',
        isPublic: false,
        publishedAt: null,
        reviewStatus: 'NONE',
        rejectionReason: null,
        transcriptionCreditsEarned: 0,
        relayEnabled: false,
        repoProfile: { transcriptionPreset: 'deep' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await callGet();
    const json = await res.json();
    expect(res.status).toBe(200);
    const pub = json.data.publications[0];
    expect(pub.editionLabel).toBe('深度剖析版');
    expect(pub.docUrl).toBe('/docs/org/cool-lib?edition=ed_preset&branch=feat%2Fv2');
  });

  it('正确聚合社区接力信息：进行中任务数、参与者头像列表与状态', async () => {
    importRecordFindManyMock.mockImplementation((args: any) => {
      if (args?.where?.userId) {
        return Promise.resolve([{ repositoryId: 'repo-relay' }]);
      }
      return Promise.resolve([]);
    });
    rawQueryMock.mockResolvedValue([{ repositoryId: 'repo-relay', userId: 'user-creator' }]);

    documentFindManyMock.mockResolvedValue([]);
    repositoryFindManyMock.mockResolvedValue([
      {
        id: 'repo-relay',
        owner: 'xtls',
        repo: 'xray-core',
        branch: 'main',
        edition: '',
        isPublic: true,
        publishedAt: new Date('2026-09-01T10:00:00Z'),
        reviewStatus: 'APPROVED',
        rejectionReason: null,
        transcriptionCreditsEarned: 200,
        relayEnabled: true,
        repoProfile: null,
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-09-01T10:00:00Z'),
      },
    ]);

    // 模拟两个接力任务：user-alice 正在转录(CLAIMED)，user-bob 已换入(SWAPPED)
    chapterUpdateJobFindManyMock.mockResolvedValue([
      { repositoryId: 'repo-relay', status: 'CLAIMED', claimedBy: 'user-alice' },
      { repositoryId: 'repo-relay', status: 'SWAPPED', claimedBy: 'user-bob' },
    ]);

    userFindManyMock.mockResolvedValue([
      { id: 'user-alice', name: 'Alice', image: 'https://example.com/alice.png' },
      { id: 'user-bob', name: 'Bob', image: 'https://example.com/bob.png' },
    ]);

    const res = await callGet();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    const pub = json.data.publications[0];
    expect(pub.id).toBe('repo-relay');
    expect(pub.relayEnabled).toBe(true);
    expect(pub.relayInProgressCount).toBe(1); // 只有 CLAIMED 是未换入进行中
    expect(pub.relayParticipants).toHaveLength(2);

    // 活跃进行中者排在前面
    expect(pub.relayParticipants[0]).toEqual({
      userId: 'user-alice',
      name: 'Alice',
      image: 'https://example.com/alice.png',
      active: true,
    });
    expect(pub.relayParticipants[1]).toEqual({
      userId: 'user-bob',
      name: 'Bob',
      image: 'https://example.com/bob.png',
      active: false,
    });
  });
});
