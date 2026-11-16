import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runListChapterVersions } from '@/lib/mcp/tools/versions';
import { RepoRuntime } from '@/lib/mcp/tools/shared';

const prismaMock = vi.hoisted(() => ({
  document: {
    findFirst: vi.fn(),
  },
  chapterVersion: {
    findMany: vi.fn(),
  },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

describe('MCP list_chapter_versions Tool (Version Market Observation)', () => {
  const mockRepo = {
    id: 'repo-100',
    owner: 'karpathy',
    repo: 'micrograd',
    branch: 'master',
    gitSha: 'sha-micrograd-7bc',
  };

  const createRuntime = (repo: any = mockRepo, multiRepo = false): RepoRuntime => ({
    label: multiRepo ? 'the Hub' : 'this bookshelf',
    multiRepo,
    resolveRepository: async () => ({
      owner: repo.owner,
      repo: repo.repo,
      repository: repo,
      documents: [],
      navTree: [],
    }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.document.findFirst.mockReset();
    prismaMock.chapterVersion.findMany.mockReset();
  });

  it('缺少 path 参数时返回错误', async () => {
    const res = await runListChapterVersions({}, createRuntime());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Error: "path" is required');
  });

  it('Hub 模式未传 repository 时提示必填', async () => {
    const res = await runListChapterVersions({ path: 'ch01.md' }, createRuntime(mockRepo, true));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('"repository" is required on the Hub');
  });

  it('目标文档未在知识库中找到时返回 outline 寻径指引', async () => {
    prismaMock.document.findFirst.mockResolvedValue(null);
    const res = await runListChapterVersions({ path: 'ch99-ghost.md' }, createRuntime());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Document "ch99-ghost.md" not found in karpathy/micrograd');
    expect(res.content[0].text).toContain('Call outline to view valid document paths');
  });

  it('文档只有首发初始译本时提示当前为唯一样本', async () => {
    prismaMock.document.findFirst.mockResolvedValue({
      id: 'doc-1',
      path: 'chapters/01.mdx',
      title: '第 1 章',
      contentId: 'cid-alpha-1234567890',
    });
    prismaMock.chapterVersion.findMany.mockResolvedValue([]);

    const res = await runListChapterVersions({ path: 'chapters/01.mdx' }, createRuntime());
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('# 📚 Chapter Versions: `chapters/01.mdx` in karpathy/micrograd');
    expect(text).toContain('- **Current Effective**: content `cid-alpha-12…`');
    expect(text).toContain('No community chapter versions (relay/retranslation) exist for this chapter yet');
  });

  it('存在社区竞争版本时按置顶、票数、时间渲染列表并标注正典与生效状态', async () => {
    prismaMock.document.findFirst.mockResolvedValue({
      id: 'doc-1',
      path: 'chapters/01.mdx',
      title: '第 1 章',
      contentId: 'cid-active-999',
    });
    prismaMock.chapterVersion.findMany.mockResolvedValue([
      {
        id: 'ver-1',
        source: 'RETRANSLATE',
        voteCount: 42,
        isCanonical: true,
        pinnedAt: new Date('2026-10-01'),
        createdAt: new Date('2026-09-20'),
        contentId: 'cid-active-999',
        author: { name: 'Alice' },
      },
      {
        id: 'ver-2',
        source: 'RELAY',
        voteCount: 15,
        isCanonical: false,
        pinnedAt: null,
        createdAt: new Date('2026-09-15'),
        contentId: 'cid-older-111',
        author: { name: 'Bob' },
      },
    ]);

    const res = await runListChapterVersions({ path: 'chapters/01.mdx' }, createRuntime());
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('- **Community Versions**: 2');
    expect(text).toContain('**[CURRENT]**');
    expect(text).toContain('📌 author-pinned');
    expect(text).toContain('canonical');
    expect(text).toContain('votes: 42');
    expect(text).toContain('by Alice');
    expect(text).toContain('by Bob');
  });
});
