/**
 * 概念图（Tutorial Concept Graph）输出格式化模块
 * 负责将概念图数据结构转换为人类与 LLM 友好的 Markdown/纯文本提示。
 */

export const CONCEPT_TAXONOMY_HEADER = '🧠 Knowledge Graph Concepts (Tutorial Concept Map)';
export const CONCEPT_DEPENDENCY_HINT_HEADER = '⚡ 依赖提示 (Prerequisite Hint)';
export const LEARNING_PATH_HEADER = '🧭 学习路径（Learning Path）';

/**
 * 边证据来源的可读标签 + 可信度档位（供邻居/依赖提示输出，让客户端判断边可信度）。
 * 确定性来源（code_dep/curriculum_order/cooccurrence）可信；llm_extracted 带幻觉风险。
 * 唯一定义处：concept-graph.ts 内部使用与对外 re-export 均引用此处，新增边来源只改这里。
 */
export const EDGE_SOURCE_LABELS: Record<string, { label: string; confidence: '确定' | '推断' }> = {
  cooccurrence: { label: '共现', confidence: '确定' },
  curriculum_order: { label: '教学顺序', confidence: '确定' },
  code_dep: { label: '代码依赖', confidence: '确定' },
  llm_extracted: { label: 'LLM推断', confidence: '推断' },
};

/**
 * 邻居关系类型修饰符（紧凑内联用）：按边类型输出带语义标签的箭头。
 * 唯一定义处——details 内联邻居、read_section 图位置注入、concept_neighbors 全量输出共用，
 * 新增边类型只改这里。co_located 是读侧动态补充的「同篇」伪边类型（非 TutorialConceptEdge 落库值）。
 */
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

/**
 * 依赖提示文本（纯函数）：目标概念的前置知识清单。
 * sourceLabel 存在时附加 [Source: owner/repo] 归因（Hub fan-out 用）。
 */
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
  text += `\n(可用 read_section 精读任一前置概念，或 learning_path 获取完整递进链)`;
  text += `\n(证据来源：共现/教学顺序/代码依赖=确定；LLM推断=可能幻觉)`;
  return text;
}

/**
 * 概念拓扑分组渲染（纯函数）：按 category 分组，组内按层级深度降序（深层前置在前），
 * depth ≥1 的概念缩进并标注 [前置]。归并组（mergedVariants > 1）追加 ×N 同义标注。
 */
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
  text += `(Use get_concept_details (concept: "<name>") to dive into any concept above, or read_section with its Address for the source section.)`;
  return text;
}

/** 学习路径输出：前置链（按教学顺序）→ 末尾追加目标概念，标注深度与溯源 Address */
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
  text += `\n(按顺序阅读即可递进掌握；每个概念可用 read_section 精读，get_concept_details 深钻)`;
  return text;
}

/** 邻居输出：按权重降序，标注方向与边类型（紧凑箭头统一走 neighborRelationTag） */
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
    return `🧭 「${conceptName}」暂无直接邻居概念（图谱边尚未构建）。可尝试 list_documents 查看概念拓扑清单。`;
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
  text += `\n(可对任一邻居调用 get_concept_details / read_section 深入；学习顺序见 learning_path)`;
  text += `\n(证据来源：共现/教学顺序/代码依赖=确定；LLM推断=可能幻觉，权重越高关系越强)`;
  return text;
}
