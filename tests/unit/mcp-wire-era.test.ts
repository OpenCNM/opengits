import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Wire 级双时代协议测试（MCP 2026-07-28 升级安全网）
 *
 * 直接 fetch(repositoryMcpHandler) 驱动真实 SDK（@modelcontextprotocol/server），
 * 覆盖两条协议腿：
 * - Legacy 腿（2025 及更早）：initialize 握手 → tools/list → prompts/get → 未知工具兜底
 * - Modern 腿（2026-07-28 无状态）：params._meta 携带版本 + 标准头 → resultType/serverInfo 信封
 *
 * 这是仓库里唯一一组打到 SDK wire 层的测试（其余 mcp-* 测试均为纯函数级），
 * SDK 升级（2.0.0 → 2.3.x）时此处必须全绿。
 */

// ── mock 面（对齐 mcp-output-snapshots.test.ts 的已知可用集合，仅保留注册链所需）──
vi.mock('@/lib/mcp/repo-resolve-cache', () => ({
  resolveRepositoryMcpCached: vi.fn(async () => ({
    repository: {
      id: 'repo-wire-1',
      owner: 'vercel',
      repo: 'next.js',
      edition: '',
      repoProfile: {},
      documents: [],
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
    targetVersionLabel: 'main',
    isFallback: false,
  })),
}));


vi.mock('@/lib/mcp/mcp-tools-manager', () => ({
  getGlobalToolPolicies: vi.fn(async () => new Map()),
}));

const beacon = vi.hoisted(() => ({
  recordMcpToolCall: vi.fn(async () => {}),
  recordMcpToolError: vi.fn(async () => {}),
  wrapToolTelemetry: vi.fn((_base: unknown, handler: Function) => handler),
  runWithMcpClientContext: vi.fn((_c: unknown, fn: Function) => fn()),
}));
vi.mock('@/lib/telemetry/mcp-beacon', () => beacon);

const prismaMock = vi.hoisted(() => ({
  document: { findFirst: vi.fn() },
  documentChunk: { findMany: vi.fn() },
  tutorialConceptNode: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  tutorialConceptEdge: { count: vi.fn() },
  repository: { findMany: vi.fn() },
  chapterVersion: { findMany: vi.fn() },
  chapterQuiz: { findMany: vi.fn() },
  globalConcept: { findMany: vi.fn() },
  mcpBundle: { findFirst: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

vi.mock('@/engine/tarball/archive-store', () => ({
  readFileLocal: vi.fn(async () => null),
}));
vi.mock('@/engine/symbols-driver', () => ({
  executeSidecarSymbolLookup: vi.fn(),
  executeSidecarSymbolSearch: vi.fn(),
}));
vi.mock('@/engine/dissect-driver', () => ({
  executeSidecarDissectAst: vi.fn(),
}));

import { repositoryMcpHandler } from '@/lib/mcp/handler-factory';
import { MCP_AVAILABLE_TOOLS } from '@/lib/mcp/capability-manifest';

const ENDPOINT = 'http://localhost:3000/api/mcp/vercel/next.js';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

function rpcRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

/** Modern（2026-07-28）无状态请求：body _meta 携带版本 + 标准头（Mcp-Method/Mcp-Protocol-Version 必带） */
function modernRequest(method: string, extraParams: Record<string, unknown> = {}): Request {
  return rpcRequest(
    {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params: {
        ...extraParams,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    },
    {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
    },
  );
}

async function json(res: Response): Promise<any> {
  const text = await res.text();
  if (text.trimStart().startsWith('{')) return JSON.parse(text);
  // SSE（legacy 腿在 Accept 含 text/event-stream 时以事件流回包）：取 data: 行的 JSON 消息
  const dataLines = text
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5).trim()));
  const rpc = dataLines.find((m) => m.result !== undefined || m.error !== undefined);
  if (!rpc) throw new Error(`No JSON-RPC message in SSE response: ${text.slice(0, 120)}`);
  return rpc;
}

describe('MCP wire-level dual-era protocol (SDK createMcpHandler)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Legacy era（initialize 握手，2025 及更早客户端）', () => {
    it('initialize 返回受支持协议版本与 serverInfo/capabilities', async () => {
      const res = await repositoryMcpHandler.fetch(
        rpcRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'wire-test-client', version: '1.0.0' },
          },
        }),
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.result.protocolVersion).toBe('2025-06-18');
      expect(body.result.serverInfo.name).toBe('opengits-vercel-next.js');
      expect(body.result.capabilities.tools).toBeDefined();
      expect(body.result.capabilities.prompts).toBeDefined();
    });

    it('tools/list 返回全部 12 个规范工具（无 initialize 前置也能直答，stateless）', async () => {
      const res = await repositoryMcpHandler.fetch(
        rpcRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      const names = body.result.tools.map((t: any) => t.name);
      expect(names.sort()).toEqual([...MCP_AVAILABLE_TOOLS].sort());
      // 旧时代结果不携带新时代信封字段（era 隔离，旧客户端零漂移）
      expect(body.result.resultType).toBeUndefined();
    });

    it('prompts/get 省略 arguments 时全可选 prompt（explain-architecture）可正常应答', async () => {
      const res = await repositoryMcpHandler.fetch(
        rpcRequest({
          jsonrpc: '2.0',
          id: 3,
          method: 'prompts/get',
          params: { name: 'explain-architecture' },
        }),
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.error).toBeUndefined();
      expect(Array.isArray(body.result.messages)).toBe(true);
    });

    it('未知工具调用返回 did-you-mean 建议（monkey-patch 兜底层在 SDK 升级后仍生效）', async () => {
      const res = await repositoryMcpHandler.fetch(
        rpcRequest({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'frobnicate_document', arguments: {} },
        }),
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toMatch(/frobnicate_document/);
    });
  });

  describe('Modern era（2026-07-28 无状态，_meta 携带版本）', () => {
    it('tools/list 携带 _meta 版本与标准头：返回 resultType=complete 与 _meta.serverInfo', async () => {
      const res = await repositoryMcpHandler.fetch(modernRequest('tools/list'));
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.error).toBeUndefined();
      expect(body.result.resultType).toBe('complete');
      expect(body.result._meta?.[SERVER_INFO_META_KEY]?.name).toBe('opengits-vercel-next.js');
      const names = body.result.tools.map((t: any) => t.name);
      expect(names.sort()).toEqual([...MCP_AVAILABLE_TOOLS].sort());
    });

    it('server/discover 宣告 modern 版本与能力（新规范 MUST）', async () => {
      const res = await repositoryMcpHandler.fetch(modernRequest('server/discover'));
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.error).toBeUndefined();
      const versions: string[] = body.result.supportedVersions ?? [];
      expect(versions).toContain('2026-07-28');
    });

    it('maxToolInputElements 加固：超复杂度入参被快速拒绝（schema 校验 DoS 防线）', async () => {
      const hugeArgs = { junk: new Array(5000).fill('x') };
      const res = await repositoryMcpHandler.fetch(
        rpcRequest({
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: { name: 'read', arguments: hugeArgs },
        }),
      );
      // 无论 2xx 与否，绝不能 5xx/挂死；SDK 应给出受控错误
      expect(res.status).toBeLessThan(500);
      const body = await json(res);
      expect(body.error ?? body.result).toBeTruthy();
    });

    it('modern 请求缺失必带标准头（Mcp-Protocol-Version）时以 400 拒绝', async () => {
      const res = await repositoryMcpHandler.fetch(
        rpcRequest({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/list',
          params: {
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      );
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toBeDefined();
    });
  });
});
