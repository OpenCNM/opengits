// ─────────────────────────────────────────────────────────────
// 仓内概念归并层（L1，确定性，零 LLM）
//
// 目标：同一仓库内「同名/近同名」概念（如 40 篇文档各有一个"事件循环"）
// 归并为一个逻辑组，使 taxonomy 去重、邻居/依赖继承、目录名额不被同组
// 变体挤占。分组键 = normalizeHeadingKey(conceptName)（与跨仓对齐层同一
// 归一化原语，保证两层口径一致）；组内代表名 = 频次最高的原名（同频取
// 更短者，再取字典序最小，确定性可重放）。
//
// 设计不变量：
// - L0 原始节点是事实源：本模块只写 canonicalKey/canonicalName 两个字段，
//   绝不合并/删除节点，边仍建在原始节点间（读侧按组成员集合扩展查询）。
// - 全部纯函数可单测；DB 适配失败静默降级（归并是增强，不是入库硬依赖）。
// ─────────────────────────────────────────────────────────────

import { prisma } from '@/lib/db';
import { callSidecar } from '@/lib/sidecar-client';
import { normalizeHeadingKey } from './heading-key';

/** 一个归并组的计划：分组键 + 代表名 + 成员节点 id + 组内去重后的原名变体 */
export interface CanonicalGroupPlan {
  key: string;
  canonicalName: string;
  memberIds: string[];
  variants: string[];
}

/**
 * 纯函数：把节点列表按归一化名分组并选出每组代表名。
 * - 空 key（归一化后为空串，如纯编号标题）不入组（保持未归并）；
 * - 代表名 = 组内出现频次最高的原名；同频时取更短者（"事件循环" 优于 "1. 事件循环"——
 *   装饰更少者更接近正典称呼），再同长取字典序最小（确定性，重跑结果一致）。
 */
export function planCanonicalGroups(
  nodes: { id: string; conceptName: string }[]
): Map<string, CanonicalGroupPlan> {
  const groups = new Map<string, { ids: string[]; nameCounts: Map<string, number> }>();
  for (const node of nodes) {
    const key = normalizeHeadingKey(node.conceptName);
    if (!key) continue;
    const group = groups.get(key) ?? { ids: [], nameCounts: new Map<string, number>() };
    group.ids.push(node.id);
    const name = node.conceptName.trim();
    group.nameCounts.set(name, (group.nameCounts.get(name) ?? 0) + 1);
    groups.set(key, group);
  }

  const plans = new Map<string, CanonicalGroupPlan>();
  for (const [key, group] of groups) {
    let canonicalName = '';
    let bestCount = 0;
    for (const [name, count] of group.nameCounts) {
      const beatsBest =
        count > bestCount ||
        (count === bestCount &&
          (canonicalName === '' ||
            name.length < canonicalName.length ||
            (name.length === canonicalName.length && name.localeCompare(canonicalName) < 0)));
      if (beatsBest) {
        canonicalName = name;
        bestCount = count;
      }
    }
    plans.set(key, {
      key,
      canonicalName,
      memberIds: group.ids,
      variants: Array.from(group.nameCounts.keys()).sort((a, b) => a.localeCompare(b)),
    });
  }
  return plans;
}

/** 单概念的归并字段初值（写入路径用）：key 空时保持未归并（null） */
export function canonicalFieldsFor(conceptName: string): {
  canonicalKey: string | null;
  canonicalName: string;
} {
  const key = normalizeHeadingKey(conceptName);
  return { canonicalKey: key || null, canonicalName: conceptName.trim() };
}

/**
 * 刷新给定分组键的组内代表名：只更新 canonicalName 与计划不一致的成员。
 * O(受影响组成员数)——写入路径每篇文档同步后按本文档涉及的 key 调用，
 * 不做全仓扫描。失败静默返回 0（归并是增强，不阻断入库管线）。
 */
