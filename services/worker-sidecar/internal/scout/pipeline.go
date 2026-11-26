package scout

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/reputation"
)

type ScoutPipelineContext struct {
	Cfg             Config
	Req             ScoutInspectRequest
	Patterns        Patterns
	MaxDepth        int
	TreeRes         *treeFetchResult
	FilteredNodes   []GitNode
	ExclusionReport ExclusionReport
	MarkdownFiles   []GitNode
	DirTree         []DirTreeNode
	Profile         SniffProfile
	Scale           ScaleDecision
	Skeleton        string
	SkeletonHash    string
	Reputation      *reputation.EvaluationResult
	ReadmeSnippet   string
}

type ScoutPipelineStage interface {
	Name() string
	Process(ctx context.Context, pCtx *ScoutPipelineContext) error
}

type treeFetchStage struct{}

func (s *treeFetchStage) Name() string { return "TreeFetch" }

func (s *treeFetchStage) Process(ctx context.Context, pCtx *ScoutPipelineContext) error {
	treeRes, err := fetchOrReadTree(ctx, pCtx.Cfg, pCtx.Req)
	if err != nil {
		return err
	}
	pCtx.TreeRes = treeRes
	return nil
}

type nodeFilterAndExclusionStage struct{}

func (s *nodeFilterAndExclusionStage) Name() string { return "NodeFilterAndExclusion" }

func (s *nodeFilterAndExclusionStage) Process(ctx context.Context, pCtx *ScoutPipelineContext) error {
	filteredNodes, exclusionReport := filterAndClassifyNodes(pCtx.TreeRes.Nodes, pCtx.Patterns)
	pCtx.FilteredNodes = filteredNodes
	pCtx.ExclusionReport = exclusionReport
	return nil
}

type markdownScopeStage struct{}

func (s *markdownScopeStage) Name() string { return "MarkdownScope" }

func (s *markdownScopeStage) Process(ctx context.Context, pCtx *ScoutPipelineContext) error {
	pCtx.MarkdownFiles = collectScopedMarkdown(
		pCtx.FilteredNodes,
		pCtx.Req.PrefixFilter,
		pCtx.Req.FilePath,
		pCtx.Req.SingleDocMode,
		pCtx.Patterns,
	)
	return nil
}

type dirTreeStage struct{}

func (s *dirTreeStage) Name() string { return "DirTree" }

func (s *dirTreeStage) Process(ctx context.Context, pCtx *ScoutPipelineContext) error {
	builder := NewDirTreeBuilder(pCtx.MaxDepth, DirTreeMaxNodes)
	pCtx.DirTree = builder.Build(pCtx.FilteredNodes)
	return nil
}

type profileAndScaleStage struct{}

func (s *profileAndScaleStage) Name() string { return "ProfileAndScale" }

func (s *profileAndScaleStage) Process(ctx context.Context, pCtx *ScoutPipelineContext) error {
	pCtx.Profile = pCtx.Patterns.SniffRepo(pCtx.FilteredNodes, pCtx.TreeRes.Truncated)
	scale := pCtx.Patterns.ComputeRepoScale(pCtx.FilteredNodes)

	rep := reputation.EvaluateRepoReputation(reputation.RepoMeta{
		Owner:     pCtx.Req.Owner,
		Repo:      pCtx.Req.Repo,
		Stars:     pCtx.Req.Stars,
		Forks:     pCtx.Req.Forks,
		NodeCount: len(pCtx.FilteredNodes),
	})
	pCtx.Reputation = &rep

	if rep.IsRejected && scale.Scale == "giant" {
		scale.Scale = "rejected"
		scale.Reason = rep.Reason
	} else if rep.IsClassic && scale.Scale == "giant" {
		scale.Reason = fmt.Sprintf("知名经典开源项目 (%s)，已自动放宽配额并开启核心自适应聚焦模式", rep.Reason)
	}

	pCtx.Scale = scale
	return nil
}

type skeletonStage struct{}

func (s *skeletonStage) Name() string { return "Skeleton" }

