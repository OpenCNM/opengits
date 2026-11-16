/**
 * 更新候选集构建器（plan-then-apply Stage 0，确定性规则层）。
 *
 * 职责：把"文件级 diff"映射为"受影响的教程章节候选"，供 LLM 计划生成（Stage 1）裁决。
 * 本模块不调 LLM、不写库——纯确定性计算，可单测。
 *
 * 映射规则：
 * - 代码类（code_only/hybrid）：diff 文件 → repoProfile.codeClusters（章节↔文件映射，
 *   见 code-ingest.ts 持久化）反查受影响章节（虚拟路径 chapters/XX.mdx）
 * - 文档类（text_only/hybrid）：diff 路径 → Document.path 直接命中（真实路径）
 * - 未命中任何章节的变更文件 → unmatchedFiles（LLM 评估是否需要 add 新章节）
 *
 * 变更分类语义（与 diffArchives 一致）：
 * - modified → 内容性变化：章节默认需重转录（重置 content + UNPROCESSED）
 * - renamed → 内容未变：不触发重置（rename 后路径映射变化由执行器处理）
 * - added/removed → 结构性变化：章节可能 add/remove
 */

import { MODULE_ROLE_PATTERNS } from './language-map';
import type { ArchiveDiff } from './repo-tarball';
import type { GitHubNode } from './fetcher';
import type { BackboneDrift } from './ingest/graph-store';

type FileChangeKind = 'added' | 'modified' | 'removed' | 'renamed';

export interface AffectedFile {
  path: string;
  change: FileChangeKind;
}

export interface UpdateCandidateChapter {
  /** Document.path（真实仓库路径或代码章节虚拟路径 chapters/XX.mdx） */
  path: string;
  title: string | null;
  /** 旧转录内容摘要（LLM 判断"变更是否触及被转录内容"的依据） */
  oldSummary: string | null;
  /** 章节级变更性质：结构性（added/removed 文件）优先于内容性（modified） */
  change: 'content' | 'structural';
  affectedFiles: AffectedFile[];
  /**
   * 非 null = 命中确定性 rename（diffArchives 哈希配对：内容未变，仅路径变化）。
   * 由代码接管路径迁移（执行器改写 Document.path + navTree，内容保留不重转录），
   * LLM 对该章节输出的任何 action 一律忽略。仅文档类章节命中：代码章节虚拟路径
   * chapters/XX.mdx 与源文件路径解耦，rename 已由模块重聚类消化。
   */
  rename?: { from: string; to: string };
  /**
   * 非 undefined = Stage 0 规则命中的确定性 keep 豁免（零 LLM、零漂移）：
   * 受影响文件全部为非教学基础设施角色（锁文件/CI/治理元数据），且章节的
   * 内容核（教学源文件）原封未动。计划器直接预填 keep 并从 LLM 候选中剔除。
   */
  keepExemption?: { reason: string; evidence: string };
  /** 外科手术式更新定位锚点（由 Go 语义 Diff 引擎给出） */
  surgicalAnchors?: Array<{
    symbolName: string;
    kind: string;
    file: string;
    change: string;
    exported: boolean;
    line: number;
    reason: string;
    diffSnippet?: string;
  }>;
  /** 是否存在黄金符号或主干契约破坏 */
  isBreaking?: boolean;
}

type NodeDriftStatus = 'stable' | 'modified' | 'breaking';
type EdgeDriftStatus = 'stable' | 'ripple' | 'broken';

interface NodeDriftInfo {
  nodeId: string;
  path: string;
  name: string;
  status: NodeDriftStatus;
  summary: string;
  changedFiles: string[];
  rippleFiles: string[];
}

interface EdgeDriftInfo {
  from: string;
  to: string;
  status: EdgeDriftStatus;
  reason?: string;
}

export interface ArchitectureDrift {
  hasDrift: boolean;
  isCrossBoundary: boolean;
  verdict: string;
  affectedNodes: NodeDriftInfo[];
  affectedEdges: EdgeDriftInfo[];
  driftMermaid: string;
}

