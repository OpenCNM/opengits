package pipelineb

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/opengits/worker-sidecar/internal/platform/httpx"
	"github.com/opengits/worker-sidecar/internal/rsg"
	"github.com/opengits/worker-sidecar/internal/sse"
)

type PreviousOutlineChapter struct {
	Index     int      `json:"index,omitempty"`
	PartTitle string   `json:"partTitle,omitempty"`
	Title     string   `json:"title"`
	Files     []string `json:"files,omitempty"`
}

type TreeOutlineRequest struct {
	Owner            string                   `json:"owner"`
	Repo             string                   `json:"repo"`
	SHA              string                   `json:"sha,omitempty"`
	RepoDir          string                   `json:"repoDir,omitempty"`
	Token            string                   `json:"token,omitempty"`
	GitHubToken      string                   `json:"githubToken,omitempty"`
	TargetLanguage   string                   `json:"targetLanguage,omitempty"`
	FileCap          int                      `json:"fileCap,omitempty"`
	Prefix           string                   `json:"prefix,omitempty"`
	UserID           string                   `json:"userId,omitempty"`
	ExcludedPaths    []string                 `json:"excludedPaths,omitempty"`
	CustomPrompt     string                   `json:"customPrompt,omitempty"`
	PreviousOutline  []PreviousOutlineChapter `json:"previousOutline,omitempty"`
	Pacing           string                   `json:"pacing,omitempty"`
	TeachingDepth    string                   `json:"teachingDepth,omitempty"`
	LearnerArchetype string                   `json:"learnerArchetype,omitempty"`
	BudgetMs         int64                    `json:"budgetMs,omitempty"`
	Retry            bool                     `json:"retry,omitempty"`
	RollupLevel      int                      `json:"rollupLevel,omitempty"`
}

type Handler struct {
	patternsFn func() cognitive.Patterns
	defsFn     func() *rsg.LanguageDefinitions
	ensureDir  func(ctx context.Context, owner, repo, sha string) (string, error)
	planner    PlannerModel
	model      OutlineModel
	sampler    OutlineSampler
	plannerFor func(userId string) PlannerModel
	modelFor   func(userId string) OutlineModel
	samplerFor func(userId string) OutlineSampler
	CacheDir   string
	statDir    func(owner, repo, sha string) bool
	prep       *PrepTracker

	GitHubToken           string
	GitHubAPIBase         string
	UserAgent             string
	treeFetcher           func(ctx context.Context, apiBase, owner, repo, sha, token, userAgent string) (*client.GitTreeResponse, error)
	blobFetcher           func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, error)
	concurrentBlobFetcher func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, bool, error)
	pingInterval          time.Duration
}

func NewHandler(
	patternsFn func() cognitive.Patterns,
	defsFn func() *rsg.LanguageDefinitions,
	ensureDir func(ctx context.Context, owner, repo, sha string) (string, error),
	planner PlannerModel,
	model OutlineModel,
	sampler ...OutlineSampler,
) *Handler {
	var s OutlineSampler
	if len(sampler) > 0 {
		s = sampler[0]
	}
	return &Handler{
		patternsFn: patternsFn, defsFn: defsFn, ensureDir: ensureDir,
		planner: planner, model: model, sampler: s,
		plannerFor:            func(string) PlannerModel { return planner },
		modelFor:              func(string) OutlineModel { return model },
		samplerFor:            func(string) OutlineSampler { return s },
		prep:                  NewPrepTracker(),
		treeFetcher:           client.GithubFetchTreeRecursive,
		blobFetcher:           client.GithubBatchGetBlobsGraphQL,
		concurrentBlobFetcher: client.GithubConcurrentBatchGetBlobsGraphQL,
	}
}

func (h *Handler) SetSampler(sampler OutlineSampler) *Handler {
	h.sampler = sampler
	h.samplerFor = func(string) OutlineSampler { return sampler }
	return h
}

func (h *Handler) SetGitHubConfig(token, apiBase, userAgent string) *Handler {
	h.GitHubToken = token
	h.GitHubAPIBase = apiBase
	h.UserAgent = userAgent
	return h
}

// Clear concurrentBlobFetcher when legacy fetchers are injected so test doubles take effect.
func (h *Handler) SetFetchers(
	treeFetcher func(ctx context.Context, apiBase, owner, repo, sha, token, userAgent string) (*client.GitTreeResponse, error),
	blobFetcher func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, error),
) *Handler {
	h.treeFetcher = treeFetcher
	h.blobFetcher = blobFetcher
	h.concurrentBlobFetcher = nil
	return h
}

func (h *Handler) SetConcurrentBlobFetcher(
	f func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, bool, error),
) *Handler {
	h.concurrentBlobFetcher = f
	return h
}

func (h *Handler) SetArchiveStat(statDir func(owner, repo, sha string) bool) *Handler {
	h.statDir = statDir
	return h
}

func (h *Handler) WithUserFactories(
	plannerFor func(userId string) PlannerModel,
	modelFor func(userId string) OutlineModel,
	samplerFor ...func(userId string) OutlineSampler,
) *Handler {
	h.plannerFor = plannerFor
	h.modelFor = modelFor
	if len(samplerFor) > 0 && samplerFor[0] != nil {
		h.samplerFor = samplerFor[0]
	}
	return h
}

