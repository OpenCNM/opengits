export const CONCEPT_TAXONOMY_HEADER = '🧠 Knowledge Graph Concepts (Tutorial Concept Map)';
export const CONCEPT_DEPENDENCY_HINT_HEADER = '⚡ 依赖提示 (Prerequisite Hint)';
export const LEARNING_PATH_HEADER = '🧭 学习路径（Learning Path）';

export const EDGE_SOURCE_LABELS: Record<string, { label: string; confidence: '确定' | '推断' }> = {
  cooccurrence: { label: '共现', confidence: '确定' },
  curriculum_order: { label: '教学顺序', confidence: '确定' },
  code_dep: { label: '代码依赖', confidence: '确定' },
  llm_extracted: { label: 'LLM推断', confidence: '推断' },
};

// co_located is a read-time pseudo-edge (not stored in TutorialConceptEdge).
export function neighborRelationTag(relation: { type: string; direction: 'incoming' | 'outgoing' | 'undirected' }): string {
  switch (relation.type) {
    case 'prerequisite':
      return relation.direction === 'outgoing' ? '⇢[后学]' : '⇠[前置]';
    case 'successor':
      return relation.direction === 'outgoing' ? '⇢[后继]' : '⇠[先学]';
    case 'part_of':
      return relation.direction === 'outgoing' ? '⇢[含部分]' : '⇠[组成部分]';
    case 'co_located':
      return '⇋[同篇]';
    default:
      return '⇋[相关]';
  }
}

export interface DependencyHintItem {
  conceptName: string;
  category: string;
  docPath: string | null;
  address: string | null;
  source?: string;
  weight?: number;
}

export function formatDependencyHintText(
  targetName: string,
  deps: DependencyHintItem[],
  sourceLabel?: string
): string {
  if (deps.length === 0) return '';
  let text = `\n\n${CONCEPT_DEPENDENCY_HINT_HEADER}${sourceLabel ? ` [Source: ${sourceLabel}]` : ''}\n`;
  text += `- 理解「${targetName}」建议先掌握:\n`;
  for (const d of deps) {
    text += `  • ${d.conceptName} (${d.category})`;
    const srcKey = d.source || 'cooccurrence';
    const srcMeta = EDGE_SOURCE_LABELS[srcKey] || { label: srcKey, confidence: '推断' as const };
    const w = typeof d.weight === 'number' ? ` · w${d.weight.toFixed(2)}` : '';
    text += ` [来源:${srcMeta.label}(${srcMeta.confidence})${w}]`;
    if (d.docPath) text += ` — ${d.docPath}`;
    if (d.address) text += ` [Address: ${d.address}]`;
    text += `\n`;
  }
  text += `\n(可用 read 精读任一前置概念，或 explore_concept(action="path") 获取完整递进链)`;
  text += `\n(证据来源：共现/教学顺序/代码依赖=确定；LLM推断=可能幻觉)`;
  return text;
}

export function formatConceptTaxonomyGrouped(
  concepts: {
    conceptName: string;
    category: string;
    docPath: string | null;
    address: string | null;
    depth: number;
    mergedVariants?: number;
  }[]
): string {
  if (concepts.length === 0) return '';
  const groups = new Map<string, typeof concepts>();
  for (const c of concepts) {
    const arr = groups.get(c.category) || [];
    arr.push(c);
    groups.set(c.category, arr);
  }
  const orderedCategories = Array.from(groups.keys()).sort(
    (a, b) => groups.get(b)!.length - groups.get(a)!.length
  );

  let text = `## ${CONCEPT_TAXONOMY_HEADER}\n\n`;
  for (const cat of orderedCategories) {
    const items = groups
      .get(cat)!
      .slice()
      .sort((a, b) => b.depth - a.depth || a.conceptName.localeCompare(b.conceptName));
    text += `### 🗂️ ${cat} (${items.length})\n`;
    for (const c of items) {
      const indent = c.depth > 0 ? '  '.repeat(Math.min(c.depth, 3)) : '';
      const label = c.depth > 0 ? `${c.conceptName} [前置×${c.depth}]` : c.conceptName;
      text += `${indent}- ${label}`;
      if ((c.mergedVariants ?? 1) > 1) text += ` ×${c.mergedVariants} 处同义`;
      if (c.docPath) text += ` — ${c.docPath}`;
      if (c.address) text += ` [Address: ${c.address}]`;
      text += `\n`;
    }
    text += `\n`;
  }
  text += `(Use explore_concept (concept: "<name>") to dive into any concept above, or read with its Address for the source section.)`;
  return text;
}

