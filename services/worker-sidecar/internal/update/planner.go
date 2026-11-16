package update

import (
	"github.com/opengits/worker-sidecar/internal/cluster"
)

// ─────────────────────────────────────────────────────────────
// Planner 纯函数（增量更新计划的核心决策体，planner/applier 分相之一）。
//
// 输入全部由外壳（BuildUpdateCandidateSet）装载：归档 diff、新旧模块
// 快照、cluster diff、文档元数据、画像模式。本函数零 I/O、零时间依赖、
// 零全局——可对任意输入组合黄金测试（BUG-55/56 类"compare 状态映射丢
// 字段"缺陷在纯函数里无处藏身）。语义图 diff 是其后的富集阶段（引擎
// 调用，留在壳内），响应拼装在其后。
// ─────────────────────────────────────────────────────────────

// repoChapterMeta 章节级元数据（语义 diff 的章节输入面）。
type repoChapterMeta struct {
	Path    string
	Title   *string
	Summary *string
	Files   []string
}

// planChapters 计算候选章节集：委托给 CandidatePlanBuilder 流水线构建器。
// 返回章节计划、未匹配文件与语义 diff 章节元数据（含按路径索引）。
func planChapters(
	diffResult *UpdateArchiveDiff,
	clusters []ModuleSnapshot,
	newClusters []ModuleSnapshot,
	clusterDiff *cluster.ClusterDiffResult,
	docs []UpdateDocumentMeta,
	ingestMode string,
) ([]UpdateCandidateChapter, []AffectedFile, []UpdateCandidateChapter, []UpdateCandidateChapter, []repoChapterMeta, map[string]repoChapterMeta) {
	builder := NewCandidatePlanBuilder(diffResult, clusters, newClusters, clusterDiff, docs, ingestMode)
	return builder.Build()
}


// repoProfileIngestMode 画像缺省空串（非 architecture_overview 路径）。
func repoProfileIngestMode(p *UpdateRepoProfile) string {
	if p == nil {
		return ""
	}
	return p.IngestMode
}
