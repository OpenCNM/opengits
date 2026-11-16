package update

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/cognitive/pipelineb"
	"github.com/opengits/worker-sidecar/internal/diff"
	"github.com/opengits/worker-sidecar/internal/platform/filecache"
)

// patterns 缓存：原生预置编译模式单例，零磁盘 IO。
var (
	clusterPatternsOnce sync.Once
	clusterPatterns     cluster.Patterns
	cogPatternsOnce     sync.Once
	cogPatterns         cognitive.Patterns
)

func cachedClusterPatterns() cluster.Patterns {
	clusterPatternsOnce.Do(func() {
		clusterPatterns = cluster.DefaultPatterns()
	})
	return clusterPatterns
}

func cachedCognitivePatterns() cognitive.Patterns {
	cogPatternsOnce.Do(func() {
		cogPatterns = cognitive.DefaultPatterns()
	})
	return cogPatterns
}

// repoMapCache 架构漂移投影的 RepoMap+拓扑按归档目录（含 toSha，内容
// 寻址不可变）缓存：此前每个候选集请求（auto-update 周期 + 手动红点
// 消费）都全量目录扫描 + 逐文件树重建 + 宏观拓扑重算。mtime+size 校验
// 兜底目录覆写。产物只读共享——调用方不得原地修改。
var repoMapCache = filecache.New[repoMapTopologyEntry](8)

type repoMapTopologyEntry struct {
	m    *pipelineb.RepoMap
	topo *pipelineb.MacroTopology
}

func cachedRepoMapTopology(toDir, repoName string, patterns cognitive.Patterns) (*pipelineb.RepoMap, *pipelineb.MacroTopology) {
	if e, ok := repoMapCache.Get(toDir); ok {
		return e.m, e.topo
	}
	m, err := pipelineb.BuildRepoMap(toDir, repoName, nil, patterns)
	if err != nil || m == nil {
		return nil, nil
	}
	topo := pipelineb.BuildMacroTopology(m, "", 1, patterns)
	if topo == nil {
		return nil, nil
	}
	repoMapCache.Put(toDir, repoMapTopologyEntry{m: m, topo: topo})
	return m, topo
}

// Semantic Diff Aliases from internal/diff
type ChapterRename = diff.ChapterRename
type UpdateArchiveDiff = diff.UpdateArchiveDiff
type KeepExemption = diff.KeepExemption
type SurgicalAnchor = diff.SurgicalAnchor
type BackboneDrift = diff.BackboneDrift
type GraphDiffResponse = diff.GraphDiffResponse
type DiffChapterInput = diff.DiffChapterInput
type GraphDiffRequest = diff.GraphDiffRequest
type ChapterSemanticDecision = diff.ChapterSemanticDecision
type FileSemanticDiff = diff.FileSemanticDiff
type FileSemanticCategory = diff.FileSemanticCategory
type SymbolDiffItem = diff.SymbolDiffItem
type GraphDiffStats = diff.GraphDiffStats

const (
	ActionKeep   = diff.ActionKeep
	ActionUpdate = diff.ActionUpdate
)

// SemanticDiffFunc calculates semantic diff between versions.
type SemanticDiffFunc func(cfg Config, req diff.GraphDiffRequest) (*diff.GraphDiffResponse, error)

// SemanticDiffEngine is the global hook injected by the host server or test suite.
var SemanticDiffEngine SemanticDiffFunc

// UpdateDocumentMeta encapsulates database document metadata.
type UpdateDocumentMeta struct {
	Path    string  `json:"path"`
	Title   *string `json:"title"`
	Summary *string `json:"summary"`
}

// UpdateRepoProfile encapsulates code clusters and ingest mode from repository profile.
type UpdateRepoProfile struct {
	IngestMode   string           `json:"ingestMode,omitempty"`
	CodeClusters []ModuleSnapshot `json:"codeClusters,omitempty"`
}

