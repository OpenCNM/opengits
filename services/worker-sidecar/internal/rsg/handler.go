package rsg

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

// SymbolsExtractRequest represents the payload for POST /v1/symbols/extract.
type SymbolsExtractRequest struct {
	FilePath string `json:"filePath"`
	Content  string `json:"content"`
}

// SymbolsExtractResponse represents the response for POST /v1/symbols/extract.
type SymbolsExtractResponse struct {
	Ok                  bool           `json:"ok"`
	Symbols             []SymbolEntry  `json:"symbols"`
	Imports             []ImportRecord `json:"imports"`
	CallSites           []CallSite     `json:"callSites"`
	ReferencedConstants []string       `json:"referencedConstants"`
}

// GraphBuildRequest represents the payload for POST /v1/graph/build.
type GraphBuildRequest struct {
	Owner string    `json:"owner"`
	Repo  string    `json:"repo"`
	Sha   string    `json:"sha"`
	Nodes []GitNode `json:"nodes,omitempty"`
}

// GraphBuildResponse represents the response for POST /v1/graph/build.
// MemoryGate 准入控制闸门契约（由 jobs.MemoryGate 提供真实实现）。
type MemoryGate interface {
	Acquire(ctx context.Context, weight int) error
	Release(weight int)
	CalculateJobWeight(nodeCount int, isCodeRepo bool) int
}

// ArchiveEnsurer 按需拉取并解压指定 Git SHA 归档的回调契约。
type ArchiveEnsurer func(ctx context.Context, owner, repo, sha string) (string, error)

// CuratedFileLoader 提供教学聚类精选文件路径（供巨仓有界语义建图优先纳入核心模块）。
type CuratedFileLoader interface {
	LoadCuratedPaths(ctx context.Context, owner, repo string) ([]string, error)
}

// Handler manages HTTP endpoints for the RSG package.
type Handler struct {
	cfg           Config
	getDefs       func() *LanguageDefinitions
	getPatterns   func() Patterns
	gate          MemoryGate
	graphRepo     GraphArtifactRepo
	ensureArchive ArchiveEnsurer
	buildSF       singleflight.Group
}

// NewHandler constructs an RSG Handler.
func NewHandler(cfg Config, getDefs func() *LanguageDefinitions, getPatterns func() Patterns) *Handler {
	return &Handler{
		cfg:         cfg,
		getDefs:     getDefs,
		getPatterns: getPatterns,
	}
}

// SetGate 注入两阶段加权内存准入闸门。
func (h *Handler) SetGate(g MemoryGate) {
	h.gate = g
}

// SetGraphRepo 注入语义图谱数据库持久化仓储。
func (h *Handler) SetGraphRepo(repo GraphArtifactRepo) {
	h.graphRepo = repo
}

// SetArchiveEnsurer 注入归档按需拉取器，使本地磁盘缺失或被驱逐时可自愈重建图谱。
func (h *Handler) SetArchiveEnsurer(fn ArchiveEnsurer) {
	h.ensureArchive = fn
}

func (h *Handler) getLanguageDefs() *LanguageDefinitions {
	if h != nil && h.getDefs != nil {
		if d := h.getDefs(); d != nil {
			return d
		}
	}
	return DefaultLanguageDefinitions()
}

func (h *Handler) getIngestPatterns() Patterns {
	if h != nil && h.getPatterns != nil {
		if p := h.getPatterns(); p != nil {
			return p
		}
	}
	return DefaultIngestPatterns()
}

// HandleSymbolsExtract handles POST /v1/symbols/extract.
func (h *Handler) HandleSymbolsExtract(w http.ResponseWriter, r *http.Request) {
	var req SymbolsExtractRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	if req.Content == "" || req.FilePath == "" {
		httpx.WriteJSON(w, http.StatusOK, SymbolsExtractResponse{
			Ok:                  true,
			Symbols:             []SymbolEntry{},
			Imports:             []ImportRecord{},
			CallSites:           []CallSite{},
			ReferencedConstants: []string{},
		})
		return
	}

	defs := h.getLanguageDefs()
	if defs == nil {
		httpx.Error(w, http.StatusInternalServerError, "language definitions not initialized")
		return
	}

	ast := defs.ExtractFileAst(req.Content, req.FilePath)
	resp := SymbolsExtractResponse{
		Ok:                  true,
		Symbols:             ast.Symbols,
		Imports:             ast.Imports,
		CallSites:           ast.CallSites,
		ReferencedConstants: ast.ReferencedConstants,
	}
	if resp.Symbols == nil {
		resp.Symbols = []SymbolEntry{}
	}
	if resp.Imports == nil {
		resp.Imports = []ImportRecord{}
	}
	if resp.CallSites == nil {
		resp.CallSites = []CallSite{}
	}
	if resp.ReferencedConstants == nil {
		resp.ReferencedConstants = []string{}
	}

	httpx.WriteJSON(w, http.StatusOK, resp)
}

