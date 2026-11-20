import { runLlmGatewayGenerate } from '@/lib/llm-gateway/service';
import {
  assembleEnrichedMermaid,
  type MacroTopology,
  type DiagramLlmOutput,
} from '@/lib/mermaid/macro-topology-assembler';

export { assembleEnrichedMermaid };
export type { MacroTopology };

/**
 * 宏观架构图 LLM 语义润色服务。
 * 遵循确定性收敛漏斗 (Deterministic Convergence Funnel)：
 * 1. 物理拓扑由 Go 端提供事实边界；
 * 2. LLM 网关以 kind: 'structured' 产出强类型 JSON 语义字典；
 * 3. 确定性组装器将其融合为安全的 Mermaid 文本；
 * 4. 任何异常、超时或无 key 场景，无损回退至 topo.rawMermaid，永不白屏。
 */
export async function enrichMacroTopologyWithLlm(
  topo: MacroTopology,
  repoName: string,
  userId?: string | null,
  targetLanguage: string = 'zh-CN',
): Promise<MacroTopology> {
  if (!topo || !Array.isArray(topo.nodes) || topo.nodes.length === 0) {
    return topo;
  }

  try {
    const res = await runLlmGatewayGenerate({
      purpose: 'diagram_architecture_macro_v1',
      userId: userId ?? null,
      variables: {
        repoName,
        scope: topo.scope,
        scale: topo.scale,
        strategy: topo.strategy,
        targetLanguage,
        nodes: topo.nodes,
        edges: topo.edges,
        rawMermaid: topo.rawMermaid,
      },
    });

    if (res.ok && res.object) {
      const llmOutput = res.object as DiagramLlmOutput;
      const enrichedMermaid = assembleEnrichedMermaid(topo, llmOutput);
      return {
        ...topo,
        mermaid: enrichedMermaid,
        summary: llmOutput.summary || topo.summary,
      };
    }
    // 密钥类故障静默降级是既定口径（着色属非关键增强），但需留排查痕迹
    if (!res.ok && (res.code === 'MISSING_API_KEY' || res.code === 'KEY_DECRYPT_FAILED')) {
      console.warn(`[MacroTopologyEnricher] key-unavailable (${res.code}), keeping raw mermaid skeleton`);
    }
  } catch (err) {
    console.warn('[MacroTopologyEnricher] LLM enrichment error, falling back to physical skeleton:', err);
  }

  return {
    ...topo,
    mermaid: topo.rawMermaid,
  };
}