// UpdateCandidateRequest input payload for POST /v1/update/candidate-set.
type UpdateCandidateRequest struct {
	Owner         string               `json:"owner"`
	Repo          string               `json:"repo"`
	Branch        string               `json:"branch"`
	FromSha       string               `json:"fromSha"`
	ToSha         string               `json:"toSha"`
	RepositoryID  string               `json:"repositoryId"`
	DocOwnerID    *string              `json:"docOwnerId,omitempty"`
	RepoProfile   *UpdateRepoProfile   `json:"repoProfile,omitempty"`
	Diff          *UpdateArchiveDiff   `json:"diff,omitempty"`
	NewTree       []GitNode            `json:"newTree,omitempty"`
	Documents     []UpdateDocumentMeta `json:"documents,omitempty"`
	HasOldArchive *bool                `json:"hasOldArchive,omitempty"`
	GraphDiff     *GraphDiffResponse   `json:"graphDiff,omitempty"`
}

// AffectedFile describes a file and its change type within a chapter or unmatched file list.
type AffectedFile struct {
	Path   string `json:"path"`
	Change string `json:"change"` // "added" | "modified" | "removed" | "renamed"
}

// DiffStats counts file change categories.
type DiffStats struct {
	Added    int `json:"added"`
	Modified int `json:"modified"`
	Removed  int `json:"removed"`
	Renamed  int `json:"renamed"`
}

// UpdateCandidateChapter represents a tutorial chapter candidate for LLM plan generation.
type UpdateCandidateChapter struct {
	Path            string           `json:"path"`
	Title           *string          `json:"title"`
	OldSummary      *string          `json:"oldSummary"`
	Change          string           `json:"change"` // "content" | "structural"
	AffectedFiles   []AffectedFile   `json:"affectedFiles"`
	Rename          *ChapterRename   `json:"rename,omitempty"`
	KeepExemption   *KeepExemption   `json:"keepExemption,omitempty"`
	SurgicalAnchors []SurgicalAnchor `json:"surgicalAnchors,omitempty"`
	IsBreaking      *bool            `json:"isBreaking,omitempty"`
}

// UpdateCandidateResponse output payload for POST /v1/update/candidate-set.
type UpdateCandidateResponse struct {
	Chapters           []UpdateCandidateChapter `json:"chapters"`
	UnmatchedFiles     []AffectedFile           `json:"unmatchedFiles"`
	StructuralAdds     []UpdateCandidateChapter `json:"structuralAdds"`
	StructuralRemoves  []UpdateCandidateChapter `json:"structuralRemoves"`
	DiffStats          DiffStats                `json:"diffStats"`
	HasOldArchive      bool                     `json:"hasOldArchive"`
	GraphDrift         *BackboneDrift           `json:"graphDrift,omitempty"`
	ArchitectureDrift  *ArchitectureDrift       `json:"architectureDrift,omitempty"`
	SuggestsNewEdition *bool                    `json:"suggestsNewEdition,omitempty"`
	IsBreaking         *bool                    `json:"isBreaking,omitempty"`
}

// codeChapterPath formats teachingOrder as chapters/XX.mdx.
func codeChapterPath(teachingOrder int) string {
	return fmt.Sprintf("chapters/%02d.mdx", teachingOrder)
}

// clusterChapterNo returns chapterNo if positive, falling back to teachingOrder.
func clusterChapterNo(chapterNo, teachingOrder int) int {
	if chapterNo > 0 {
		return chapterNo
	}
	return teachingOrder
}

// isCodeChapterPath checks if a path is a virtual code chapter.
func isCodeChapterPath(p string) bool {
	return strings.HasPrefix(p, "chapters/")
}

// diffArchiveTrees compares two hash trees into added, modified, removed and renames.
func diffArchiveTrees(oldTree, newTree map[string]string) *UpdateArchiveDiff {
	return diff.DiffArchiveTrees(oldTree, newTree)
}

func computeArchiveDiffFromDisk(archiveRoot, owner, repo, fromSha, toSha string) (*UpdateArchiveDiff, bool, error) {
	return diff.ComputeArchiveDiffFromDisk(archiveRoot, owner, repo, fromSha, toSha)
}

