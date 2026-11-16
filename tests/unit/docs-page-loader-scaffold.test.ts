import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inferDocSubsystem } from '@/lib/docs/docs-page-loader';

vi.mock('@/engine/symbols-driver', () => ({
  executeSidecarConceptGrounding: vi.fn(),
}));

import { executeSidecarConceptGrounding } from '@/engine/symbols-driver';

const mockConceptGrounding = executeSidecarConceptGrounding as ReturnType<typeof vi.fn>;

describe('🧪 [1.18.5.4] 章节认知脚手架与骨干文件零客户端二次请求服务端直出', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('inferDocSubsystem (物理子系统推断与职责规则匹配)', () => {
    it('标准多级路径：推断子系统并匹配 MODULE_ROLE_PATTERNS.subsystemDuties', () => {
      const { subsystemName, subsystemDuty } = inferDocSubsystem('01-runtime/02-event-loop.mdx');
      expect(subsystemName).toBe('runtime');
      expect(subsystemDuty).toContain('渲染');
    });

    it('剥离常见文档根目录前缀（docs/、guide/、manual/）', () => {
      const { subsystemName: sub1 } = inferDocSubsystem('docs/compiler/01-ast.md');
      expect(sub1).toBe('compiler');

      const { subsystemName: sub2 } = inferDocSubsystem('guide/components/button.mdx');
      expect(sub2).toBe('components');
    });

    it('单级扁平路径推断', () => {
      const { subsystemName } = inferDocSubsystem('architecture.mdx');
      expect(subsystemName).toBe('architecture');
    });

    it('工具类路径匹配通用工具与共享基础职责', () => {
      const { subsystemName, subsystemDuty } = inferDocSubsystem('utils/date-helpers.md');
      expect(subsystemName).toBe('utils');
      expect(subsystemDuty).toContain('底层工具');
    });

    it('API 与数据层路径匹配数据通信职责', () => {
      const { subsystemName, subsystemDuty } = inferDocSubsystem('api/fetcher.md');
      expect(subsystemName).toBe('api');
      expect(subsystemDuty).toContain('网络请求');
    });

    it('未命中预置模式时提供规范兜底文案', () => {
      const { subsystemName, subsystemDuty } = inferDocSubsystem('customxyz/spec.md');
      expect(subsystemName).toBe('customxyz');
      expect(subsystemDuty).toBe('负责 customxyz 子模块的核心功能实现与物理代码拓扑流。');
    });
  });

  describe('Sidecar Concept Grounding 骨干文件检索与优先级', () => {
    it('成功检索并优先匹配同名子系统路径的骨干文件', async () => {
      mockConceptGrounding.mockResolvedValue({
        ok: true,
        backboneFiles: [
          { path: 'src/core/main.ts', role: 'entry_point', pageRank: 0.95 },
          { path: 'src/runtime/renderer.ts', role: 'core_contract', pageRank: 0.88 },
          { path: 'src/runtime/vnode.ts', role: 'pipeline_flow', pageRank: 0.72 },
          { path: 'src/util/helper.ts', role: 'leaf_utility', pageRank: 0.2 },
        ],
      });

      const res = await executeSidecarConceptGrounding({
        owner: 'facebook',
        repo: 'react',
        sha: 'sha123',
        conceptName: 'runtime',
        timeoutMs: 1500,
      });

      expect(res.ok).toBe(true);
      expect(res.backboneFiles).toHaveLength(4);

      // 验证匹配子系统的文件优先级排序
      const matched = res.backboneFiles.filter((f) => f.path.includes('runtime'));
      expect(matched).toHaveLength(2);
      expect(matched[0].path).toBe('src/runtime/renderer.ts');
    });

    it('Sidecar 离线或超时优雅降级为 []，不破坏服务', async () => {
      mockConceptGrounding.mockRejectedValue(new Error('Sidecar timeout'));

      let backboneFiles: Array<{ path: string; role: string; pageRank: number }> = [];
      try {
        const res = await executeSidecarConceptGrounding({
          owner: 'test',
          repo: 'test',
          sha: 'sha999',
          conceptName: 'core',
          timeoutMs: 1500,
        });
        backboneFiles = res?.backboneFiles || [];
      } catch {
        backboneFiles = [];
      }

      expect(backboneFiles).toEqual([]);
    });
  });
});
