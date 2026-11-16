/**
 * apps/client/src/lib/agent/topology-grounding.ts
 *
 * 确定性代码拓扑切片与 Frame-0 物理事实网关（战役三）。
 *
 * 核心设计原则：
 * 1. 非对称计算（Cognitive Budget & CDC）：微秒级提取落盘 RSG 的 1-hop 调用链与 AST 符号，
 *    以确定性事实短路大模型的幻觉与盲猜；
 * 2. 认知预算严格守恒（Token Budget <= 300 tokens）：紧凑骨架 Markdown，严控上下文开销；
 * 3. 弹性降级（Fail-Open Resilience）：图谱缺失、超规巨仓或 Sidecar 请求超时（500ms），
 *    自动静默降级，不阻塞任何主对话。
 */

import { callSidecar } from '../sidecar-client';
import { parseExplainCodePayload } from '@/lib/code-viewport/explain-context';

export interface TopologySliceRequest {
  owner: string;
  repo: string;
  sha?: string;
  path: string;
  symbol?: string;
  line?: number;
}

export interface CallEdgeInfo {
  callerFile: string;
  callerSymbol: string;
  calleeFile: string;
  calleeSymbol: string;
  line: number;
}

export interface SymbolEntryInfo {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface TopologySliceResponse {
  found: boolean;
  filePath: string;
  targetSymbol?: SymbolEntryInfo;
  role?: string;
  pageRank?: number;
  callers: CallEdgeInfo[];
  callees: CallEdgeInfo[];
  peerSymbols: Array<{ name: string; kind: string }>;
  topologyText: string;
}

const COMMON_CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'go', 'py', 'rs', 'java', 'c', 'cpp', 'cc', 'h', 'hpp',
  'cs', 'rb', 'php', 'swift', 'kt', 'dart'
]);

const RESERVED_STOPWORDS = new Set([
  'what', 'how', 'why', 'when', 'where', 'who', 'does', 'this', 'that', 'with',
  'from', 'into', 'about', 'call', 'calls', 'called', 'code', 'file', 'function',
  'method', 'class', 'type', 'const', 'true', 'false', 'null', 'undefined'
]);

/**
 * 从当前路径、检索结果或查询中探测目标源码路径与符号名。
 */
