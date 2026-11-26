import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { normalizeMcpToolCallRequest } from '@/lib/mcp/request-normalizer';
import { MCP_AVAILABLE_TOOLS } from '@/lib/mcp/capability-manifest';

describe('MCP Gateway Request Normalizer & Alias Rewriter (第一性原理)', () => {
  const label = 'test-owner/test-repo';

  function makeRequest(body: Record<string, unknown>): NextRequest {
    return new NextRequest('http://localhost:3000/api/mcp/test-owner/test-repo', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  describe('1. 标准规范原语直通 (Canonical Pass-Through)', () => {
    it('标准 read 工具调用零修改放行', async () => {
      const originalBody = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'read',
          arguments: { target: 'docs/guide.md' },
        },
      };
      const req = makeRequest(originalBody);
      const res = await normalizeMcpToolCallRequest(req, MCP_AVAILABLE_TOOLS, label);

      expect(res.directResponse).toBeNull();
      const body = await res.request.json();
      expect(body.params.name).toBe('read');
      expect(body.params.arguments.target).toBe('docs/guide.md');
    });

    it('标准 search 工具调用零修改放行', async () => {
      const originalBody = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'search',
          arguments: { query: 'useState', filter: 'code' },
        },
      };
      const req = makeRequest(originalBody);
      const res = await normalizeMcpToolCallRequest(req, MCP_AVAILABLE_TOOLS, label);

      expect(res.directResponse).toBeNull();
      const body = await res.request.json();
      expect(body.params.name).toBe('search');
      expect(body.params.arguments.query).toBe('useState');
    });

    it('非 tools/call 协议请求 (如 tools/list, initialize) 零修改直接放行', async () => {
      const originalBody = {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
      };
      const req = makeRequest(originalBody);
      const res = await normalizeMcpToolCallRequest(req, MCP_AVAILABLE_TOOLS, label);

      expect(res.directResponse).toBeNull();
      const body = await res.request.json();
      expect(body.method).toBe('tools/list');
    });
  });

  describe('2. 透明别名重写 (Turn 1 Zero Roundtrip)', () => {
    it('get_document 自动映射至 read 原语并将 path 映射至 target', async () => {
      const originalBody = {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'get_document',
          arguments: { path: 'README.md' },
        },
      };
      const req = makeRequest(originalBody);
      const res = await normalizeMcpToolCallRequest(req, MCP_AVAILABLE_TOOLS, label);

      expect(res.directResponse).toBeNull();
      const body = await res.request.json();
      expect(body.params.name).toBe('read');
      expect(body.params.arguments.target).toBe('README.md');
      expect(body.params.arguments.path).toBeUndefined();
    });

    it('read_doc 带 path 与 section 时自动融合成 Address (path#section)', async () => {
      const originalBody = {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'read_doc',
          arguments: { path: 'docs/auth.md', section: 'JWT 验证' },
        },
      };
      const req = makeRequest(originalBody);
      const res = await normalizeMcpToolCallRequest(req, MCP_AVAILABLE_TOOLS, label);

      expect(res.directResponse).toBeNull();
      const body = await res.request.json();
      expect(body.params.name).toBe('read');
      expect(body.params.arguments.target).toBe('docs/auth.md#JWT 验证');
      expect(body.params.arguments.section).toBeUndefined();
    });

    it('search_docs 自动重写为 search 并将 mode 兼容映射为 filter', async () => {
      const originalBody = {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'search_docs',
          arguments: { query: 'redis cache', mode: 'architecture' },
        },
      };
      const req = makeRequest(originalBody);
      const res = await normalizeMcpToolCallRequest(req, MCP_AVAILABLE_TOOLS, label);

      expect(res.directResponse).toBeNull();
      const body = await res.request.json();
      expect(body.params.name).toBe('search');
      expect(body.params.arguments.query).toBe('redis cache');
      expect(body.params.arguments.filter).toBe('architecture');
      expect(body.params.arguments.mode).toBeUndefined();
    });

    it('list_docs / toc 自动映射至 browse 结构感知原语', async () => {
      const originalBody = {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: {
          name: 'list_docs',
          arguments: {},
        },
      };
      const req = makeRequest(originalBody);
      const res = await normalizeMcpToolCallRequest(req, MCP_AVAILABLE_TOOLS, label);

      expect(res.directResponse).toBeNull();
      const body = await res.request.json();
      expect(body.params.name).toBe('browse');
    });

    it('Soft Deprecation：8 个历史核心工具名透明改写至 4 大核心原语', async () => {
      const cases: Array<{
        name: string;
        args: Record<string, unknown>;
        wantName: string;
        checkArgs: (a: Record<string, unknown>) => void;
      }> = [
        {
          name: 'list_resources',
          args: {},
          wantName: 'browse',
          checkArgs: (a) => expect(a.view).toBe('resources'),
        },
        {
          name: 'outline',
          args: { path: 'docs/guide.md' },
          wantName: 'browse',
          checkArgs: (a) => expect(a.path).toBe('docs/guide.md'),
        },
        {
          name: 'read_document',
          args: {},
          wantName: 'browse',
          checkArgs: (a) => expect(a.target).toBeUndefined(),
        },
        {
          name: 'read_document',
          args: { path: 'README.md', section: 'Install' },
          wantName: 'read',
          checkArgs: (a) => expect(a.target).toBe('README.md#Install'),
        },
        {
          name: 'explore_concept',
          args: { action: 'course_map' },
          wantName: 'browse',
          checkArgs: (a) => expect(a.view).toBe('course_map'),
        },
        {
          name: 'explore_concept',
          args: { concept: 'Router', action: 'details' },
          wantName: 'read',
          checkArgs: (a) => expect(a.concept).toBe('Router'),
        },
        {
          name: 'check_breaking_changes',
          args: { query: 'Next.js 15' },
          wantName: 'search',
          checkArgs: (a) => expect(a.filter).toBe('gotchas'),
        },
        {
          name: 'search_symbols',
          args: { query: 'Init' },
          wantName: 'search',
          checkArgs: (a) => expect(a.filter).toBe('symbols'),
        },
        {
          name: 'read_symbol',
          args: { symbol: 'InitScheduler', file: 'sched.go' },
          wantName: 'read_code',
          checkArgs: (a) => expect(a.path).toBe('sched.go'),
        },
        {
          name: 'read_source_file',
          args: { path: 'src/index.ts', start_line: 1, end_line: 20 },
          wantName: 'read_code',
          checkArgs: (a) => expect(a.path).toBe('src/index.ts'),
        },
      ];

      for (const tc of cases) {
        const req = makeRequest({
          jsonrpc: '2.0',
          id: 50,
          method: 'tools/call',
          params: { name: tc.name, arguments: tc.args },
        });
        const res = await normalizeMcpToolCallRequest(req, MCP_AVAILABLE_TOOLS, label);
        expect(res.directResponse).toBeNull();
        const body = await res.request.json();
        expect(body.params.name).toBe(tc.wantName);
        tc.checkArgs(body.params.arguments);
      }
    });
  });

  describe('3. 未知工具与已下线工具网关短路响应 (Zero DB & Serverless Friendly)', () => {
    it('已下线工具 (list_chapter_versions / dissect_code / verify_claim) 直接短路报错并列出 4 核心原语', async () => {
      for (const offlined of ['list_chapter_versions', 'dissect_code', 'verify_claim']) {
        const req = makeRequest({
          jsonrpc: '2.0',
          id: 98,
          method: 'tools/call',
          params: { name: offlined, arguments: {} },
        });
        const res = await normalizeMcpToolCallRequest(req, MCP_AVAILABLE_TOOLS, label);
        expect(res.directResponse).not.toBeNull();
        const json = await res.directResponse!.json();
        expect(json.result.isError).toBe(true);
        expect(json.result.content[0].text).toContain('Available tools: browse, search, read, read_code');
      }
    });
    it('幻觉不存在的工具名时，网关直接短路拦截，返回带建议的 isError JSON-RPC 结果', async () => {
      const originalBody = {
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: {
          name: 'non_existent_magic_tool',
          arguments: { foo: 'bar' },
        },
      };
      const req = makeRequest(originalBody);
      const res = await normalizeMcpToolCallRequest(req, MCP_AVAILABLE_TOOLS, label);

      expect(res.directResponse).not.toBeNull();
      expect(res.directResponse!.status).toBe(200);

      const json = await res.directResponse!.json();
      expect(json.jsonrpc).toBe('2.0');
      expect(json.id).toBe(99);
      expect(json.result).toBeDefined();
      expect(json.result.isError).toBe(true);
      expect(json.result.content[0].type).toBe('text');
      expect(json.result.content[0].text).toContain('Error: Tool "non_existent_magic_tool" not found');
      expect(json.result.content[0].text).toContain('Available tools:');
    });
  });
});
