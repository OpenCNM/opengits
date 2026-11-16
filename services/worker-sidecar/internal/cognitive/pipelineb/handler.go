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

// ─────────────────────────────────────────────────────────────
// /v1/outline/tree 端点(P3):Web 导入向导的统一树大纲集成面。
//
// 请求:{owner, repo, sha?, repoDir?(测试/本地覆盖), targetLanguage?,
//        fileCap?} → 归档就位 → 全量树+提取 → 深度路由:
//   子树在预算内 → 深度 1(单次 outline_map_v1);超预算 → 深度 2 下钻
//   (outline_plan_v1 规划 + 并行子树 + 汇编装甲)→ CourseTree 产物。
// 响应:{depth, courseTree, chapters, droppedPaths, stats}。
// ─────────────────────────────────────────────────────────────

// TreeOutlineRequest 端点请求。
type TreeOutlineRequest struct {
	Owner          string `json:"owner"`
	Repo           string `json:"repo"`
	SHA            string `json:"sha,omitempty"`
	RepoDir        string `json:"repoDir,omitempty"` // 本地目录直读(测试/内部)
	Token          string `json:"token,omitempty"`
	GitHubToken    string `json:"githubToken,omitempty"`
	TargetLanguage string `json:"targetLanguage,omitempty"`
	FileCap        int    `json:"fileCap,omitempty"`
	/** 子目录作用域(D2):非空时仅该前缀下文件入图(用户选定分区导入) */
	Prefix string `json:"prefix,omitempty"`
	/** BYOK 归属用户(网关 keyOrigin=user 的 key 解析与记账;空=匿名) */
	UserID string `json:"userId,omitempty"`
	/** 用户显式剪除的目录或文件路径前缀 */
	ExcludedPaths []string `json:"excludedPaths,omitempty"`
	/** 用户自然语言编排偏好指令 */
	CustomPrompt string `json:"customPrompt,omitempty"`
	/** 大纲节奏/章节粒度 (compact: 紧凑 5-7章, normal: 标准 8-10章, detailed: 详尽 11-14章) */
	Pacing string `json:"pacing,omitempty"`
	/** 教学深度 (overview: 简单 / standard: 默认 / deep: 困难)——全链路贯穿大纲规划与文件选取 */
	TeachingDepth string `json:"teachingDepth,omitempty"`
	/** 学习者画像与定位 (architecture_overview / deep_dive_internals / cross_language_migrant / pedagogical_beginner) */
	LearnerArchetype string `json:"learnerArchetype,omitempty"`
	/** 调用方总预算（毫秒）：客户端 fetch 超时闸的显式契约——整条处理链
	 * （归档+提取+LLM+装甲）的 ctx 上限，LLM 切片按剩余额度动态钳制 */
	BudgetMs int64 `json:"budgetMs,omitempty"`
	/** 是否强制重置/重试（清理前序失败或陈旧状态） */
	Retry bool `json:"retry,omitempty"`
}

// Handler 树大纲端点依赖。
type Handler struct {
	patternsFn func() cognitive.Patterns
	defsFn     func() *rsg.LanguageDefinitions
	ensureDir  func(ctx context.Context, owner, repo, sha string) (string, error)
	planner    PlannerModel
	model      OutlineModel
	sampler    OutlineSampler
	// 按请求用户派生模型与采样器(网关 BYOK 归属);未设置时恒用 planner/model/sampler 常量
	plannerFor func(userId string) PlannerModel
	modelFor   func(userId string) OutlineModel
	samplerFor func(userId string) OutlineSampler
	// A4 缓存目录(空=禁用):同 (owner,repo,sha) 命中免重提取
	CacheDir string
	// 冷启动判定(空=禁用异步准备,走旧同步语义——测试 RepoDir 直读/未接线部署):
	// 返回归档是否已在本地磁盘。归档缺失且 tree-map 缓存未命中时请求立即
	// 202 PREPARING,准备在分离 ctx 后台完成(prepare on cold, serve on warm)。
	statDir func(owner, repo, sha string) bool
	prep    *PrepTracker

	GitHubToken   string
	GitHubAPIBase string
	UserAgent     string
	treeFetcher   func(ctx context.Context, apiBase, owner, repo, sha, token, userAgent string) (*client.GitTreeResponse, error)
	blobFetcher   func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, error)
	// 并发分块 Blob 拉取器（契约 C2）：策略 A 全量 AST 与策略 B 大配额抓取通道；
	// 返回 (内容, 是否截断, 错误)。nil = 未接线，恒走策略 B + 旧版 blobFetcher 语义
	concurrentBlobFetcher func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, bool, error)
	pingInterval          time.Duration
}