// HandleBuild handles POST /v1/graph/build.
// BuildGraphOnDemand 按需补图注入缝（/v1/cognitive/project 与 fact-grounding
// 缓存缺失时惰性建图）：缓存命中直接复用，缺失则走归档建图并落盘。
// 巨仓护栏见 buildGraphArtifact（有效文件超阈值拒绝——对齐证据阶梯
// 「巨型禁 RSG 格」的资格裁定，tree-sitter 对巨仓算力不可行）。
func (h *Handler) BuildGraphOnDemand(owner, repo, sha string) (*SemanticGraphArtifact, error) {
	return h.buildGraphArtifact(context.Background(), GraphBuildRequest{Owner: owner, Repo: repo, Sha: sha})
}


// graphBuildMaxValidFiles 建图有效文件护栏阈值（对齐 ingest ScaleAccumulator
// IsGiantNow 的主判据 totalValidFiles > 1000）。
const graphBuildMaxValidFiles = 1000

// giantRepoScopedMaxFiles 巨仓（>1000 有效文件）按需符号索引的物理有界预算：
// 教学精选文件 + 顶层目录按深度轮转抽样核心源码，严格守在 MemoryGate / 1000 阈值内。
const giantRepoScopedMaxFiles = 600

// errGiantRepoBuild 巨仓拒绝建图（调用方回落 404 语义，客户端按契约走 TS 投影兜底）。
var errGiantRepoBuild = fmt.Errorf("giant repo not eligible for semantic graph build (valid files > %d)", graphBuildMaxValidFiles)

func walkArchiveNodes(archiveDir string) []GitNode {
	var nodes []GitNode
	_ = filepath.Walk(archiveDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(archiveDir, path)
		if err != nil {
			return nil
		}
		nodes = append(nodes, GitNode{
			Path: filepath.ToSlash(rel),
			Type: "blob",
			Size: info.Size(),
		})
		return nil
	})
	return nodes
}

