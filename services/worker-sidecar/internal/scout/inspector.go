package scout

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/opengits/worker-sidecar/internal/reputation"
)

const (
	DirTreeDefaultMaxDepth = 8
	DirTreeMaxNodes        = 2000
)

type GitNode = cluster.GitNode
type SniffProfile = archive.SniffProfile
type ScaleDecision = archive.ScaleDecision

type DirTreeNode struct {
	Path        string        `json:"path"`
	Name        string        `json:"name"`
	Depth       int           `json:"depth"`
	MdCount     int           `json:"mdCount"`
	CodeCount   int           `json:"codeCount"`
	PrimaryLang string        `json:"primaryLang,omitempty"`
	KeyFiles    []string      `json:"keyFiles,omitempty"`
	TotalFiles  int           `json:"totalFiles"`
	Children    []DirTreeNode `json:"children"`
}

type ExclusionItem struct {
	Path          string `json:"path"`
	Category      string `json:"category"`
	CategoryLabel string `json:"categoryLabel"`
	Reason        string `json:"reason"`
	Size          int64  `json:"size,omitempty"`
}

type ExclusionReport struct {
	TotalExcludedCount  int             `json:"totalExcludedCount"`
	ByCategory          map[string]int  `json:"byCategory"`
	SampleExcludedFiles []ExclusionItem `json:"sampleExcludedFiles"`
	AllExcludedFiles    []ExclusionItem `json:"allExcludedFiles,omitempty"`
}

type ScoutInspectRequest struct {
	Owner         string `json:"owner"`
	Repo          string `json:"repo"`
	Branch        string `json:"branch,omitempty"`
	Sha           string `json:"sha,omitempty"`
	Token         string `json:"token,omitempty"`
	PrefixFilter  string `json:"prefixFilter,omitempty"`
	FilePath      string `json:"filePath,omitempty"`
	SingleDocMode bool   `json:"singleDocMode,omitempty"`
	MaxDepth      int    `json:"maxDepth,omitempty"`
	Stars         int    `json:"stars,omitempty"`
	Forks         int    `json:"forks,omitempty"`
}

type ScoutInspectResponse struct {
	Ok              bool                         `json:"ok"`
	ArchiveUsed     bool                         `json:"archiveUsed"`
	TotalNodeCount  int                          `json:"totalNodeCount"`
	MarkdownFiles   []GitNode                    `json:"markdownFiles"`
	Profile         SniffProfile                 `json:"profile"`
	Scale           ScaleDecision                `json:"scale"`
	DirTree         []DirTreeNode                `json:"dirTree"`
	ExclusionReport ExclusionReport              `json:"exclusionReport"`
	Skeleton        string                       `json:"skeleton"`
	SkeletonHash    string                       `json:"skeletonHash"`
	Truncated       bool                         `json:"truncated"`
	Reputation      *reputation.EvaluationResult `json:"reputation,omitempty"`
	ReadmeSnippet   string                       `json:"readmeSnippet,omitempty"`
}

type FileExclusionVerdict = archive.FileExclusionVerdict

type Config struct {
	ArchiveRoot   string
	GitHubAPIBase string
	GitHubToken   string
	UserAgent     string
}

type Patterns interface {
	archive.RepoSniffer
	ClassifyExcludedFile(filePath string, size int64) FileExclusionVerdict
	IsHighPriorityMigrationFile(filePath string) bool
	IsNoisyPath(path string) bool
	IsHiddenFileOrDir(path string) bool
	IsIgnoredFilename(name string) bool
	IsBinaryOrArchiveFile(path string) bool
	MarkdownExtensions() []string
	IsNonContentDir(path string) bool
	IsNonContentFile(path string) bool
	IsCodeFile(path string) bool
	IsDocFile(path string) bool
}

type Inspector struct {
	cfg Config
}

func NewInspector(cfg Config) *Inspector {
	return &Inspector{cfg: cfg}
}

func (ins *Inspector) Inspect(ctx context.Context, req ScoutInspectRequest, patterns Patterns) (*ScoutInspectResponse, error) {
	return InspectRepositoryTree(ctx, ins.cfg, req, patterns)
}

