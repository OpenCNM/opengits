/**
 * 相似度检测域的插件契约（Extract → Match → Consume 分层的类型层）。
 *
 * 设计约束：
 * - 检测器（detector）是唯一扩展点：一个信号一个文件，实现 SourceSignalDetector
 *   并注册进 registry 即被 service 编排——业务调用点（scout/publish/ingest）零感知。
 * - DetectionContext 只含调用点已有数据，检测器按需取用；新增可选字段不算破坏契约。
 * - 本域零 LLM、零向量嵌入：全部信号为确定性计算（hash / 索引查询 / pg_trgm）。
 */

/** 树节点最小形状（fetcher 的 GitHubNode 与归档推导树都满足；engine 无关） */
export interface DetectionTreeNode {
  path: string;
  type: string;
}

/** 检测上下文：调用点已有数据的超集，全部字段可选（除定位三元组） */
export interface DetectionContext {
  owner: string;
  repo: string;
  branch: string;
  /** 当前 commit（懒惰 clone 检测 / 归档键） */
  gitSha?: string | null;
  /** 源码树（骨架信号的数据源；scout 与 ingest 均已持有） */
  treeNodes?: DetectionTreeNode[] | null;
  /** GitHub fork 上游（仅 scout 持有；来自 GitHub API parent/source 字段） */
  forkUpstream?: { owner: string; repo: string } | null;
  /** 行上已持久化的签名（publish 等无树的调用点复用 ingest 期计算结果） */
  existingSignature?: {
    skeleton?: string | null;
    skeletonHash?: string | null;
  };
}

/** 骨架特征（持久化到 Repository.skeleton / skeletonHash 列） */
export interface SkeletonFeature {
  detectorKey: 'skeleton-trgm';
  skeleton: string;
  skeletonHash: string;
}

/** gitSha 特征（即列值，无需额外持久化） */
export interface GitShaFeature {
  detectorKey: 'git-sha';
  gitSha: string;
}

/** fork 元数据特征（来自 GitHub API，不持久化——scout 即时检测） */
export interface ForkMetaFeature {
  detectorKey: 'fork-meta';
  upstream: { owner: string; repo: string };
}

export type SignalFeature = SkeletonFeature | GitShaFeature | ForkMetaFeature;

/** 单次比对命中（0-1 归一化置信度） */
export interface SignalMatch {
  detectorKey: string;
  repositoryId: string;
  owner: string;
  repo: string;
  /** git-sha=1（同 commit 铁证）；fork=0.9（GitHub 元数据）；skeleton=trgm similarity */
  similarity: number;
}

/** match 的可选参数：limit 截断 + 自身排除（同仓库多讲法行骨架天然相同，不算同源） */
export interface MatchOptions {
  limit?: number;
  exclude?: { owner: string; repo: string };
}

/** 统一检测结果：编排层合并去重后交给消费方（横幅/归簇） */
export interface SourceDetectionResult {
  /** 按相似度降序；同一目标仓多信号命中时取最高置信 */
  matches: SignalMatch[];
  best: SignalMatch | null;
  /** 各检测器的特征提取产物（供 ingest 持久化签名） */
  features: SignalFeature[];
}

/**
 * 信号检测器插件契约。
 * extract 缺省的检测器（如纯即时信号）可只实现 match；service 对异常逐个隔离
 * （检测是建议性能力，绝不阻断业务流）。
 */
export interface SourceSignalDetector {
  /** 信号标识（match 归因与消费方展示用） */
  key: string;
  /** 从上下文提取特征（null = 本信号在此上下文不可用） */
  extract?(ctx: DetectionContext): Promise<SignalFeature | null>;
  /** 用特征比对公开教程语料 */
  match(feature: SignalFeature, opts?: MatchOptions): Promise<SignalMatch[]>;
}

/** 信号方法的人类可读名（横幅/徽章展示；集中在注册侧避免散落） */
export const SIGNAL_METHOD_LABELS: Record<string, string> = {
  'git-sha': '同一 commit',
  'fork-meta': 'Fork 派生',
  'skeleton-trgm': '目录结构',
};