// BuildUpdateCandidateSet orchestrates update candidate set generation in Go memory.
func BuildUpdateCandidateSet(cfg Config, req UpdateCandidateRequest, store ...CandidateStore) (*UpdateCandidateResponse, error) {
	archiveRoot := cfg.ArchiveRoot
	if archiveRoot == "" {
		archiveRoot = "storage/repos"
	}

	hasOldArchive := false
	if req.HasOldArchive != nil {
		hasOldArchive = *req.HasOldArchive
	} else if req.Owner != "" && req.Repo != "" && req.FromSha != "" {
		oldDir := cluster.ArchiveDirFor(archiveRoot, req.Owner, req.Repo, req.FromSha)
		if fi, err := os.Stat(oldDir); err == nil && fi.IsDir() {
			hasOldArchive = true
		} else {
			oldCompact := archive.CompactArchivePathFor(archiveRoot, req.Owner, req.Repo, req.FromSha)
			if fi, err := os.Stat(oldCompact); err == nil && !fi.IsDir() {
				hasOldArchive = true
			}
		}
	}

	diffResult := req.Diff
	if diffResult == nil {
		computedDiff, hasOld, err := computeArchiveDiffFromDisk(archiveRoot, req.Owner, req.Repo, req.FromSha, req.ToSha)
		if err != nil {
			// 归档缺失按需重拉（对齐 Node ensureArchive GC 恢复回退，c4949c4b^
			// update-candidate-set）：老版归档被清扫/新 sha 从未下载不再直接
			// 422 强制全量重导、周期红点永久卡死
			if ensureErr := ensureArchivesForDiff(cfg, archiveRoot, req.Owner, req.Repo, req.FromSha, req.ToSha); ensureErr != nil {
				log.Printf("[update-candidate] archive ensure fallback failed for %s/%s: %v", req.Owner, req.Repo, ensureErr)
			} else {
				computedDiff, hasOld, err = computeArchiveDiffFromDisk(archiveRoot, req.Owner, req.Repo, req.FromSha, req.ToSha)
			}
			if err != nil {
				return nil, fmt.Errorf("增量 Diff 不可用（归档缺失或计算空值）: %w", err)
			}
		}
		diffResult = computedDiff
		if req.HasOldArchive == nil {
			hasOldArchive = hasOld
		}
	}
	if diffResult == nil {
		return nil, errors.New("增量 Diff 不可用（归档缺失或计算空值）")
	}

	var currentStore CandidateStore
	if len(store) > 0 && store[0] != nil {
		currentStore = store[0]
	}

	repoProfile := req.RepoProfile
	if repoProfile == nil && currentStore != nil && req.RepositoryID != "" {
		pctx, pcancel := context.WithTimeout(context.Background(), 10*time.Second)
		if p, err := currentStore.GetRepoProfile(pctx, req.RepositoryID); err == nil && p != nil {
			repoProfile = p
		}
		pcancel()
	}
	var clusters []ModuleSnapshot
	if repoProfile != nil && len(repoProfile.CodeClusters) > 0 {
		clusters = repoProfile.CodeClusters
	}

	docs := req.Documents
	if len(docs) == 0 && currentStore != nil && req.RepositoryID != "" {
		dctx, dcancel := context.WithTimeout(context.Background(), 10*time.Second)
		if d, err := currentStore.GetDocuments(dctx, req.RepositoryID, req.DocOwnerID); err == nil && len(d) > 0 {
			docs = d
		}
		dcancel()
	}
	docByPath := make(map[string]UpdateDocumentMeta, len(docs))
	for _, d := range docs {
		docByPath[d.Path] = d
	}

	patterns := cachedClusterPatterns()

	var newClusters []ModuleSnapshot
	var clusterDiff *cluster.ClusterDiffResult
	freshTree := req.NewTree

	if len(clusters) > 0 {
		if len(freshTree) == 0 && req.Owner != "" && req.Repo != "" && req.ToSha != "" {
			var skipFn func(string) bool
			if patterns != nil {
				skipFn = func(relPath string) bool {
					return patterns.IsNonContentDir(relPath)
				}
			}
			_ = cluster.WalkArchiveTree(archiveRoot, req.Owner, req.Repo, req.ToSha, skipFn, func(n GitNode) error {
				freshTree = append(freshTree, n)
				return nil
			})
		}
		if len(freshTree) > 0 {
			recomputed := cluster.RecomputeModuleSnapshots(clusters, freshTree, patterns)
			if recomputed != nil {
				newClusters = recomputed
				cd := cluster.DiffCodeClusters(clusters, recomputed)
				clusterDiff = &cd
			}
		}
	}

	chapters, unmatchedFiles, structuralAdds, structuralRemoves, allRepoChapters, repoChapterMap := planChapters(diffResult, clusters, newClusters, clusterDiff, docs, repoProfileIngestMode(repoProfile))

	// Semantic Graph Diff
	var graphDrift *BackboneDrift
	var suggestsNewEdition *bool
	var isBreaking *bool
	var graphDiffResp *GraphDiffResponse

	if len(chapters) > 0 || len(diffResult.Modified) > 0 || len(diffResult.Added) > 0 || len(diffResult.Removed) > 0 {
		if req.GraphDiff != nil {
			graphDiffResp = req.GraphDiff
		} else if SemanticDiffEngine != nil {
			diffChaptersInput := make([]DiffChapterInput, 0)
			if len(allRepoChapters) > 0 {
				for _, c := range allRepoChapters {
					diffChaptersInput = append(diffChaptersInput, DiffChapterInput{Path: c.Path, Files: c.Files})
				}
			} else {
				for _, c := range chapters {
					files := make([]string, 0, len(c.AffectedFiles))
					for _, f := range c.AffectedFiles {
						files = append(files, f.Path)
					}
					diffChaptersInput = append(diffChaptersInput, DiffChapterInput{Path: c.Path, Files: files})
				}
			}

			graphDiffReq := GraphDiffRequest{
				Owner:         req.Owner,
				Repo:          req.Repo,
				FromSha:       req.FromSha,
				ToSha:         req.ToSha,
				ModifiedFiles: diffResult.Modified,
				AddedFiles:    diffResult.Added,
				RemovedFiles:  diffResult.Removed,
				Chapters:      diffChaptersInput,
			}
			var err error
			graphDiffResp, err = SemanticDiffEngine(cfg, graphDiffReq)
			if err != nil {
				return nil, fmt.Errorf("Worker sidecar semantic graph diff failed: %w", err)
			}
		}

		if graphDiffResp != nil {
			if graphDiffResp.GraphDrift != nil {
				graphDrift = graphDiffResp.GraphDrift
			}
			sne := graphDiffResp.SuggestsNewEdition
			suggestsNewEdition = &sne
			ib := graphDiffResp.IsBreaking
			isBreaking = &ib

			existingChapterIdx := make(map[string]int, len(chapters))
			for i, c := range chapters {
				existingChapterIdx[c.Path] = i
			}

			for _, decision := range graphDiffResp.ChapterDecisions {
				idx, found := existingChapterIdx[decision.Path]
				switch decision.Action {
				case ActionKeep:
					if found {
						applyKeepDecision(&chapters[idx], decision)
					}
				case ActionUpdate:
					if found {
						applyUpdateExistingChapter(&chapters[idx], decision)
					} else {
						newChap := buildNewCandidateChapter(decision, repoChapterMap)
						chapters = append(chapters, newChap)
						existingChapterIdx[decision.Path] = len(chapters) - 1
					}
				}
			}
		}
	}

	var archDrift *ArchitectureDrift
	if req.Owner != "" && req.Repo != "" && req.ToSha != "" {
		toDir := cluster.ArchiveDirFor(archiveRoot, req.Owner, req.Repo, req.ToSha)
		if fi, err := os.Stat(toDir); err == nil && fi.IsDir() {
			cogPatterns := cachedCognitivePatterns()
			m, topo := cachedRepoMapTopology(toDir, req.Repo, cogPatterns)
			if m != nil && topo != nil {
				var fileDiffs map[string]diff.FileSemanticDiff
				rippleCallers := make(map[string][]diff.SurgicalAnchor)
				if graphDiffResp != nil {
					fileDiffs = graphDiffResp.FileDiffs
					for _, dec := range graphDiffResp.ChapterDecisions {
						for _, a := range dec.SurgicalAnchors {
							if a.Change == "ripple" || strings.Contains(a.Reason, "调用了") {
								rippleCallers[a.File] = append(rippleCallers[a.File], a)
							}
						}
					}
					for f, fd := range graphDiffResp.FileDiffs {
						if fd.Category == diff.FileCategoryRippleAffected && len(rippleCallers[f]) == 0 {
							rippleCallers[f] = append(rippleCallers[f], diff.SurgicalAnchor{
								File:   f,
								Change: "ripple",
								Reason: fd.Details,
							})
						}
					}
				}
				archDrift = ComputeArchitectureDrift(topo, diffResult, fileDiffs, rippleCallers)
			}
		}
	}

	return &UpdateCandidateResponse{
		Chapters:          chapters,
		UnmatchedFiles:    unmatchedFiles,
		StructuralAdds:    structuralAdds,
		StructuralRemoves: structuralRemoves,
		DiffStats: DiffStats{
			Added:    len(diffResult.Added),
			Modified: len(diffResult.Modified),
			Removed:  len(diffResult.Removed),
			Renamed:  len(diffResult.Renamed),
		},
		HasOldArchive:      hasOldArchive,
		GraphDrift:         graphDrift,
		ArchitectureDrift:  archDrift,
		SuggestsNewEdition: suggestsNewEdition,
		IsBreaking:         isBreaking,
	}, nil
}

