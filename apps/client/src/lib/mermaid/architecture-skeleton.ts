import type { ModuleCognition, ModuleGoldenSymbol } from '@/engine/structurizer/cognitive-projector';

export interface SkeletonOptions {
  maxCallSteps?: number;
  includeExternal?: boolean;
}

/**
 * 纯函数构建模块架构与数据流的 Mermaid 确定性物理拓扑骨架。
 * 基于 Tree-sitter AST 解析的真实内部调用边（CallFlow）、黄金符号与模块依赖，
 * 绝不凭空臆造虚假调用，为下游 LLM 业务语义着色提供事实根基。
 */
export function buildModuleArchitectureMermaidSkeleton(
  title: string,
  cog?: Partial<ModuleCognition> | null,
  goldenSymbols?: ModuleGoldenSymbol[] | null,
  options?: SkeletonOptions
): string {
  const maxSteps = options?.maxCallSteps && options.maxCallSteps > 0 ? options.maxCallSteps : 6;
  const includeExternal = options?.includeExternal ?? true;

  const cleanTitle = (title || 'Module Architecture').replace(/"/g, "''").trim() || 'Module Architecture';

  const lines: string[] = ['```mermaid', 'flowchart TD'];

  const nodeIdMap = new Map<string, string>();
  let nextId = 1;
  const getNodeId = (sym: string): string => {
    const existing = nodeIdMap.get(sym);
    if (existing) return existing;
    const newId = `fn${nextId++}`;
    nodeIdMap.set(sym, newId);
    return newId;
  };

  const subgraphId = 'ChapterMod';
  lines.push(`  subgraph ${subgraphId}["${cleanTitle}"]`);

  let firstNodeId = '';
  let lastNodeId = '';
  let hasInternalNodes = false;

  // 1. 若具备 AST 调用流（CallFlow），绘制物理调用边
  if (cog?.callFlow && cog.callFlow.length > 0) {
    let stepsCount = 0;
    for (const step of cog.callFlow) {
      const caller = (step.caller || '').trim();
      const callee = (step.callee || '').trim();
      if (!caller || !callee) continue;

      const callerId = getNodeId(caller);
      const calleeId = getNodeId(callee);

      const callerLabel = caller.replace(/"/g, "''");
      const calleeLabel = callee.replace(/"/g, "''");

      lines.push(`    ${callerId}["${callerLabel}()"]`);
      lines.push(`    ${calleeId}["${calleeLabel}()"]`);
      lines.push(`    ${callerId} --> ${calleeId}`);

      if (!firstNodeId) firstNodeId = callerId;
      lastNodeId = calleeId;
      hasInternalNodes = true;

      stepsCount++;
      if (stepsCount >= maxSteps) break;
    }
  }

  // 2. 若无调用流，使用 GoldenSymbols 骨架
  if (!hasInternalNodes) {
    const symbols = (goldenSymbols && goldenSymbols.length > 0)
      ? goldenSymbols
      : (cog?.goldenSymbols ?? []);

    if (symbols.length > 0) {
      let symCount = 0;
      let prevId = '';
      for (const sym of symbols) {
        const name = (sym.name || '').trim();
        if (!name) continue;

        const symId = getNodeId(name);
        const kindStr = sym.kind ? ` (${sym.kind})` : '';
        const label = `${name}${kindStr}`.replace(/"/g, "''");

        lines.push(`    ${symId}["${label}"]`);

        if (!firstNodeId) firstNodeId = symId;
        if (prevId) {
          lines.push(`    ${prevId} -.-> ${symId}`);
        }
        prevId = symId;
        lastNodeId = symId;
        hasInternalNodes = true;

        symCount++;
        if (symCount >= 4) break;
      }
    }
  }

  // 3. 若仍无，使用模块核心节点兜底
  if (!hasInternalNodes) {
    const singleId = getNodeId(cleanTitle);
    lines.push(`    ${singleId}["${cleanTitle} Core"]`);
    firstNodeId = singleId;
    lastNodeId = singleId;
  }

  lines.push('  end');

  // 4. 上下游依赖外接
  if (includeExternal && cog) {
    if (Array.isArray(cog.upstreamModules)) {
      let upCount = 0;
      for (const up of cog.upstreamModules) {
        const upName = (up || '').trim();
        if (!upName) continue;
        const upId = `up${upCount + 1}`;
        const cleanUp = upName.replace(/"/g, "''");
        lines.push(`  ${upId}(["Prerequisite: ${cleanUp}"]) --> ${firstNodeId}`);
        upCount++;
        if (upCount >= 2) break;
      }
    }

    if (Array.isArray(cog.downstreamModules)) {
      let downCount = 0;
      for (const down of cog.downstreamModules) {
        const downName = (down || '').trim();
        if (!downName) continue;
        const downId = `down${downCount + 1}`;
        const cleanDown = downName.replace(/"/g, "''");
        lines.push(`  ${lastNodeId} --> ${downId}(["Dependent: ${cleanDown}"])`);
        downCount++;
        if (downCount >= 2) break;
      }
    }
  }

  lines.push('```');
  return lines.join('\n');
}