// SelectBoundedNodesForGiantRepo 为超大规模仓库筛选有界核心文件集（<= maxFiles）：
// 1. 优先纳入教学聚类精选源码（codeClusters）与路径别名配置（tsconfig/composer）；
// 2. 其余按顶层子系统轮转 + 路径浅层优先（入口与契约文件优先于深层叶子）填满预算。
func SelectBoundedNodesForGiantRepo(
	nodes []GitNode,
	curatedPaths []string,
	defs *LanguageDefinitions,
	patterns Patterns,
	maxFiles int,
) []GitNode {
	if maxFiles <= 0 {
		maxFiles = giantRepoScopedMaxFiles
	}
	if maxFiles > graphBuildMaxValidFiles {
		maxFiles = graphBuildMaxValidFiles
	}
	if defs == nil {
		defs = DefaultLanguageDefinitions()
	}
	maxBytes := defs.Config.MaxParseFileBytes
	if maxBytes <= 0 {
		maxBytes = 1024 * 1024
	}

	curatedSet := make(map[string]bool, len(curatedPaths))
	for _, p := range curatedPaths {
		norm := strings.ToLower(strings.TrimPrefix(filepath.ToSlash(strings.TrimSpace(p)), "./"))
		if norm != "" {
			curatedSet[norm] = true
		}
	}

	var curatedNodes, configNodes, testNodes []GitNode
	nonTestByTop := make(map[string][]GitNode)

	for _, n := range nodes {
		if n.Type != "blob" {
			continue
		}
		if patterns != nil && (patterns.IsNonContentDir(n.Path) || patterns.IsNonContentFile(n.Path)) {
			continue
		}
		cleanPath := strings.TrimPrefix(filepath.ToSlash(n.Path), "./")
		if strings.HasSuffix(cleanPath, "composer.json") || (strings.HasSuffix(cleanPath, ".json") && isTsConfigPath(cleanPath)) {
			if n.Size <= int64(maxBytes) {
				configNodes = append(configNodes, n)
			}
			continue
		}
		if defs.DetectLanguage(cleanPath) == nil || n.Size > int64(maxBytes) {
			continue
		}
		if curatedSet[strings.ToLower(cleanPath)] {
			curatedNodes = append(curatedNodes, n)
			continue
		}
		if defs.IsTestFile(cleanPath) {
			testNodes = append(testNodes, n)
			continue
		}
		top := ""
		if idx := strings.IndexByte(cleanPath, '/'); idx >= 0 {
			top = cleanPath[:idx]
		}
		nonTestByTop[top] = append(nonTestByTop[top], n)
	}

	sortByDepthThenPath := func(s []GitNode) {
		sort.Slice(s, func(i, j int) bool {
			di := strings.Count(s[i].Path, "/")
			dj := strings.Count(s[j].Path, "/")
			if di != dj {
				return di < dj
			}
			return s[i].Path < s[j].Path
		})
	}
	sortByDepthThenPath(curatedNodes)
	sortByDepthThenPath(configNodes)
	if len(configNodes) > 20 {
		configNodes = configNodes[:20]
	}

	topDirs := make([]string, 0, len(nonTestByTop))
	for top, bucket := range nonTestByTop {
		sortByDepthThenPath(bucket)
		nonTestByTop[top] = bucket
		topDirs = append(topDirs, top)
	}
	sort.Strings(topDirs)

	selected := make([]GitNode, 0, maxFiles)
	appendWithinBudget := func(n GitNode) bool {
		if len(selected) >= maxFiles {
			return false
		}
		selected = append(selected, n)
		return true
	}

	for _, n := range configNodes {
		if !appendWithinBudget(n) {
			return selected
		}
	}
	for _, n := range curatedNodes {
		if !appendWithinBudget(n) {
			return selected
		}
	}

	for idx := 0; len(selected) < maxFiles; idx++ {
		progressed := false
		for _, top := range topDirs {
			bucket := nonTestByTop[top]
			if idx < len(bucket) {
				progressed = true
				if !appendWithinBudget(bucket[idx]) {
					return selected
				}
			}
		}
		if !progressed {
			break
		}
	}

	if len(selected) == 0 && len(testNodes) > 0 {
		sortByDepthThenPath(testNodes)
		for _, n := range testNodes {
			if !appendWithinBudget(n) {
				break
			}
		}
	}
	return selected
}

// countValidBlobs 有效内容文件计数（非内容目录/文件剔除；builder 侧还有语言与
// 体积过滤，此计数为保守超集——只会更早拒绝，不会漏拒）。
func countValidBlobs(nodes []GitNode, patterns Patterns) int {
	count := 0
	for _, n := range nodes {
		if n.Type != "blob" {
			continue
		}
		if patterns != nil && (patterns.IsNonContentDir(n.Path) || patterns.IsNonContentFile(n.Path)) {
			continue
		}
		count++
	}
	return count
}