export interface UpdateCandidateSet {
  chapters: UpdateCandidateChapter[];
  /** 变更但未命中任何章节的文件（LLM 评估是否 add；含真实文件内容采样由计划器自行抓取） */
  unmatchedFiles: AffectedFile[];
  /** 重聚类检测到的上游新增模块（M2b）：候选 add 章节，由 LLM 裁决 add/忽略 */
  structuralAdds: UpdateCandidateChapter[];
  /** 重聚类检测到的上游消失模块（M2b）：已并入 chapters，由 LLM 裁决 remove/keep */
  structuralRemoves: UpdateCandidateChapter[];
  diffStats: { added: number; modified: number; removed: number; renamed: number };
  /** 旧 sha 是否有本地归档可读（false → 内容采样不可用，计划器应跳过采样） */
  hasOldArchive: boolean;
  /** 骨架漂移指数（新旧 sha 主干集合差异）；任一图谱产物缺失时为 undefined（漂移未知） */
  graphDrift?: BackboneDrift;
  /** 宏观架构漂移与红黄绿拓扑全景图 */
  architectureDrift?: ArchitectureDrift;
  /** drift.index ≥ DefaultBackboneDriftEditionThreshold（Go rsg/diff_engine.go，0.3）→ 建议创建全新教材版本（New Edition） */
  suggestsNewEdition?: boolean;
  /** 是否存在破坏性变更 */
  isBreaking?: boolean;
}

export interface BuildUpdateCandidateSetParams {
  owner: string;
  repo: string;
  branch: string;
  fromSha: string;
  toSha: string;
  repositoryId: string;
  /** 读取哪个归属的文档元数据（null = 共享行；当前用户私有副本 = userId） */
  docOwnerId?: string | null;
  /** 仓库 repoProfile（含 codeClusters）；缺省从 DB 读 */
  repoProfile?: Record<string, unknown> | null;
  /** 预计算 diff；缺省内部调用 diffArchives（from 归档缺失自动按需重下） */
  diff?: ArchiveDiff | null;
  /** 新 sha 的树节点（M2b 重聚类用）；缺省内部 treeFromArchive(toSha) */
  newTree?: GitHubNode[] | null;
  /** 测试注入：跳过 DB 文档读取 */
  documentsOverride?: Array<{ path: string; title: string | null; summary: string | null }>;
  /** GitHub 凭据（用户 OAuth 优先）——from 归档按需重下时使用 */
  token?: string;
}

/** 代码章节虚拟路径（与 code-ingest.ts 的 chapters/{order}.mdx 命名保持一致） */
export function codeChapterPath(teachingOrder: number): string {
  return `chapters/${String(teachingOrder).padStart(2, '0')}.mdx`;
}

/**
 * 路径恒定标识：chapterNo 与首次导入顺序绑定、永不变更；
 * 旧快照（无 chapterNo 字段）回退 teachingOrder。
 */
export function clusterChapterNo(cluster: { chapterNo?: number; teachingOrder: number }): number {
  return cluster.chapterNo ?? cluster.teachingOrder;
}

export function isCodeChapterPath(p: string): boolean {
  return MODULE_ROLE_PATTERNS.virtualChapterPathPrefixes.some((prefix) => p.startsWith(prefix));
}

/**
 * 增量更新候选集构建器（plan-then-apply Stage 0）。
 * Fail-Closed 单实现（2026-09-11 收刀）：计算全量由 Go worker-sidecar 承载
 * （Zero-Ping-Pong & Zero-Set-Churn；缺省输入由 Go pgx store 自查）——本地
 * TypeScript 实现（localBuildUpdateCandidateSet）已物理删除，sidecar 故障显式抛错。
 */
export async function buildUpdateCandidateSet(
  params: BuildUpdateCandidateSetParams
): Promise<UpdateCandidateSet> {
  const { executeSidecarCandidateSet } = await import('./update-candidate-driver');
  return await executeSidecarCandidateSet(params);
}