export function detectTopologyTarget(params: {
  currentPath?: string;
  query?: string;
  topDocPath?: string;
  owner?: string;
  repo?: string;
}): { path?: string; symbol?: string } {
  let candidatePath: string | undefined;
  let candidateSymbol: string | undefined;

  const { currentPath, query, topDocPath, owner, repo } = params;

  // 1. 规范化并探测 currentPath
  if (currentPath && currentPath !== 'Unknown') {
    let clean = currentPath.trim();
    if (owner && repo) {
      clean = clean.replace(new RegExp(`^/?(?:docs/)?${owner}/${repo}/?`), '');
    }
    clean = clean.replace(/^\/?docs\//, '').replace(/^\.\//, '').replace(/^\/+/, '');
    
    // 检查是否有源码后缀
    const ext = clean.split('.').pop()?.toLowerCase();
    if (ext && COMMON_CODE_EXTENSIONS.has(ext)) {
      candidatePath = clean;
    }
  }

  // 2. 若 query 中直接包含类似 src/index.ts 的路径
  if (!candidatePath && query) {
    const pathMatch = query.match(/(?:[\w.-]+\/)+[\w.-]+\.(?:[a-zA-Z0-9]+)/);
    if (pathMatch) {
      const ext = pathMatch[0].split('.').pop()?.toLowerCase();
      if (ext && COMMON_CODE_EXTENSIONS.has(ext)) {
        candidatePath = pathMatch[0];
      }
    }
  }

  // 3. 兜底回落至知识库检索出的 Top-1 结果
  if (!candidatePath && topDocPath) {
    let cleanTop = topDocPath.replace(/^\.\//, '').replace(/^\/+/, '');
    const ext = cleanTop.split('.').pop()?.toLowerCase();
    if (ext && COMMON_CODE_EXTENSIONS.has(ext)) {
      candidatePath = cleanTop;
    }
  }

  // 4. 探测符号候选
  if (query) {
    // 优先检查反引号中的标识符: `emit`
    const backtickMatch = query.match(/`([a-zA-Z_][a-zA-Z0-9_]*)`/);
    if (backtickMatch && !RESERVED_STOPWORDS.has(backtickMatch[1].toLowerCase())) {
      candidateSymbol = backtickMatch[1];
    }

    // 其次检查调用语法: emit() 或 dispatch(...)
    if (!candidateSymbol) {
      const callMatch = query.match(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
      if (callMatch && !RESERVED_STOPWORDS.has(callMatch[1].toLowerCase())) {
        candidateSymbol = callMatch[1];
      }
    }

    // 再次检查声明语法: function emit / def calculate
    if (!candidateSymbol) {
      const defMatch = query.match(/\b(?:function|func|def|class|type|interface)\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
      if (defMatch && !RESERVED_STOPWORDS.has(defMatch[1].toLowerCase())) {
        candidateSymbol = defMatch[1];
      }
    }

    // 检查代码块解释 JSON: {"type":"explain_code","code":"...","filePath":"...","symbol":"..."}
    const codeExplain = parseExplainCodePayload(query);
    if (codeExplain) {
      if (!candidatePath && codeExplain.filePath) {
        const cleanFilePath = codeExplain.filePath.replace(/^\.\//, '').replace(/^\/+/, '');
        const ext = cleanFilePath.split('.').pop()?.toLowerCase();
        if (ext && COMMON_CODE_EXTENSIONS.has(ext)) {
          candidatePath = cleanFilePath;
        }
      }
      if (!candidateSymbol && codeExplain.symbol) {
        candidateSymbol = codeExplain.symbol;
      }
    }

    // 检查选中文本 JSON: {"type":"explain_selection","text":"..."}
    if (!candidateSymbol && query.includes('explain_selection')) {
      try {
        const parsed = JSON.parse(query);
        const text = (parsed.text || '').trim();
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(text) && !RESERVED_STOPWORDS.has(text.toLowerCase())) {
          candidateSymbol = text;
        }
      } catch {
        // 忽略非 JSON
      }
    }
  }

  return {
    path: candidatePath,
    symbol: candidateSymbol,
  };
}

/**
 * 向 Go worker-sidecar 请求拓扑切片（Fail-Open，超时或异常返回 null）。
 */
export async function fetchTopologySlice(
  params: TopologySliceRequest,
  options?: { timeoutMs?: number }
): Promise<TopologySliceResponse | null> {
  if (!params.owner || !params.repo || !params.path) {
    return null;
  }

  try {
    const timeoutMs = options?.timeoutMs ?? 500;
    const res = await callSidecar<TopologySliceResponse>(
      '/v1/graph/slice-context',
      params,
      {
        label: 'rsg /v1/graph/slice-context',
        timeoutMs,
      }
    );
    if (res && res.found) {
      return res;
    }
    return null;
  } catch (err) {
    // Fail-Open：拓扑切片仅作为事实增强，绝对不阻断主对话
    return null;
  }
}

/**
 * 组装注入 Prompt 的事实骨架文本。
 */
export function formatTopologyGroundingPrompt(slice: TopologySliceResponse): string {
  if (!slice.found || !slice.topologyText || !slice.topologyText.trim()) {
    return '';
  }

  return `=== [PHYSICAL CODE TOPOLOGY GROUNDING (Verified Call Graph & AST Symbols)] ===
The following physical code topology fact was deterministically extracted from the repository's AST call graph (PageRank, verified callers & callees). Ground your technical explanations and call relationships strictly on these physical facts:

${slice.topologyText.trim()}`;
}
