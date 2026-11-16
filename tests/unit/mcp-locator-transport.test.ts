import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as searchDriver from '@/engine/search-driver';
import { locateRepositorySections, searchRepositoryDocs } from '@/lib/mcp/doc-search';

vi.mock('@/engine/search-driver', () => ({
  executeSidecarSearch: vi.fn(),
}));

describe('MCP Locator Zero-Content Transport (Unit 7.12 & 9.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('🧪 [7.12.1.3 · HIGH] searchRepositoryDocs 默认 includeContent 为 true，并映射 Go 端返回的 snippet', async () => {
    const mockHit: searchDriver.SidecarSearchHit = {
      chunkId: 'chunk-1',
      docId: 'doc-1',
      title: 'Guide',
      path: 'guide.md',
      heading: 'Introduction',
      headingPath: 'Guide > Introduction',
      snippet: 'This is a short snippet preview',
      content: 'Full long content with 10,000 words...',
      similarity: 0.85,
    };

    vi.mocked(searchDriver.executeSidecarSearch).mockResolvedValue([mockHit]);

    const results = await searchRepositoryDocs('repo-1', 'introduction');

    expect(searchDriver.executeSidecarSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: 'repo-1',
        query: 'introduction',
        includeContent: true,
      })
    );
    expect(results).toHaveLength(1);
    expect(results[0].snippet).toBe('This is a short snippet preview');
    expect(results[0].content).toBe('Full long content with 10,000 words...');
  });

  it('🧪 [7.12.1.3 · HIGH] locateRepositorySections 显式传递 includeContent: false，消费原生 snippet 零正文传输', async () => {
    const mockHit: searchDriver.SidecarSearchHit = {
      chunkId: 'chunk-1',
      docId: 'doc-1',
      title: 'Architecture Overview',
      path: 'docs/arch.md',
      heading: 'Kernel System',
      headingPath: 'Docs > Kernel System',
      snippet: '...the kernel system manages process isolation and context windows...',
      content: '', // Go 端 includeContent: false 时省略正文
      similarity: 0.9,
    };

    vi.mocked(searchDriver.executeSidecarSearch).mockResolvedValue([mockHit]);

    const hits = await locateRepositorySections('repo-1', 'kernel system', 5);

    // 断言底层检索被严格配置为 includeContent: false
    expect(searchDriver.executeSidecarSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: 'repo-1',
        includeContent: false,
      })
    );

    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('docs/arch.md');
    expect(hits[0].heading).toBe('Kernel System');
    // snippet 优先基于 hit.snippet 组装，不依赖 content
    expect(hits[0].snippet).toContain('kernel system');
  });
});