func (s *skeletonStage) Process(ctx context.Context, pCtx *ScoutPipelineContext) error {
	skeletonPaths := concept.ExtractSkeletonPaths(pCtx.TreeRes.Nodes, pCtx.Patterns)
	pCtx.Skeleton = concept.BuildSkeleton(skeletonPaths)
	pCtx.SkeletonHash = concept.SkeletonHashOf(pCtx.Skeleton)
	return nil
}

type readmeStage struct{}

func (s *readmeStage) Name() string { return "Readme" }

func (s *readmeStage) Process(ctx context.Context, pCtx *ScoutPipelineContext) error {
	var readmePath string
	for _, n := range pCtx.FilteredNodes {
		base := strings.ToLower(filepath.Base(n.Path))
		if (base == "readme.md" || base == "readme" || base == "readme.rst" || base == "readme.txt") && !strings.Contains(n.Path, "/") {
			readmePath = n.Path
			break
		}
	}
	if readmePath == "" {
		for _, n := range pCtx.FilteredNodes {
			base := strings.ToLower(filepath.Base(n.Path))
			if base == "readme.md" || base == "readme" || base == "readme.rst" {
				readmePath = n.Path
				break
			}
		}
	}
	if readmePath == "" || !pCtx.TreeRes.ArchiveUsed {
		return nil
	}

	archiveRoot := pCtx.Cfg.ArchiveRoot
	if archiveRoot == "" {
		archiveRoot = "storage/repos"
	}
	compactPath := archive.ArchiveDirFor(archiveRoot, pCtx.Req.Owner, pCtx.Req.Repo, pCtx.Req.Sha) + ".tar.gz"
	if _, err := os.Stat(compactPath); err == nil {
		content, err := archive.ReadSingleFileFromCompactArchive(compactPath, readmePath, 0, 0, 4096)
		if err == nil && len(content) > 0 {
			if len(content) > 3000 {
				content = content[:3000]
			}
			pCtx.ReadmeSnippet = content
			return nil
		}
	}

	expandedDir := archive.ArchiveDirFor(archiveRoot, pCtx.Req.Owner, pCtx.Req.Repo, pCtx.Req.Sha)
	unpackedPath := filepath.Join(expandedDir, filepath.FromSlash(readmePath))
	if b, err := os.ReadFile(unpackedPath); err == nil && len(b) > 0 {
		content := string(b)
		if len(content) > 3000 {
			content = content[:3000]
		}
		pCtx.ReadmeSnippet = content
	}

	return nil
}

type ScoutPipeline struct {
	stages []ScoutPipelineStage
}

func NewDefaultScoutPipeline() *ScoutPipeline {
	return &ScoutPipeline{
		stages: []ScoutPipelineStage{
			&treeFetchStage{},
			&nodeFilterAndExclusionStage{},
			&markdownScopeStage{},
			&dirTreeStage{},
			&profileAndScaleStage{},
			&skeletonStage{},
			&readmeStage{},
		},
	}
}

func (p *ScoutPipeline) Execute(ctx context.Context, pCtx *ScoutPipelineContext) (*ScoutInspectResponse, error) {
	for _, stage := range p.stages {
		if err := stage.Process(ctx, pCtx); err != nil {
			return nil, err
		}
	}

	return &ScoutInspectResponse{
		Ok:              true,
		ArchiveUsed:     pCtx.TreeRes.ArchiveUsed,
		TotalNodeCount:  len(pCtx.TreeRes.Nodes),
		MarkdownFiles:   pCtx.MarkdownFiles,
		Profile:         pCtx.Profile,
		Scale:           pCtx.Scale,
		DirTree:         pCtx.DirTree,
		ExclusionReport: pCtx.ExclusionReport,
		Skeleton:        pCtx.Skeleton,
		SkeletonHash:    pCtx.SkeletonHash,
		Truncated:       pCtx.TreeRes.Truncated,
		Reputation:      pCtx.Reputation,
		ReadmeSnippet:   pCtx.ReadmeSnippet,
	}, nil
}