// ensureArchivesForDiff 按需重拉缺失归档（ensure.go 共享内核；单 sha 120s 预算）。
func ensureArchivesForDiff(cfg Config, archiveRoot, owner, repo, fromSha, toSha string) error {
	if owner == "" || repo == "" {
		return errors.New("owner/repo missing for archive ensure")
	}
	ensureCfg := archive.Config{
		ArchiveRoot:   archiveRoot,
		GitHubAPIBase: cfg.GitHubAPIBase,
		GitHubToken:   cfg.GitHubToken,
		UserAgent:     cfg.UserAgent,
	}
	svc := archive.NewEnsureService(ensureCfg)
	ctx, cancel := context.WithTimeout(context.Background(), 240*time.Second)
	defer cancel()
	for _, sha := range []string{fromSha, toSha} {
		if sha == "" {
			continue
		}
		if fi, err := os.Stat(cluster.ArchiveDirFor(archiveRoot, owner, repo, sha)); err == nil && fi.IsDir() {
			continue // 本地已有
		}
		dir, _, err := svc.Ensure(ctx, owner, repo, sha, 0, cfg.GitHubToken)
		if err != nil {
			return fmt.Errorf("ensure archive %s: %w", sha, err)
		}
		if dir == "" {
			return fmt.Errorf("ensure archive %s skipped (over cap or timeout)", sha)
		}
	}
	return nil
}

