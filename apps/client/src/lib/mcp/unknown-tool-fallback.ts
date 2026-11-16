import { McpServer } from '@modelcontextprotocol/server';
import { recordMcpToolError } from '@/lib/telemetry/mcp-beacon';

/**
 * ─────────────────────────────────────────────────────────────
 * 未知工具兜底（Tool-Not-Found Fallback）
 *
 * 背景：LLM 幻觉调用不存在的工具名时，SDK v2 的 tools/call 分发
 * （mcp-DXXb3Vv3.mjs setToolRequestHandlers）会直接抛出
 * ProtocolError(-32602, "Tool xxx not found")——Agent 只收到裸错误、
 * 看不到正确工具名，幻觉会反复发生；SDK 无任何内置兜底钩子
 * （fallbackRequestHandler 只对未注册的 method 生效，tools/call
 * 永远有 handler）。
 *
 * 方案：在所有 registerTool 完成之后，替换底层 Server 的 tools/call
 * 分发——已知工具原样委托内建 handler（行为零变化），未知工具返回
 * isError 工具结果 + did-you-mean 建议（Levenshtein 相似度 + 别名表）。
 *
 * 安全红线：包装安装失败（SDK 内部结构变化）时仅告警并跳过，
 * 绝不影响已知工具分发。
 * ─────────────────────────────────────────────────────────────
 */

/** 常见幻觉/直觉工具名 → 规范原语/工具名注册表（集中维护，禁止内联到函数体） */
export const TOOL_ALIASES: Record<string, string> = {
  // 结构大纲类 → outline
  list_documents: 'outline',
  list_docs: 'outline',
  list_doc: 'outline',
  list_tool: 'outline',
  toc: 'outline',
  get_outline: 'outline',
  show_outline: 'outline',
  table_of_contents: 'outline',

  // 正文读取类 → read
  get_document: 'read',
  get_doc: 'read',
  read_doc: 'read',
  read_section: 'read',
  cat_document: 'read',
  view_document: 'read',

  // 检索类 → search
  search_docs: 'search',
  search_doc: 'search',
  search_architecture: 'search',
  search_code_examples: 'search',
  search_across_hub: 'search',
  concept_search: 'search',

  // 资源与书架发现 → list_resources
  list_tutorials: 'list_resources',
  list_tutorial: 'list_resources',
  get_tutorial_detail: 'read',

  // 概念图谱与课程路线 → explore_concept
  get_concept_details: 'explore_concept',
  concept_details: 'explore_concept',
  concept_neighbors: 'explore_concept',
  learning_path: 'explore_concept',
  course_map: 'explore_concept',
  skill_coverage: 'explore_concept',
  recommend_tutorial: 'explore_concept',

  // 破坏性变更 → check_breaking_changes
  breaking_changes: 'check_breaking_changes',
  breaking_change: 'check_breaking_changes',
  check_breaking_change: 'check_breaking_changes',


  // 代码符号检索 → search_symbols
  find_symbols: 'search_symbols',
  symbol_search: 'search_symbols',
  search_symbol: 'search_symbols',
  find_symbol: 'search_symbols',

  // 符号精确读取 → read_symbol
  symbol: 'read_symbol',
  get_symbol: 'read_symbol',
  inspect_symbol: 'read_symbol',
  get_code_context: 'read_symbol',
  lookup_symbol: 'read_symbol',

  // 原始源码文件读取 → read_source_file
  get_file: 'read_source_file',
  read_file: 'read_source_file',
  read_code: 'read_source_file',
  get_source: 'read_source_file',
  cat_file: 'read_source_file',
  view_source: 'read_source_file',

  // 章节版本市场 → list_chapter_versions
  list_versions: 'list_chapter_versions',
  chapter_versions: 'list_chapter_versions',
  list_chapter_version: 'list_chapter_versions',
  get_versions: 'list_chapter_versions',

  // 代码解剖 → dissect_code
  dissect: 'dissect_code',
  dissect_file: 'dissect_code',
  code_diagram: 'dissect_code',
  visualize_code: 'dissect_code',

  // 事实测谎与核验 → verify_claim
  verify: 'verify_claim',
  verify_fact: 'verify_claim',
  check_claim: 'verify_claim',
  fact_check: 'verify_claim',
  verify_code: 'verify_claim',
};

