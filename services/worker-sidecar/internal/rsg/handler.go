package rsg

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

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

// Handler manages HTTP endpoints for the RSG package.
type Handler struct {
	cfg         Config
	getDefs     func() *LanguageDefinitions
	getPatterns func() Patterns
	gate        MemoryGate
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

// errGiantRepoBuild 巨仓拒绝建图（调用方回落 404 语义，客户端按契约走 TS 投影兜底）。
var errGiantRepoBuild = fmt.Errorf("giant repo not eligible for semantic graph build (valid files > %d)", graphBuildMaxValidFiles)

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
	}
	graphDir := "storage/graphs"
	if h != nil && h.cfg.SemanticGraphDir != "" {
		graphDir = h.cfg.SemanticGraphDir
	}

	// 1. Check if already persisted (fast-path: zero MemoryGate contention)
	if existing, err := LoadSemanticGraphArtifact(graphDir, req.Owner, req.Repo, req.Sha); err == nil && existing != nil {
		return existing, nil
	}

	archiveDir := archive.ArchiveDirFor(archiveRoot, req.Owner, req.Repo, req.Sha)
	nodes := req.Nodes
	if len(nodes) == 0 {
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

	return BuildRepoSemanticGraph(ctx, archiveRoot, graphDir, req.Owner, req.Repo, req.Sha, defs, patterns, nodes)
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

	// If sha is specified, try loading artifact directly from disk
	if req.Sha != "" {
		artifact, err = LoadSemanticGraphArtifact(graphDir, req.Owner, req.Repo, req.Sha)
		if err != nil {
			log.Printf("[worker-sidecar] load graph for slice-context error (%s/%s@%s): %v", req.Owner, req.Repo, req.Sha, err)
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

	// If not found, fallback to OnDemand build if possible and sha is present
	if artifact == nil && req.Sha != "" {
		artifact, _ = h.BuildGraphOnDemand(req.Owner, req.Repo, req.Sha)
	}

	// Perform fast extraction (if artifact is nil, ExtractTopologySlice returns graceful empty response)
	sliceResp := ExtractTopologySlice(artifact, req)
	httpx.WriteJSON(w, http.StatusOK, sliceResp)
}

// Routes constructs an http.Handler with internal token authentication for testing and standalone mounting.