export async function refreshCanonicalNames(repositoryId: string, keys: string[]): Promise<number> {
  const validKeys = keys.filter((k) => k && k.trim() !== '');
  if (validKeys.length === 0) return 0;
  try {
    const members = await prisma.tutorialConceptNode.findMany({
      where: { repositoryId, canonicalKey: { in: validKeys } },
      select: { id: true, conceptName: true, canonicalKey: true, canonicalName: true },
    });
    const plans = planCanonicalGroups(members);
    const updates: Array<{ ids: string[]; canonicalName: string }> = [];
    for (const plan of plans.values()) {
      const memberSet = new Set(plan.memberIds);
      const staleIds = members
        .filter((m) => memberSet.has(m.id) && m.canonicalName !== plan.canonicalName)
        .map((m) => m.id);
      if (staleIds.length === 0) continue;
      updates.push({ ids: staleIds, canonicalName: plan.canonicalName });
    }
    if (updates.length === 0) return 0;
    const res = await callSidecar<{ ok: boolean; count: number }>(
      '/v1/concepts/canonical/update',
      { updates },
      { label: 'concept-canonical/refresh', timeoutMs: 15_000 }
    );
    return res.count;
  } catch (err) {
    console.warn('[concept-canonical] refreshCanonicalNames skipped:', err);
    return 0;
  }
}

/**
 * 读路径辅助：解析某节点所属归并组的全部成员 id（含自身）。
 * 未归并（canonicalKey 为空）或查询失败时退化为 [nodeId]——读侧行为与
 * 归并层上线前完全一致，保证降级安全。
 */
export async function resolveCanonicalMemberIds(
  repositoryId: string,
  nodeId: string
): Promise<string[]> {
  try {
    const node = await prisma.tutorialConceptNode.findFirst({
      where: { id: nodeId, repositoryId },
      select: { canonicalKey: true },
    });
    if (!node?.canonicalKey) return [nodeId];
    const members = await prisma.tutorialConceptNode.findMany({
      where: { repositoryId, canonicalKey: node.canonicalKey },
      select: { id: true },
    });
    const ids = members.map((m) => m.id);
    return ids.length > 0 ? ids : [nodeId];
  } catch (err) {
    console.warn('[concept-canonical] resolveCanonicalMemberIds fallback to self:', err);
    return [nodeId];
  }
}

/**
 * 存量回填（单仓）：为全仓概念计算 canonicalKey/canonicalName。
 * 幂等：已一致的成员跳过；按「目标键值对」分批 updateMany，而不是逐节点 update。
 * 返回统计供 CLI 输出。
 */
export async function applyCanonicalBackfillToRepository(repositoryId: string): Promise<{
  nodes: number;
  groups: number;
  updated: number;
}> {
  const nodes = await prisma.tutorialConceptNode.findMany({
    where: { repositoryId },
    select: { id: true, conceptName: true, canonicalKey: true, canonicalName: true },
  });
  const plans = planCanonicalGroups(nodes);
  // O(n)：id → 节点索引一次建好；按「目标 key+name」收敛更新批次（同目标值合一次 updateMany）
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const batchByTarget = new Map<string, { key: string; name: string; ids: string[] }>();
  const groupedIds = new Set<string>();
  for (const plan of plans.values()) {
    for (const id of plan.memberIds) groupedIds.add(id);
    const batchKey = `${plan.key} ${plan.canonicalName}`;
    const batch = batchByTarget.get(batchKey) ?? { key: plan.key, name: plan.canonicalName, ids: [] };
    for (const id of plan.memberIds) {
      const member = nodeById.get(id);
      if (member && (member.canonicalKey !== plan.key || member.canonicalName !== plan.canonicalName)) {
        batch.ids.push(id);
      }
    }
    if (batch.ids.length > 0) batchByTarget.set(batchKey, batch);
  }
  const updates: Array<{ ids: string[]; canonicalKey: string; canonicalName: string }> = [];
  for (const batch of batchByTarget.values()) {
    if (batch.ids.length > 0) {
      updates.push({
        ids: batch.ids,
        canonicalKey: batch.key,
        canonicalName: batch.name,
      });
    }
  }
  let updated = 0;
  if (updates.length > 0) {
    const res = await callSidecar<{ ok: boolean; count: number }>(
      '/v1/concepts/canonical/update',
      { updates },
      { label: 'concept-canonical/backfill', timeoutMs: 30_000 }
    );
    updated = res.count;
  }
  return { nodes: groupedIds.size, groups: plans.size, updated };
}