// NewHandler 构造(ensureDir: 归档就位服务,返回本地根目录; sampler 为可选 AI 采样器)。
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

// SetSampler 注入 AI 采样决策器（供单元测试 Mock 或外部替换）。
func (h *Handler) SetSampler(sampler OutlineSampler) *Handler {
	h.sampler = sampler
	h.samplerFor = func(string) OutlineSampler { return sampler }
	return h
}

// SetGitHubConfig 配置 GitHub API 基础参数。
func (h *Handler) SetGitHubConfig(token, apiBase, userAgent string) *Handler {
	h.GitHubToken = token
	h.GitHubAPIBase = apiBase
	h.UserAgent = userAgent
	return h
}

// SetFetchers 注入树拉取与 Blob 拉取函数（供单元测试 Mock 或外部替换）。
// 显式注入旧版 fetcher 对即声明并发分块通道让位（concurrentBlobFetcher 置 nil，
// 恒走策略 B + 本注入语义）；并发通道经 SetConcurrentBlobFetcher 单独恢复。
func (h *Handler) SetFetchers(
	treeFetcher func(ctx context.Context, apiBase, owner, repo, sha, token, userAgent string) (*client.GitTreeResponse, error),
	blobFetcher func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, error),
) *Handler {
	h.treeFetcher = treeFetcher
	h.blobFetcher = blobFetcher
	h.concurrentBlobFetcher = nil
	return h
}

// SetConcurrentBlobFetcher 注入并发分块 Blob 拉取器（供单元测试 Mock 或外部替换；
// nil 关闭策略 A 全量 AST 通道，恒走策略 B）。
func (h *Handler) SetConcurrentBlobFetcher(
	f func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, bool, error),
) *Handler {
	h.concurrentBlobFetcher = f
	return h
}

// SetArchiveStat 接线冷启动判定(daemon 装配期调用;nil 恢复纯同步语义)。
func (h *Handler) SetArchiveStat(statDir func(owner, repo, sha string) bool) *Handler {
	h.statDir = statDir
	return h
}

// WithUserFactories 按请求 userId 派生模型与采样器适配器(BYOK 归属——网关
// keyOrigin=user 依赖 userId 解密用户 key;uid 空串时应返回匿名适配器)。
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

// samplerForReq 按请求用户取采样器；网关采样器克隆挂载请求选定条件
// （customPrompt/teachingDepth/learnerArchetype，契约 C3 策略 B 透传）。
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

// plannerForReq / modelForReq 按请求用户取模型;工厂未接线(测试直构
// Handler)时回退构造期常量。支持动态挂载用户定制指令、节奏、教学深度与学习者画像。
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