func (h *Handler) samplerForReq(userId string, customPrompt string, teachingDepth string, learnerArchetype string) OutlineSampler {
	var base OutlineSampler
	if h.samplerFor != nil {
		base = h.samplerFor(userId)
	} else {
		base = h.sampler
	}
	if base == nil {
		return nil
	}
	if gs, ok := base.(*GatewaySampler); ok {
		clone := *gs
		if customPrompt != "" {
			clone.CustomPrompt = customPrompt
		}
		if teachingDepth != "" {
			clone.TeachingDepth = teachingDepth
		}
		if learnerArchetype != "" {
			clone.LearnerArchetype = learnerArchetype
		}
		return &clone
	}
	return base
}

func formatPreviousOutline(items []PreviousOutlineChapter) string {
	if len(items) == 0 {
		return ""
	}
	var sb strings.Builder
	for i, item := range items {
		title := strings.TrimSpace(item.Title)
		if title == "" {
			continue
		}
		idx := item.Index
		if idx <= 0 {
			idx = i + 1
		}
		part := strings.TrimSpace(item.PartTitle)
		if part != "" {
			fmt.Fprintf(&sb, "%d. [%s] %s", idx, part, title)
		} else {
			fmt.Fprintf(&sb, "%d. %s", idx, title)
		}
		if len(item.Files) > 0 {
			limit := min(len(item.Files), 5)
			fmt.Fprintf(&sb, " (files: %s)", strings.Join(item.Files[:limit], ", "))
		}
		sb.WriteByte('\n')
		if sb.Len() >= 2500 {
			break
		}
	}
	return strings.TrimSpace(sb.String())
}

func attachPreviousOutline(planner PlannerModel, model OutlineModel, previousOutline string) {
	if previousOutline == "" {
		return
	}
	if gp, ok := planner.(*GatewayPlanner); ok && gp != nil {
		gp.PreviousOutline = previousOutline
	}
	if gm, ok := model.(*GatewayModel); ok && gm != nil {
		gm.PreviousOutline = previousOutline
	}
}

func (h *Handler) plannerForReq(userId string, customPrompt string, pacing string, teachingDepth string, extra ...string) PlannerModel {
	var base PlannerModel
	if h.plannerFor != nil {
		base = h.plannerFor(userId)
	} else {
		base = h.planner
	}
	if base == nil {
		return nil
	}
	if gp, ok := base.(*GatewayPlanner); ok {
		clone := *gp
		if customPrompt != "" {
			clone.CustomPrompt = customPrompt
		}
		if pacing != "" {
			clone.Pacing = pacing
		}
		if teachingDepth != "" {
			clone.TeachingDepth = teachingDepth
		}
		if len(extra) > 0 && extra[0] != "" {
			clone.LearnerArchetype = extra[0]
		}
		return &clone
	}
	return base
}

func (h *Handler) modelForReq(userId string, customPrompt string, teachingDepth string, extra ...string) OutlineModel {
	var base OutlineModel
	if h.modelFor != nil {
		base = h.modelFor(userId)
	} else {
		base = h.model
	}
	if base == nil {
		return nil
	}
	if gm, ok := base.(*GatewayModel); ok {
		clone := *gm
		if customPrompt != "" {
			clone.CustomPrompt = customPrompt
		}
		if teachingDepth != "" {
			clone.TeachingDepth = teachingDepth
		}
		if len(extra) > 0 && extra[0] != "" {
			clone.LearnerArchetype = extra[0]
		}
		if len(extra) > 1 && extra[1] != "" {
			clone.Pacing = extra[1]
		}
		return &clone
	}
	return base
}

const (
	TreeFirstFullAstCapEnvVar    = "TREE_FIRST_FULL_AST_CAP"
	TreeFirstFullAstBytesEnvVar  = "TREE_FIRST_FULL_AST_BYTES"
	defaultTreeFirstFullAstCap   = 600
	defaultTreeFirstFullAstBytes = 15 << 20
	// Skip AST parsing on >256KB files where parse latency outweighs structural signal.
	fullAstPrefilterMaxBytes      = 256 << 10
	defaultSamplingSkeletonBudget = 160
)

func treeFirstFullAstFileCap() int {
	if v := os.Getenv(TreeFirstFullAstCapEnvVar); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return defaultTreeFirstFullAstCap
}

func treeFirstFullAstBytesCap() int64 {
	if v := os.Getenv(TreeFirstFullAstBytesEnvVar); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			return n
		}
	}
	return defaultTreeFirstFullAstBytes
}

type SamplingStats struct {
	Strategy         string
	SampledFileCount int
	AstCoverageRatio float64
}

func samplingStatsFields(stats map[string]any, s *SamplingStats) map[string]any {
	if s == nil {
		return stats
	}
	stats["samplingStrategy"] = s.Strategy
	stats["sampledFileCount"] = s.SampledFileCount
	stats["astCoverageRatio"] = s.AstCoverageRatio
	return stats
}

