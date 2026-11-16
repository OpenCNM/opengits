import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSidecarConceptGrounding } from '@/engine/symbols-driver';

// Mock DB and Graph Store
vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findUnique: vi.fn(),
    },
    tutorialConceptNode: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    tutorialConceptEdge: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/engine/ingest/graph-store', () => ({
  loadSemanticGraphArtifact: vi.fn(),
}));

describe('Graph Grounding Driver & Sidecar Cutover', () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
    process.env.WORKER_SIDECAR_URL = 'http://localhost:8088';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // 🧪 向量 1.18.5.1: 概念代码锚点查询下沉 Go 原生图谱检索，消灭 Node 堆内大图谱反序列化
  describe('executeSidecarConceptGrounding', () => {
    it('正确拼装请求参数、携带鉴权头并解析 Go sidecar 响应', async () => {
      const mockResponse = {
        ok: true,
        backboneFiles: [
          { path: 'src/core/contract.ts', role: 'core_contract', pageRank: 0.457 },
          { path: 'src/entry/main.ts', role: 'entry_point', pageRank: 0.355 },
        ],
        goldenSymbols: [
          { name: 'RouterContract', kind: 'type', file: 'src/core/contract.ts', score: 0.95 },
          { name: 'bootstrap', kind: 'function', file: 'src/entry/main.ts', score: 0.88 },
        ],
      };

      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await executeSidecarConceptGrounding({
        owner: 'testowner',
        repo: 'testrepo',
        sha: 'sha123456',
        conceptName: 'Router',
        scopeFiles: ['src/core/contract.ts'],
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toContain('/v1/graph/concept-grounding');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        'x-internal-token': 'test-internal-token',
        'content-type': 'application/json',
      });

      const body = JSON.parse(String(init.body));
      expect(body).toEqual({
        owner: 'testowner',
        repo: 'testrepo',
        sha: 'sha123456',
        conceptName: 'Router',
        scopeFiles: ['src/core/contract.ts'],
      });

      expect(result.backboneFiles).toHaveLength(2);
      expect(result.backboneFiles[0].path).toBe('src/core/contract.ts');
      expect(result.goldenSymbols).toHaveLength(2);
      expect(result.goldenSymbols[0].name).toBe('RouterContract');
    });

    it('当 sidecar 返回 ok: false 时显式抛出异常', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, error: 'semantic graph artifact not found' }),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        executeSidecarConceptGrounding({
          owner: 'testowner',
          repo: 'testrepo',
          sha: 'sha123456',
          conceptName: 'Router',
        })
      ).rejects.toThrow(/semantic graph artifact not found/);
    });
  });

  // 🧪 向量 1.18.5.1: getConceptGrounding 优先走 sidecar 并在异常时 Fail-Open 回落本地
  describe('getConceptGrounding (Priority & Fail-Open Fallback)', () => {
    it('sidecar 在线时优先直读 Go 端结果，彻底跳过 Node 侧 loadSemanticGraphArtifact', async () => {
      const { prisma } = await import('@/lib/db');
      const { loadSemanticGraphArtifact } = await import('@/engine/ingest/graph-store');
      const { getConceptGrounding } = await import('@/lib/mcp/concept-graph/concept-queries');

      vi.mocked(prisma.repository.findUnique).mockResolvedValueOnce({
        id: 'repo-1',
        owner: 'testowner',
        repo: 'testrepo',
        gitSha: 'sha123456',
      } as any);

      const sidecarResponse = {
        ok: true,
        backboneFiles: [{ path: 'src/core/engine.ts', role: 'core_contract', pageRank: 0.5 }],
        goldenSymbols: [{ name: 'Engine', kind: 'type', file: 'src/core/engine.ts', score: 0.9 }],
      };

      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => sidecarResponse,
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const res = await getConceptGrounding('repo-1', 'Engine');

      expect(res).not.toBeNull();
      expect(res?.backboneFiles[0].path).toBe('src/core/engine.ts');
      expect(res?.goldenSymbols[0].name).toBe('Engine');
      // 核心断言：本地 loadSemanticGraphArtifact 绝对不被触发，零 V8 堆内存开销
      expect(loadSemanticGraphArtifact).not.toHaveBeenCalled();
    });

    it('sidecar 故障时 Fail-Open 平滑回落至本地 loadSemanticGraphArtifact 纯 TS 解析', async () => {
      const { prisma } = await import('@/lib/db');
      const { loadSemanticGraphArtifact } = await import('@/engine/ingest/graph-store');
      const { getConceptGrounding } = await import('@/lib/mcp/concept-graph/concept-queries');

      vi.mocked(prisma.repository.findUnique).mockResolvedValueOnce({
        id: 'repo-2',
        owner: 'testowner',
        repo: 'testrepo',
        gitSha: 'sha123456',
      } as any);

      // 模拟 sidecar 抛错
      const fetchMock = vi.fn(async () => {
        throw new Error('Connection refused to sidecar');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      // 模拟本地图谱产物
      vi.mocked(loadSemanticGraphArtifact).mockResolvedValueOnce({
        version: 2,
        gitSha: 'sha123456',
        generatedAt: '2026-09-14T00:00:00Z',
        nodes: [
          {
            path: 'src/fallback.ts',
            language: 'typescript',
            inDegree: 1,
            outDegree: 0,
            pageRank: 0.333,
            role: 'core_contract',
            isBackbone: true,
            isEntryPoint: false,
          },
        ],
        entryPoints: [],
        backboneNodes: ['src/fallback.ts'],
        coreContractNodes: ['src/fallback.ts'],
        pipelineNodes: [],
        symbolsByFile: {},
        edges: [],
        softEdges: [],
        goldenSymbols: [
          { file: 'src/fallback.ts', name: 'FallbackSymbol', kind: 'function', score: 0.8, importers: 1 },
        ],
        callEdges: [],
        meta: {} as any,
      });

      const res = await getConceptGrounding('repo-2', 'Fallback');

      expect(res).not.toBeNull();
      expect(res?.backboneFiles[0].path).toBe('src/fallback.ts');
      expect(res?.goldenSymbols[0].name).toBe('FallbackSymbol');
      // 断言本地降级被正确调用
      expect(loadSemanticGraphArtifact).toHaveBeenCalledWith('testowner', 'testrepo', 'sha123456');
    });

    it('当 sidecar 返回结果为空数组时，直接返回 null', async () => {
      const { prisma } = await import('@/lib/db');
      const { getConceptGrounding } = await import('@/lib/mcp/concept-graph/concept-queries');

      vi.mocked(prisma.repository.findUnique).mockResolvedValueOnce({
        id: 'repo-empty',
        owner: 'testowner',
        repo: 'testrepo',
        gitSha: 'sha123456',
      } as any);

      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, backboneFiles: [], goldenSymbols: [] }),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const res = await getConceptGrounding('repo-empty', 'NonExistentConcept');
      expect(res).toBeNull();
    });

    it('当传入代码章节路径时，自动解析 scopeFiles 并注入到 sidecar 请求中', async () => {
      const { prisma } = await import('@/lib/db');
      const { getConceptGrounding } = await import('@/lib/mcp/concept-graph/concept-queries');

      vi.mocked(prisma.repository.findUnique).mockImplementation(async (args: any) => {
        if (args?.select?.owner) {
          return { id: 'repo-chapter', owner: 'org', repo: 'app', gitSha: 'sha999' } as any;
        }
        if (args?.select?.repoProfile) {
          return {
            repoProfile: {
              codeClusters: [
                {
                  teachingOrder: 1,
                  title: 'Core Engine',
                  directories: ['src/engine'],
                  files: ['src/engine/kernel.ts', 'src/engine/types.ts'],
                },
              ],
            },
          } as any;
        }
        return null as any;
      });

      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          backboneFiles: [{ path: 'src/engine/kernel.ts', role: 'core_contract', pageRank: 0.6 }],
          goldenSymbols: [{ name: 'Kernel', kind: 'type', file: 'src/engine/kernel.ts', score: 0.9 }],
        }),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const res = await getConceptGrounding('repo-chapter', 'Kernel', 'chapters/01.mdx');

      expect(res).not.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(init.body));
      expect(body.scopeFiles).toEqual(['src/engine/kernel.ts', 'src/engine/types.ts']);
    });
  });

  // （🧪 向量 1.18.5.2 executeSidecarFactGrounding repoInfo 直读——随 cognitive-driver
  //  TS 镜像退役物理删除；事实锚定单一实现在 Go internal/cognitive/fact_grounding.go，
  //  行为由 Go TestFactGrounding.* 与双端黄金对拍锁定）
});
