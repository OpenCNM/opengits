import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runListResources } from '@/lib/mcp/tools/resources';
import { RepoRuntime } from '@/lib/mcp/tools/shared';

const manifestMock = vi.hoisted(() => ({
  buildBookshelfManifest: vi.fn(),
}));
vi.mock('@/lib/mcp/capability-manifest', () => manifestMock);

describe('MCP list_resources Tool (Bookshelf & Resource Manifest)', () => {
  const mockRepo = {
    id: 'repo-calc-1',
    owner: 'acme',
    repo: 'calculator',
    category: 'Math',
    documents: [{ id: 'd1' }, { id: 'd2' }],
  };

  const createSingleRuntime = (repo: any = mockRepo): RepoRuntime => ({
    label: 'this bookshelf',
    multiRepo: false,
    resolveRepository: async () => ({
      owner: repo?.owner || 'acme',
      repo: repo?.repo || 'calculator',
      repository: repo,
      documents: [],
      navTree: [],
      targetVersionLabel: 'v1.0.0',
    }),
  });

  const createHubRuntime = (userId = 'user-1'): RepoRuntime => ({
    label: 'the Hub',
    multiRepo: true,
    userId,
    resolveRepository: async () => null,
  });

  const mockManifests = [
    {
      identity: {
        id: 'repo-1',
        owner: 'pytorch',
        repo: 'torchtune',
        displayName: 'pytorch/torchtune',
        category: 'AI / Deep Learning',
        tags: ['PyTorch', 'LLM', 'FineTuning'],
        sourceType: 'github' as const,
        sourceUrl: 'https://github.com/pytorch/torchtune',
        lastSyncedAt: '2026-11-01',
      },
      techStack: {
        primaryLanguages: ['Python'],
        framework: 'PyTorch',
      },
      bestUsedFor: ['Fine-tune LLMs locally', 'Inspect LoRA configs'],
    },
    {
      identity: {
        id: 'repo-2',
        owner: 'web-doc',
        repo: 'rust-async-book',
        displayName: 'web-doc/rust-async-book',
        category: 'Systems',
        tags: ['Rust', 'Async', 'Concurrency'],
        sourceType: 'web' as const,
        sourceUrl: 'https://rust-lang.github.io/async-book',
        lastSyncedAt: '2026-11-02',
      },
      techStack: {
        primaryLanguages: ['Rust'],
        framework: 'Tokio',
      },
      bestUsedFor: ['Master Rust async/await', 'Pin and Future mechanics'],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    manifestMock.buildBookshelfManifest.mockReset();
  });

  it('单仓模式返回目标仓库的元信息摘要', async () => {
    const res = await runListResources({}, createSingleRuntime(mockRepo));
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('Repository: acme/calculator');
    expect(text).toContain('Category: Math');
    expect(text).toContain('Total Documents: 2');
    expect(text).toContain('Target Version: v1.0.0');
  });

  it('单仓模式未解析到仓库时返回 isError', async () => {
    const res = await runListResources({}, createSingleRuntime(null));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Repository not found.');
  });

  it('Hub 模式展示全书架名片、Emoji 标识及 Tech Stack', async () => {
    manifestMock.buildBookshelfManifest.mockResolvedValue(mockManifests);

    const res = await runListResources({}, createHubRuntime('user-1'));
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('OpenGits Hub Bookshelf (2 tutorials found):');
    expect(text).toContain('### 🐙 pytorch/torchtune [GitHub]');
    expect(text).toContain('### 🌐 web-doc/rust-async-book [Web Docs]');
    expect(text).toContain('Category: AI / Deep Learning');
    expect(text).toContain('Tech Stack: Python (PyTorch)');
    expect(text).toContain('Tech Stack: Rust (Tokio)');
    expect(text).toContain('* Fine-tune LLMs locally');
  });

  it('Hub 模式支持 category 大小写无关过滤', async () => {
    manifestMock.buildBookshelfManifest.mockResolvedValue(mockManifests);

    const res = await runListResources({ category: 'deep learning' }, createHubRuntime('user-1'));
    const text = res.content[0].text;
    expect(text).toContain('(1 tutorials found)');
    expect(text).toContain('pytorch/torchtune');
    expect(text).not.toContain('rust-async-book');
  });

  it('Hub 模式支持 query 关键字跨字段过滤 (tags 与 bestUsedFor)', async () => {
    manifestMock.buildBookshelfManifest.mockResolvedValue(mockManifests);

    // 匹配 tags 中的 "Concurrency"
    const res = await runListResources({ query: 'concurrency' }, createHubRuntime('user-1'));
    const text = res.content[0].text;
    expect(text).toContain('(1 tutorials found)');
    expect(text).toContain('rust-async-book');
    expect(text).not.toContain('pytorch/torchtune');
  });

  it('Hub 模式过滤无匹配项时输出 0 tutorials found', async () => {
    manifestMock.buildBookshelfManifest.mockResolvedValue(mockManifests);

    const res = await runListResources({ query: 'nonexistent-framework' }, createHubRuntime('user-1'));
    const text = res.content[0].text;
    expect(text).toContain('OpenGits Hub Bookshelf (0 tutorials found):');
  });
});
