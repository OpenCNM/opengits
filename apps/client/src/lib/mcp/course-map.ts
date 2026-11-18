import { REPO_PROFILE_CLUSTERS_KEY } from '@/lib/constants';
import { NavNode } from '@/engine/structurizer';
import { parseSuperTopicsBlock } from '@/lib/mcp/graph-condense';
import { flattenNavTreeEntries } from '@/lib/outline-reader';

// ─────────────────────────────────────────────────────────────
// course_map：把仓库的课程骨架渲染为依赖图视图。
// 设计规范 §4.1 course_map：仓库 → pedagogy 大纲以依赖图呈现。
// 数据源优先级：
//   ① conceptSuperTopics（L2 超主题凝聚产物，巨仓的「目录的目录」）
//   ② codeClusters（代码仓教学顺序）
//   ③ navTree 文件大纲兜底（展平走统一入口 flattenNavTreeEntries）
// ─────────────────────────────────────────────────────────────

interface ClusterCognitive {
  phase?: string;
  upstreamModules?: string[];
}

interface ClusterRow {
  teachingOrder: number;
  title: string;
  files: string[];
  directories?: string[];
  cognitive?: ClusterCognitive;
}

/** 从 repoProfile 解析 codeClusters（容忍脏数据，与 backfill-code-dep-edges 同款校验） */
function parseCodeClusters(repoProfile: unknown): ClusterRow[] {
  const profile = (repoProfile || {}) as Record<string, unknown>;
  const raw = profile[REPO_PROFILE_CLUSTERS_KEY];
  if (!Array.isArray(raw)) return [];
  return (raw as ClusterRow[]).filter(
    (r) => r && typeof r.teachingOrder === 'number' && typeof r.title === 'string' && Array.isArray(r.files)
  );
}

function classifyCoursePhase(phaseStr?: string): number {
  const p = (phaseStr || '').toLowerCase().trim();
  if (p.includes('perception') || p.includes('phase1') || p.includes('foundation')) return 0;
  if (p.includes('entity') || p.includes('phase2') || p.includes('core')) return 1;
  if (p.includes('pipeline') || p.includes('phase3') || p.includes('interface')) return 2;
  if (p.includes('adapter') || p.includes('phase4') || p.includes('extension')) return 3;
  return 0;
}

/**
 * 渲染课程图视图（纯函数）。
 * 数据源优先级：conceptSuperTopics（巨仓超主题骨架）→ codeClusters（代码仓教学顺序）→ navTree 兜底。
 */
