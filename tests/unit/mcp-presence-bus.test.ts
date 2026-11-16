import { test, expect, describe, vi, beforeEach } from 'vitest';
import {
  publishPresence,
  subscribePresence,
} from '@/lib/mcp/presence-bus';
import {
  normalizeClientName,
  recordMcpClientPresence,
} from '@/lib/mcp/mcp-heartbeat';
import {
  presenceStatus,
  MCP_PRESENCE_ONLINE_MS,
  MCP_PRESENCE_RECENT_MS,
} from '@/lib/mcp/active-clients-projection';
import { recordMcpToolCall, runWithMcpClientContext, runWithMcpEditionContext, wrapToolTelemetry } from '@/lib/telemetry/mcp-beacon';
import { prisma } from '@/lib/db';

const callSidecarMock = vi.fn().mockResolvedValue({ ok: true });

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    mcpCallLog: {
      create: vi.fn().mockResolvedValue({ id: 'log-1' }),
    },
    user: {
      findUnique: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ id: 'user-1' }),
    },
    repository: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    mcpBundle: {
      findUnique: vi.fn(),
    },
    mcpActiveSession: {
      upsert: vi.fn().mockResolvedValue({ id: 'sess-1' }),
    },
  },
}));

describe('MCP 客户端在线状态事件总线', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callSidecarMock.mockReset();
    callSidecarMock.mockResolvedValue({ ok: true });
  });

  describe('subscribePresence 用户隔离', () => {
    test('🧪 [7.7.1.1] 只收到本人 userId 的事件（跨用户不得推送）', () => {
      const received: unknown[] = [];
      const unsubscribe = subscribePresence('user-a', (e) => received.push(e));

      publishPresence({ type: 'presence', userId: 'user-b', clientName: 'Cursor IDE', at: 1 });
      expect(received).toHaveLength(0);

      publishPresence({ type: 'presence', userId: 'user-a', clientName: 'Cursor IDE', at: 2 });
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ type: 'presence', clientName: 'Cursor IDE' });

      unsubscribe();
    });

    test('🧪 [7.7.2.1] 取消订阅后不再收到事件（SSE abort 防泄漏向量）', () => {
      const received: unknown[] = [];
      const unsubscribe = subscribePresence('user-a', (e) => received.push(e));
      unsubscribe();

      publishPresence({ type: 'call', userId: 'user-a', clientName: 'Cline', status: 'SUCCESS', hit: true, at: 3 });
      expect(received).toHaveLength(0);
    });

    test('多个订阅者互不干扰', () => {
      const a: unknown[] = [];
      const b: unknown[] = [];
      const unA = subscribePresence('user-a', (e) => a.push(e));
      const unB = subscribePresence('user-b', (e) => b.push(e));

      publishPresence({ type: 'call', userId: 'user-a', clientName: 'Cursor IDE', status: 'SUCCESS', hit: false, at: 4 });
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(0);

      unA();
      unB();
    });
  });

  describe('normalizeClientName 归一化口径', () => {
    test('常见 UA 归一化为展示名，与 McpActiveSession/McpCallLog 同口径', () => {
      expect(normalizeClientName('Cursor/0.42.x')).toBe('Cursor IDE');
      expect(normalizeClientName('claude-desktop/1.2')).toBe('Claude Desktop');
      expect(normalizeClientName('Windsurf Agent')).toBe('Windsurf');
      expect(normalizeClientName('Cline VSCode')).toBe('Cline');
      expect(normalizeClientName('CustomTool/2.0')).toBe('CustomTool/2.0');
    });
  });

  describe('recordMcpClientPresence 心跳 + 事件发布', () => {
    test('落心跳（fire-and-forget）并即时发布 presence 事件，返回归一化名', () => {
      const received: unknown[] = [];
      const unsubscribe = subscribePresence('user-1', (e) => received.push(e));

      const name = recordMcpClientPresence('user-1', 'Cursor/0.42', '1.2.3.4');
      expect(name).toBe('Cursor IDE');
      expect(callSidecarMock).toHaveBeenCalledWith(
        '/v1/mcp/presence/touch',
        expect.objectContaining({ userId: 'user-1', clientName: 'Cursor IDE' }),
        expect.anything()
      );
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ type: 'presence', clientName: 'Cursor IDE' });

      unsubscribe();
    });
  });

  describe('presenceStatus 双阈值判定', () => {
    const now = 1_000_000;
    test('90 秒内 online，90 秒~5 分钟 recent，超窗 offline', () => {
      expect(presenceStatus(now - 10_000, now)).toBe('online');
      expect(presenceStatus(now - MCP_PRESENCE_ONLINE_MS - 1, now)).toBe('recent');
      expect(presenceStatus(now - MCP_PRESENCE_RECENT_MS - 1, now)).toBe('offline');
      expect(presenceStatus(now - MCP_PRESENCE_ONLINE_MS, now)).toBe('online');
      expect(presenceStatus(now - MCP_PRESENCE_RECENT_MS, now)).toBe('recent');
    });
  });

  describe('mcp-beacon clientName 透传与 call 事件', () => {
    test('recordMcpToolCall 在客户端上下文内写库带 clientName 并发布 call 事件', async () => {
      const received: unknown[] = [];
      const unsubscribe = subscribePresence('user-1', (e) => received.push(e));

      await runWithMcpClientContext('Cursor IDE', async () => {
        await recordMcpToolCall({ toolName: 'search_docs', userId: 'user-1', resultCount: 3 });
      });

      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(callSidecarMock).toHaveBeenCalledWith(
        '/v1/telemetry/mcp-call-log',
        expect.objectContaining({ clientName: 'Cursor IDE', userId: 'user-1' }),
        expect.anything()
      );
      expect(received[0]).toMatchObject({ type: 'call', clientName: 'Cursor IDE', hit: true });

      unsubscribe();
    });

    test('wrapToolTelemetry 收割 handler 携带的 telemetry 并剥除后返回', async () => {
      (prisma.user.findUnique as any).mockResolvedValue(null);
      const wrapped = wrapToolTelemetry(
        { toolName: 'search', userId: 'user-1', repositoryId: 'repo-9', dimension: 'all' },
        async () => ({
          content: [{ type: 'text' as const, text: 'ok output' }],
          telemetry: { resultCount: 3, query: 'q', resultSnapshot: { count: 3 } },
        })
      );
      const res = await wrapped({}, {});
      expect(res.content[0].text).toBe('ok output');
      expect((res as any).telemetry).toBeUndefined();

      const call = callSidecarMock.mock.calls.find(
        (c: any[]) => c[1].toolName === 'search' && c[1].resultCount === 3
      );
      expect(call).toBeTruthy();
      expect(call![1]).toMatchObject({ repositoryId: 'repo-9', status: 'SUCCESS', resultCount: 3 });
    });

    test('recordMcpToolCall 讲法回退三件套经上下文透传至 wire 契约', async () => {
      await runWithMcpEditionContext(
        { requestedEdition: 'ed_deep', resolvedEdition: '', isFallback: true },
        async () => {
          await recordMcpToolCall({ toolName: 'search', userId: 'user-1', resultCount: 2 });
        }
      );

      expect(callSidecarMock).toHaveBeenCalledWith(
        '/v1/telemetry/mcp-call-log',
        expect.objectContaining({
          requestedEdition: 'ed_deep',
          resolvedEdition: '',
          isFallback: true,
        }),
        expect.anything()
      );
    });

    test('runWithMcpEditionContext 空对象零注入（无回退时不污染 wire 契约）', async () => {
      await runWithMcpEditionContext(undefined, async () => {
        await recordMcpToolCall({ toolName: 'search', userId: 'user-1', resultCount: 1 });
      });
      const call = callSidecarMock.mock.calls[callSidecarMock.mock.calls.length - 1];
      expect(call[1]).not.toHaveProperty('requestedEdition');
      expect(call[1]).not.toHaveProperty('isFallback');
    });

    test('🧪 [7.7.3.1] wrapToolTelemetry 不丢弃外层注入的 clientName', async () => {
      (prisma.user.findUnique as any).mockResolvedValue(null);
      const wrapped = wrapToolTelemetry({ toolName: 'search_docs', userId: 'user-1' }, async () => {
        // 包装器内层 store 必须保留外层 runWithMcpClientContext 注入的 clientName
        await recordMcpToolCall({ toolName: 'get_document', resultCount: 1 });
        return { content: [] };
      });

      await runWithMcpClientContext('Cline', () => wrapped({}, {}));

      const telemetryCalls = callSidecarMock.mock.calls.filter((c: any[]) => c[0] === '/v1/telemetry/mcp-call-log');
      const lastCall = telemetryCalls.at(-1);
      expect(lastCall).toBeDefined();
      expect(lastCall[1].clientName).toBe('Cline');
      expect(lastCall[1].userId).toBe('user-1');
    });

    test('无客户端上下文时 clientName 落 null/undefined 且不发布事件', async () => {
      const received: unknown[] = [];
      const unsubscribe = subscribePresence('user-9', (e) => received.push(e));

      await recordMcpToolCall({ toolName: 'search_docs', userId: 'user-9', resultCount: 0 });

      await new Promise((r) => setTimeout(r, 20));
      const telemetryCalls = callSidecarMock.mock.calls.filter((c: any[]) => c[0] === '/v1/telemetry/mcp-call-log');
      const lastCall = telemetryCalls.at(-1);
      expect(lastCall).toBeDefined();
      expect(lastCall[1].toolName).toBe('search_docs');
      expect(lastCall[1].userId).toBe('user-9');
      expect(lastCall[1].clientName).toBeUndefined();
      expect(received).toHaveLength(0);

      unsubscribe();
    });

    test('🧪 [7.7.4.1] 双端口径一致：SSE 流与 HTTP 回落共用活跃判定双阈值 (online <= 90s, recent <= 5min)', () => {
      const now = 10_000_000;
      expect(presenceStatus(now - 1000, now)).toBe('online');
      expect(presenceStatus(now - MCP_PRESENCE_ONLINE_MS + 10, now)).toBe('online');
      expect(presenceStatus(now - MCP_PRESENCE_ONLINE_MS - 10, now)).toBe('recent');
      expect(presenceStatus(now - MCP_PRESENCE_RECENT_MS + 10, now)).toBe('recent');
      expect(presenceStatus(now - MCP_PRESENCE_RECENT_MS - 10, now)).toBe('offline');
    });
  });
});
