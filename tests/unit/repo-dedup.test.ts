import { test, expect, describe, vi, beforeEach } from 'vitest';
import { canonicalizeRepo, checkRepoDuplicates } from '@/lib/repo-dedup';
import { prisma } from '@/lib/db';

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    importRecord: {
      findFirst: vi.fn(),
    },
  },
}));

describe('repo-dedup 规范化与查重', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('canonicalizeRepo：小写化、去除前后斜杠与 .git 尾缀', () => {
    expect(canonicalizeRepo(' Facebook ', ' React ')).toEqual({
      owner: 'facebook',
      repo: 'react',
    });

    expect(canonicalizeRepo('/vercel/', '/next.js.git/')).toEqual({
      owner: 'vercel',
      repo: 'next.js',
    });

    expect(canonicalizeRepo('///org///', 'repo.git')).toEqual({
      owner: 'org',
      repo: 'repo',
    });

    expect(canonicalizeRepo('', '')).toEqual({
      owner: '',
      repo: '',
    });
  });

  test('checkRepoDuplicates：探索广场已有公开教程查重', async () => {
    (prisma.repository.findMany as any).mockResolvedValue([
      {
        id: 'repo-1',
        owner: 'facebook',
        repo: 'react',
        isPublic: true,
        gitSha: 'sha123',
        transcriptionModels: ['gpt-4o'],
        documents: [{ id: 'doc-1' }],
      },
    ]);
    (prisma.importRecord.findFirst as any).mockResolvedValue(null);

    const result = await checkRepoDuplicates({
      owner: 'Facebook',
      repo: 'React',
    });

    expect(result.existsInExplore).toBe(true);
    expect(result.existingRepo).toEqual({
      id: 'repo-1',
      owner: 'facebook',
      repo: 'react',
      gitSha: 'sha123',
      transcriptionModels: ['gpt-4o'],
      isPublic: true,
      isMaintainer: false,
    });
    expect(result.isFork).toBe(false);
  });

  test('checkRepoDuplicates：个人书架查重（userId 命中）', async () => {
    (prisma.repository.findMany as any).mockResolvedValue([]);
    (prisma.user.findUnique as any).mockResolvedValue({
      savedRepos: [
        {
          repository: {
            id: 'repo-2',
            owner: 'vercel',
            repo: 'next.js',
            isPublic: false,
            gitSha: null,
            transcriptionModels: ['claude-3-5-sonnet'],
          },
        },
      ],
    });
    (prisma.importRecord.findFirst as any).mockResolvedValue({ userId: 'user-1' });

    const result = await checkRepoDuplicates({
      owner: 'vercel',
      repo: 'next.js',
      userId: 'user-1',
    });

    expect(result.existsOnShelf).toBe(true);
    expect(result.existsInExplore).toBe(false);
    expect(result.existingRepo).toEqual({
      id: 'repo-2',
      owner: 'vercel',
      repo: 'next.js',
      gitSha: null,
      transcriptionModels: ['claude-3-5-sonnet'],
      isPublic: false,
      isMaintainer: true,
    });
  });

  test('checkRepoDuplicates：Fork 上游在探索广场的识别', async () => {
    (prisma.repository.findMany as any).mockResolvedValue([]);
    (prisma.repository.findFirst as any).mockResolvedValue({
      id: 'upstream-repo-id',
      owner: 'torvalds',
      repo: 'linux',
      transcriptionModels: ['qwen-max'],
    });

    const result = await checkRepoDuplicates({
      owner: 'forker',
      repo: 'linux',
      upstream: { owner: 'Torvalds', repo: 'Linux.git' },
    });

    expect(result.isFork).toBe(true);
    expect(result.upstream).toEqual({ owner: 'torvalds', repo: 'linux' });
    expect(result.upstreamExistsInExplore).toBe(true);
    expect(result.upstreamRepo).toEqual({
      id: 'upstream-repo-id',
      owner: 'torvalds',
      repo: 'linux',
      transcriptionModels: ['qwen-max'],
    });
  });

  test('checkRepoDuplicates：维护者身份识别 (isMaintainer) 各种场景', async () => {
    (prisma.repository.findMany as any).mockResolvedValue([
      {
        id: 'repo-public-1',
        owner: 'xtls',
        repo: 'xray-core',
        isPublic: true,
        gitSha: 'sha999',
        transcriptionModels: ['qwen-plus'],
        documents: [{ id: 'doc-1' }],
      },
    ]);
    (prisma.importRecord.findFirst as any).mockResolvedValue({ userId: 'author-user' });

    // 场景 A：其他用户（访客）查重已公开教程
    const resultVisitor = await checkRepoDuplicates({
      owner: 'XTLS',
      repo: 'Xray-core',
      userId: 'visitor-user',
    });
    expect(resultVisitor.existsInExplore).toBe(true);
    expect(resultVisitor.existingRepo?.isPublic).toBe(true);
    expect(resultVisitor.existingRepo?.isMaintainer).toBe(false);

    // 场景 B：原作者本人查重已公开教程
    const resultAuthor = await checkRepoDuplicates({
      owner: 'XTLS',
      repo: 'Xray-core',
      userId: 'author-user',
    });
    expect(resultAuthor.existsInExplore).toBe(true);
    expect(resultAuthor.existingRepo?.isPublic).toBe(true);
    expect(resultAuthor.existingRepo?.isMaintainer).toBe(true);

    // 未登录用户查重已公开教程
    const resultAnon = await checkRepoDuplicates({
      owner: 'XTLS',
      repo: 'Xray-core',
      userId: null,
    });
    expect(resultAnon.existingRepo?.isPublic).toBe(true);
    expect(resultAnon.existingRepo?.isMaintainer).toBe(false);

    // 访客将他人的公开教程收藏到自己书架后查重：existsOnShelf 为 true，但依然不能成为维护者
    (prisma.user.findUnique as any).mockResolvedValue({
      savedRepos: [
        {
          repository: {
            id: 'repo-public-1',
            owner: 'xtls',
            repo: 'xray-core',
            isPublic: true,
            gitSha: 'sha999',
            transcriptionModels: ['qwen-plus'],
          },
        },
      ],
    });
    const resultShelfVisitor = await checkRepoDuplicates({
      owner: 'XTLS',
      repo: 'Xray-core',
      userId: 'visitor-user',
    });
    expect(resultShelfVisitor.existsOnShelf).toBe(true);
    expect(resultShelfVisitor.existsInExplore).toBe(true);
    expect(resultShelfVisitor.existingRepo?.isPublic).toBe(true);
    expect(resultShelfVisitor.existingRepo?.isMaintainer).toBe(false);
  });

  describe('346 准则：只要不能被搜索到，无论是转录状态还是审核状态，都不算已有教程', () => {
    test('转录环节（存在 UNPROCESSED 文档）：不算已有教程', async () => {
      (prisma.repository.findMany as any).mockResolvedValue([
        {
          id: 'repo-transcribing-1',
          owner: 'langchain-ai',
          repo: 'langgraph',
          isPublic: true,
          reviewStatus: 'APPROVED',
          gitSha: 'sha-trans',
          transcriptionModels: ['glm-5.3-flash'],
          documents: [
            { id: 'doc-1', status: 'PROCESSED' },
            { id: 'doc-2', status: 'UNPROCESSED' },
          ],
        },
      ]);
      (prisma.user.findUnique as any).mockResolvedValue({
        savedRepos: [
          {
            repository: {
              id: 'repo-transcribing-1',
              owner: 'langchain-ai',
              repo: 'langgraph',
              isPublic: false,
              reviewStatus: 'NONE',
              gitSha: 'sha-trans',
              transcriptionModels: ['glm-5.3-flash'],
              documents: [
                { id: 'doc-1', status: 'PROCESSED' },
                { id: 'doc-2', status: 'UNPROCESSED' },
              ],
            },
          },
        ],
      });

      const result = await checkRepoDuplicates({
        owner: 'langchain-ai',
        repo: 'langgraph',
        userId: 'user-1',
      });

      expect(result.existsOnShelf).toBe(false);
      expect(result.existsInExplore).toBe(false);
      expect(result.existingRepo).toBeNull();
    });

    test('转录环节（存在 PROCESSING 进行中文档）：不算已有教程', async () => {
      (prisma.repository.findMany as any).mockResolvedValue([
        {
          id: 'repo-transcribing-2',
          owner: 'langchain-ai',
          repo: 'langgraph',
          isPublic: true,
          reviewStatus: 'APPROVED',
          gitSha: 'sha-trans',
          transcriptionModels: ['glm-5.3-flash'],
          documents: [
            { id: 'doc-1', status: 'PROCESSING' },
          ],
        },
      ]);
      (prisma.user.findUnique as any).mockResolvedValue({
        savedRepos: [
          {
            repository: {
              id: 'repo-transcribing-2',
              owner: 'langchain-ai',
              repo: 'langgraph',
              isPublic: false,
              reviewStatus: 'NONE',
              gitSha: 'sha-trans',
              transcriptionModels: ['glm-5.3-flash'],
              documents: [
                { id: 'doc-1', status: 'PROCESSING' },
              ],
            },
          },
        ],
      });

      const result = await checkRepoDuplicates({
        owner: 'langchain-ai',
        repo: 'langgraph',
        userId: 'user-1',
      });

      expect(result.existsOnShelf).toBe(false);
      expect(result.existsInExplore).toBe(false);
      expect(result.existingRepo).toBeNull();
    });

    test('转录环节（空文档列表）：刚导入尚未生成章节文档，不算已有教程', async () => {
      (prisma.repository.findMany as any).mockResolvedValue([
        {
          id: 'repo-empty-docs',
          owner: 'langchain-ai',
          repo: 'langgraph',
          isPublic: true,
          reviewStatus: 'APPROVED',
          gitSha: 'sha-trans',
          transcriptionModels: ['glm-5.3-flash'],
          documents: [],
        },
      ]);
      (prisma.user.findUnique as any).mockResolvedValue({
        savedRepos: [
          {
            repository: {
              id: 'repo-empty-docs',
              owner: 'langchain-ai',
              repo: 'langgraph',
              isPublic: false,
              reviewStatus: 'NONE',
              gitSha: 'sha-trans',
              transcriptionModels: ['glm-5.3-flash'],
              documents: [],
            },
          },
        ],
      });

      const result = await checkRepoDuplicates({
        owner: 'langchain-ai',
        repo: 'langgraph',
        userId: 'user-1',
      });

      expect(result.existsOnShelf).toBe(false);
      expect(result.existsInExplore).toBe(false);
      expect(result.existingRepo).toBeNull();
    });

    test('审核环节（reviewStatus 为 PENDING）：不可被搜索到，不算已有教程', async () => {
      (prisma.repository.findMany as any).mockResolvedValue([
        {
          id: 'repo-pending-review',
          owner: 'langchain-ai',
          repo: 'langgraph',
          isPublic: false,
          reviewStatus: 'PENDING',
          gitSha: 'sha-pending',
          transcriptionModels: ['glm-5.3-flash'],
          documents: [
            { id: 'doc-1', status: 'PROCESSED' },
            { id: 'doc-2', status: 'PROCESSED' },
          ],
        },
      ]);
      (prisma.user.findUnique as any).mockResolvedValue({
        savedRepos: [
          {
            repository: {
              id: 'repo-pending-review',
              owner: 'langchain-ai',
              repo: 'langgraph',
              isPublic: false,
              reviewStatus: 'PENDING',
              gitSha: 'sha-pending',
              transcriptionModels: ['glm-5.3-flash'],
              documents: [
                { id: 'doc-1', status: 'PROCESSED' },
                { id: 'doc-2', status: 'PROCESSED' },
              ],
            },
          },
        ],
      });

      const result = await checkRepoDuplicates({
        owner: 'langchain-ai',
        repo: 'langgraph',
        userId: 'user-1',
      });

      expect(result.existsOnShelf).toBe(false);
      expect(result.existsInExplore).toBe(false);
      expect(result.existingRepo).toBeNull();
    });

    test('审核驳回（reviewStatus 为 REJECTED）：不可被搜索到，不算已有教程', async () => {
      (prisma.repository.findMany as any).mockResolvedValue([
        {
          id: 'repo-rejected',
          owner: 'langchain-ai',
          repo: 'langgraph',
          isPublic: false,
          reviewStatus: 'REJECTED',
          gitSha: 'sha-rej',
          transcriptionModels: ['glm-5.3-flash'],
          documents: [
            { id: 'doc-1', status: 'PROCESSED' },
          ],
        },
      ]);
      (prisma.user.findUnique as any).mockResolvedValue({
        savedRepos: [
          {
            repository: {
              id: 'repo-rejected',
              owner: 'langchain-ai',
              repo: 'langgraph',
              isPublic: false,
              reviewStatus: 'REJECTED',
              gitSha: 'sha-rej',
              transcriptionModels: ['glm-5.3-flash'],
              documents: [
                { id: 'doc-1', status: 'PROCESSED' },
              ],
            },
          },
        ],
      });

      const result = await checkRepoDuplicates({
        owner: 'langchain-ai',
        repo: 'langgraph',
        userId: 'user-1',
      });

      expect(result.existsOnShelf).toBe(false);
      expect(result.existsInExplore).toBe(false);
      expect(result.existingRepo).toBeNull();
    });

    test('全量转录完成且过审公开（isPublic: true, reviewStatus: APPROVED, 全量 PROCESSED）：算作已有教程', async () => {
      (prisma.repository.findMany as any).mockResolvedValue([
        {
          id: 'repo-approved-ready',
          owner: 'langchain-ai',
          repo: 'langgraph',
          isPublic: true,
          reviewStatus: 'APPROVED',
          gitSha: 'sha-ok',
          transcriptionModels: ['glm-5.3-flash'],
          documents: [
            { id: 'doc-1', status: 'PROCESSED' },
            { id: 'doc-2', status: 'PROCESSED' },
          ],
        },
      ]);
      (prisma.user.findUnique as any).mockResolvedValue({
        savedRepos: [
          {
            repository: {
              id: 'repo-approved-ready',
              owner: 'langchain-ai',
              repo: 'langgraph',
              isPublic: true,
              reviewStatus: 'APPROVED',
              gitSha: 'sha-ok',
              transcriptionModels: ['glm-5.3-flash'],
              documents: [
                { id: 'doc-1', status: 'PROCESSED' },
                { id: 'doc-2', status: 'PROCESSED' },
              ],
            },
          },
        ],
      });
      (prisma.importRecord.findFirst as any).mockResolvedValue({ userId: 'user-1' });

      const result = await checkRepoDuplicates({
        owner: 'langchain-ai',
        repo: 'langgraph',
        userId: 'user-1',
      });

      expect(result.existsOnShelf).toBe(true);
      expect(result.existsInExplore).toBe(true);
      expect(result.existingRepo).not.toBeNull();
      expect(result.existingRepo?.id).toBe('repo-approved-ready');
      expect(result.existingRepo?.isPublic).toBe(true);
      expect(result.existingRepo?.isMaintainer).toBe(true);
    });
  });
});