export function formatCourseMap(repoProfile: unknown, navTree?: NavNode[] | null): string {
  // ① L2 超主题骨架：巨仓「目录的目录」——Agent 先看超主题再下钻概念/章节
  const superBlock = parseSuperTopicsBlock(repoProfile);
  const superTopics = superBlock?.topics ?? [];
  if (superTopics.length > 0) {
    const coveredKeys = new Set(superTopics.flatMap((t) => t.memberKeys));
    let text = `🗺️ Course Map（知识超主题骨架，${superTopics.length} 个主题域）\n\n`;
    text += '```mermaid\nflowchart TD\n';
    superTopics.forEach((t, i) => {
      const id = `T${String(i + 1).padStart(2, '0')}`;
      const label = `${t.title}（${t.memberKeys.length} 概念组）`.replace(/"/g, "''");
      text += `  ${id}["${label}"]\n`;
      if (i + 1 < superTopics.length) text += `  ${id} --> T${String(i + 2).padStart(2, '0')}\n`;
    });
    text += '```\n\n';
    text += `主题域清单（用 explore_concept(action="details") 深入任一概念，或 explore_concept(action="neighbors") 查邻居）：\n`;
    for (const t of superTopics) {
      text += `- ${t.title}`;
      if (t.summary) text += ` — ${t.summary}`;
      text += `\n`;
    }
    if (coveredKeys.size > 0) {
      const generatedOn = superBlock?.generatedAt?.slice(0, 10) || '近期';
      text += `\n(超主题由图谱凝聚生成于 ${generatedOn}；覆盖 ${coveredKeys.size} 个概念组)\n`;
    }
    return text;
  }

  // ② 代码仓教学顺序
  const clusters = parseCodeClusters(repoProfile).slice().sort((a, b) => a.teachingOrder - b.teachingOrder);

  if (clusters.length > 0) {
    const hasCognitive = clusters.some(
      (c) => c.cognitive && (c.cognitive.phase || (c.cognitive.upstreamModules && c.cognitive.upstreamModules.length > 0))
    );

    const totalFiles = clusters.reduce((n, c) => n + c.files.length, 0);
    let text = `🗺️ Course Map — ${clusters.length} 章 / ${totalFiles} 文件（按教学顺序）\n\n`;
    text += '```mermaid\nflowchart TD\n';

    if (!hasCognitive) {
      const ids = clusters.map((c) => `Ch${String(c.teachingOrder).padStart(2, '0')}`);
      for (let i = 0; i < clusters.length; i++) {
        const c = clusters[i];
        const label = `${c.teachingOrder}. ${c.title}（${c.files.length} 文件）`.replace(/"/g, "''");
        text += `  ${ids[i]}["${label}"]\n`;
        if (i + 1 < clusters.length) text += `  ${ids[i]} --> ${ids[i + 1]}\n`;
      }
    } else {
      const groups = [
        { title: `subgraph Phase_Foundation["🌱 基础层 (Foundation)"]`, clusters: [] as ClusterRow[] },
        { title: `subgraph Phase_Core["⚡️ 核心层 (Core Logic)"]`, clusters: [] as ClusterRow[] },
        { title: `subgraph Phase_Interface["🔌 接口层 (Interface & Delivery)"]`, clusters: [] as ClusterRow[] },
        { title: `subgraph Phase_Extension["🚀 扩展层 (Advanced Extension)"]`, clusters: [] as ClusterRow[] },
      ];

      for (const c of clusters) {
        const phaseIdx = classifyCoursePhase(c.cognitive?.phase);
        groups[phaseIdx].clusters.push(c);
      }

      for (const g of groups) {
        if (g.clusters.length === 0) continue;
        text += `  ${g.title}\n`;
        for (const c of g.clusters) {
          const id = `Ch${String(c.teachingOrder).padStart(2, '0')}`;
          const label = `${c.teachingOrder}. ${c.title}（${c.files.length} 文件）`.replace(/"/g, "''");
          text += `    ${id}["${label}"]\n`;
        }
        text += `  end\n`;
      }

      const lookup: Record<string, string> = {};
      for (const c of clusters) {
        const id = `Ch${String(c.teachingOrder).padStart(2, '0')}`;
        lookup[c.title.toLowerCase()] = id;
        lookup[`ch${String(c.teachingOrder).padStart(2, '0')}`.toLowerCase()] = id;
        lookup[`ch${c.teachingOrder}`.toLowerCase()] = id;
        if (Array.isArray(c.directories)) {
          for (const dir of c.directories) {
            const cleanDir = dir.toLowerCase().replace(/^\/+|\/+$/g, '');
            lookup[cleanDir] = id;
            const parts = cleanDir.split('/');
            lookup[parts[parts.length - 1]] = id;
          }
        }
      }

      interface EdgePair {
        from: string;
        to: string;
      }
      const edges: EdgePair[] = [];
      const seenEdges = new Set<string>();

      for (const c of clusters) {
        const currId = `Ch${String(c.teachingOrder).padStart(2, '0')}`;
        if (!c.cognitive?.upstreamModules) continue;
        for (const up of c.cognitive.upstreamModules) {
          const cleanUp = up.trim().toLowerCase().replace(/^\/+|\/+$/g, '');
          let fromId = lookup[cleanUp];
          if (!fromId) {
            const parts = cleanUp.split('/');
            fromId = lookup[parts[parts.length - 1]];
          }
          if (fromId && fromId !== currId) {
            const key = `${fromId}-->${currId}`;
            if (!seenEdges.has(key)) {
              seenEdges.add(key);
              edges.push({ from: fromId, to: currId });
            }
          }
        }
      }

      if (edges.length === 0) {
        for (let i = 0; i + 1 < clusters.length; i++) {
          const fromId = `Ch${String(clusters[i].teachingOrder).padStart(2, '0')}`;
          const toId = `Ch${String(clusters[i + 1].teachingOrder).padStart(2, '0')}`;
          edges.push({ from: fromId, to: toId });
        }
      }

      for (const e of edges) {
        text += `  ${e.from} --> ${e.to}\n`;
      }
    }

    text += '```\n\n';
    text += `章节清单（可对任一章用 read / explore_concept 深入）：\n`;
    for (const c of clusters) {
      text += `- ${c.teachingOrder}. ${c.title} — ${c.files.length} 文件\n`;
    }
    return text;
  }

  // 兜底：navTree 文件大纲
  const navFiles = flattenNavTreeEntries(navTree ?? undefined);
  if (navFiles.length === 0) {
    return `🗺️ Course Map：该仓库无 codeClusters（非代码教学仓），且 navTree 为空，无法生成课程图。可用 read_document（无参数）查看文档清单。`;
  }
  let text = `🗺️ Course Map（文档大纲兜底，${navFiles.length} 篇）\n\n`;
  navFiles.slice(0, 50).forEach((f, i) => {
    text += `${i + 1}. ${f.title} [Path: ${f.path}]\n`;
  });
  if (navFiles.length > 50) text += `...（其余 ${navFiles.length - 50} 篇见 read_document 大纲）\n`;
  return text;
}
