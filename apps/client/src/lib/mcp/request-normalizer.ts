import { NextRequest, NextResponse } from 'next/server';
import { getCorsHeaders } from '@/lib/constants';
import { readBodyJson } from './body-json';
import { TOOL_ALIASES, buildUnknownToolResult } from './unknown-tool-fallback';
import { recordMcpToolError } from '@/lib/telemetry/mcp-beacon';

export interface NormalizeMcpResult {
  /** 规范化后的请求对象（工具名/入参已重写，可直接送入 McpHandler） */
  request: NextRequest;
  /** 若为未知工具，直接在此返回短路响应，无需拉起后端 McpServer 与 DB 查询 */
  directResponse: NextResponse | null;
}

/**
 * 网关层 MCP 请求规范化器（第一性原理：消除黑客猴子补丁，请求入站单阶段规范化）
 *
 * 核心设计：
 * 1. 原语直通：若请求是 tools/call 且属于可用工具清单，完全零开销直接放行。
 * 2. 透明别名重写 (Turn 1 Zero Roundtrip)：
 *    若请求为历史或直觉别名（如 get_document / read_doc -> read，search_docs -> search），
 *    在网关层原地重写工具名与入参结构（例如自动将 path 映射为 target），
 *    直接由规范原语在第 1 轮返回正文，消除一轮无谓的沟通与报错。
 * 3. 未知工具短路响应：
 *    若为未知工具名，直接在网关层计算 Levenshtein 建议并返回 isError JSON-RPC 结果，
 *    彻底避免侵入 SDK 内部私有属性 `_requestHandlers`，同时保护底层数据库免受非法工具调用开销。
 */
export async function normalizeMcpToolCallRequest(
  request: NextRequest,
  availableTools: readonly string[],
  label: string
): Promise<NormalizeMcpResult> {
  const body = await readBodyJson(request);
  if (!body) {
    return { request, directResponse: null };
  }

  if (!body || typeof body !== 'object' || body.method !== 'tools/call') {
    return { request, directResponse: null };
  }

  const rawName = body.params?.name;
  if (!rawName || typeof rawName !== 'string') {
    return { request, directResponse: null };
  }

  const trimmedName = rawName.trim();
  const normalizedKey = trimmedName.toLowerCase();

  // 1. 已知规范工具：直接放行
  if (availableTools.includes(trimmedName)) {
    return { request, directResponse: null };
  }

  // 2. 命中别名表：在网关层透明重写工具名与参数
  const canonicalName = TOOL_ALIASES[normalizedKey];
  if (canonicalName && availableTools.includes(canonicalName)) {
    const rawArgs = { ...(body.params?.arguments || {}) };
    const adaptedArgs = { ...rawArgs };

    // 针对 read 原语的入参兼容重写：path/section -> target
    if (canonicalName === 'read') {
      if (adaptedArgs.path && !adaptedArgs.target) {
        adaptedArgs.target = adaptedArgs.section
          ? `${adaptedArgs.path}#${adaptedArgs.section}`
          : adaptedArgs.path;
        delete adaptedArgs.path;
        delete adaptedArgs.section;
      }
    }

    // 针对 search 原语的入参兼容重写：mode -> filter
    if (canonicalName === 'search') {
      if (adaptedArgs.mode && !adaptedArgs.filter) {
        adaptedArgs.filter = adaptedArgs.mode;
        delete adaptedArgs.mode;
      }
    }

    const rewrittenBody = {
      ...body,
      params: {
        ...body.params,
        name: canonicalName,
        arguments: adaptedArgs,
      },
    };

    const rewrittenRequest = new NextRequest(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(rewrittenBody),
    });

    return { request: rewrittenRequest, directResponse: null };
  }

  // 3. 真正未知的工具：直接在网关层短路拦截并记录遥测，返回友好建议
  recordMcpToolError({
    toolName: trimmedName,
    query: JSON.stringify(body.params?.arguments ?? {}).slice(0, 200),
    responseTimeMs: 0,
    errorMessage: `Tool not found: ${trimmedName}`,
  });

  const unknownResult = buildUnknownToolResult(trimmedName, [...availableTools], label);
  const responsePayload = {
    jsonrpc: '2.0',
    id: body.id ?? null,
    result: unknownResult,
  };

  return {
    request,
    directResponse: NextResponse.json(responsePayload, {
      status: 200,
      headers: getCorsHeaders('GET, POST, OPTIONS'),
    }),
  };
}
