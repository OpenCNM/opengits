import { describe, expect, it, vi, beforeEach } from 'vitest';

const prismaMocks = vi.hoisted(() => ({
  repository: {
    findMany: vi.fn(),
  },
  document: {
    groupBy: vi.fn(),
  },
}));

vi.mock('@/lib/db', () => ({
  prisma: prismaMocks,
}));

import { getRepositoryEditions } from '@/lib/repository-resolver';

/** 聚合下推后的两组分组结果（计数组 / 模型组），由各用例按需赋值 */
let statusGroups: Array<{ repositoryId: string; status: string; _count: { _all: number } }> = [];
let modelGroups: Array<{ repositoryId: string; generationModel: string | null }> = [];

describe('getRepositoryEditions 元信息增强', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusGroups = [];
    modelGroups = [];
    prismaMocks.document.groupBy.mockImplementation((args: { by: string[] }) =>
      Promise.resolve(args.by.includes('status') ? statusGroups : modelGroups)
    );
  });

  it('正确解析 creatorName、isCurrentUserCreator、wordCount 及 teachingDepth', async () => {
    statusGroups = [
      { repositoryId: 'repo-1', status: 'PROCESSED', _count: { _all: 2 } },
      { repositoryId: 'repo-1', status: 'UNPROCESSED', _count: { _all: 1 } },
    ];
    prismaMocks.repository.findMany.mockResolvedValue([
      {
        id: 'repo-1',
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main',
        edition: '',
        repoProfile: {
          editionPreset: 'deep',
          teachingDepth: 'deep',
        },
        isPublic: true,
        transcriptionModels: ['gemini-2.0-flash'],
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
        importRecords: [
          {
            user: {
              id: 'user-alice',
              name: 'Alice',
              image: 'https://example.com/alice.png',
            },
          },
        ],
        documents: [
          { status: 'PROCESSED', content: '一二三四五' }, // 5 chars
          { status: 'PROCESSED', content: '六七八九十' }, // 5 chars
          { status: 'UNPROCESSED', content: '未处理忽略' },
        ],
      },
    ]);

    const editions = await getRepositoryEditions('test-owner', 'test-repo', {
      userId: 'user-alice',
    });

    expect(editions).toHaveLength(1);
    const ed = editions[0];

    // 验证新元数据字段
    expect(ed.creatorName).toBe('Alice');
    expect(ed.isCurrentUserCreator).toBe(true);
    // 字数只取落库物理事实 totalWords：缺失时置 undefined（CDC 裁剪——绝不从正文估算编数）
    expect(ed.wordCount).toBeUndefined();
    expect(ed.teachingDepth).toBe('deep');
    expect(ed.chapterCount).toBe(3);
    expect(ed.processedDocsCount).toBe(2);
  });

  it('importRecords 为空时回退 repoProfile.creator，非本人创建时 isCurrentUserCreator 为 false', async () => {
    prismaMocks.repository.findMany.mockResolvedValue([
      {
        id: 'repo-2',
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main',
        edition: 'ed_12345678',
        repoProfile: {
          creator: 'CommunityContributor',
          editionPreset: 'standard',
          // teachingDepth 未指定，应回退至 standard preset 默认值
        },
        isPublic: true,
        transcriptionModels: [],
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
        importRecords: [],
        documents: [],
      },
    ]);

    const editions = await getRepositoryEditions('test-owner', 'test-repo', {
      userId: 'user-bob',
    });

    expect(editions).toHaveLength(1);
    const ed = editions[0];

    expect(ed.creatorName).toBe('CommunityContributor');
    expect(ed.isCurrentUserCreator).toBe(false);
    // 无 totalWords 物理事实时不编造字数（原从空文档求和得 0，现为 undefined）
    expect(ed.wordCount).toBeUndefined();
    expect(ed.teachingDepth).toBe('standard');
  });

  it('优先使用 repoProfile.totalWords 作为字数统计', async () => {
    statusGroups = [{ repositoryId: 'repo-3', status: 'PROCESSED', _count: { _all: 1 } }];
    prismaMocks.repository.findMany.mockResolvedValue([
      {
        id: 'repo-3',
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main',
        edition: 'ed_custom',
        repoProfile: {
          totalWords: 52000,
          editionPreset: 'cheatsheet',
        },
        isPublic: true,
        transcriptionModels: [],
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
        importRecords: [
          {
            user: {
              id: 'user-other',
              name: null,
            },
          },
        ],
        documents: [
          { status: 'PROCESSED', content: 'abc' },
        ],
      },
    ]);

    const editions = await getRepositoryEditions('test-owner', 'test-repo');

    expect(editions).toHaveLength(1);
    const ed = editions[0];

    expect(ed.wordCount).toBe(52000);
    expect(ed.isCurrentUserCreator).toBe(false);
    expect(ed.creatorName).toBeNull();
  });

  it('边界防御：userId 直接匹配、空白字符串修剪回退、非法负数字数回退', async () => {
    statusGroups = [
      { repositoryId: 'repo-4', status: 'PROCESSED', _count: { _all: 1 } },
      { repositoryId: 'repo-4', status: 'ERROR', _count: { _all: 1 } },
    ];
    prismaMocks.repository.findMany.mockResolvedValue([
      {
        id: 'repo-4',
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main',
        edition: 'ed_edge',
        repoProfile: {
          creator: '   ', // 全空格创作者
          totalWords: -100, // 负数字数应忽略
          teachingDepth: '   ', // 空格 teachingDepth
          editionPreset: 'deep',
        },
        isPublic: true,
        transcriptionModels: [],
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
        importRecords: [
          {
            userId: 'user-charlie',
            user: null, // user 关联不存在，仅有 userId
          },
        ],
        documents: [
          { status: 'PROCESSED', content: 'hello' },
          { status: 'FAILED', content: 'failed-content' },
        ],
      },
    ]);

    const editions = await getRepositoryEditions('test-owner', 'test-repo', {
      userId: 'user-charlie',
    });

    expect(editions).toHaveLength(1);
    const ed = editions[0];

    // user 关联为空且 creator 为纯空格，creatorName 应规范为 null
    expect(ed.creatorName).toBeNull();
    // 即使 user 为 null，importRecord.userId 匹配时依然应确认为本人创建
    expect(ed.isCurrentUserCreator).toBe(true);
    // 负数 totalWords 被丢弃；字数缺失时置 undefined，绝不再从文档正文长度现算
    // （原实现导致 ingest-status 每 10s 轮询全量拉取章节 MDX 正文，已按 CDC 公理移除）
    expect(ed.wordCount).toBeUndefined();
    // 空白 teachingDepth 应回退至 deep preset 的默认值 'deep'
    expect(ed.teachingDepth).toBe('deep');
  });

  it('转录模型为首：transcriptionModels 为空时优先提取 documents generationModel 与 repoProfile.transcriptionModel，绝不渲染“教学解读版”', async () => {
    modelGroups = [{ repositoryId: 'repo-from-docs', generationModel: 'glm-5.3-flash' }];
    prismaMocks.repository.findMany.mockResolvedValue([
      {
        id: 'repo-from-docs',
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main',
        edition: 'ed_from_docs',
        repoProfile: {
          editionPreset: 'standard',
          editionLabel: '讲法 ed_from_docs',
        },
        isPublic: true,
        transcriptionModels: [],
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
        importRecords: [],
        documents: [
          { status: 'PROCESSED', content: 'test', generationModel: 'glm-5.3-flash' },
        ],
      },
      {
        id: 'repo-from-profile',
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main',
        edition: 'ed_from_profile',
        repoProfile: {
          editionPreset: 'standard',
          transcriptionModel: 'qwen-max',
          editionLabel: '讲法 ed_from_profile',
        },
        isPublic: true,
        transcriptionModels: [],
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
        importRecords: [],
        documents: [],
      },
      {
        id: 'repo-no-model-standard',
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main',
        edition: 'ed_no_model',
        repoProfile: {
          editionPreset: 'standard',
          editionLabel: '讲法 ed_no_model',
        },
        isPublic: true,
        transcriptionModels: [],
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
        importRecords: [],
        documents: [],
      },
    ]);

    const editions = await getRepositoryEditions('test-owner', 'test-repo');

    expect(editions).toHaveLength(3);

    // 1. 从 documents 聚合出 generationModel
    expect(editions[0].label).toBe('glm-5.3-flash');
    expect(editions[0].transcriptionModels).toEqual(['glm-5.3-flash']);

    // 2. 从 repoProfile.transcriptionModel 提取
    expect(editions[1].label).toBe('qwen-max');
    expect(editions[1].transcriptionModels).toEqual(['qwen-max']);

    // 3. 无模型且 standard 预设：必须是“标准教程”，绝不能是“教学解读版”
    expect(editions[2].label).toBe('标准教程');
    expect(editions[2].label).not.toBe('教学解读版');
  });
});
