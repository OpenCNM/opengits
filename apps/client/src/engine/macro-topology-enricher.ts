import { runLlmGatewayGenerate } from '@/lib/llm-gateway/service';
import {
  assembleEnrichedMermaid,
  type MacroTopology,
  type DiagramLlmOutput,
} from '@/lib/mermaid/macro-topology-assembler';

export { assembleEnrichedMermaid };
export type { MacroTopology };

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