func InspectRepositoryTree(ctx context.Context, cfg Config, req ScoutInspectRequest, patterns Patterns) (*ScoutInspectResponse, error) {
	if req.Owner == "" || req.Repo == "" {
		return nil, fmt.Errorf("owner and repo are required")
	}

	maxDepth := req.MaxDepth
	if maxDepth <= 0 || maxDepth > DirTreeDefaultMaxDepth {
		maxDepth = DirTreeDefaultMaxDepth
	}

	pCtx := &ScoutPipelineContext{
		Cfg:      cfg,
		Req:      req,
		Patterns: patterns,
		MaxDepth: maxDepth,
	}

	pipeline := NewDefaultScoutPipeline()
	return pipeline.Execute(ctx, pCtx)
}

func SkeletonHashOf(skeleton string) string {
	return concept.SkeletonHashOf(skeleton)
}

type treeFetchResult struct {
	Nodes       []GitNode
	ArchiveUsed bool
	Truncated   bool
}

func fetchOrReadTree(ctx context.Context, cfg Config, req ScoutInspectRequest) (*treeFetchResult, error) {
	archiveRoot := cfg.ArchiveRoot
	if archiveRoot == "" {
		archiveRoot = "storage/repos"
	}

	if req.Sha != "" {
		archiveDir := archive.ArchiveDirFor(archiveRoot, req.Owner, req.Repo, req.Sha)
		if st, err := os.Stat(archiveDir); err == nil && st.IsDir() {
			diskNodes, ok := archive.TreeFromArchive(archiveRoot, req.Owner, req.Repo, req.Sha)
			if ok && len(diskNodes) > 0 {
				return &treeFetchResult{
					Nodes:       diskNodes,
					ArchiveUsed: true,
					Truncated:   false,
				}, nil
			}
		}
	}

	apiBase := cfg.GitHubAPIBase
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}

	ref := req.Branch
	if ref == "" {
		ref = req.Sha
	}
	if ref == "" {
		ref = "main"
	}

	treeURL := fmt.Sprintf("%s/repos/%s/%s/git/trees/%s?recursive=1",
		strings.TrimRight(apiBase, "/"),
		req.Owner,
		req.Repo,
		url.PathEscape(ref),
	)

	token := req.Token
	if token == "" {
		token = cfg.GitHubToken
	}

	ua := cfg.UserAgent
	if ua == "" {
		ua = "OpenGits-Engine"
	}
	// Uses shared GitHub client for rate-limit backoff and deterministic 404/409 empty-repo handling.
	var ghRes struct {
		SHA       string    `json:"sha"`
		Tree      []GitNode `json:"tree"`
		Truncated bool      `json:"truncated"`
	}
	if err := client.GithubGetJSON(ctx, treeURL, token, ua, &ghRes); err != nil {
		if client.IsGithubEmptyRepo(err) {
			return nil, err
		}
		return nil, fmt.Errorf("failed to fetch github tree: %w", err)
	}

	if len(ghRes.Tree) == 0 {
		return nil, fmt.Errorf("empty repository")
	}

	if ghRes.Truncated {
		contentsURL := fmt.Sprintf("%s/repos/%s/%s/contents?ref=%s",
			strings.TrimRight(apiBase, "/"),
			req.Owner,
			req.Repo,
			url.PathEscape(ref),
		)
		var contents []struct {
			Path string `json:"path"`
			Type string `json:"type"`
			Size int64  `json:"size"`
		}
		if err := client.GithubGetJSON(ctx, contentsURL, token, ua, &contents); err == nil {
			existingPaths := make(map[string]bool, len(ghRes.Tree))
			for _, n := range ghRes.Tree {
				existingPaths[n.Path] = true
			}
			for _, item := range contents {
				if existingPaths[item.Path] {
					continue
				}
				nodeType := "blob"
				if item.Type == "dir" {
					nodeType = "tree"
				}
				ghRes.Tree = append(ghRes.Tree, GitNode{
					Path: item.Path,
					Type: nodeType,
					Size: item.Size,
				})
			}
		}
	}

	return &treeFetchResult{
		Nodes:       ghRes.Tree,
		ArchiveUsed: false,
		Truncated:   ghRes.Truncated,
	}, nil
}