func (h *Handler) resolveOutlineToken(req TreeOutlineRequest) string {
	if t := req.GitHubToken; t != "" {
		return t
	}
	if t := req.Token; t != "" {
		return t
	}
	return h.GitHubToken
}

func (h *Handler) tryTreeFirst(ctx context.Context, req TreeOutlineRequest, patterns cognitive.Patterns, progressFn ...ProgressCallback) (*RepoMap, *SamplingStats, error) {
	if h.treeFetcher == nil {
		return nil, nil, errors.New("tree fetcher not configured")
	}

	var cb ProgressCallback
	if len(progressFn) > 0 && progressFn[0] != nil {
		cb = progressFn[0]
	}

	effectiveToken := h.resolveOutlineToken(req)
	if effectiveToken == "" {
		return nil, nil, errors.New("no github token available for tree-first ingest")
	}

	apiBase := h.GitHubAPIBase
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}
	ua := h.UserAgent
	if ua == "" {
		ua = "OpenGits-Engine/1.0"
	}

	fetchCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	treeResp, err := h.treeFetcher(fetchCtx, apiBase, req.Owner, req.Repo, req.SHA, effectiveToken, ua)
	if err != nil {
		return nil, nil, fmt.Errorf("tree fetch: %w", err)
	}
	if treeResp == nil {
		return nil, nil, errors.New("nil tree response")
	}
	if treeResp.Truncated {
		return nil, nil, fmt.Errorf("tree truncated (>100k entries)")
	}
	if len(treeResp.Tree) == 0 {
		return nil, nil, errors.New("empty git tree")
	}

	if cb != nil {
		cb(ProgressStep{
			Stage:  "tree",
			Title:  "代码树纯内存提取",
			Detail: fmt.Sprintf("已感知 %d 个文件", len(treeResp.Tree)),
		})
	}

	contentEntries := FilterContentEntries(treeResp.Tree, patterns, req.Prefix)
	if len(contentEntries) == 0 {
		return nil, nil, fmt.Errorf("empty repository: no content files found")
	}

	var defs *rsg.LanguageDefinitions
	if h.defsFn != nil {
		defs = h.defsFn()
	}

	var totalBytes int64
	for _, e := range contentEntries {
		totalBytes += e.Size
	}
	if h.concurrentBlobFetcher != nil &&
		len(contentEntries) <= treeFirstFullAstFileCap() &&
		totalBytes <= treeFirstFullAstBytesCap() {
		m, stats, err := h.tryFullAstMap(fetchCtx, apiBase, req, ua, effectiveToken, treeResp.Tree, contentEntries, defs, patterns, cb)
		if err != nil {
			return nil, nil, err
		}
		return m, stats, nil
	}
	return h.tryStratifiedMap(fetchCtx, apiBase, req, ua, effectiveToken, treeResp.Tree, contentEntries, defs, patterns, cb)
}

func (h *Handler) tryFullAstMap(
	ctx context.Context, apiBase string, req TreeOutlineRequest, ua, token string,
	treeEntries, contentEntries []client.GitTreeEntry,
	defs *rsg.LanguageDefinitions, patterns cognitive.Patterns, cb ProgressCallback,
) (*RepoMap, *SamplingStats, error) {
	paths := make([]string, 0, len(contentEntries))
	for _, e := range contentEntries {
		if e.Size > fullAstPrefilterMaxBytes {
			continue
		}
		paths = append(paths, strings.TrimPrefix(filepath.ToSlash(e.Path), "/"))
	}

	contents, truncated, err := h.concurrentBlobFetcher(ctx, apiBase, req.Owner, req.Repo, req.SHA, paths, token, ua)
	if err != nil {
		return nil, nil, fmt.Errorf("full-ast concurrent blob fetch: %w", err)
	}
	if contents == nil {
		contents = map[string]string{}
	}

	if cb != nil {
		cb(ProgressStep{
			Stage:  "sample",
			Title:  "全量 AST 建图",
			Detail: fmt.Sprintf("阈值内仓库：已全量提取 %d/%d 个文件", len(contents), len(contentEntries)),
		})
	}

	fileCap := req.FileCap
	if fileCap < len(contentEntries) {
		fileCap = len(contentEntries)
	}
	m, err := BuildRepoMapFromTree(treeEntries, contents, req.Repo, req.Prefix, defs, patterns, fileCap)
	if err != nil {
		return nil, nil, err
	}

	strategy := SamplingStrategyFullAst
	if truncated {
		strategy = SamplingStrategyPartialAst
	}
	ratio := 1.0
	if len(contentEntries) > 0 {
		ratio = float64(len(contents)) / float64(len(contentEntries))
	}
	return m, &SamplingStats{
		Strategy:         strategy,
		SampledFileCount: len(contents),
		AstCoverageRatio: ratio,
	}, nil
}

