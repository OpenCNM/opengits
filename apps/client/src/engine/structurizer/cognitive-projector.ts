type CognitivePhase =
  | 'phase1_perception'
  | 'phase2_entity'
  | 'phase3_pipeline'
  | 'phase4_adapter';

export interface ModuleGoldenSymbol {
  name: string;
  file: string;
  kind: 'function' | 'type';
}

interface ModuleCallStep {
  caller: string;
  callee: string;
  calleeFile?: string;
}

export interface ModuleCognition {
  phase: CognitivePhase;
  phaseOrder: number;
  rationale: string;
  upstreamModules: string[];
  downstreamModules: string[];
  goldenSymbols?: ModuleGoldenSymbol[];
  callFlow?: ModuleCallStep[];
}
