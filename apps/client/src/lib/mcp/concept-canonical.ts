// Deterministic canonicalization groups same-repo concept variants by normalizeHeadingKey without deleting raw L0 nodes.

import { prisma } from '@/lib/db';
import { callSidecar } from '@/lib/sidecar-client';
import { normalizeHeadingKey } from './heading-key';

export interface CanonicalGroupPlan {
  key: string;
  canonicalName: string;
  memberIds: string[];
  variants: string[];
}

// Break frequency ties by shorter raw name (fewer prefixes), then lexicographically for deterministic replays.
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

export function canonicalFieldsFor(conceptName: string): {
  canonicalKey: string | null;
  canonicalName: string;
} {
  const key = normalizeHeadingKey(conceptName);
  return { canonicalKey: key || null, canonicalName: conceptName.trim() };
}

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