func (h *Handler) tryStratifiedMap(
	ctx context.Context, apiBase string, req TreeOutlineRequest, ua, token string,
	treeEntries, contentEntries []client.GitTreeEntry,
	defs *rsg.LanguageDefinitions, patterns cognitive.Patterns, cb ProgressCallback,
) (*RepoMap, *SamplingStats, error) {
	subsystems := DiscoverSubsystems(SubsystemSourcesFromTreeEntries(contentEntries), patterns)

	coreFiles := make(map[string]string)
	readmePath := FindReadmePathFromEntries(treeEntries, req.Prefix)
	var readmeContent string

	sampler := h.samplerForReq(req.UserID, req.CustomPrompt, req.TeachingDepth, req.LearnerArchetype)
	if sampler != nil && readmePath != "" && h.blobFetcher != nil {
		readmeBlobs, rErr := h.blobFetcher(ctx, apiBase, req.Owner, req.Repo, req.SHA, []string{readmePath}, token, ua)
		if rErr != nil {
			log.Printf("[pipelineb] stratified readme fetch skipped (optional): %v", rErr)
		} else if readmeBlobs != nil {
			if content, ok := readmeBlobs[readmePath]; ok {
				readmeContent = content
				coreFiles[readmePath] = content
			}
		}
	}

	previewFiles := make([]FileMap, 0, len(contentEntries))
	for _, e := range contentEntries {
		rel := strings.TrimPrefix(filepath.ToSlash(e.Path), "/")
		loc := int(e.Size)/32 + 1
		if c, ok := coreFiles[rel]; ok {
			loc = strings.Count(c, "\n") + 1
		}
		previewFiles = append(previewFiles, FileMap{
			Path:     rel,
			LOC:      loc,
			IsDoc:    patterns != nil && patterns.IsDocFile(rel),
			IsTest:   patterns != nil && patterns.IsTestFile(rel),
			IsConfig: patterns != nil && (patterns.IsConfigFile(rel) || isMainConfigFile(strings.ToLower(filepath.Base(rel)))),
		})
	}
	previewTree := BuildRepoTree(previewFiles, req.Repo)
	skeleton := RenderSamplingSkeleton(previewTree)
	if len(subsystems) > 0 {
		skeleton = RenderStratifiedSamplingSkeleton(previewTree, subsystems, defaultSamplingSkeletonBudget)
	}

	sreq := SampleRequest{
		Skeleton:         skeleton,
		Readme:           readmeContent,
		Prefix:           req.Prefix,
		TeachingDepth:    req.TeachingDepth,
		LearnerArchetype: req.LearnerArchetype,
		CustomPrompt:     req.CustomPrompt,
	}
	corePaths, sampleMode := SampleOrFallbackCoreFiles(ctx, sampler, treeEntries, sreq, patterns, subsystems)

	if cb != nil {
		cb(ProgressStep{
			Stage:  "sample",
			Title:  "AI 架构探针",
			Detail: fmt.Sprintf("已定向抽样 %d 个核心文件提取 AST", len(corePaths)),
		})
	}

	entrySize := make(map[string]int64, len(contentEntries))
	for _, e := range contentEntries {
		entrySize[strings.TrimPrefix(filepath.ToSlash(e.Path), "/")] = e.Size
	}
	var toFetch []string
	for _, p := range corePaths {
		if _, ok := coreFiles[p]; ok {
			continue
		}
		if sz := entrySize[p]; sz > fullAstPrefilterMaxBytes {
			log.Printf("[pipelineb] stratified skip oversized sample (%d bytes > %d cap): %s", sz, fullAstPrefilterMaxBytes, p)
			continue
		}
		toFetch = append(toFetch, p)
	}

	fetchTruncated := false
	if len(toFetch) > 0 {
		var (
			blobs map[string]string
			bErr  error
		)
		if h.concurrentBlobFetcher != nil {
			blobs, fetchTruncated, bErr = h.concurrentBlobFetcher(ctx, apiBase, req.Owner, req.Repo, req.SHA, toFetch, token, ua)
		} else if h.blobFetcher != nil {
			blobs, bErr = h.blobFetcher(ctx, apiBase, req.Owner, req.Repo, req.SHA, toFetch, token, ua)
		}
		if bErr != nil {
			log.Printf("[pipelineb] stratified blob fetch partial failure: have=%d requested=%d: %v", len(coreFiles), len(toFetch), bErr)
		}
		for k, v := range blobs {
			coreFiles[k] = v
		}
		if len(coreFiles) == 0 {
			if bErr != nil {
				return nil, nil, fmt.Errorf("stratified sampling fetched 0/%d core files: %w", len(toFetch), bErr)
			}
			return nil, nil, fmt.Errorf("stratified sampling fetched 0/%d core files (empty batch result)", len(toFetch))
		}
		if fetchTruncated {
			log.Printf("[pipelineb] stratified blob fetch partial: fetched=%d/%d requested files, continuing fail-open", len(blobs), len(toFetch))
		}
	}

	m, err := BuildRepoMapFromTree(treeEntries, coreFiles, req.Repo, req.Prefix, defs, patterns, req.FileCap)
	if err != nil {
		return nil, nil, fmt.Errorf("build repo map from tree: %w", err)
	}

	ratio := 1.0
	if len(contentEntries) > 0 {
		ratio = float64(len(coreFiles)) / float64(len(contentEntries))
	}
	strategy := sampleMode
	if fetchTruncated {
		strategy = SamplingStrategyStratifiedPartial
	}
	return m, &SamplingStats{
		Strategy:         strategy,
		SampledFileCount: len(coreFiles),
		AstCoverageRatio: ratio,
	}, nil
}

