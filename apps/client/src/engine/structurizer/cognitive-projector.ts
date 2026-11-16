/**
 * src/engine/structurizer/cognitive-projector.ts
 *
 * Cognitive Gradient 类型契约（Tier 3）。
 * 投影计算已全量下沉 Go worker-sidecar（internal/cognitive/projector.go，
 * PageRank-mass 四阶段投票，非文件数投票：孤立 bootstrap 不再劫持 Phase 1）。
 * 本文件仅保留跨端认知元数据类型，供 architecture-skeleton 生成 Mermaid 骨架图消费。
 * （2026-11 死代码清算：TS 侧认知 Prompt 组装函数随投影下沉一并移除。）
 */

type CognitivePhase =
  | 'phase1_perception'
  | 'phase2_entity'
  | 'phase3_pipeline'
  | 'phase4_adapter';

/** Golden symbol reference projected into module metadata and lesson prompts. */
export interface ModuleGoldenSymbol {
  name: string;
  file: string;
  kind: 'function' | 'type';
}

/** One high-confidence call step (both endpoints verified in the graph builder). */
interface ModuleCallStep {
  caller: string;
  callee: string;
  calleeFile?: string;
}

/** Cognitive metadata attached to a persisted module snapshot (repoProfile.codeClusters). */
export interface ModuleCognition {
  phase: CognitivePhase;
  phaseOrder: number;
  rationale: string;
  /** Modules this one depends on, by module name. */
  upstreamModules: string[];
  /** Modules that depend on this one, by module name. */
  downstreamModules: string[];
  /** Golden symbols (top imported bindings by importer PageRank mass). */
  goldenSymbols?: ModuleGoldenSymbol[];
  /** Observed high-confidence call flow within the module. */
  callFlow?: ModuleCallStep[];
}