/** 建议候选的最小相似度阈值：低于视为无关名，不给出误导向建议 */
const MIN_SUGGESTION_RATIO = 0.55;

/** 最多给出的建议数 */
const MAX_SUGGESTIONS = 3;

/**
 * Levenshtein 编辑距离（经典 DP，无第三方依赖）。
 * 用例：(“search_doc”, “search_docs”) → 1；(“foo”, “bar”) → 3。
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

/** 归一化相似度比值 0~1：1 - 编辑距离 / 较长串长度 */
export function similarityRatio(a: string, b: string): number {
  const len = Math.max(a.length, b.length);
  if (len === 0) return 1;
  return 1 - levenshteinDistance(a, b) / len;
}

/**
 * 构建未知工具兜底结果：isError 工具结果 + did-you-mean 建议。
 * 命中别名表的候选加权优先；无任何候选时附完整工具清单。
 */
export function buildUnknownToolResult(requestedName: string, toolNames: string[], label: string) {
  const normalized = requestedName.toLowerCase().trim();
  const aliasTarget = TOOL_ALIASES[normalized];

  const scored = toolNames
    .map((name) => {
      const base = similarityRatio(normalized, name.toLowerCase());
      const score = aliasTarget === name ? Math.min(0.95, base + 0.25) : base;
      return { name, score };
    })
    .filter(({ score }) => score >= MIN_SUGGESTION_RATIO)
    .sort((a, b) => b.score - a.score);

  const suggestions = scored.slice(0, MAX_SUGGESTIONS);

  let text = `Error: Tool "${requestedName}" not found in ${label}.`;
  if (suggestions.length > 0) {
    text += `\n\nDid you mean:\n${suggestions.map((s) => `- ${s.name}`).join('\n')}`;
  } else {
    text += `\n\nAvailable tools: ${toolNames.join(', ')}.`;
  }
  text += `\n\nList all available tools anytime with the MCP tools/list request.`;

  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  };
}

/**
 * 包装 server 的 tools/call 分发：未知工具名返回 isError 建议结果。
 * 必须在所有 registerTool 调用完成之后调用（此时内建 handler 已安装）。
 */
export function installUnknownToolFallback(server: McpServer, opts: { label: string }): void {
  try {
    // 取底层 Server 实例与内建 tools/call handler（SDK 2.0 内部结构，
    // 通过 _requestHandlers Map 访问；与 simulate 路由访问 _registeredTools 同一模式）
    const protocol = (server as any).server;
    const builtInCallHandler = protocol?._requestHandlers?.get('tools/call');
    if (typeof builtInCallHandler !== 'function') {
      console.warn(`[MCP] tools/call built-in handler not found; unknown-tool fallback skipped for ${opts.label}`);
      return;
    }

    // 工具名清单在安装时快照（工具注册全部完成后调用，禁止硬编码工具清单）
    const toolNames = Object.keys((server as any)._registeredTools ?? {});

    protocol.removeRequestHandler('tools/call');
    protocol.setRequestHandler('tools/call', async (request: any, ctx: any) => {
      const name = request?.params?.name;
      if (typeof name === 'string' && !(server as any)._registeredTools[name]) {
        // 未知工具：遥测记 ERROR（幻觉频率可观测）+ 返回 isError 建议结果
        recordMcpToolError({
          toolName: name,
          query: JSON.stringify(request?.params?.arguments ?? {}).slice(0, 200),
          responseTimeMs: 0,
          errorMessage: `Tool not found: ${name}`,
        });
        return buildUnknownToolResult(name, toolNames, opts.label);
      }
      // 已知工具：原样委托内建 handler（含 schema 校验 / 输出投影等全部内建行为）
      return builtInCallHandler(request, ctx);
    });
  } catch (error) {
    // 安全红线：包装失败仅告警跳过，绝不影响已知工具分发
    console.warn(`[MCP] Failed to install unknown-tool fallback for ${opts.label}:`, error);
  }
}
