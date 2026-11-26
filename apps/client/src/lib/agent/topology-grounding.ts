import { callSidecar } from '../sidecar-client';
import { ignoreBestEffort } from '@/lib/best-effort';
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

  if (currentPath && currentPath !== 'Unknown') {
    let clean = currentPath.trim();
    if (owner && repo) {
      clean = clean.replace(new RegExp(`^/?(?:docs/)?${owner}/${repo}/?`), '');
    }
    clean = clean.replace(/^\/?docs\//, '').replace(/^\.\//, '').replace(/^\/+/, '');
    
    const ext = clean.split('.').pop()?.toLowerCase();
    if (ext && COMMON_CODE_EXTENSIONS.has(ext)) {
      candidatePath = clean;
    }
  }

  if (!candidatePath && query) {
    const pathMatch = query.match(/(?:[\w.-]+\/)+[\w.-]+\.(?:[a-zA-Z0-9]+)/);
    if (pathMatch) {
      const ext = pathMatch[0].split('.').pop()?.toLowerCase();
      if (ext && COMMON_CODE_EXTENSIONS.has(ext)) {
        candidatePath = pathMatch[0];
      }
    }
  }

  if (!candidatePath && topDocPath) {
    let cleanTop = topDocPath.replace(/^\.\//, '').replace(/^\/+/, '');
    const ext = cleanTop.split('.').pop()?.toLowerCase();
    if (ext && COMMON_CODE_EXTENSIONS.has(ext)) {
      candidatePath = cleanTop;
    }
  }

  if (query) {
    const backtickMatch = query.match(/`([a-zA-Z_][a-zA-Z0-9_]*)`/);
    if (backtickMatch && !RESERVED_STOPWORDS.has(backtickMatch[1].toLowerCase())) {
      candidateSymbol = backtickMatch[1];
    }

    if (!candidateSymbol) {
      const callMatch = query.match(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
      if (callMatch && !RESERVED_STOPWORDS.has(callMatch[1].toLowerCase())) {
        candidateSymbol = callMatch[1];
      }
    }

    if (!candidateSymbol) {
      const defMatch = query.match(/\b(?:function|func|def|class|type|interface)\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
      if (defMatch && !RESERVED_STOPWORDS.has(defMatch[1].toLowerCase())) {
        candidateSymbol = defMatch[1];
      }
    }

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

    if (!candidateSymbol && query.includes('explain_selection')) {
      try {
        const parsed = JSON.parse(query);
        const text = (parsed.text || '').trim();
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(text) && !RESERVED_STOPWORDS.has(text.toLowerCase())) {
          candidateSymbol = text;
        }
      } catch {
      }
    }
  }

  return {
    path: candidatePath,
    symbol: candidateSymbol,
  };
}

// Fail-open: topology slice enriches chat context and must never block the main response.
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
    ignoreBestEffort(err);
    return null;
  }
}

export function formatTopologyGroundingPrompt(slice: TopologySliceResponse): string {
  if (!slice.found || !slice.topologyText || !slice.topologyText.trim()) {
    return '';
  }

  return `=== [PHYSICAL CODE TOPOLOGY GROUNDING (Verified Call Graph & AST Symbols)] ===
The following physical code topology fact was deterministically extracted from the repository's AST call graph (PageRank, verified callers & callees). Ground your technical explanations and call relationships strictly on these physical facts:

${slice.topologyText.trim()}`;
}