export function formatLearningPathOutput(
  targetName: string,
  chain: Array<{
    conceptId?: string;
    depth?: number;
    conceptName: string;
    category: string;
    docPath: string | null;
    headingPath?: string | null;
    address: string | null;
    canonicalKey?: string | null;
    canonicalName?: string | null;
  }>
): string {
  if (chain.length === 0) {
    return `🧭 尚未发现「${targetName}」的前置知识链（图谱中暂无 prerequisite / successor 边）。学习路径将随图谱边构建后可用。`;
  }
  const steps = [...chain].reverse();
  let text = `${LEARNING_PATH_HEADER} — 目标: ${targetName}\n\n`;
  steps.forEach((c, idx) => {
    text += `${idx + 1}. ${c.conceptName} (${c.category})`;
    if (c.canonicalName && c.canonicalName !== c.conceptName) text += ` (归并: ${c.canonicalName})`;
    if (c.docPath) text += ` — ${c.docPath}`;
    if (c.address) text += `\n   [Address: ${c.address}]`;
    text += `\n`;
  });
  text += `${steps.length + 1}. 🎯 ${targetName}（目标概念）\n`;
  text += `\n(按顺序阅读即可递进掌握；每个概念可用 read 精读，explore_concept 深钻)`;
  return text;
}

export function formatNeighborsOutput(
  conceptName: string,
  neighbors: Array<{
    conceptId?: string;
    conceptName: string;
    category: string;
    docPath: string | null;
    headingPath?: string | null;
    address: string | null;
    canonicalKey?: string | null;
    canonicalName?: string | null;
    edgeCount?: number;
    relation: {
      type: string;
      direction: 'incoming' | 'outgoing' | 'undirected';
      weight: number;
      source?: string;
    };
  }>
): string {
  if (neighbors.length === 0) {
    return `🧭 「${conceptName}」暂无直接邻居概念（图谱边尚未构建）。可尝试 outline 查看概念拓扑清单。`;
  }
  let text = `🧭 概念邻居（Concept Neighbors）— ${conceptName}\n\n`;
  for (const n of neighbors) {
    const arrow = neighborRelationTag(n.relation);
    const srcKey = n.relation.source || 'cooccurrence';
    const srcMeta = EDGE_SOURCE_LABELS[srcKey] || { label: srcKey, confidence: '推断' as const };
    text += `- ${n.conceptName} (${n.category}) ${arrow} [${n.relation.type} · 来源:${srcMeta.label}(${srcMeta.confidence}) · w${n.relation.weight.toFixed(2)}]`;
    const neighborCanonical = n.canonicalName;
    if (neighborCanonical && neighborCanonical !== n.conceptName)
      text += ` (归并: ${neighborCanonical})`;
    if (n.docPath) text += ` — ${n.docPath}`;
    if (n.address) text += `\n  [Address: ${n.address}]`;
    text += `\n`;
  }
  text += `\n(可对任一邻居调用 explore_concept / read 深入；学习顺序见 explore_concept(action="path"))`;
  text += `\n(证据来源：共现/教学顺序/代码依赖=确定；LLM推断=可能幻觉，权重越高关系越强)`;
  return text;
}
