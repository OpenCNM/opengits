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

// ─────────────────────────────────────────────────────────────
// Scout 探测阶段万级文件树与规则画像下沉引擎（Zero-Tree Transport）
// 1. 本地归档优先直读（0 网络），未命中时流式请求 GitHub Trees API
// 2. 单趟流式分类排除黑名单（ExclusionReport，最大 15 个样本）
// 3. 原生 Markdown 提取与作用域收窄（prefixFilter / singleDocMode）
// 4. 原生受限深度 DirTree 构建（自然序 + 2000 节点预算整枝裁剪）
// 5. 原生画像嗅探与骨架特征提取（零树化同源检测入参）
// ─────────────────────────────────────────────────────────────

const (
	DirTreeDefaultMaxDepth = 8
	DirTreeMaxNodes        = 2000
)

type GitNode = cluster.GitNode
type SniffProfile = archive.SniffProfile
type ScaleDecision = archive.ScaleDecision

// DirTreeNode 目录树节点（对齐 TS DirTreeNode，供前端树状选择器消费）。
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

// ExclusionItem 排除文件条目（对齐 TS ExclusionItem）。
type ExclusionItem struct {
	Path          string `json:"path"`
	Category      string `json:"category"`
	CategoryLabel string `json:"categoryLabel"`
	Reason        string `json:"reason"`
	Size          int64  `json:"size,omitempty"`
}

// ExclusionReport 排除报告（对齐 TS ExclusionReport）。
type ExclusionReport struct {
	TotalExcludedCount  int             `json:"totalExcludedCount"`
	ByCategory          map[string]int  `json:"byCategory"`
	SampleExcludedFiles []ExclusionItem `json:"sampleExcludedFiles"`
	AllExcludedFiles    []ExclusionItem `json:"allExcludedFiles,omitempty"`
}

// ScoutInspectRequest 探测输入请求。
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

// ScoutInspectResponse 紧凑决策返回（< 50KB，零万级节点 IPC 跨进程搬运）。
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

// FileExclusionVerdict 文件排除分类判定（对齐 internal/archive 单一事实源）。
type FileExclusionVerdict = archive.FileExclusionVerdict

// Config 探测引擎基础配置。
type Config struct {
	ArchiveRoot   string
	GitHubAPIBase string
	GitHubToken   string
	UserAgent     string
}

// Patterns 规范探测过滤与画像所需规则接口。
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

// Inspector 探测执行器。
type Inspector struct {
	cfg Config
}

// NewInspector 构造探测器实例。
func NewInspector(cfg Config) *Inspector {
	return &Inspector{cfg: cfg}
}

// Inspect 执行端到端探测。
func (ins *Inspector) Inspect(ctx context.Context, req ScoutInspectRequest, patterns Patterns) (*ScoutInspectResponse, error) {
	return InspectRepositoryTree(ctx, ins.cfg, req, patterns)
}

// InspectRepositoryTree 执行端到端 Scout 探测流水线与紧凑决策生成。
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

// SkeletonHashOf 计算骨架签名哈希。
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

	// 1. 本地归档优先
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

	// 2. 未命中本地归档：流式请求 GitHub Trees API
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
	// 共享 GitHub 客户端（对齐 fetcher.getRepoTree：限流退避重试、409 立即
	// 空仓、404 末次空仓——此前单次请求遇瞬断/限流即整步失败）
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

		// 高优先级迁移/版本过渡文档白名单保留
		if node.Type == "blob" && patterns.IsHighPriorityMigrationFile(node.Path) {
			filtered = append(filtered, node)
			continue
		}

		// 1. 过滤嘈杂目录前缀（如 node_modules/, dist/, .github/）
		if patterns.IsNoisyPath(node.Path) {
			continue
		}

		// 2. 过滤隐藏目录与文件（如 .agents/, .gitignore）
		if patterns.IsHiddenFileOrDir(node.Path) {
			continue
		}

		// 3. 过滤非教学治理元文件
		parts := strings.Split(node.Path, "/")
		filename := parts[len(parts)-1]
		if patterns.IsIgnoredFilename(filename) {
			continue
		}

		// 4. 基础二进制/多媒体扩展名过滤
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

// buildDirTree 兼容旧调用入口，委托给 DirTreeBuilder。
func buildDirTree(nodes []GitNode, maxDepth int) []DirTreeNode {
	return NewDirTreeBuilder(maxDepth, DirTreeMaxNodes).Build(nodes)
}

// ─────────────────────────────────────────────────────────────
// 独立规则画像与分类模式加载辅助（供 scout 独立测试与自包含运行使用）
// ─────────────────────────────────────────────────────────────
