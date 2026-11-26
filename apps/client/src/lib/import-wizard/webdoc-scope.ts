import type { ModuleTab, WebDocScopeParams } from '@/lib/schemas/webdoc-topology';

export type WebDocScoutPhase = 'idle' | 'scouting' | 'ready' | 'failed';
export const WEBDOC_JOURNEY_STAGES = ['input', 'scout', 'confirm', 'crawl', 'done'] as const;
export type WebDocJourneyStage = (typeof WEBDOC_JOURNEY_STAGES)[number];

export interface ResolveWebDocStageInput {
  step: number;
  subStep: 'input' | 'directory_confirm' | 'outline_draft' | 'web_confirm';
  webScoutPhase: WebDocScoutPhase;
  ingestSuccess: boolean;
}

export function resolveWebDocJourneyStage({
  step,
  subStep,
  webScoutPhase,
  ingestSuccess,
}: ResolveWebDocStageInput): WebDocJourneyStage {
  if (step >= 3) {
    return ingestSuccess ? 'done' : 'crawl';
  }
  if (subStep === 'web_confirm') {
    return webScoutPhase === 'ready' ? 'confirm' : 'scout';
  }
  return 'input';
}

export function getWebDocStageIndex(stage: WebDocJourneyStage): number {
  return WEBDOC_JOURNEY_STAGES.indexOf(stage);
}

export type WebDocCrawlStageKey =
  | 'connecting'
  | 'entry'
  | 'fetching'
  | 'deep_fetching'
  | 'assets'
  | 'tree'
  | 'persisting'
  | 'done';

export interface WebDocCrawlProgress {
  percent: number;
  stageKey: WebDocCrawlStageKey;
}

export function resolveWebDocCrawlProgress(
  logs: readonly string[],
  ingestSuccess: boolean,
): WebDocCrawlProgress {
  if (ingestSuccess) {
    return { percent: 100, stageKey: 'done' };
  }
  if (logs.length === 0) {
    return { percent: 12, stageKey: 'connecting' };
  }

  let hasPhase1 = false;
  let phase2TickCount = 0;
  let hasDeepRender = false;
  let hasCrawlDone = false;
  let hasAssets = false;
  let hasTree = false;
  let persistTickCount = 0;

  for (const line of logs) {
    if (line.includes('[1/3]')) hasPhase1 = true;
    if (line.includes('切换 Firecrawl') || line.includes('深度渲染引擎')) {
      hasDeepRender = true;
    }
    if (line.includes('抓取网页文档内容完成')) {
      hasCrawlDone = true;
    } else if (line.includes('[2/3]')) {
      phase2TickCount += 1;
    }
    if (line.includes('持久化同源图片') || line.includes('图片资产')) {
      hasAssets = true;
    }
    if (line.includes('构建文档大纲导航树')) {
      hasTree = true;
    }
    if (line.includes('清洗正文并持久化') || line.includes('文档已入库') || line.includes('Ingestion pipeline completed')) {
      persistTickCount += 1;
    }
  }

  if (persistTickCount > 0) {
    return { percent: Math.min(96, 86 + persistTickCount), stageKey: 'persisting' };
  }
  if (hasTree) {
    return { percent: 82, stageKey: 'tree' };
  }
  if (hasAssets) {
    return { percent: 72, stageKey: 'assets' };
  }
  if (hasCrawlDone) {
    return { percent: 64, stageKey: 'assets' };
  }
  if (hasDeepRender || phase2TickCount > 0) {
    return {
      percent: Math.min(60, 28 + phase2TickCount * 3),
      stageKey: hasDeepRender ? 'deep_fetching' : 'fetching',
    };
  }
  if (hasPhase1) {
    return { percent: 24, stageKey: 'entry' };
  }
  return { percent: 16, stageKey: 'connecting' };
}

export function chipModules(tabs: readonly ModuleTab[]): ModuleTab[] {
  return tabs.filter((t) => t.path.startsWith('/') && t.path.length > 1);
}

export function isUnderPrefix(modulePath: string, primaryDocPrefix: string): boolean {
  if (primaryDocPrefix === '/') return true;
  return modulePath === primaryDocPrefix || modulePath.startsWith(`${primaryDocPrefix}/`);
}

export function isDefaultSelectedModule(
  tab: Pick<ModuleTab, 'kind' | 'path'>,
  primaryDocPrefix: string,
): boolean {
  return (tab.kind === 'doc' || tab.kind === 'api') && isUnderPrefix(tab.path, primaryDocPrefix);
}

export function defaultSelectedPaths(primaryDocPrefix: string, chips: readonly ModuleTab[]): string[] {
  const selected: string[] = [];
  for (const c of chips) {
    if (isDefaultSelectedModule(c, primaryDocPrefix)) {
      selected.push(c.path);
    }
  }
  if (selected.length === 0 && chips.length > 0) {
    selected.push(chips[0].path);
  }
  return selected;
}

export interface WebDocScopeUIState {
  mode: 'recommended' | 'all';
  primaryDocPrefix: string;
  selectedPaths: string[];
  moduleTabs: ModuleTab[];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function buildScopePayload(state: WebDocScopeUIState): WebDocScopeParams {
  if (!state.primaryDocPrefix) {
    return { scopeMode: '', primaryDocPrefix: '', allowedPrefixes: [], moduleTabs: [] };
  }
  if (state.mode === 'all') {
    return { scopeMode: 'all', primaryDocPrefix: '/', allowedPrefixes: ['/'], moduleTabs: state.moduleTabs };
  }
  const chips = chipModules(state.moduleTabs);
  const defaults = defaultSelectedPaths(state.primaryDocPrefix, chips);
  const rawEffective = state.selectedPaths.length > 0 ? state.selectedPaths : defaults;
  const effectiveSelected = rawEffective.length > 0 ? rawEffective : [state.primaryDocPrefix];
  const baseline = defaults.length > 0 ? defaults : [state.primaryDocPrefix];
  const isDefault = sameSet(effectiveSelected, baseline);
  return {
    scopeMode: isDefault ? 'recommended' : 'custom',
    primaryDocPrefix: state.primaryDocPrefix,
    allowedPrefixes: effectiveSelected,
    moduleTabs: state.moduleTabs,
  };
}