func filterAndClassifyNodes(nodes []GitNode, patterns Patterns) ([]GitNode, ExclusionReport) {
	report := ExclusionReport{
		TotalExcludedCount: 0,
		ByCategory: map[string]int{
			"archive":      0,
			"executable":   0,
			"office_media": 0,
			"build_db":     0,
			"oversized":    0,
		},
		SampleExcludedFiles: make([]ExclusionItem, 0, 15),
		AllExcludedFiles:    []ExclusionItem{},
	}

	filtered := make([]GitNode, 0, len(nodes))

	for _, node := range nodes {
		if node.Type == "blob" {
			verdict := patterns.ClassifyExcludedFile(node.Path, node.Size)
			if verdict.IsExcluded && verdict.Category != "" {
				report.TotalExcludedCount++
				report.ByCategory[verdict.Category]++
				item := ExclusionItem{
					Path:          node.Path,
					Category:      verdict.Category,
					CategoryLabel: verdict.CategoryLabel,
					Reason:        verdict.Reason,
					Size:          node.Size,
				}
				if len(report.SampleExcludedFiles) < 15 {
					report.SampleExcludedFiles = append(report.SampleExcludedFiles, item)
				}
				continue
			}
		}

		if node.Type == "blob" && patterns.IsHighPriorityMigrationFile(node.Path) {
			filtered = append(filtered, node)
			continue
		}

		if patterns.IsNoisyPath(node.Path) {
			continue
		}

		if patterns.IsHiddenFileOrDir(node.Path) {
			continue
		}

		parts := strings.Split(node.Path, "/")
		filename := parts[len(parts)-1]
		if patterns.IsIgnoredFilename(filename) {
			continue
		}

		if patterns.IsBinaryOrArchiveFile(node.Path) {
			continue
		}

		filtered = append(filtered, node)
	}

	return filtered, report
}

func collectScopedMarkdown(nodes []GitNode, prefixFilter, filePath string, singleDocMode bool, patterns Patterns) []GitNode {
	var mdFiles []GitNode
	extensions := patterns.MarkdownExtensions()
	if len(extensions) == 0 {
		extensions = []string{".md", ".mdx"}
	}

	for _, n := range nodes {
		if n.Type != "blob" {
			continue
		}
		lower := strings.ToLower(n.Path)
		isMd := false
		for _, ext := range extensions {
			if strings.HasSuffix(lower, ext) {
				isMd = true
				break
			}
		}
		if isMd {
			mdFiles = append(mdFiles, n)
		}
	}

	effectivePrefix := prefixFilter
	if effectivePrefix == "" && filePath != "" && !singleDocMode {
		effectivePrefix = filePath
	}

	if effectivePrefix != "" {
		prefixNorm := effectivePrefix
		if !strings.HasSuffix(prefixNorm, "/") {
			prefixNorm += "/"
		}
		var matched []GitNode
		for _, n := range mdFiles {
			if strings.HasPrefix(n.Path, prefixNorm) || strings.HasPrefix(n.Path, effectivePrefix) {
				matched = append(matched, n)
			}
		}
		mdFiles = matched
	}

	if singleDocMode && filePath != "" {
		normTarget := strings.ToLower(filePath)
		var exact []GitNode
		for _, n := range mdFiles {
			if strings.ToLower(n.Path) == normTarget {
				exact = append(exact, n)
			}
		}
		if len(exact) > 0 {
			mdFiles = exact
		} else {
			var matched []GitNode
			for _, n := range mdFiles {
				if strings.HasSuffix(strings.ToLower(n.Path), normTarget) {
					matched = append(matched, n)
				}
			}
			if len(matched) > 0 {
				mdFiles = matched
			}
		}
	}

	if mdFiles == nil {
		mdFiles = []GitNode{}
	}
	return mdFiles
}

func buildDirTree(nodes []GitNode, maxDepth int) []DirTreeNode {
	return NewDirTreeBuilder(maxDepth, DirTreeMaxNodes).Build(nodes)
}