func (h *Handler) HandleTreeOutline(w http.ResponseWriter, r *http.Request) {
	var req TreeOutlineRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if req.Owner == "" || req.Repo == "" {
		httpx.Error(w, http.StatusBadRequest, "owner and repo are required")
		return
	}

	isStream := strings.Contains(r.Header.Get("Accept"), "text/event-stream") || r.URL.Query().Get("stream") == "1"

	var sw *sse.Writer
	var cb ProgressCallback
	if isStream {
		var sseErr error
		sw, sseErr = sse.NewWriter(w)
		if sseErr != nil {
			httpx.Error(w, http.StatusInternalServerError, "sse unsupported: "+sseErr.Error())
			return
		}
		cb = func(step ProgressStep) {
			_ = sw.SendEvent("", "step", step)
		}
		pInterval := 4 * time.Second
		if h.pingInterval > 0 {
			pInterval = h.pingInterval
		}
		ticker := time.NewTicker(pInterval)
		stopPing := make(chan struct{})
		var pingWg sync.WaitGroup
		pingWg.Add(1)
		go func() {
			defer pingWg.Done()
			for {
				select {
				case <-ticker.C:
					if err := sw.SendComment("ping"); err != nil {
						return
					}
				case <-stopPing:
					return
				case <-r.Context().Done():
					return
				}
			}
		}()
		defer func() {
			ticker.Stop()
			close(stopPing)
			pingWg.Wait()
		}()
	}

	sendError := func(status int, msg string) {
		if isStream && sw != nil {
			_ = sw.SendEvent("", "error", map[string]any{
				"message": msg,
				"status":  status,
			})
		} else {
			httpx.Error(w, status, msg)
		}
	}

	sendPipelineError := func(prefix string, err error) {
		var planErr *PlanErrorWithDiagnostics
		var diag *PipelineDiagnostics
		if errors.As(err, &planErr) {
			d := planErr.Diagnostics
			diag = &d
			log.Printf("[pipelineb] diag plan_failed repo=%s/%s sha=%s needRollupRequested=%d needRollupCapped=%v planDegenerateTriggered=%v planDegenerateRecovered=%v",
				req.Owner, req.Repo, req.SHA, d.NeedRollupRequested, d.NeedRollupCapped, d.PlanDegenerateTriggered, d.PlanDegenerateRecovered)
		}
		var gw *client.LlmGatewayError
		if errors.As(err, &gw) {
			status := gw.Status
			if status == 0 {
				status = client.MapLlmErrorCodeToStatus(gw.Code)
			}
			if isStream && sw != nil {
				payload := map[string]any{
					"message":         prefix + gw.Message,
					"upstreamMessage": gw.Message,
					"status":          status,
					"code":            gw.Code,
				}
				if gw.Provider != "" {
					payload["provider"] = gw.Provider
				}
				if gw.Model != "" {
					payload["model"] = gw.Model
				}
				if gw.UpstreamStatus > 0 {
					payload["upstreamStatus"] = gw.UpstreamStatus
				}
				if gw.UpstreamCode != "" {
					payload["upstreamCode"] = gw.UpstreamCode
				}
				if diag != nil {
					payload["diagnostics"] = *diag
				}
				_ = sw.SendEvent("", "error", payload)
			} else {
				httpx.Error(w, status, prefix+err.Error())
			}
			return
		}
		// Redact non-gateway internal errors externally so host filesystem paths never leak to UI.
		log.Printf("[pipelineb] pipeline_error repo=%s/%s sha=%s err=%v", req.Owner, req.Repo, req.SHA, err)
		sendError(http.StatusInternalServerError, prefix+"internal outline pipeline error")
	}

	sendSuccess := func(status int, payload map[string]any) {
		if isStream && sw != nil {
			_ = sw.SendEvent("", "complete", payload)
		} else {
			httpx.WriteJSON(w, status, payload)
		}
	}

	lang := req.TargetLanguage
	// Reject "none" (doc-transcription sentinel) so generative outlines never instruct the LLM to write in "none".
	if lang == "" || lang == "none" {
		lang = "zh-CN"
	}

	patterns := h.patternsFn()

	var m *RepoMap
	var sampling *SamplingStats
	if h.CacheDir != "" && req.SHA != "" {
		if cache, err := LoadTreeMap(h.CacheDir, req.Owner, req.Repo, req.SHA); err == nil && cache.Tree != nil {
			files := cache.Tree.LeafFiles()
			m = &RepoMap{RepoName: req.Repo, Files: files, Tree: cache.Tree}
			for _, f := range files {
				m.TotalLOC += f.LOC
			}
			m.EstTokens = estimateTokensFor(m)
			if cb != nil {
				cb(ProgressStep{
					Stage:  "tree",
					Title:  "已读取仓库目录",
					Detail: fmt.Sprintf("共 %d 个文件", len(files)),
				})
			}
		}
	}

	if m == nil && req.RepoDir != "" {
		if _, err := os.Stat(req.RepoDir); err != nil {
			sendError(http.StatusBadGateway, "repo dir unavailable: "+err.Error())
			return
		}
		m = h.loadCachedOrBuild(req.RepoDir, req, patterns)
		if cb != nil && m != nil && m.Tree != nil {
			cb(ProgressStep{
				Stage:  "tree",
				Title:  "代码树本地提取完成",
				Detail: fmt.Sprintf("已感知 %d 个文件", m.Tree.FileCount),
			})
		}
	}

	if m == nil && req.RepoDir == "" && h.statDir != nil && req.SHA != "" && h.statDir(req.Owner, req.Repo, req.SHA) {
		if h.ensureDir == nil {
			sendError(http.StatusServiceUnavailable, "archive ensure not configured")
			return
		}
		dir, err := h.ensureDir(r.Context(), req.Owner, req.Repo, req.SHA)
		if err != nil {
			sendError(http.StatusBadGateway, "archive ensure failed: "+err.Error())
			return
		}
		if _, err := os.Stat(dir); err != nil {
			sendError(http.StatusBadGateway, "repo dir unavailable: "+err.Error())
			return
		}
		m = h.loadCachedOrBuild(dir, req, patterns)
		if cb != nil && m != nil && m.Tree != nil {
			cb(ProgressStep{
				Stage:  "tree",
				Title:  "代码树归档提取完成",
				Detail: fmt.Sprintf("已感知 %d 个文件", m.Tree.FileCount),
			})
		}
	}

	if m == nil && req.RepoDir == "" && req.SHA != "" {
		key := PrepKey(req.Owner, req.Repo, req.SHA)
		if req.Retry {
			h.prep.Reset(key)
		}
		if failed, perr := h.prep.ConsumeFailed(key); failed {
			sendError(http.StatusBadGateway, "repo preparation failed: "+perr)
			return
		} else if st, _ := h.prep.Get(key); st == PrepStatusRunning {
			sendSuccess(http.StatusAccepted, map[string]any{
				"ok":           true,
				"preparing":    true,
				"status":       PrepStatusRunning,
				"detail":       "大型仓库首次解析：正在后台下载归档并构建代码地图，就绪后自动继续",
				"retryAfterMs": PrepPollIntervalMs,
			})
			return
		}

		treeMap, samplingStats, treeErr := h.tryTreeFirst(r.Context(), req, patterns, cb)
		if treeErr == nil && treeMap != nil && treeMap.Tree != nil {
			m = treeMap
			sampling = samplingStats
			if h.CacheDir != "" && req.Prefix == "" {
				_, _ = SaveTreeMap(h.CacheDir, req.Owner, req.Repo, req.SHA, &TreeMapCache{GitSha: req.SHA, Tree: m.Tree})
			}
		} else {
			if treeErr != nil && strings.Contains(treeErr.Error(), "truncated") {
				log.Printf("[pipelineb] diag tree_first_truncated repo=%s/%s sha=%s fallback=202_coldstart_archive",
					req.Owner, req.Repo, req.SHA)
			}
			if h.statDir != nil {
				h.launchPrep(req)
				sendSuccess(http.StatusAccepted, map[string]any{
					"ok":           true,
					"preparing":    true,
					"status":       PrepStatusRunning,
					"detail":       "大型仓库首次解析：正在后台下载归档并构建代码地图，就绪后自动继续",
					"retryAfterMs": PrepPollIntervalMs,
				})
				return
			}
			if h.ensureDir == nil {
				sendError(http.StatusServiceUnavailable, "archive ensure not configured")
				return
			}
			dir, err := h.ensureDir(r.Context(), req.Owner, req.Repo, req.SHA)
			if err != nil {
				sendError(http.StatusBadGateway, "archive ensure failed: "+err.Error())
				return
			}
			m = h.loadCachedOrBuild(dir, req, patterns)
		}
	} else if m == nil && req.RepoDir == "" {
		if h.ensureDir == nil {
			sendError(http.StatusServiceUnavailable, "archive ensure not configured")
			return
		}
		dir, err := h.ensureDir(r.Context(), req.Owner, req.Repo, req.SHA)
		if err != nil {
			sendError(http.StatusBadGateway, "archive ensure failed: "+err.Error())
			return
		}
		m = h.loadCachedOrBuild(dir, req, patterns)
	}

	m = scopeMapToPrefix(m, req.Prefix)

	// Fail closed when map building leaves Tree nil instead of panicking on FileCount dereference.
	if m == nil || m.Tree == nil {
		sendError(http.StatusBadGateway, "repo map unavailable (build failed or empty archive)")
		return
	}

	if len(req.ExcludedPaths) > 0 {
		PruneTree(m.Tree, req.ExcludedPaths)
		m.Files = m.Tree.LeafFiles()
		m.TotalLOC = 0
		for _, f := range m.Files {
			m.TotalLOC += f.LOC
		}
		m.EstTokens = estimateTokensFor(m)
	}

	m = h.enrichMapWithThematicSampling(r.Context(), m, req, patterns, cb)

	handlerBudget := 15 * time.Minute
	if req.BudgetMs > 0 {
		if d := time.Duration(req.BudgetMs) * time.Millisecond; d < handlerBudget {
			handlerBudget = d
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), handlerBudget)
	defer cancel()

	// Route depth using full Tree.FileCount rather than truncated len(Files) so large repos do not force depth 1.
	prevOutline := ""
	if req.CustomPrompt != "" && len(req.PreviousOutline) > 0 {
		prevOutline = formatPreviousOutline(req.PreviousOutline)
	}
	plannerInst := h.plannerForReq(req.UserID, req.CustomPrompt, req.Pacing, req.TeachingDepth, req.LearnerArchetype)
	modelInst := h.modelForReq(req.UserID, req.CustomPrompt, req.TeachingDepth, req.LearnerArchetype, req.Pacing)
	attachPreviousOutline(plannerInst, modelInst, prevOutline)

	effectiveCap := MaxFilesInMap(req.FileCap)
	if m.Tree.FileCount <= effectiveCap {
		if cb != nil {
			cb(ProgressStep{
				Stage:  "plan",
				Title:  "快速大纲生成",
				Detail: fmt.Sprintf("仓库规模适中 (%d 文件)，正在进行单阶段大纲生成", m.Tree.FileCount),
			})
		}
		res, err := Run(ctx, m, modelInst, patterns, lang)
		if err != nil {
			sendPipelineError("outline failed: ", err)
			return
		}
		subsystems := DiscoverSubsystems(SubsystemSourcesFromRepoMap(m), patterns)
		AttachSubtreeCompanionsWithMap(res.Chapters, m.Tree, m, subsystems)
		macroTopo := BuildMacroTopology(m, "", 1, patterns)
		excludedFiles := ComputeExcludedFiles(m, res.Chapters, false)
		sendSuccess(http.StatusOK, map[string]any{
			"ok":            true,
			"depth":         1,
			"repo":          req.Repo,
			"macroTopology": macroTopo,
			"chapters":      res.Chapters,
			"droppedPaths":  res.DroppedPaths,
			"excludedFiles": excludedFiles,
			"stats": samplingStatsFields(map[string]any{
				"files":        len(m.Files),
				"allFiles":     m.Tree.FileCount,
				"durationMs":   res.Duration.Milliseconds(),
				"promptTokens": res.EstPromptTok,
			}, sampling),
		})
		return
	}

	res, err := RunDrill(ctx, m, plannerInst, modelInst, patterns, lang, req.TeachingDepth, req.RollupLevel, cb)
	if err != nil {
		sendPipelineError("tree outline failed: ", err)
		return
	}

	if res.CurriculumMode == "single" {
		macroTopo := BuildMacroTopology(m, "", 1, patterns)
		excludedFiles := ComputeExcludedFiles(m, res.Chapters, res.Thematic)
		sendSuccess(http.StatusOK, map[string]any{
			"ok":            true,
			"depth":         1,
			"repo":          req.Repo,
			"macroTopology": macroTopo,
			"chapters":      res.Chapters,
			"droppedPaths":  res.DroppedPaths,
			"excludedFiles": excludedFiles,
			"stats": samplingStatsFields(map[string]any{
				"files": len(m.Files), "allFiles": m.Tree.FileCount,
				"durationMs":  res.Duration.Milliseconds(),
				"diagnostics": res.Diagnostics,
			}, sampling),
		})
		return
	}

	tree := BuildCourseTree(req.Repo, res, skipRootWrapper(m.Tree))
	tree.AttachTopologies(m, patterns)
	excludedFiles := ComputeExcludedFiles(m, res.Chapters, res.Thematic)
	sendSuccess(http.StatusOK, map[string]any{
		"ok":            true,
		"depth":         2,
		"repo":          req.Repo,
		"courseTree":    tree,
		"macroTopology": tree.MacroTopology,
		"chapters":      res.Chapters,
		"droppedPaths":  res.DroppedPaths,
		"excludedFiles": excludedFiles,
		"stats": samplingStatsFields(map[string]any{
			"files": len(m.Files), "allFiles": m.Tree.FileCount,
			"durationMs":  res.Duration.Milliseconds(),
			"diagnostics": res.Diagnostics,
		}, sampling),
	})
}

