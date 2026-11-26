import { McpServer } from '@modelcontextprotocol/server';
import { recordMcpToolError } from '@/lib/telemetry/mcp-beacon';

export const TOOL_ALIASES: Record<string, string> = {
  outline: 'browse',
  list_resources: 'browse',
  list_repositories: 'browse',
  list_repos: 'browse',
  list_documents: 'browse',
  list_docs: 'browse',
  list_doc: 'browse',
  list_tool: 'browse',
  toc: 'browse',
  get_outline: 'browse',
  show_outline: 'browse',
  table_of_contents: 'browse',
  list_tutorials: 'browse',
  list_tutorial: 'browse',
  course_map: 'browse',
  skill_coverage: 'browse',
  recommend_tutorial: 'browse',

  read_document: 'read',
  get_document: 'read',
  get_doc: 'read',
  read_doc: 'read',
  read_section: 'read',
  cat_document: 'read',
  view_document: 'read',
  get_tutorial_detail: 'read',
  explore_concept: 'read',
  get_concept_details: 'read',
  concept_details: 'read',
  concept_neighbors: 'read',
  learning_path: 'read',

  search_docs: 'search',
  search_doc: 'search',
  search_architecture: 'search',
  search_code_examples: 'search',
  search_across_hub: 'search',
  concept_search: 'search',
  check_breaking_changes: 'search',
  breaking_changes: 'search',
  breaking_change: 'search',
  check_breaking_change: 'search',
  search_symbols: 'search',
  find_symbols: 'search',
  symbol_search: 'search',
  search_symbol: 'search',
  find_symbol: 'search',

  read_symbol: 'read_code',
  symbol: 'read_code',
  get_symbol: 'read_code',
  inspect_symbol: 'read_code',
  get_code_context: 'read_code',
  lookup_symbol: 'read_code',
  read_source_file: 'read_code',
  get_file: 'read_code',
  read_file: 'read_code',
  get_source: 'read_code',
  cat_file: 'read_code',
  view_source: 'read_code',
};

const MIN_SUGGESTION_RATIO = 0.55;

const MAX_SUGGESTIONS = 3;

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

export function similarityRatio(a: string, b: string): number {
  const len = Math.max(a.length, b.length);
  if (len === 0) return 1;
  return 1 - levenshteinDistance(a, b) / len;
}

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

export function installUnknownToolFallback(server: McpServer, opts: { label: string }): void {
  try {
    // Patches underlying Protocol tools/call handler because SDK fallbackRequestHandler skips registered methods.
    const protocol = (server as any).server;
    const builtInCallHandler = protocol?._requestHandlers?.get('tools/call');
    if (typeof builtInCallHandler !== 'function') {
      console.warn(`[MCP] tools/call built-in handler not found; unknown-tool fallback skipped for ${opts.label}`);
      return;
    }

    const toolNames = Object.keys((server as any)._registeredTools ?? {});

    protocol.removeRequestHandler('tools/call');
    protocol.setRequestHandler('tools/call', async (request: any, ctx: any) => {
      const name = request?.params?.name;
      if (typeof name === 'string' && !(server as any)._registeredTools[name]) {
        recordMcpToolError({
          toolName: name,
          query: JSON.stringify(request?.params?.arguments ?? {}).slice(0, 200),
          responseTimeMs: 0,
          errorMessage: `Tool not found: ${name}`,
        });
        return buildUnknownToolResult(name, toolNames, opts.label);
      }
      return builtInCallHandler(request, ctx);
    });
  } catch (error) {
    console.warn(`[MCP] Failed to install unknown-tool fallback for ${opts.label}:`, error);
  }
}
