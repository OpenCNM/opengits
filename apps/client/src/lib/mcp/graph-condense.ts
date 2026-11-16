// ─────────────────────────────────────────────────────────────
// 概念图谱紧缩与统计（graph-condense，纯确定性）
//
// 本模块只保留零 LLM 的确定性核心：
// - condenseConceptGraph：纯计算拓扑紧缩（Unit 4.4 Contract）
// - computeGraphStats：图谱健康指标（readiness 端点 / capability-manifest 消费）
// - parseSuperTopicsBlock：repoProfile 超主题区块的容错读取
//   （course_map / graph 概览消费；历史 LLM 凝聚管线已整体裁撤，
//    该区块仅剩存量数据兼容读，不再有写入方）
// ─────────────────────────────────────────────────────────────

import { z } from 'zod';
import { prisma } from '@/lib/db';
import { REPO_PROFILE_SUPERTOPICS_KEY } from '@/lib/constants';
import { conceptSuperTopicsBlockSchema } from '@/lib/mcp/concept-schemas';

/** 图谱健康指标（观测层：readiness 端点与 capability-manifest 共用） */
export interface GraphStats {
  conceptNodes: number;
  canonicalGroups: number;
  conceptEdges: number;
  /** 边/节点比：< 2 提示长尾稀疏化（condense 阈值信号之一） */
  edgesPerNode: number;
  /** 归并覆盖率 0~1：已回填 canonicalKey 的节点占比（0 = 未跑回填） */
  mergeCoverage: number;
  supertopicCount: number;
}

export interface RawConceptGraphNode {
  id: string;
  name?: string;
  score?: number;
  depth?: number;
}

export interface RawConceptGraphEdge {
  sourceId: string;
  targetId: string;
  weight?: number;
}

export interface ConceptGraph {
  nodes: RawConceptGraphNode[];
  edges: RawConceptGraphEdge[];
}

export interface CompactGraph {
  nodes: RawConceptGraphNode[];
  edges: RawConceptGraphEdge[];
}

/**
 * 计算单仓图谱健康指标。全部为廉价 count/groupBy（索引覆盖）。
 * light 模式（书架批量 N 仓 fan-out）只取两个 count，跳过分组与超主题查询。
 */
export async function computeGraphStats(
  repositoryId: string,
  repoProfile?: unknown,
  opts?: { light?: boolean }
): Promise<GraphStats> {
  const light = opts?.light === true;
  if (light) {
    const [conceptNodes, conceptEdges] = await Promise.all([
      prisma.tutorialConceptNode.count({ where: { repositoryId } }),
      prisma.tutorialConceptEdge.count({ where: { repositoryId } }),
    ]);
    return {
      conceptNodes,
      canonicalGroups: 0,
      conceptEdges,
      edgesPerNode: conceptNodes > 0 ? Math.round((conceptEdges / conceptNodes) * 100) / 100 : 0,
      mergeCoverage: 0,
      supertopicCount: 0,
    };
  }

  const [conceptNodes, conceptEdges, keyGroups, mergedNodes] = await Promise.all([
    prisma.tutorialConceptNode.count({ where: { repositoryId } }),
    prisma.tutorialConceptEdge.count({ where: { repositoryId } }),
    prisma.tutorialConceptNode
      .groupBy({ by: ['canonicalKey'], where: { repositoryId, canonicalKey: { not: null } }, _count: { _all: true } })
      .catch(() => []),
    prisma.tutorialConceptNode.count({ where: { repositoryId, canonicalKey: { not: null } } }),
  ]);
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    conceptNodes,
    canonicalGroups: keyGroups.length,
    conceptEdges,
    edgesPerNode: conceptNodes > 0 ? round2(conceptEdges / conceptNodes) : 0,
    mergeCoverage: conceptNodes > 0 ? round2(mergedNodes / conceptNodes) : 0,
    supertopicCount: repoProfile !== undefined ? (parseSuperTopicsBlock(repoProfile)?.topics.length ?? 0) : 0,
  };
}

/** repoProfile JSON 区块的容错读取（照 parseCodeClusters 模式；存量数据兼容读） */
export function parseSuperTopicsBlock(
  repoProfile: unknown
): z.infer<typeof conceptSuperTopicsBlockSchema> | null {
  if (!repoProfile || typeof repoProfile !== 'object') return null;
  const raw = (repoProfile as Record<string, unknown>)[REPO_PROFILE_SUPERTOPICS_KEY];
  const parsed = conceptSuperTopicsBlockSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