func (h *Handler) archiveOnDisk(req TreeOutlineRequest) bool {
	if h.CacheDir != "" && req.SHA != "" {
		if c, err := LoadTreeMap(h.CacheDir, req.Owner, req.Repo, req.SHA); err == nil && c.Tree != nil {
			return true
		}
	}
	if h.statDir == nil {
		return false
	}
	return h.statDir(req.Owner, req.Repo, req.SHA)
}

// Run background preparation on a detached context so client disconnect does not abort cold-start caching.
func (h *Handler) launchPrep(req TreeOutlineRequest) {
	h.prep.Start(PrepKey(req.Owner, req.Repo, req.SHA), func(ctx context.Context) error {
		// Convert nil factories inside detached prep goroutine to errors so panics cannot crash the process.
		if h.ensureDir == nil || h.defsFn == nil || h.patternsFn == nil {
			return errors.New("prep misconfigured: nil handler factories")
		}
		dir, err := h.ensureDir(ctx, req.Owner, req.Repo, req.SHA)
		if err != nil {
			return err
		}
		m, err := BuildScopedRepoMap(dir, req.Repo, "", h.defsFn(), h.patternsFn(), req.FileCap)
		if err != nil {
			return err
		}
		if m == nil || m.Tree == nil {
			return errors.New("repo map build failed (empty archive or extraction failure)")
		}
		if h.CacheDir != "" {
			_, _ = SaveTreeMap(h.CacheDir, req.Owner, req.Repo, req.SHA, &TreeMapCache{GitSha: req.SHA, Tree: m.Tree})
		}
		return nil
	})
}

