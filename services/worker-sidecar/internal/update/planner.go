package update

import (
	"github.com/opengits/worker-sidecar/internal/cluster"
)

type repoChapterMeta struct {
	Path    string
	Title   *string
	Summary *string
	Files   []string
}

// Pure deterministic planner; all I/O and archive loading happen in BuildUpdateCandidateSet.
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

func repoProfileIngestMode(p *UpdateRepoProfile) string {
	if p == nil {
		return ""
	}
	return p.IngestMode
}
