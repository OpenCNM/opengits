export interface NodePayload {
  lines?: [number, number];
  description?: string;
  codeSnippet?: string;
}

export interface GraphNode {
  id: string;
  label: string;
  payload?: NodePayload;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface ParsedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function parseMermaidToGraph(mermaidCode: string, codeText?: string): ParsedGraph {
  if (!mermaidCode) return { nodes: [], edges: [] };

  const nodesMap = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const lines = mermaidCode.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();

    const payloadMatch = line.match(/^%%\s*@Payload\s*\[(.*?)\]\s*:\s*(\{.*\})$/i);
    if (payloadMatch) {
      const nodeId = payloadMatch[1].trim();
      try {
        const payloadData: NodePayload = JSON.parse(payloadMatch[2]);
        
        if (codeText && payloadData.lines && payloadData.lines.length === 2) {
          const [start, end] = payloadData.lines;
          const codeLines = codeText.split(/\r?\n/);
          // Convert 1-indexed LLM line numbers to 0-indexed array slices.
          payloadData.codeSnippet = codeLines.slice(Math.max(0, start - 1), end).join('\n');
        }

        const existingNode = nodesMap.get(nodeId);
        if (existingNode) {
          existingNode.payload = payloadData;
        } else {
          nodesMap.set(nodeId, { id: nodeId, label: nodeId, payload: payloadData });
        }
      } catch (e) {
        console.warn(`[MermaidParser] Failed to parse @Payload JSON for node ${nodeId}:`, e);
      }
      continue;
    }

    if (line.startsWith('%%') || /^(?:graph|flowchart|subgraph|end|direction|style|classDef|class|click|linkStyle)\b/i.test(line)) {
      continue;
    }

    const edgeParts = splitMermaidEdges(line);
    if (edgeParts) {
      const { parts, labels } = edgeParts;
      for (let i = 0; i < parts.length - 1; i++) {
        const sourceNodes = splitByAmpersand(parts[i])
          .map(parseNodeDef)
          .filter((n): n is GraphNode => n !== null);
        const targetNodes = splitByAmpersand(parts[i + 1])
          .map(parseNodeDef)
          .filter((n): n is GraphNode => n !== null);
        const edgeLabel = labels[i];

        for (const sourceNode of sourceNodes) {
          if (!nodesMap.has(sourceNode.id)) {
            nodesMap.set(sourceNode.id, sourceNode);
          } else if (sourceNode.label !== sourceNode.id) {
            nodesMap.get(sourceNode.id)!.label = sourceNode.label;
          }
        }

        for (const targetNode of targetNodes) {
          if (!nodesMap.has(targetNode.id)) {
            nodesMap.set(targetNode.id, targetNode);
          } else if (targetNode.label !== targetNode.id) {
            nodesMap.get(targetNode.id)!.label = targetNode.label;
          }
        }

        for (const sourceNode of sourceNodes) {
          for (const targetNode of targetNodes) {
            edges.push({
              id: `e-${sourceNode.id}-${targetNode.id}`,
              source: sourceNode.id,
              target: targetNode.id,
              label: edgeLabel,
            });
          }
        }
      }
      continue;
    }

    const standaloneNodes = splitByAmpersand(line)
      .map(parseNodeDef)
      .filter((n): n is GraphNode => n !== null);
    for (const standaloneNode of standaloneNodes) {
      if (!nodesMap.has(standaloneNode.id)) {
        nodesMap.set(standaloneNode.id, standaloneNode);
      } else if (standaloneNode.label !== standaloneNode.id) {
        nodesMap.get(standaloneNode.id)!.label = standaloneNode.label;
      }
    }
  }

  return {
    nodes: Array.from(nodesMap.values()),
    edges,
  };
}

function splitByAmpersand(str: string): string[] {
  if (!str) return [];
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  let depth = 0;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (inQuotes) {
      current += char;
      if (char === quoteChar && str[i - 1] !== '\\') {
        inQuotes = false;
      }
    } else if (char === '"' || char === "'") {
      inQuotes = true;
      quoteChar = char;
      current += char;
    } else if (char === '[' || char === '(' || char === '{') {
      depth++;
      current += char;
    } else if (char === ']' || char === ')' || char === '}') {
      if (depth > 0) depth--;
      current += char;
    } else if (char === '&' && depth === 0) {
      if (current.trim()) {
        result.push(current.trim());
      }
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    result.push(current.trim());
  }
  return result.length > 0 ? result : [str.trim()];
}