func (h *Handler) loadCachedOrBuild(root string, req TreeOutlineRequest, patterns cognitive.Patterns) *RepoMap {
	if h.CacheDir != "" && req.SHA != "" {
		if cache, err := LoadTreeMap(h.CacheDir, req.Owner, req.Repo, req.SHA); err == nil && cache.Tree != nil {
			files := cache.Tree.LeafFiles()
			m := &RepoMap{RepoName: req.Repo, Files: files, Tree: cache.Tree}
			for _, f := range files {
				m.TotalLOC += f.LOC
			}
			m.EstTokens = estimateTokensFor(m)
			return m
		}
	}
	m, err := BuildScopedRepoMap(root, req.Repo, req.Prefix, h.defsFn(), patterns, req.FileCap)
	if err != nil {
		return &RepoMap{RepoName: req.Repo}
	}
	if h.CacheDir != "" && req.SHA != "" && req.Prefix == "" && m.Tree != nil {
		_, _ = SaveTreeMap(h.CacheDir, req.Owner, req.Repo, req.SHA, &TreeMapCache{GitSha: req.SHA, Tree: m.Tree})
	}
	return m
}

func scopeMapToPrefix(m *RepoMap, prefix string) *RepoMap {
	prefix = strings.Trim(prefix, "/ ")
	if prefix == "" || m == nil {
		return m
	}
	files := make([]FileMap, 0, len(m.Files))
	for _, f := range m.Files {
		if strings.HasPrefix(f.Path+"/", prefix+"/") {
			files = append(files, f)
		}
	}
	scoped := &RepoMap{RepoName: m.RepoName + "/" + prefix, Files: files}
	for _, f := range files {
		scoped.TotalLOC += f.LOC
	}
	scoped.EstTokens = estimateTokensFor(scoped)
	scoped.Tree = BuildRepoTree(files, scoped.RepoName)
	for _, ce := range m.CallEdges {
		if strings.HasPrefix(ce.Caller+"/", prefix+"/") || strings.HasPrefix(ce.Callee+"/", prefix+"/") {
			scoped.CallEdges = append(scoped.CallEdges, ce)
		}
	}
	return scoped
}

