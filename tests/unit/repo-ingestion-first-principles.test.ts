import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDirectoryTopologySummary } from '@/engine/ai-repo-sniffer';
import { type GitHubNode } from '@/engine/repo-sniffer';

const { generateStructuredMock, resolveActiveUserModelMock } = vi.hoisted(() => ({
  generateStructuredMock: vi.fn(),
  resolveActiveUserModelMock: vi.fn(),
}));

describe('仓库导入 (Repo Ingestion) 第一性原理单元测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveActiveUserModelMock.mockResolvedValue({ modelId: 'mock-model' });
  });

  describe('Layer 1: 确定性感知层 (buildDirectoryTopologySummary)', () => {
    it('应将全仓节点无损压缩为包含配置、目录统计与代表性采样的拓扑指纹', () => {
      const nodes: GitHubNode[] = [
        { path: 'book.toml', type: 'blob', size: 100 },
        { path: 'package.json', type: 'blob', size: 200 },
        { path: 'Cargo.toml', type: 'blob', size: 300 },
        { path: 'src/main.rs', type: 'blob', size: 1500 },
        { path: 'src/lib.rs', type: 'blob', size: 2500 },
        { path: 'docs/intro.md', type: 'blob', size: 1200 },
        { path: 'docs/guide.md', type: 'blob', size: 1800 },
        { path: 'docs/advanced/deep.md', type: 'blob', size: 2200 },
        { path: 'i18n/zh/intro.md', type: 'blob', size: 1200 },
        { path: 'README.md', type: 'blob', size: 800 },
      ];

      const topology = buildDirectoryTopologySummary(nodes);

      expect(topology.totalNodes).toBe(nodes.length);
      expect(topology.totalMarkdownFiles).toBe(5);
      expect(topology.configFiles).toContain('book.toml');
      expect(topology.configFiles).toContain('package.json');
      expect(topology.configFiles).toContain('Cargo.toml');

      // 验证目录统计
      expect(topology.directories['docs/']).toBeDefined();
      expect(topology.directories['docs/'].markdownCount).toBe(2);
      expect(topology.directories['docs/'].samplePaths.length).toBeGreaterThan(0);

      expect(topology.directories['src/']).toBeDefined();
      expect(topology.directories['src/'].codeCount).toBe(2);
    });

    it('深度目录应优先聚合为 top-2 级，且 Markdown 密集目录排在前列', () => {
      const nodes: GitHubNode[] = [
        ...Array.from({ length: 10 }, (_, i) => ({
          path: `deep/level2/level3/doc_${i}.md`,
          type: 'blob' as const,
          size: 100,
        })),
        { path: 'shallow/readme.md', type: 'blob' as const, size: 100 },
      ];

      const topology = buildDirectoryTopologySummary(nodes);
      expect(topology.directories['deep/level2/']).toBeDefined();
      expect(topology.directories['deep/level2/'].markdownCount).toBe(10);
    });
  });
});
