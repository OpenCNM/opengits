import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSearch } from '@/lib/mcp/tools/search';
import { DocSearchUnavailableError } from '@/lib/mcp/doc-search';
import { RepoRuntime } from '@/lib/mcp/tools/shared';

const searchDriver = vi.hoisted(() => ({ executeSidecarSearch: vi.fn() }));
vi.mock('@/engine/search-driver', () => searchDriver);

// 遥测 mock：断言 ERROR 状态与 BLIND_SPOT 的区分
const beacon = vi.hoisted(() => ({ recordMcpToolCall: vi.fn(async () => {}), recordMcpToolError: vi.fn(async () => {}) }));
vi.mock('@/lib/telemetry/mcp-beacon', () => beacon);

// 概念注入依赖 prisma，故障路径测试中直接旁路
vi.mock('@/lib/mcp/concept-graph', () => ({
  getConceptDependencies: vi.fn(async () => []),
  formatDependencyHintText: vi.fn(() => ''),
  CONCEPT_DEPENDENCY_HINT_HEADER: '',
  getConceptGrounding: vi.fn(async () => null),
}));

const mockRepo = {
  id: 'repo-1',
  owner: 'acme',
  repo: 'calculator',
  branch: 'main',
  repoProfile: {},
  documents: [],
  navTree: [],
};

const createRuntime = (): RepoRuntime => ({
  multiRepo: false,
  resolveRepository: async () => ({
    repository: mockRepo,
    documents: [],
    navTree: [],
  }),
});

describe('sidecar 检索故障 fail-closed（ERROR ≠ BLIND_SPOT）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sidecar 抛错时 search 返回 isError 且遥测记 ERROR 而非空结果', async () => {
    searchDriver.executeSidecarSearch.mockRejectedValue(new Error('sidecar unreachable'));
    const res = await runSearch({ query: 'state machine' }, {}, createRuntime());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Search backend unavailable');
    expect(res.content[0].text).toContain('NOT an empty result');

    // 遥测收割契约：handler 携带 ERROR telemetry（由 wrapToolTelemetry 统一记录——见 mcp-presence-bus）
    expect(res.telemetry).toMatchObject({ resultCount: 0, status: 'ERROR' });
    expect(res.telemetry.errorMessage).toContain('sidecar unreachable');
  });

  it('searchRepositoryDocs 直接上抛 DocSearchUnavailableError（消费方可辨识）', async () => {
    searchDriver.executeSidecarSearch.mockRejectedValue(new Error('ECONNREFUSED'));
    const { searchRepositoryDocs } = await import('@/lib/mcp/doc-search');
    await expect(searchRepositoryDocs('repo-1', 'query', 5)).rejects.toBeInstanceOf(DocSearchUnavailableError);
  });

  it('入参守卫仍返回空数组（非基础设施故障不上抛）', async () => {
    const { searchRepositoryDocs } = await import('@/lib/mcp/doc-search');
    await expect(searchRepositoryDocs('repo-1', '   ', 5)).resolves.toEqual([]);
    expect(searchDriver.executeSidecarSearch).not.toHaveBeenCalled();
  });
});