// ─────────────────────────────────────────────────────────────
// 策略分级路由阈值（WP1·体量分级）：环境变量可覆盖，零硬编码。
//
// 策略 A（阈值内）：全量轻量 AST 建图，显式短路 LLM 采样器（Asymmetric
// Compute——全量确定性事实已覆盖选材职能，不付 4s 采样延迟）。
// 策略 B（超阈值）：子系统分层配额抽样（契约 C1 SSOT + 既有 AI 采样升级）。
// ─────────────────────────────────────────────────────────────
const (
	TreeFirstFullAstCapEnvVar    = "TREE_FIRST_FULL_AST_CAP"   // 策略 A 文件数阈值（默认 600）
	TreeFirstFullAstBytesEnvVar  = "TREE_FIRST_FULL_AST_BYTES" // 策略 A 总字节阈值（默认 15MB）
	defaultTreeFirstFullAstCap   = 600
	defaultTreeFirstFullAstBytes = 15 << 20
	// fullAstPrefilterMaxBytes 策略 A 单文件预过滤帽：>256KB 的巨型源码文件
	// AST 建图价值密度低于墙钟成本，直接跳过（扩展名黑名单由并发拉取器 C2
	// 内置 SSOT 统一剔除，此处不重复维护）。
	fullAstPrefilterMaxBytes = 256 << 10
	// defaultSamplingSkeletonBudget 采样骨架认知预算（行数）。
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

// SamplingStats 采样路由可观测事实（契约 C4）：仅进接口 stats 与服务端结构化
// 日志，绝不渲染进导入向导 UI（最小文案公理）。
type SamplingStats struct {
	Strategy         string  // full-ast | stratified | partial-ast | fallback-8
	SampledFileCount int     // 真实内容进入建图的文件数
	AstCoverageRatio float64 // 已提取 AST 文件 / 作用域有效内容文件（分母 0 记 1）
}

// samplingStatsFields 采样路由观测键并入 stats map。未走 tree-first 路由的
// 缓存/归档路径无本次采样事实——如实缺席，绝不伪造（Grounding Dilemma）。
func samplingStatsFields(stats map[string]any, s *SamplingStats) map[string]any {
	if s == nil {
		return stats
	}
	stats["samplingStrategy"] = s.Strategy
	stats["sampledFileCount"] = s.SampledFileCount
	stats["astCoverageRatio"] = s.AstCoverageRatio
	return stats
}

// tryTreeFirst 尝试通过 GitHub Trees API + GraphQL 批量拉取执行 Tree-First 秒级快速导入（纯内存构建）。
// 若遇到 >100,000 截断、网络异常或未提供 Token，返回错误触发 Fail-closed 降级。
// 策略分级路由：作用域有效内容文件在阈值内走策略 A（全量 AST，短路 LLM 采样器），
// 超阈值走策略 B（子系统分层配额抽样）；返回建图与采样路由观测事实。
func (h *Handler) tryTreeFirst(ctx context.Context, req TreeOutlineRequest, patterns cognitive.Patterns, progressFn ...ProgressCallback) (*RepoMap, *SamplingStats, error) {
	if h.treeFetcher == nil {
		return nil, nil, errors.New("tree fetcher not configured")
	}

	var cb ProgressCallback
	if len(progressFn) > 0 && progressFn[0] != nil {
		cb = progressFn[0]
	}

	effectiveToken := req.GitHubToken
	if effectiveToken == "" {
		effectiveToken = req.Token
	}
	if effectiveToken == "" {
		effectiveToken = h.GitHubToken
	}
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

	// 体量分级：文件数与总字节双阈值判定（确定性微秒级短路，零 LLM）
	var totalBytes int64
	for _, e := range contentEntries {
		totalBytes += e.Size
	}
	if h.concurrentBlobFetcher != nil &&
		len(contentEntries) <= treeFirstFullAstFileCap() &&
		totalBytes <= treeFirstFullAstBytesCap() {
		m, stats, err := h.tryFullAstMap(fetchCtx, apiBase, req, ua, effectiveToken, treeResp.Tree, contentEntries, defs, patterns, cb)
		if err != nil {
			// 策略 A 全批失败 fail-closed：上层走既有归档降级，绝不静默换轨掩盖物理故障
			return nil, nil, err
		}
		return m, stats, nil
	}
	return h.tryStratifiedMap(fetchCtx, apiBase, req, ua, effectiveToken, treeResp.Tree, contentEntries, defs, patterns, cb)
}

// tryFullAstMap 策略 A：全量轻量 AST 建图（阈值内仓库，显式短路 LLM 采样器）。
// tree entry size 预过滤 >256KB 后经 GithubConcurrentBatchGetBlobsGraphQL 并发
// 全量拉取，全量 ExtractFileAst 建 CallEdges/Hotness/TopologicalLayer；
// 拉取截断（墙钟/单批失败）时策略记 partial-ast，聚合内容绝不整体丢弃（C2）。
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

	// 全量提取：fileCap 上抬至作用域文件数，杜绝预算帽截断 AST 覆盖（能力不倒退）
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

// tryStratifiedMap 策略 B：超阈值仓库子系统分层配额抽样（既有秒级路径的配额升级）。
// DiscoverSubsystems（契约 C1 SSOT）划分子系统 → 骨架按子系统均摊预算 →
// AI 采样按子系统配额保底（总上限 min(50, max(25, 子系统数×3))）→ 并发分块一次抓取。
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
			// README 可选输入：抓取失败不阻塞策略 B，但必须可观测（fail-open 留痕）
			log.Printf("[pipelineb] stratified readme fetch skipped (optional): %v", rErr)
		} else if readmeBlobs != nil {
			if content, ok := readmeBlobs[readmePath]; ok {
				readmeContent = content
				coreFiles[readmePath] = content
			}
		}
	}

	// 内存构建轻量折叠树并渲染骨架图 (Zero-Materialization)；多子系统仓库按子系统均摊预算
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

	// AI 架构审阅与自主点名（用户选定条件全链路贯穿，契约 C5）；超时 (4s) 或异常时 fail-open 回退
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

	// 单文件字节预过滤（与策略 A 同款 256KB 帽）：AI 点名与配额补足不得越过
	// 巨型文件墙钟成本线——tree entry size 是微秒级确定性事实，抓取前短路
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

	// 并发分块通道优先（大配额 >25 会被旧版单批硬帽静默截断）；
	// 未接线时回退旧版单批语义（既有测试/外部替换依赖）。
	// 截断/失败全部可观测：truncated 标注 stratified-partial，全灭才 fail-closed
	// 触发上层归档降级，部分成功 fail-open 续跑——绝不静默吞掉降级事实
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
			// 一个文件都没拿到：fail-closed 让 tryTreeFirst 整体失败，
			// 触发上层 202 异步归档降级，绝不拿空图冒充采样成果
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
	// 截断降级可观测（契约 C4）：部分成功的策略 B 如实标注 stratified-partial，
	// 绝不冒充完整 stratified 成果（Grounding Dilemma）
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

