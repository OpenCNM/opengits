import { describe, it, expect } from 'vitest';
import { generateFallbackMermaid, parseMermaidToGraph } from '@/lib/mermaid/mermaidParser';

describe('M03 [3.5] 代码透视剖析 (Dissection) 缓存与视图', () => {
  // 🧪 [3.5.1.1 · LOW] 空白归一化缓存指纹用例已随 /api/dissect 端点下线退役
  // （端点仓内零消费；MCP dissect 走 sidecar 直连不经 HTTP）

  // 🧪 [3.5.2.1 · MEDIUM] 复杂递归代码生成环路 Mermaid 导致渲染卡死
  // AntiPattern: 无步数上限递归拆解
  // DefenseAssertion: 拆解步骤上限钳制在 maxSteps <= 8 步，超出自动聚合折叠
  it('3.5.2.1 步骤上限钳制：兜底 Mermaid 流程图步骤强限制 <= 8 步', () => {
    const longCode = Array.from({ length: 40 }, (_, i) => `step_${i}();`).join('\n');
    const mermaid = generateFallbackMermaid(longCode);

    expect(mermaid).toMatch(/graph (LR|TD)/);
    const graph = parseMermaidToGraph(mermaid);
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.nodes.length).toBeLessThanOrEqual(8);
  });

  // 🧪 [3.5.3.1 · LOW] 行号越界 (如高亮 Line 999 但代码只有 50 行) 导致视图报错
  // AntiPattern: 直接根据行号 DOM querySelector 抛错
  // DefenseAssertion: 安全行号钳位与可选链查询，越界时自动高亮首行或安全忽略
  it('3.5.3.1 行号越界容错：Mermaid @Payload 携带越界行号时安全切片不崩溃', () => {
    const codeText = 'const a = 1;\nconst b = 2;\nconst c = 3;'; // 仅 3 行
    const mermaidWithOverflow = `graph TD
      A[Start] --> B[Overflow Step]
      %% @Payload[B]: {"description": "Step details", "lines": [10, 999]}
    `;

    // 动态代码切片处理越界行号
    const graph = parseMermaidToGraph(mermaidWithOverflow, codeText);
    expect(graph.nodes).toHaveLength(2);

    const nodeB = graph.nodes.find((n) => n.id === 'B');
    expect(nodeB).toBeDefined();
    expect(nodeB?.payload?.description).toBe('Step details');
    // slice(Math.max(0, 10 - 1), 999) 超出范围时切片为空串，安全降级不报 uncaught exception
    expect(nodeB?.payload?.codeSnippet).toBe('');
  });
});
