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

type SymbolsExtractRequest struct {
	FilePath string `json:"filePath"`
	Content  string `json:"content"`
}

type SymbolsExtractImport struct {
	Module   string   `json:"module"`
	Bindings []string `json:"bindings"`
}

type SymbolsExtractCallSite struct {
	Name string `json:"name"`
	Line int    `json:"line"`
}

type SymbolsExtractResponse struct {
	Ok                  bool                     `json:"ok"`
	Symbols             []SymbolEntry            `json:"symbols"`
	Imports             []SymbolsExtractImport   `json:"imports"`
	CallSites           []SymbolsExtractCallSite `json:"callSites"`
	ReferencedConstants []string                 `json:"referencedConstants"`
}

type GraphBuildRequest struct {
	Owner string    `json:"owner"`
	Repo  string    `json:"repo"`
	Sha   string    `json:"sha"`
	Nodes []GitNode `json:"nodes,omitempty"`
}

type MemoryGate interface {
	Acquire(ctx context.Context, weight int) error
	Release(weight int)
	CalculateJobWeight(nodeCount int, isCodeRepo bool) int
}

type ArchiveEnsurer func(ctx context.Context, owner, repo, sha string) (string, error)

type CuratedFileLoader interface {
	LoadCuratedPaths(ctx context.Context, owner, repo string) ([]string, error)
}

type Handler struct {
	cfg           Config
	getDefs       func() *LanguageDefinitions
	getPatterns   func() Patterns
	gate          MemoryGate
	graphRepo     GraphArtifactRepo
	ensureArchive ArchiveEnsurer
	buildSF       singleflight.Group
}

func NewHandler(cfg Config, getDefs func() *LanguageDefinitions, getPatterns func() Patterns) *Handler {
	return &Handler{
		cfg:         cfg,
		getDefs:     getDefs,
		getPatterns: getPatterns,
	}
}

func (h *Handler) SetGate(g MemoryGate) {
	h.gate = g
}

func (h *Handler) SetGraphRepo(repo GraphArtifactRepo) {
	h.graphRepo = repo
}

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

func (h *Handler) HandleSymbolsExtract(w http.ResponseWriter, r *http.Request) {
	var req SymbolsExtractRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	if req.Content == "" || req.FilePath == "" {
		httpx.WriteJSON(w, http.StatusOK, SymbolsExtractResponse{
			Ok:                  true,
			Symbols:             []SymbolEntry{},
			Imports:             []SymbolsExtractImport{},
			CallSites:           []SymbolsExtractCallSite{},
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
	wireImports := make([]SymbolsExtractImport, 0, len(ast.Imports))
	for _, imp := range ast.Imports {
		bindings := imp.Bindings
		if bindings == nil {
			bindings = []string{}
		}
		wireImports = append(wireImports, SymbolsExtractImport{
			Module:   imp.Module,
			Bindings: bindings,
		})
	}
	wireCallSites := make([]SymbolsExtractCallSite, 0, len(ast.CallSites))
	for _, cs := range ast.CallSites {
		wireCallSites = append(wireCallSites, SymbolsExtractCallSite{
			Name: cs.Name,
			Line: cs.Line,
		})
	}
	resp := SymbolsExtractResponse{
		Ok:                  true,
		Symbols:             ast.Symbols,
		Imports:             wireImports,
		CallSites:           wireCallSites,
		ReferencedConstants: ast.ReferencedConstants,
	}
	if resp.Symbols == nil {
		resp.Symbols = []SymbolEntry{}
	}
	if resp.ReferencedConstants == nil {
		resp.ReferencedConstants = []string{}
	}

	httpx.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) BuildGraphOnDemand(owner, repo, sha string) (*SemanticGraphArtifact, error) {
	return h.buildGraphArtifact(context.Background(), GraphBuildRequest{Owner: owner, Repo: repo, Sha: sha})
}

const graphBuildMaxValidFiles = 1000

const GraphBuildMaxValidFiles = graphBuildMaxValidFiles

const giantRepoScopedMaxFiles = 120

const GiantRepoScopedMaxFiles = giantRepoScopedMaxFiles

const giantRepoSampledMaxFileBytes = 64 * 1024

var errGiantRepoBuild = fmt.Errorf("giant repo not eligible for semantic graph build (valid files > %d)", graphBuildMaxValidFiles)

func WalkArchiveNodes(archiveDir string) []GitNode {
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

func CountValidBlobs(nodes []GitNode, patterns Patterns) int {
	return countValidBlobs(nodes, patterns)
}

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
		if defs.IsTestFile(cleanPath) || n.Size > giantRepoSampledMaxFileBytes {
			if defs.IsTestFile(cleanPath) {
				testNodes = append(testNodes, n)
			}
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

// Conservative superset count before language/size filters so giant repos fail closed earlier.
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
		nodes = WalkArchiveNodes(archiveDir)
	}

	defs := h.getLanguageDefs()
	patterns := h.getIngestPatterns()

	if countValidBlobs(nodes, patterns) > graphBuildMaxValidFiles {
		return nil, errGiantRepoBuild
	}

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

	if loaded, err := LoadSemanticGraphArtifact(graphDir, owner, repo, sha); err == nil && loaded != nil {
		return loaded, nil
	}

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

		buildCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Minute)
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
				WalkArchiveNodes(archiveDir),
				curated,
				h.getLanguageDefs(),
				h.getIngestPatterns(),
				giantRepoScopedMaxFiles,
			)
			if len(scopedNodes) == 0 {
				return nil, berr
			}
			log.Printf("[rsg] giant repo %s/%s@%s scoped semantic graph build (curated=%d, sampled=%d)", owner, repo, sha, len(curated), len(scopedNodes))
			scopedArt, serr := h.buildGraphArtifact(buildCtx, GraphBuildRequest{
				Owner: owner,
				Repo:  repo,
				Sha:   sha,
				Nodes: scopedNodes,
			})
			if serr != nil {
				log.Printf("[rsg] giant repo %s/%s@%s scoped build failed: %v", owner, repo, sha, serr)
			} else if scopedArt != nil {
				log.Printf("[rsg] giant repo %s/%s@%s scoped build succeeded (nodes=%d)", owner, repo, sha, len(scopedArt.Nodes))
			}
			return scopedArt, serr
		}
		return art, berr
	})
	if err != nil {
		return nil, err
	}
	art, _ := res.(*SemanticGraphArtifact)
	return art, nil
}