// HandleTreeOutline POST /v1/outline/tree。
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

	sendSuccess := func(status int, payload map[string]any) {
		if isStream && sw != nil {
			_ = sw.SendEvent("", "complete", payload)
		} else {
			httpx.WriteJSON(w, status, payload)
		}
	}

	lang := req.TargetLanguage
	// 'none'(不翻译)只约束文档转录;大纲是生成型内容,无原文可保——
	// 纵深防御:即便调用方漏解析,也绝不把 'none' 透传进 Prompt 渲染成
	// "全部文字使用 none"(客户端已在边界按界面 locale 解析)。
	if lang == "" || lang == "none" {
		lang = "zh-CN"
	}

	patterns := h.patternsFn()

	var m *RepoMap
	// 采样路由观测事实（契约 C4）：仅 tree-first 路由产生；缓存/归档路径如实缺席
	var sampling *SamplingStats
	// 1. 本地 tree-map 缓存优先 (同 SHA 秒级直出，0 磁盘 0 网络)
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
					Title:  "缓存代码树秒级直出",
					Detail: fmt.Sprintf("已感知 %d 个文件 (缓存命中)", len(files)),
				})
			}
		}
	}

	// 2. 本地目录直读覆盖 (测试 / 内部调用)
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

	// 3. 磁盘已有归档目录 (Warm Path)
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

	// 4. 冷启动 (Cold Path): 磁盘既无 tree-map 缓存也无解压归档
	if m == nil && req.RepoDir == "" && req.SHA != "" {
		key := PrepKey(req.Owner, req.Repo, req.SHA)
		if req.Retry {
			h.prep.Reset(key)
		}
		if failed, perr := h.prep.ConsumeFailed(key); failed {
			// 上轮准备已确定失败:如实暴露错误,并清空失败状态以允许后续重试重新点火
			sendError(http.StatusBadGateway, "repo preparation failed: "+perr)
			return
		} else if st, _ := h.prep.Get(key); st == PrepStatusRunning {
			// 后台归档下载与建图已在运行中（前序冷启动或降级触发）：直接让位 202，绝不重复盲目重跑 Tree-First 浪费 GitHub 配额
			sendSuccess(http.StatusAccepted, map[string]any{
				"ok":           true,
				"preparing":    true,
				"status":       PrepStatusRunning,
				"detail":       "大型仓库首次解析：正在后台下载归档并构建代码地图，就绪后自动继续",
				"retryAfterMs": PrepPollIntervalMs,
			})
			return
		}

		// 优先尝试 Tree-First 秒级快速导入（纯内存构建，含策略 A/B 分级路由）
		treeMap, samplingStats, treeErr := h.tryTreeFirst(r.Context(), req, patterns, cb)
		if treeErr == nil && treeMap != nil && treeMap.Tree != nil {
			m = treeMap
			sampling = samplingStats
			// 缓存固化：同 SHA 保证后续请求毫秒级直出
			if h.CacheDir != "" && req.Prefix == "" {
				_, _ = SaveTreeMap(h.CacheDir, req.Owner, req.Repo, req.SHA, &TreeMapCache{GitSha: req.SHA, Tree: m.Tree})
			}
		} else {
			// Tree-First 失败（截断 >100k、网络瞬断或未提供 Token）：Fail-closed 回退到原有 202 异步后台归档
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
			// statDir 未接线环境下的回退
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
		// SHA 为空且无 RepoDir
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

	// 建图失败时 loadCachedOrBuild 返回仅含 RepoName 的空壳（Tree=nil），
	// 深度路由解引用 FileCount 必 panic——与 HandleSkeleton/HandleTopology
	// 一致地显式失败（fail-closed），不得带病继续。
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

	// 调用方预算契约：budgetMs 显式声明时收紧总 ctx（与 15min 缺省取小），
	// LLM 切片由 Run 按 ctx 剩余额度动态推导——预算所有权归真正的持有者
	handlerBudget := 15 * time.Minute
	if req.BudgetMs > 0 {
		if d := time.Duration(req.BudgetMs) * time.Millisecond; d < handlerBudget {
			handlerBudget = d
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), handlerBudget)
	defer cancel()

	// 深度路由看全量文件数(m.Tree.FileCount)与动态预算上限(effectiveCap)——截断时 m.Files 恒为
	// 配额值,以它路由会让巨仓永远走深度 1
	effectiveCap := MaxFilesInMap(req.FileCap)
	if m.Tree.FileCount <= effectiveCap {
		if cb != nil {
			cb(ProgressStep{
				Stage:  "plan",
				Title:  "快速大纲生成",
				Detail: fmt.Sprintf("仓库规模适中 (%d 文件)，正在进行单阶段大纲生成", m.Tree.FileCount),
			})
		}
		res, err := Run(ctx, m, h.modelForReq(req.UserID, req.CustomPrompt, req.TeachingDepth, req.LearnerArchetype, req.Pacing), patterns, lang)
		if err != nil {
			sendError(http.StatusInternalServerError, "outline failed: "+err.Error())
			return
		}
		// 深度 1 快路径同样走 WP4.2 AST 边优先挂载：策略 A 提取的 CallEdges
		// 在旗舰路径生效，严禁仅因共享顶层分区（depth==1）跨子系统错挂
		subsystems := DiscoverSubsystems(SubsystemSourcesFromRepoMap(m), patterns)
		AttachSubtreeCompanionsWithMap(res.Chapters, m.Tree, m, subsystems)
		macroTopo := BuildMacroTopology(m, "", 1, patterns)
		excludedFiles := ComputeExcludedFiles(m, res.Chapters)
		sendSuccess(http.StatusOK, map[string]any{
			"ok":            true,
			"depth":         1,
			"repo":          req.Repo,
			"macroTopology": macroTopo,
			"chapters":      res.Chapters,
			"droppedPaths":  res.DroppedPaths,
			"excludedFiles": excludedFiles,
			"stats":         samplingStatsFields(map[string]any{"files": len(m.Files), "promptTokens": res.EstPromptTok}, sampling),
		})
		return
	}

	res, err := RunDrill(ctx, m, h.plannerForReq(req.UserID, req.CustomPrompt, req.Pacing, req.TeachingDepth, req.LearnerArchetype), h.modelForReq(req.UserID, req.CustomPrompt, req.TeachingDepth, req.LearnerArchetype, req.Pacing), patterns, lang, req.TeachingDepth, cb)
	if err != nil {
		sendError(http.StatusInternalServerError, "tree outline failed: "+err.Error())
		return
	}

	if res.CurriculumMode == "single" {
		macroTopo := BuildMacroTopology(m, "", 1, patterns)
		excludedFiles := ComputeExcludedFiles(m, res.Chapters)
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
				"durationMs": res.Duration.Milliseconds(),
			}, sampling),
		})
		return
	}

	tree := BuildCourseTree(req.Repo, res, skipRootWrapper(m.Tree))
	tree.AttachTopologies(m, patterns)
	excludedFiles := ComputeExcludedFiles(m, res.Chapters)
	sendSuccess(http.StatusOK, map[string]any{
		"ok":            true,
		"depth":         2,
		"repo":          req.Repo,
		"courseTree":    tree,
		"macroTopology": tree.MacroTopology,
		"chapters":      res.Chapters, // 兼容:扁平视角同产出
		"droppedPaths":  res.DroppedPaths,
		"excludedFiles": excludedFiles,
		"stats": samplingStatsFields(map[string]any{
			"files": len(m.Files), "allFiles": m.Tree.FileCount,
			"durationMs": res.Duration.Milliseconds(),
		}, sampling),
	})
}