type ExcludedFile struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
	Note   string `json:"note,omitempty"`
}

func ComputeExcludedFiles(m *RepoMap, chapters []cognitive.OutlineChapter, thematic bool) []ExcludedFile {
	if m == nil || len(m.Files) == 0 {
		return nil
	}
	chosen := make(map[string]bool, len(m.Files))
	for _, ch := range chapters {
		for _, f := range ch.Files {
			clean := strings.Trim(filepath.ToSlash(f.Path), "/ ")
			chosen[clean] = true
			for _, comp := range f.CompanionFiles {
				chosen[strings.Trim(filepath.ToSlash(comp), "/ ")] = true
			}
		}
	}

	var excluded []ExcludedFile
	for _, f := range m.Files {
		clean := strings.Trim(filepath.ToSlash(f.Path), "/ ")
		if clean == "" || chosen[clean] {
			continue
		}
		reason := "辅助文件"
		if thematic {
			reason = "非当前专题范围"
		}
		lower := strings.ToLower(clean)
		if f.IsTest || strings.Contains(lower, "test") || strings.Contains(lower, "spec") {
			reason = "测试文件"
		} else if strings.HasPrefix(lower, "records/") || strings.HasPrefix(lower, "benchmarks/") || strings.HasPrefix(lower, "evals/") || mdpat.IsRunRecordDump(f.Path) {
			// Single source of truth shared with outline_sanitizer to filter logs and hashed runtime dumps.
			reason = "评测与运行记录"
		} else if strings.Contains(lower, "testdata/") || strings.Contains(lower, "fixtures/") || strings.Contains(lower, "fixture/") {
			reason = "测试样本/数据"
		} else if strings.HasPrefix(lower, "dist/") || strings.HasPrefix(lower, "build/") || strings.HasPrefix(lower, "out/") {
			reason = "构建产物"
		} else if f.IsConfig {
			reason = "环境配置"
		} else if f.IsDoc {
			reason = "补充文档"
		}

		note := f.Lang
		if f.LOC > 0 {
			if note != "" {
				note = fmt.Sprintf("%s · %d 行", note, f.LOC)
			} else {
				note = fmt.Sprintf("%d 行", f.LOC)
			}
		}

		excluded = append(excluded, ExcludedFile{
			Path:   f.Path,
			Reason: reason,
			Note:   note,
		})
	}
	return excluded
}
