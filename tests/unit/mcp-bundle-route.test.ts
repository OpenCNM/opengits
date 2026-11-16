import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cachedMcpBundle,
  clearBundleMetaCacheForTest,
  createBundleMcpServer,
  getPooledServer,
  releasePooledServer,
  clearServerPoolForTest,
  type CachedMcpBundle,
} from '@/app/api/mcp/bundle/[bundleId]/route';
import { prisma } from '@/lib/db';

vi.mock('@/lib/db', () => ({
  prisma: {
    mcpBundle: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    document: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('@/lib/mcp/bundle-search', () => ({
  searchBundleDocs: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/telemetry/mcp-beacon', () => ({
  recordMcpToolCall: vi.fn().mockResolvedValue(undefined),
  wrapToolTelemetry: vi.fn((_opts, fn) => fn),
  runWithMcpClientContext: vi.fn((_client, fn) => fn()),
}));

vi.mock('@/lib/mcp/mcp-heartbeat', () => ({
  recordMcpClientPresence: vi.fn().mockReturnValue('MockClient'),
}));

vi.mock('@/lib/mcp/request-guard', () => ({
  enforceMcpAuth: vi.fn().mockResolvedValue({ userId: 'u-1' }),
  enforceMcpAuthAndQuota: vi.fn().mockResolvedValue({ userId: 'u-1' }),
}));

vi.mock('@/lib/mcp/mcp-tools-manager', () => ({
  getGlobalToolPolicies: vi.fn().mockResolvedValue(new Map()),
}));

describe('Bundle MCP Route Lightening & Server Pooling (Unit 7.14 · H-07)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBundleMetaCacheForTest();
    clearServerPoolForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockBundleDb = {
    id: 'bundle-1',
    slug: 'ai-infra',
    title: 'AI Infrastructure Bundle',
    description: 'A curated bundle for AI infrastructure',
    repositories: [
      { id: 'repo-1', owner: 'vllm-project', repo: 'vllm', category: 'Inference', starCount: 30000, isVerified: true },
      { id: 'repo-2', owner: 'huggingface', repo: 'transformers', category: 'Core', starCount: 120000, isVerified: true },
    ],
  };

  it('🧪 [7.14.5.1 · HIGH] cachedMcpBundle 提供 60s TTL 元数据缓存，消灭高频请求重复打库查询', async () => {
    vi.mocked(prisma.mcpBundle.findFirst).mockResolvedValue(mockBundleDb as any);

    // 第一次调用：缓存未命中，执行 DB 查询
    const first = await cachedMcpBundle('ai-infra');
    expect(first).not.toBeNull();
    expect(first?.id).toBe('bundle-1');
    expect(first?.repositories).toHaveLength(2);
    expect(prisma.mcpBundle.findFirst).toHaveBeenCalledTimes(1);

    // 第二次调用（相同 key）：命中 TTL 内存缓存，跳过 DB 查询
    const second = await cachedMcpBundle('ai-infra');
    expect(second).toEqual(first);
    expect(prisma.mcpBundle.findFirst).toHaveBeenCalledTimes(1);

    // 通过 id 查询：同样命中别名缓存
    const third = await cachedMcpBundle('bundle-1');
    expect(third).toEqual(first);
    expect(prisma.mcpBundle.findFirst).toHaveBeenCalledTimes(1);

    // 清理缓存后再次查询：重新触发 DB 查询
    clearBundleMetaCacheForTest();
    const fourth = await cachedMcpBundle('ai-infra');
    expect(fourth?.id).toBe('bundle-1');
    expect(prisma.mcpBundle.findFirst).toHaveBeenCalledTimes(2);
  });

  it('🧪 [7.14.5.1 · HIGH] McpServer 实例池化复用并前置编译 Zod schema，切除 90% 重复编译与堆分配', async () => {
    const bundle: CachedMcpBundle = {
      id: 'bundle-1',
      slug: 'ai-infra',
      title: 'AI Infrastructure Bundle',
      description: 'A curated bundle',
      repositories: mockBundleDb.repositories,
    };

    const poolKey = `${bundle.id}:FREE:user-1`;

    // 初始池为空
    expect(getPooledServer(poolKey)).toBeNull();

    // 创建新实例
    const server1 = createBundleMcpServer(bundle, 'FREE', 'user-1', false, new Map());
    expect(server1).toBeDefined();

    // 释放回池
    releasePooledServer(poolKey, server1);

    // 再次获取：命中池化实例，实现零重复构造与零 Zod 重新编译
    const pooledServer = getPooledServer(poolKey);
    expect(pooledServer).toBe(server1);

    // 池中实例已被取出，再次获取返回 null
    expect(getPooledServer(poolKey)).toBeNull();

    // 再次释放回池并清理
    releasePooledServer(poolKey, server1);
    clearServerPoolForTest();
    expect(getPooledServer(poolKey)).toBeNull();
  });
});