// archiveOnDisk 就绪判定（纯磁盘查询,零下载零提取):tree-map 缓存或
// 归档目录任一在位即视为可同步走预算内路径。
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

// launchPrep 幂等启动后台准备:归档就位 + 全量建图(与 loadCachedOrBuild
// 同构:prefix 恒空建全树,缓存惠及所有前缀请求) + 落 tree-map 缓存。
// ctx 为分离后台 ctx,与请求生命周期解耦——这正是冷启动契约的核心。
func (h *Handler) launchPrep(req TreeOutlineRequest) {
	h.prep.Start(PrepKey(req.Owner, req.Repo, req.SHA), func(ctx context.Context) error {
		// 失效封闭:后台 goroutine 里的 nil 工厂必须转为错误而非 panic
		//(panic 在分离 goroutine 中会击穿整个进程)
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

// loadCachedOrBuild A4:SHA 命中缓存直接重建 RepoMap(提取免跑);// 未命中构建后写缓存。repoDir 测试覆盖同样适用(sha 即内容指纹位)。
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
		return &RepoMap{RepoName: req.Repo} // 上层对空地图走深度1/错误路径
	}
	if h.CacheDir != "" && req.SHA != "" && req.Prefix == "" && m.Tree != nil {
		_, _ = SaveTreeMap(h.CacheDir, req.Owner, req.Repo, req.SHA, &TreeMapCache{GitSha: req.SHA, Tree: m.Tree})
	}
	return m
}

// scopeMapToPrefix 子目录作用域(D2):前缀过滤文件与树(重建子树),
// 深度路由随过滤后规模生效。空前缀=整仓(现状)。
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

// ExcludedFile 记录未纳入核心大纲的辅助/测试/数据文件（安全出口）。
type ExcludedFile struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
	Note   string `json:"note,omitempty"`
}

// ComputeExcludedFiles 对比全量扫描文件与大纲采纳文件，计算未纳入大纲的安全出口文件清单。
func ComputeExcludedFiles(m *RepoMap, chapters []cognitive.OutlineChapter) []ExcludedFile {
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
		lower := strings.ToLower(clean)
		if f.IsTest || strings.Contains(lower, "test") || strings.Contains(lower, "spec") {
			reason = "测试文件"
		} else if strings.HasPrefix(lower, "records/") || strings.HasPrefix(lower, "benchmarks/") || strings.HasPrefix(lower, "evals/") || mdpat.IsRunRecordDump(f.Path) {
			// IsRunRecordDump（SSOT）：.log 恒转储 + UUID/散列命名 .txt/.out——
			// 与大纲装甲挡截判定同源，杜绝两处硬编码漂移
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
