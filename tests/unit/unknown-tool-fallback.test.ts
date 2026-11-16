import { test, expect, describe, vi, beforeEach } from 'vitest';
import {
  TOOL_ALIASES,
  similarityRatio,
  buildUnknownToolResult,
  installUnknownToolFallback,
} from '@/lib/mcp/unknown-tool-fallback';
import { recordMcpToolError } from '@/lib/telemetry/mcp-beacon';

vi.mock('@/lib/telemetry/mcp-beacon', () => ({
  recordMcpToolError: vi.fn(),
}));

describe('unknown-tool-fallback 未知工具兜底与建议生成', () => {
  const registeredToolNames = [
    'list_resources',
    'search',
    'read',
    'read_document',
    'explore_concept',
    'check_breaking_changes',
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('similarityRatio 相似度算法', () => {
    test('相同字符串为 1.0，完全无关为低分', () => {
      expect(similarityRatio('read_document', 'read_document')).toBe(1.0);
      expect(similarityRatio('', '')).toBe(1.0);
      expect(similarityRatio('search_doc', 'search')).toBeGreaterThanOrEqual(0.6);
      expect(similarityRatio('foo', 'bar')).toBe(0);
    });
  });

  describe('buildUnknownToolResult 建议加权与文案生成', () => {
    test('别名表命中（如 read_doc / search_docs）加权推荐规范工具名 read / search', () => {
      expect(TOOL_ALIASES['read_doc']).toBe('read');
      expect(TOOL_ALIASES['search_docs']).toBe('search');

      const result = buildUnknownToolResult('read_doc', registeredToolNames, 'test-server');
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('Tool "read_doc" not found in test-server');
      expect(text).toContain('Did you mean:\n- read');
    });

    test('遗留搜索工具名（如 search_docs）给出 search 建议', () => {
      const result = buildUnknownToolResult('search_docs', registeredToolNames, 'test-server');
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('Did you mean:');
      expect(text).toContain('search');
    });

    test('完全无关的未知工具名（如 unknown_random_tool）输出 Available tools 全列表', () => {
      const result = buildUnknownToolResult('completely_random_xyz', registeredToolNames, 'test-server');
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('Available tools: list_resources, search, read, read_document, explore_concept, check_breaking_changes');
      expect(text).not.toContain('Did you mean:');
    });
  });

  describe('installUnknownToolFallback 服务分发拦截', () => {
    test('拦截未知工具记录遥测，放行已知工具', async () => {
      let registeredHandler: ((request: any, ctx: any) => Promise<any>) | null = null;
      const fakeBuiltinHandler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

      const fakeMcpServer = {
        _registeredTools: {
          read_document: {},
          search: {},
        },
        server: {
          _requestHandlers: new Map([['tools/call', fakeBuiltinHandler]]),
          removeRequestHandler: vi.fn(),
          setRequestHandler: vi.fn((name, handler) => {
            if (name === 'tools/call') registeredHandler = handler;
          }),
        },
      };

      installUnknownToolFallback(fakeMcpServer as any, { label: 'my-agent' });
      expect(fakeMcpServer.server.setRequestHandler).toHaveBeenCalledWith('tools/call', expect.any(Function));
      expect(registeredHandler).not.toBeNull();

      // 1. 调用已知工具
      const knownRes = await registeredHandler!({ params: { name: 'read_document', arguments: {} } }, {});
      expect(fakeBuiltinHandler).toHaveBeenCalled();
      expect(knownRes).toEqual({ content: [{ type: 'text', text: 'ok' }] });
      expect(recordMcpToolError).not.toHaveBeenCalled();

      // 2. 调用未知工具
      const unknownRes = await registeredHandler!({ params: { name: 'read_doc', arguments: { query: 'test' } } }, {});
      expect(recordMcpToolError).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'read_doc',
          errorMessage: 'Tool not found: read_doc',
        })
      );
      expect(unknownRes.isError).toBe(true);
      expect(unknownRes.content[0].text).toContain('Did you mean:\n- read_document');
    });
  });
});