func EnsureBoundedSemanticGraph(
	ctx context.Context,
	archiveRoot, graphDir, owner, repo, sha string,
	defs *LanguageDefinitions,
	patterns Patterns,
	rawNodes []GitNode,
	curatedPaths []string,
	graphRepo GraphArtifactRepo,
	gate MemoryGate,
) (*SemanticGraphArtifact, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if owner == "" || repo == "" || sha == "" || strings.EqualFold(owner, "web-docs") {
		return nil, os.ErrNotExist
	}
	if defs == nil {
		return nil, fmt.Errorf("language definitions not loaded")
	}
	if graphDir == "" {
		graphDir = "storage/graphs"
	}
	if archiveRoot == "" {
		archiveRoot = "storage/repos"
		if envDir := strings.TrimSpace(os.Getenv("TARBALL_CACHE_DIR")); envDir != "" {
			archiveRoot = envDir
		}
	}

	if existing, err := LoadSemanticGraphArtifact(graphDir, owner, repo, sha); err == nil && existing != nil {
		if graphRepo != nil {
			_ = graphRepo.SaveArtifact(ctx, owner, repo, sha, existing)
		}
		return existing, nil
	}
	if graphRepo != nil {
		if persisted, err := graphRepo.LoadArtifact(ctx, owner, repo, sha); err == nil && persisted != nil {
			_, _ = SaveSemanticGraphArtifact(graphDir, owner, repo, sha, persisted)
			return persisted, nil
		}
	}

	archiveDir := archive.ArchiveDirFor(archiveRoot, owner, repo, sha)
	if !hasArchiveFiles(archiveDir) {
		return nil, os.ErrNotExist
	}

	buildNodes := rawNodes
	if len(buildNodes) == 0 {
		buildNodes = WalkArchiveNodes(archiveDir)
	}

	if countValidBlobs(buildNodes, patterns) >= graphBuildMaxValidFiles {
		allNodes := buildNodes
		if len(rawNodes) > 0 {
			allNodes = WalkArchiveNodes(archiveDir)
		}
		buildNodes = SelectBoundedNodesForGiantRepo(allNodes, curatedPaths, defs, patterns, giantRepoScopedMaxFiles)
	}
	if len(buildNodes) == 0 {
		return nil, fmt.Errorf("no eligible source files for semantic graph in %s/%s@%s", owner, repo, sha)
	}

	if gate != nil {
		weight := gate.CalculateJobWeight(len(buildNodes), true)
		if err := gate.Acquire(ctx, weight); err != nil {
			return nil, err
		}
		defer gate.Release(weight)
	}

	artifact, err := BuildRepoSemanticGraph(ctx, archiveRoot, graphDir, owner, repo, sha, defs, patterns, buildNodes)
	if err == nil && artifact != nil && graphRepo != nil {
		if serr := graphRepo.SaveArtifact(ctx, owner, repo, sha, artifact); serr != nil {
			log.Printf("[rsg] persist bounded semantic graph to DB failed (%s/%s@%s): %v", owner, repo, sha, serr)
		}
	}
	return artifact, err
}

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

	if req.Sha != "" {
		artifact, err = h.LoadOrBuildSemanticGraph(r.Context(), req.Owner, req.Repo, req.Sha)
		if err != nil {
			log.Printf("[worker-sidecar] load graph for slice-context (%s/%s@%s): %v", req.Owner, req.Repo, req.Sha, err)
		}
	} else {

		// Sort by mtime instead of os.ReadDir lexicographical order so the newest graph artifact is selected.
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

	sliceResp := ExtractTopologySlice(artifact, req)
	httpx.WriteJSON(w, http.StatusOK, sliceResp)
}
