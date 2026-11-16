/**
 * apps/client/src/engine/dissect-driver.ts
 *
 * Go worker-sidecar 代码切片 (Dissection) 纯 CPU AST 投影驱动层。
 * 遵循 Fail-Closed 与平滑降级设计：优先调用 Sidecar Wazero Tree-sitter 原生端点，
 * 若 Sidecar 异常或超时，自动切换至快速语义分段，保障前台交互永远可用。
 */

import { callSidecar } from '@/lib/sidecar-client';

interface DissectNode {
  id: string;
  label: string;
  kind: 'function' | 'branch' | 'loop' | 'call' | 'return' | 'block';
  startLine: number;
  endLine: number;
  description: string;
}

interface DissectEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

interface DissectAstResult {
  mermaidCode: string;
  nodes: DissectNode[];
  edges: DissectEdge[];
  language: string;
  isAst: boolean;
}

interface ExecuteDissectAstOptions {
  code: string;
  language?: string;
  timeoutMs?: number;
}

/**
 * 快速本地分段降级（仅当 Sidecar 不可达或异常时介入，保证视图绝对不崩溃）
 */
export function fallbackLocalDissect(code: string, language = 'code'): DissectAstResult {
  const lines = code ? code.split(/\r?\n/) : [];
  const total = lines.length || 1;

  if (total <= 3) {
    const node: DissectNode = {
      id: 'N1',
      label: '核心代码逻辑',
      kind: 'block',
      startLine: 1,
      endLine: total,
      description: '执行基础业务逻辑',
    };
    return {
      mermaidCode: `flowchart TD\n  N1["核心代码逻辑"]\n  %% @Payload[N1]: {"description": "执行基础业务逻辑", "lines": [1, ${total}]}`,
      nodes: [node],
      edges: [],
      language,
      isAst: false,
    };
  }

  const s1 = Math.max(1, Math.floor(total / 3));
  const s2 = Math.max(s1 + 1, Math.floor((total * 2) / 3));

  const nodes: DissectNode[] = [
    {
      id: 'N1',
      label: '输入准备与初始化',
      kind: 'block',
      startLine: 1,
      endLine: s1,
      description: '准备输入参数与运行时环境',
    },
    {
      id: 'N2',
      label: '核心运算与状态流转',
      kind: 'block',
      startLine: s1 + 1,
      endLine: s2,
      description: '执行核心数据计算与业务逻辑',
    },
    {
      id: 'N3',
      label: '结果构造与输出返回',
      kind: 'return',
      startLine: s2 + 1,
      endLine: total,
      description: '构造返回值并结束调用',
    },
  ];

  const edges: DissectEdge[] = [
    { id: 'e-N1-N2', source: 'N1', target: 'N2' },
    { id: 'e-N2-N3', source: 'N2', target: 'N3' },
  ];

  const mermaidLines = [
    'flowchart TD',
    '  N1["输入准备与初始化"]',
    '  N2["核心运算与状态流转"]',
    '  N3(["结果构造与输出返回"])',
    '  N1 --> N2',
    '  N2 --> N3',
    `  %% @Payload[N1]: {"description": "准备输入参数与运行时环境", "lines": [1, ${s1}]}`,
    `  %% @Payload[N2]: {"description": "执行核心数据计算与业务逻辑", "lines": [${s1 + 1}, ${s2}]}`,
    `  %% @Payload[N3]: {"description": "构造返回值并结束调用", "lines": [${s2 + 1}, ${total}]}`,
  ];

  return {
    mermaidCode: mermaidLines.join('\n'),
    nodes,
    edges,
    language,
    isAst: false,
  };
}

/**
 * 执行 Sidecar 纯 CPU AST 代码切片分析
 */
export async function executeSidecarDissectAst(
  options: ExecuteDissectAstOptions
): Promise<DissectAstResult> {
  const { code, language = 'code', timeoutMs = 3000 } = options;
  if (!code || !code.trim()) {
    return fallbackLocalDissect('', language);
  }

  try {
    const result = await callSidecar<DissectAstResult>(
      '/v1/dissect/ast',
      { code, language },
      {
        label: 'dissect /v1/dissect/ast',
        timeoutMs,
      }
    );
    if (result && result.mermaidCode && Array.isArray(result.nodes)) {
      return result;
    }
  } catch (err) {
    console.warn('[dissect-driver] Sidecar AST failed, falling back to local dissect:', err);
  }

  return fallbackLocalDissect(code, language);
}