func (h *Handler) buildGraphArtifact(ctx context.Context, req GraphBuildRequest) (*SemanticGraphArtifact, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	archiveRoot := "storage/repos"
	if h != nil && h.cfg.ArchiveRoot != "" {
		archiveRoot = h.cfg.ArchiveRoot
	} else if envDir := strings.TrimSpace(os.Getenv("TARBALL_CACHE_DIR")); envDir != "" {
		archiveRoot = envDir
	}
	graphDir := "storage/graphs"
	if h != nil && h.cfg.SemanticGraphDir != "" {
		graphDir = h.cfg.SemanticGraphDir
	}

	// 1. Check if already persisted (fast-path: zero MemoryGate contention)
	if existing, err := LoadSemanticGraphArtifact(graphDir, req.Owner, req.Repo, req.Sha); err == nil && existing != nil {
		return existing, nil
	}
	if h != nil && h.graphRepo != nil {
		if persisted, err := h.graphRepo.LoadArtifact(ctx, req.Owner, req.Repo, req.Sha); err == nil && persisted != nil {
			_, _ = SaveSemanticGraphArtifact(graphDir, req.Owner, req.Repo, req.Sha, persisted)
			return persisted, nil
		}
	}

	archiveDir := archive.ArchiveDirFor(archiveRoot, req.Owner, req.Repo, req.Sha)
	nodes := req.Nodes
	if len(nodes) == 0 {
		nodes = walkArchiveNodes(archiveDir)
	}

	defs := h.getLanguageDefs()
	patterns := h.getIngestPatterns()

	// 2. 巨仓护栏：有效文件超阈值即拒绝建图（在申请 Gate 之前拦截，避免无谓排队）
	if countValidBlobs(nodes, patterns) > graphBuildMaxValidFiles {
		return nil, errGiantRepoBuild
	}

	// 3. MemoryGate 闸门准入（防止多个建图请求并发打爆 Sidecar 物理内存）
	if h != nil && h.gate != nil {
		weight := h.gate.CalculateJobWeight(len(nodes), true)
		if err := h.gate.Acquire(ctx, weight); err != nil {
			return nil, err
		}
		defer h.gate.Release(weight)
	}

	artifact, err := BuildRepoSemanticGraph(ctx, archiveRoot, graphDir, req.Owner, req.Repo, req.Sha, defs, patterns, nodes)
	if err == nil && artifact != nil && h != nil && h.graphRepo != nil {
		if serr := h.graphRepo.SaveArtifact(ctx, req.Owner, req.Repo, req.Sha, artifact); serr != nil {
			log.Printf("[rsg] persist semantic graph to DB failed (%s/%s@%s): %v", req.Owner, req.Repo, req.Sha, serr)
		}
	}
	return artifact, err
}

func hasArchiveFiles(dir string) bool {
	entries, err := os.ReadDir(dir)
	return err == nil && len(entries) > 0
}

// LoadOrBuildSemanticGraph 统一读取并懒自愈建图：
// 本地磁盘缓存 → PostgreSQL RepoSemanticGraph → 单飞按需拉取归档并运行 Tree-sitter 构建。
func (h *Handler) LoadOrBuildSemanticGraph(ctx context.Context, owner, repo, sha string) (*SemanticGraphArtifact, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	graphDir := "storage/graphs"
	if h != nil && h.cfg.SemanticGraphDir != "" {
		graphDir = h.cfg.SemanticGraphDir
	}
	archiveRoot := "storage/repos"
	if h != nil && h.cfg.ArchiveRoot != "" {
		archiveRoot = h.cfg.ArchiveRoot
	} else if envDir := strings.TrimSpace(os.Getenv("TARBALL_CACHE_DIR")); envDir != "" {
		archiveRoot = envDir
	}

	// 1. 本地磁盘 Fast Path
	if loaded, err := LoadSemanticGraphArtifact(graphDir, owner, repo, sha); err == nil && loaded != nil {
		return loaded, nil
	}

	// 2. PostgreSQL 持久化层读取并回暖本地磁盘
	if h != nil && h.graphRepo != nil {
		if persisted, err := h.graphRepo.LoadArtifact(ctx, owner, repo, sha); err == nil && persisted != nil {
			_, _ = SaveSemanticGraphArtifact(graphDir, owner, repo, sha, persisted)
			return persisted, nil
		}
	}

	if h == nil || owner == "" || repo == "" || sha == "" {
		return nil, os.ErrNotExist
	}

	sfKey := strings.ToLower(owner) + "/" + strings.ToLower(repo) + "@" + strings.ToLower(sha)
	res, err, _ := h.buildSF.Do(sfKey, func() (any, error) {
		if loaded, lerr := LoadSemanticGraphArtifact(graphDir, owner, repo, sha); lerr == nil && loaded != nil {
			return loaded, nil
		}
		if h.graphRepo != nil {
			if persisted, perr := h.graphRepo.LoadArtifact(ctx, owner, repo, sha); perr == nil && persisted != nil {
				_, _ = SaveSemanticGraphArtifact(graphDir, owner, repo, sha, persisted)
				return persisted, nil
			}
		}

		buildCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 90*time.Second)
		defer cancel()

		archiveDir := archive.ArchiveDirFor(archiveRoot, owner, repo, sha)
		if !hasArchiveFiles(archiveDir) {
			if h.ensureArchive == nil || strings.EqualFold(owner, "web-docs") {
				return nil, os.ErrNotExist
			}
			if _, eerr := h.ensureArchive(buildCtx, owner, repo, sha); eerr != nil {
				return nil, eerr
			}
			if !hasArchiveFiles(archiveDir) {
				return nil, os.ErrNotExist
			}
		}

		art, berr := h.buildGraphArtifact(buildCtx, GraphBuildRequest{Owner: owner, Repo: repo, Sha: sha})
		if errors.Is(berr, errGiantRepoBuild) {
			var curated []string
			if loader, ok := h.graphRepo.(CuratedFileLoader); ok {
				if paths, lerr := loader.LoadCuratedPaths(buildCtx, owner, repo); lerr == nil {
					curated = paths
				}
			}
			scopedNodes := SelectBoundedNodesForGiantRepo(
				walkArchiveNodes(archiveDir),
				curated,
				h.getLanguageDefs(),
				h.getIngestPatterns(),
				giantRepoScopedMaxFiles,
			)
			if len(scopedNodes) == 0 {
				return nil, berr
			}
			log.Printf("[rsg] giant repo %s/%s@%s scoped semantic graph build (curated=%d, sampled=%d)", owner, repo, sha, len(curated), len(scopedNodes))
			return h.buildGraphArtifact(buildCtx, GraphBuildRequest{
				Owner: owner,
				Repo:  repo,
				Sha:   sha,
				Nodes: scopedNodes,
			})
		}
		return art, berr
	})
	if err != nil {
		return nil, err
	}
	art, _ := res.(*SemanticGraphArtifact)
	return art, nil
}