const CONNECTOR_RE = /\s*(?:--(?![-oox>])\s*([^\r\n]+?)\s*(?:-->|---)|==(?!=[=>])\s*([^\r\n]+?)\s*(?:==>|===)|-\.(?!\.)\s*([^\r\n]+?)\s*(?:-\.->|-\.-|\.->|\.-)|(?:-->|---|==>|===|-\.->|-.-|<-->|<--|<==>|--o|o--|o--o|--x|x--|x--x)\s*(?:\|(.*?)\|)?)\s*/g;

function isInsideQuotes(line: string, index: number): boolean {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < index; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    }
  }
  return inDouble || inSingle;
}

function splitMermaidEdges(line: string): { parts: string[]; labels: (string | undefined)[] } | null {
  CONNECTOR_RE.lastIndex = 0;
  const parts: string[] = [];
  const labels: (string | undefined)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CONNECTOR_RE.exec(line)) !== null) {
    if (isInsideQuotes(line, match.index)) {
      continue;
    }
    const nodeStr = line.slice(lastIndex, match.index).trim();
    parts.push(nodeStr);
    const label = (match[1] || match[2] || match[3] || match[4] || '').trim() || undefined;
    labels.push(label);
    lastIndex = CONNECTOR_RE.lastIndex;
  }

  const lastNodeStr = line.slice(lastIndex).trim();
  if (parts.length > 0 && lastNodeStr) {
    parts.push(lastNodeStr);
    return { parts, labels };
  }
  return null;
}

const DELIMITER_PAIRS: [string, string][] = [
  ['([', '])'],
  ['[(', ')]'],
  ['(((', ')))'],
  ['((', '))'],
  ['[[', ']]'],
  ['{{', '}}'],
  ['[/', '/]'],
  ['[\\', '\\]'],
  ['[/', '\\]'],
  ['[\\', '/]'],
  ['>[', ']'],
  ['>', ']'],
  ['{', '}'],
  ['[', ']'],
  ['(', ')'],
];

function extractInnerLabel(rest: string): string {
  if (!rest) return '';
  let trimmed = rest.trim();

  for (const [open, close] of DELIMITER_PAIRS) {
    if (trimmed.startsWith(open) && trimmed.endsWith(close)) {
      trimmed = trimmed.slice(open.length, trimmed.length - close.length).trim();
      break;
    }
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  return trimmed.replace(/\\"/g, '"').replace(/\\'/g, "'");
}

export function parseNodeDef(raw: string): GraphNode | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const idMatch = trimmed.match(/^([a-zA-Z0-9_\u4e00-\u9fa5-]+)/);
  if (!idMatch) return null;

  const id = idMatch[1].trim();
  const rest = trimmed.slice(id.length).trim();
  if (!rest) {
    return { id, label: id };
  }

  const label = extractInnerLabel(rest) || id;
  return { id, label };
}

export function generateFallbackMermaid(codeText: string): string {
  const codeLines = codeText ? codeText.split(/\r?\n/) : [];
  const total = codeLines.length;

  if (total === 0) {
    return `graph LR\n  A["基础逻辑组装"]\n  %% @Payload[A]: {"description": "通用代码逻辑", "lines": [1, 1]}`;
  }

  const end1 = Math.min(3, total);
  const end2 = Math.min(8, total);

  return `graph LR
  A["模块初始化 & 环境加载"]
  B["数据处理 & 核心业务逻辑"]
  C["结果输出 & 逻辑控制"]
  A --> B
  B --> C
  %% @Payload[A]: {"description": "初始化资源、读取配置与环境变量", "lines": [1, ${end1}]}
  %% @Payload[B]: {"description": "执行核心数据转换与业务算法处理", "lines": [${Math.min(end1 + 1, total)}, ${end2}]}
  %% @Payload[C]: {"description": "控制程序流向、返回或格式化数据输出", "lines": [${Math.min(end2 + 1, total)}, ${total}]}`;
}