func applyKeepDecision(existing *UpdateCandidateChapter, decision diff.ChapterSemanticDecision) {
	if decision.KeepExemption != nil {
		existing.KeepExemption = decision.KeepExemption
		return
	}
	existing.KeepExemption = &KeepExemption{
		Reason:   "Go 语义裁决无需更新，零 LLM 豁免",
		Evidence: existing.Path,
	}
}

func applyUpdateExistingChapter(existing *UpdateCandidateChapter, decision diff.ChapterSemanticDecision) {
	existing.KeepExemption = nil
	if len(decision.SurgicalAnchors) > 0 {
		existing.SurgicalAnchors = decision.SurgicalAnchors
	}
	if decision.IsBreaking {
		brk := true
		existing.IsBreaking = &brk
	}
}

func buildNewCandidateChapter(decision diff.ChapterSemanticDecision, repoChapterMap map[string]repoChapterMeta) UpdateCandidateChapter {
	meta, hasMeta := repoChapterMap[decision.Path]
	targetFiles := extractDecisionTargetFiles(decision.SurgicalAnchors, meta, hasMeta)

	affectedFiles := make([]AffectedFile, 0, len(targetFiles))
	for _, f := range targetFiles {
		affectedFiles = append(affectedFiles, AffectedFile{Path: f, Change: "modified"})
	}

	var title *string
	var summary *string
	if hasMeta {
		title = meta.Title
		summary = meta.Summary
	}
	isBrk := decision.IsBreaking
	return UpdateCandidateChapter{
		Path:            decision.Path,
		Title:           title,
		OldSummary:      summary,
		Change:          "content",
		AffectedFiles:   affectedFiles,
		SurgicalAnchors: decision.SurgicalAnchors,
		IsBreaking:      &isBrk,
	}
}

func extractDecisionTargetFiles(anchors []SurgicalAnchor, meta repoChapterMeta, hasMeta bool) []string {
	if len(anchors) == 0 {
		if hasMeta {
			return meta.Files
		}
		return nil
	}
	seen := make(map[string]bool)
	var targetFiles []string
	for _, a := range anchors {
		if a.File != "" && !seen[a.File] {
			seen[a.File] = true
			targetFiles = append(targetFiles, a.File)
		}
	}
	return targetFiles
}
