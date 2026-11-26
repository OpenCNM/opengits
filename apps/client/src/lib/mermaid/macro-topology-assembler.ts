import { stripMermaidDangerousHtml } from './xss-guard';

export interface MacroTopologyNode {
  id: string;
  path: string;
  name: string;
  role?: string;
  fileCount: number;
  loc: number;
  hotness: number;
  topExports?: string[];
  primaryLang?: string;
}

export interface MacroTopologyEdge {
  from: string;
  to: string;
  weight: number;
  symbols?: string[];
  label?: string;
}

export interface MacroTopology {
  scope: string;
  scale: number;
  strategy: string;
  nodes: MacroTopologyNode[];
  edges: MacroTopologyEdge[];
  rawMermaid: string;
  mermaid: string;
  summary?: string;
}

export interface DiagramLlmNode {
  id: string;
  title: string;
  subtitle: string;
  layer?: 'interface' | 'core' | 'infra' | 'storage' | 'utility' | string;
}

export interface DiagramLlmEdge {
  from: string;
  to: string;
  label: string;
}

export interface DiagramLlmOutput {
  nodes?: DiagramLlmNode[];
  edges?: DiagramLlmEdge[];
  summary?: string;
}

function escapeMermaidText(str: string): string {
  return str
    .replace(/"/g, "''")
    .replace(/[[\]{}()]/g, ' ')
    .replace(/[|]/g, '/')
    .trim();
}

function formatLOC(loc: number): string {
  if (loc >= 1000) {
    return `${(loc / 1000).toFixed(1)}k`;
  }
  return String(loc);
}

// Enforces AST node/edge whitelist over LLM topology semantics and fails closed to the raw physical skeleton.
export function assembleEnrichedMermaid(
  topo: MacroTopology,
  llmResult?: DiagramLlmOutput | null
): string {
  if (!topo || !Array.isArray(topo.nodes) || topo.nodes.length === 0) {
    return topo?.rawMermaid || '```mermaid\nflowchart TD\n  empty["Empty Architecture"]\n```';
  }

  if (!llmResult || !Array.isArray(llmResult.nodes) || llmResult.nodes.length === 0) {
    return topo.rawMermaid;
  }

  try {
    const physicalNodesMap = new Map<string, MacroTopologyNode>();
    for (const n of topo.nodes) {
      physicalNodesMap.set(n.id, n);
    }

    const physicalEdgesSet = new Set<string>();
    for (const e of topo.edges || []) {
      physicalEdgesSet.add(`${e.from}->${e.to}`);
    }

    const llmNodesMap = new Map<string, DiagramLlmNode>();
    for (const ln of llmResult.nodes) {
      if (physicalNodesMap.has(ln.id)) {
        llmNodesMap.set(ln.id, ln);
      }
    }

    const llmEdgesMap = new Map<string, string>();
    if (Array.isArray(llmResult.edges)) {
      for (const le of llmResult.edges) {
        const key = `${le.from}->${le.to}`;
        if (physicalEdgesSet.has(key) && le.label?.trim()) {
          llmEdgesMap.set(key, escapeMermaidText(le.label));
        }
      }
    }

    const groups: Record<string, MacroTopologyNode[]> = {
      interface: [],
      core: [],
      infra: [],
      storage: [],
      utility: [],
    };

    for (const n of topo.nodes) {
      const semantic = llmNodesMap.get(n.id);
      let layer = semantic?.layer?.toLowerCase() || n.role?.toLowerCase() || 'core';
      if (!groups[layer]) {
        layer = 'core';
      }
      groups[layer].push(n);
    }

    const lines: string[] = ['```mermaid', 'flowchart TD'];

    const renderGroup = (subId: string, title: string, nodes: MacroTopologyNode[]) => {
      if (!nodes || nodes.length === 0) return;
      lines.push(`  subgraph ${subId}["${title}"]`);
      for (const n of nodes) {
        const sem = llmNodesMap.get(n.id);
        const title = sem?.title ? escapeMermaidText(sem.title) : escapeMermaidText(n.name);
        const sub = sem?.subtitle ? escapeMermaidText(sem.subtitle) : '';

        const nameLine = sub ? `<b>${title}</b><br/>${sub}` : `<b>${title}</b>`;
        const metricLine = n.fileCount > 0 ? `<br/><small>${n.fileCount} files · ${formatLOC(n.loc)} LOC</small>` : '';

        if (n.id.startsWith('ext_')) {
          lines.push(`    ${n.id}(["${title}"])`);
        } else {
          lines.push(`    ${n.id}["${nameLine}${metricLine}"]`);
        }
      }
      lines.push('  end');
    };

    renderGroup('Interface', '接入与交互层 (Interface)', groups.interface);
    renderGroup('Core', '核心业务引擎 (Core Pipeline)', groups.core);
    renderGroup('Storage', '数据存储与模型 (Storage & Models)', groups.storage);
    renderGroup('Infra', '底层基础支持 (Infrastructure)', groups.infra);
    renderGroup('Utility', '通用工具组件 (Utilities)', groups.utility);

    lines.push('');

    for (const e of topo.edges || []) {
      const key = `${e.from}->${e.to}`;
      let label = llmEdgesMap.get(key);
      if (!label) {
        if (e.symbols && e.symbols.length > 0) {
          label = `calls ${e.symbols.slice(0, 2).join(', ')}`;
        } else if (e.weight > 0) {
          label = `calls (${e.weight})`;
        } else {
          label = '';
        }
      }

      if (label) {
        lines.push(`  ${e.from} -->|"${label}"| ${e.to}`);
      } else {
        lines.push(`  ${e.from} --> ${e.to}`);
      }
    }

    lines.push('```');
    return stripMermaidDangerousHtml(lines.join('\n'));
  } catch (err) {
    console.warn('[MacroTopologyAssembler] Error fusing LLM result, falling back to rawMermaid:', err);
    return topo.rawMermaid;
  }
}
