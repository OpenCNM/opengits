// WebDoc 确认页作用域选择器纯函数（UI 状态 → 提交载荷的单一出口）：
// 0ms 首屏不猜测前缀（作用域值唯一来源是 scout 响应），scout 未就绪时
// 提交 scopeMode='' 由 Go 侧自动拓扑裁决兜底（行为与历史完全一致，零回归）。

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

/** 网页文档横向向导当前所在步骤（输入 → 嗅探 → 确认目录 → 开始抓取 → 完成阅读） */
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

/**
 * 将后端 WebDoc 导入流式日志投影为单调递增的进度条百分比与友好文案键，
 * 不向用户暴露 `[2/3]`、`(65/69)` 等内部技术数字。
 */
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

/** 可渲染为目录筛选项的模块：站内绝对路径（外链 external / 空路径一律不渲染） */
export function chipModules(tabs: readonly ModuleTab[]): ModuleTab[] {
  return tabs.filter((t) => t.path.startsWith('/') && t.path.length > 1);
}

/** 判定模块路径是否落在推荐前缀之下（primary='/' 视为全站命中） */
export function isUnderPrefix(modulePath: string, primaryDocPrefix: string): boolean {
  if (primaryDocPrefix === '/') return true;
  return modulePath === primaryDocPrefix || modulePath.startsWith(`${primaryDocPrefix}/`);
}

/** 单一事实判定：该目录是否属于默认推荐勾选的核心文档/API 模块 */
export function isDefaultSelectedModule(
  tab: Pick<ModuleTab, 'kind' | 'path'>,
  primaryDocPrefix: string,
): boolean {
  return (tab.kind === 'doc' || tab.kind === 'api') && isUnderPrefix(tab.path, primaryDocPrefix);
}

/**
 * 默认勾选集：推荐前缀下的 doc/api 模块自动收录；changelog 等其他 kind 默认排除
 * （点击可加回）。无任何命中时至少勾选首个 Chip，保证显式模式可提交。
 */
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
  /** 单选态：recommended（默认）| all；chips 点选自动升级为 custom 由派生逻辑判定 */
  mode: 'recommended' | 'all';
  /** scout 推荐前缀；scout 未就绪时为 '' */
  primaryDocPrefix: string;
  /** 当前勾选的 Chip 路径 */
  selectedPaths: string[];
  /** scout 识别的全量 Tabs（提交以持久化多 Tab 隔离元数据） */
  moduleTabs: ModuleTab[];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * UI 状态 → 提交载荷（四模式单一出口）：
 * - primary 为空（scout 未就绪/失败）⇒ scopeMode='' 自动裁决兜底
 * - all ⇒ primary='/' + allows=['/']
 * - 勾选集与默认一致 ⇒ recommended；否则 ⇒ custom
 */
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
  // 防御单模块无 chip 场景（chips 为空时 allowedPrefixes 不能为空，否则触犯 webDocScopeParamsSchema 400）
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