// HandleTopologySlice handles POST /v1/graph/slice-context.
func (h *Handler) HandleTopologySlice(w http.ResponseWriter, r *http.Request) {
	var req TopologySliceRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	if req.Owner == "" || req.Repo == "" || req.Path == "" {
		httpx.Error(w, http.StatusBadRequest, "missing required fields (owner, repo, path)")
		return
	}

	if err := httpx.AssertSafeSegment(req.Owner); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid owner parameter")
		return
	}
	if err := httpx.AssertSafeSegment(req.Repo); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid repo parameter")
		return
	}
	if req.Sha != "" {
		if err := httpx.AssertSafeSegment(req.Sha); err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid sha parameter")
			return
		}
	}

	graphDir := "storage/graphs"
	if h != nil && h.cfg.SemanticGraphDir != "" {
		graphDir = h.cfg.SemanticGraphDir
	}

	var (
		artifact *SemanticGraphArtifact
		err      error
	)

	// If sha is specified, load from disk/DB or lazily build from archive
	if req.Sha != "" {
		artifact, err = h.LoadOrBuildSemanticGraph(r.Context(), req.Owner, req.Repo, req.Sha)
		if err != nil {
			log.Printf("[worker-sidecar] load graph for slice-context (%s/%s@%s): %v", req.Owner, req.Repo, req.Sha, err)
		}
	} else {
		// If sha is not provided, pick the most recently modified graph artifact.
		// os.ReadDir 是字典序不是时间序——首份可加载文件可能是任意旧 sha，
		// 与 "latest existing graph" 的注释意图相悖。
		repoGraphDir := filepath.Join(graphDir, filepath.Clean(req.Owner), filepath.Clean(req.Repo))
		if entries, err := os.ReadDir(repoGraphDir); err == nil && len(entries) > 0 {
			type cand struct {
				name  string
				mtime time.Time
			}
			var cands []cand
			for _, e := range entries {
				if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
					continue
				}
				if info, ierr := e.Info(); ierr == nil {
					cands = append(cands, cand{e.Name(), info.ModTime()})
				}
			}
			sort.Slice(cands, func(i, j int) bool { return cands[i].mtime.After(cands[j].mtime) })
			for _, c := range cands {
				shaFromFilename := strings.TrimSuffix(c.name, ".json")
				if a, err := LoadSemanticGraphArtifact(graphDir, req.Owner, req.Repo, shaFromFilename); err == nil && a != nil {
					artifact = a
					break
				}
			}
		}
	}

	// Perform fast extraction (if artifact is nil, ExtractTopologySlice returns graceful empty response)
	sliceResp := ExtractTopologySlice(artifact, req)
	httpx.WriteJSON(w, http.StatusOK, sliceResp)
}

// Routes constructs an http.Handler with internal token authentication for testing and standalone mounting.
