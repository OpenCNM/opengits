package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/jobs"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/opengits/worker-sidecar/internal/reputation"
	"github.com/opengits/worker-sidecar/internal/rsg"
	"github.com/opengits/worker-sidecar/internal/webdoc"
)

type LanguageDefinitions = rsg.LanguageDefinitions
type SemanticGraphArtifact = rsg.SemanticGraphArtifact
type FirecrawlAPI = webdoc.FirecrawlAPI
type FirecrawlDoc = webdoc.FirecrawlDoc
type CrawlFilters = webdoc.CrawlFilters
type ModuleDraftInput = cognitive.ModuleDraftInput
type PhaseVoteOptions = cognitive.PhaseVoteOptions
type ProjectedModule = cognitive.ProjectedModule
type ModuleCognition = cognitive.ModuleCognition

type LLMGenerator interface {
	Generate(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error
}

type LlmGatewayClient = LLMGenerator

var BuildRepoSemanticGraph = rsg.BuildRepoSemanticGraph
var LoadLanguageDefinitions = rsg.LoadLanguageDefinitions
var ProjectToCognitiveGradient = cognitive.ProjectToCognitiveGradient
var LoadSemanticGraphArtifact = cognitive.LoadSemanticGraphArtifact

type ConfirmedModule struct {
	Name        string   `json:"name"`
	Summary     string   `json:"summary"`
	Directories []string `json:"directories"`
	Granularity string   `json:"granularity"`
}

type ImportSettleResult = jobs.ImportSettleResult

type IngestBodyDeps struct {
	Store                Store
	Archive              *ArchiveClient
	Web                  InternalJobAPI
	SettleJob            func(ctx context.Context, jobId string, result ImportSettleResult) error
	ArchiveRoot          string
	Patterns             *Patterns
	Languages            *LanguageDefinitions
	GraphDir             string
	GraphRepo            cognitive.GraphArtifactRepo
	LLM                  LLMGenerator
	Firecrawl            FirecrawlAPI
	Gate                 *jobs.MemoryGate
	Emit                 func(eventType string, payload map[string]any)
	TriggerTranscription func()
}

func (d IngestBodyDeps) emit(eventType string, payload map[string]any) {
	if d.Emit != nil {
		d.Emit(eventType, payload)
	}
}

func emitIngestError(deps IngestBodyDeps, prefix string, err error) {
	if payload, ok := client.FormatGatewaySSEErrorPayload(prefix, err); ok {
		deps.emit("error", payload)
		return
	}
	msg := prefix
	if err != nil {
		msg = prefix + err.Error()
	}
	deps.emit("error", map[string]any{"message": msg})
}

func (d IngestBodyDeps) settle(ctx context.Context, jobId string, result ImportSettleResult) error {
	if d.SettleJob == nil {
		return fmt.Errorf("settle executor not configured")
	}
	return d.SettleJob(ctx, jobId, result)
}

func (d IngestBodyDeps) RunBody(ctx context.Context, _ jobs.Config, job jobs.JobRow, emit func(string, map[string]any)) bool {
	deps := d
	if emit != nil {
		deps.Emit = emit
	}
	return runIngestBody(ctx, LoadConfigFromEnv(), deps, job) == Done
}

func (d IngestBodyDeps) WebClient() jobs.InternalJobAPI {
	return d.Web
}

type InternalJobAPI interface {
}

type ingestProgressReporter struct {
	store       Store
	jobID       string
	interval    time.Duration
	mu          sync.Mutex
	lastUpdate  time.Time
	maxProgress int
}

func newIngestProgressReporter(store Store, jobID string, interval time.Duration) *ingestProgressReporter {
	if interval <= 0 {
		interval = 3 * time.Second
	}
	return &ingestProgressReporter{
		store:    store,
		jobID:    jobID,
		interval: interval,
	}
}

func (r *ingestProgressReporter) Report(ctx context.Context, step string, progress int, force bool) {
	if r == nil || r.store == nil || r.jobID == "" {
		return
	}
	r.mu.Lock()
	now := time.Now()
	if !force && now.Sub(r.lastUpdate) < r.interval {
		r.mu.Unlock()
		return
	}
	if progress < r.maxProgress {
		progress = r.maxProgress
	} else {
		r.maxProgress = progress
	}
	r.lastUpdate = now
	r.mu.Unlock()

	_ = r.store.UpdateImportJobProgress(ctx, r.jobID, step, progress)
}

type Outcome int

const (
	Done Outcome = iota
	Fallback
)

type IngestOutcome = Outcome
type ingestOutcome = Outcome

const (
	IngestDone     = Done
	IngestFallback = Fallback
	ingestDone     = Done
	ingestFallback = Fallback
)

type EnvelopeOptions struct {
	GitSha              string             `json:"gitSha"`
	Sha                 string             `json:"sha"`
	IsPublic            bool               `json:"isPublic"`
	Category            string             `json:"category"`
	Tags                []string           `json:"tags"`
	Prefix              string             `json:"prefix"`
	PrefixFilter        string             `json:"prefixFilter"`
	CustomOutline       json.RawMessage    `json:"customOutline"`
	DraftOutline        json.RawMessage    `json:"draftOutline"`
	IngestPrefix        string             `json:"ingestPrefix"`
	TargetLanguage      string             `json:"targetLanguage"`
	ActiveModuleNames   []string           `json:"activeModuleNames"`
	Url                 string             `json:"url"`
	Name                string             `json:"name"`
	MaxPages            int                `json:"maxPages"`
	RepoProfile         json.RawMessage    `json:"repoProfile"`
	UseAi               bool               `json:"useAi"`
	CustomPrompt        string             `json:"customPrompt"`
	TranscriptionPreset string             `json:"transcriptionPreset"`
	EditionLabel        string             `json:"editionLabel"`
	AiGranularity       string             `json:"aiGranularity"`
	AiCondensation      string             `json:"aiCondensation"`
	TeachingDepth       string             `json:"teachingDepth"`
	VersionLabel        string             `json:"versionLabel"`
	CustomExtensions    []string           `json:"customExtensions"`
	StarCount           int                `json:"starCount"`
	Model               string             `json:"model"`
	TranscriptionModel  string             `json:"transcriptionModel"`
	ScopeMode           string             `json:"scopeMode"`
	PrimaryDocPrefix    string             `json:"primaryDocPrefix"`
	AllowedPrefixes     []string           `json:"allowedPrefixes"`
	ModuleTabs          []webdoc.ModuleTab `json:"moduleTabs"`
}

type ImportJobEnvelope struct {
	Kind            string          `json:"kind"`
	UserId          string          `json:"userId"`
	Branch          string          `json:"branch"`
	Edition         string          `json:"edition"`
	Sha             string          `json:"sha"`
	GitSha          string          `json:"gitSha"`
	PreExistingRepo json.RawMessage `json:"preExistingRepo"`
	Options         EnvelopeOptions `json:"options"`
}

type JobRow = jobs.JobRow

func newArchiveProgressHandler(
	ctx context.Context,
	reporter *ingestProgressReporter,
	emit func(string, map[string]any),
) archive.ProgressCallback {
	var lastArchiveLogTime time.Time
	var lastArchiveLogMu sync.Mutex

	return func(p archive.Progress) {
		if ctx.Err() != nil {
			return
		}
		lastArchiveLogMu.Lock()
		now := time.Now()
		isFinal := p.Percent >= 100.0 || p.SpeedFormatted == "cached"
		if !isFinal && now.Sub(lastArchiveLogTime) < 1*time.Second {
			lastArchiveLogMu.Unlock()
			return
		}
		lastArchiveLogTime = now
		lastArchiveLogMu.Unlock()

		jobProgress := 20 + int(p.Percent*0.18)
		if jobProgress > 38 {
			jobProgress = 38
		}
		speedStr := p.SpeedFormatted
		if speedStr == "" {
			speedStr = archive.FormatSpeed(p.SpeedBps)
		}
		stepDesc := fmt.Sprintf("[2/5] 装载并解压代码仓归档 (%s, %.1f%%)", speedStr, p.Percent)
		if reporter != nil {
			reporter.Report(ctx, stepDesc, jobProgress, isFinal)
		}

		var curFilePart string
		if p.CurrentFile != "" && p.CurrentFile != "cached" {
			curFilePart = fmt.Sprintf(" · %s", p.CurrentFile)
		}
		logMsg := fmt.Sprintf("[2/5] 装载归档: %s (%.1f%%)%s", speedStr, p.Percent, curFilePart)
		if emit != nil {
			emit("progress", map[string]any{
				"speedBps":        p.SpeedBps,
				"speed":           speedStr,
				"speedFormatted":  speedStr,
				"downloadedBytes": p.DownloadedBytes,
				"totalBytes":      p.TotalBytes,
				"percent":         p.Percent,
				"currentFile":     p.CurrentFile,
				"extractedBytes":  p.ExtractedBytes,
				"extractedFiles":  p.ExtractedFiles,
				"message":         logMsg,
			})
		}
	}
}

func RunIngestBody(ctx context.Context, cfg Config, deps IngestBodyDeps, job JobRow) Outcome {
	return runIngestBody(ctx, cfg, deps, job)
}
func runIngestBody(ctx context.Context, cfg Config, deps IngestBodyDeps, job JobRow) ingestOutcome {
	var envelope ImportJobEnvelope
	if err := json.Unmarshal(job.Params, &envelope); err != nil {
		deps.emit("error", map[string]any{"message": fmt.Sprintf("任务参数信封解析失败: %v", err)})
		return ingestFallback
	}

	if envelope.Kind == "web-doc" {
		return runWebDocIngest(ctx, cfg, deps, job, envelope)
	}
	if envelope.Kind == "web-sync" {
		return runWebDocSync(ctx, cfg, deps, job, envelope)
	}
	o := envelope.Options
	scopePrefix := resolveScopePrefix(o.PrefixFilter, o.Prefix)
	userId := envelope.UserId
	if userId == "" {
		userId = derefStrPtr(job.UserId)
	}

	draftContent, draftOK := parseDraftOutline(o.DraftOutline)
	// Fail closed on corrupt draftOutline JSON so malformed payloads do not misreport as oversized repo.
	if len(o.DraftOutline) > 2 && !draftOK {
		deps.emit("error", map[string]any{"message": "草稿大纲载荷解析失败（JSON 无效），请重新生成大纲后重试"})
		return ingestFallback
	}

	// User-confirmed customOutline defines a bounded scope and overrides the giant-repo gate.
	customCats, customOK := parseCustomOutline(o.CustomOutline)
	if len(o.CustomOutline) > 2 && !customOK {
		deps.emit("error", map[string]any{"message": "自定义大纲载荷解析失败（JSON 无效），请返回向导重新确认大纲"})
		return ingestFallback
	}
	var outlineKeep map[string]bool
	if len(customCats) > 0 {
		outlineKeep = collectCustomOutlineKeepPaths(customCats)
	}

	reporter := newIngestProgressReporter(deps.Store, job.Id, 3*time.Second)

	reporter.Report(ctx, "[1/5] 解析代码仓版本与提交标识...", 10, true)
	deps.emit("log", map[string]any{"message": "[1/5] 解析代码仓版本与提交标识 (Resolve Git SHA)..."})
	sha := o.GitSha
	if sha == "" {
		sha = o.Sha
	}
	if sha == "" {
		sha = envelope.GitSha
	}
	if sha == "" {
		sha = envelope.Sha
	}
	if sha == "" {
		resolved, err := ResolveLatestSha(ctx, cfg, job.Owner, job.Repo, job.Branch)
		if err != nil {
			deps.emit("error", map[string]any{"message": fmt.Sprintf("解析仓库最新 commit SHA 失败: %v", err)})
			return ingestFallback
		}
		sha = resolved
	}

	// Prefetch stars concurrently during archive/scan; envelope.Options is only read after wait() at commit.
	starPrefetch := prefetchRepoStars(ctx, cfg, job, &envelope)

	starPrefetch.wait()
	rep := reputation.EvaluateRepoReputation(reputation.RepoMeta{
		Owner: job.Owner,
		Repo:  job.Repo,
		Stars: envelope.Options.StarCount,
	})

	reporter.Report(ctx, "[2/5] 装载并解压代码仓归档...", 20, true)
	deps.emit("log", map[string]any{"message": "[2/5] 装载并解压代码仓归档 (Ensure Archive)..."})
	if rep.IsClassic {
		deps.emit("log", map[string]any{"message": fmt.Sprintf("识别为知名经典开源项目 (%s)，配额放宽至 %dMB", rep.Reason, rep.Quotas.MaxUnpackCapBytes/(1024*1024))})
	}

	onArchiveProgress := newArchiveProgressHandler(ctx, reporter, deps.emit)
	archiveCtx := archive.WithProgress(ctx, onArchiveProgress)
	if len(outlineKeep) > 0 {
		archiveCtx = archive.WithAllowedFiles(archiveCtx, outlineKeep)
	}

	if deps.Archive == nil || !deps.Archive.EnsureWithCap(archiveCtx, job.Owner, job.Repo, sha, rep.Quotas.MaxUnpackCapBytes, scopePrefix) {
		maxMB := rep.Quotas.MaxUnpackCapBytes / (1024 * 1024)
		deps.emit("error", map[string]any{"message": fmt.Sprintf("归档不可用：仓库超过当前信誉配额（上限 %dMB）或下载失败，请缩小导入范围或稍后重试", maxMB)})
		return ingestFallback
	}

	reporter.Report(ctx, "[3/5] 流式扫描文件树与结构嗅探...", 40, true)
	deps.emit("log", map[string]any{"message": "[3/5] 流式扫描文件树与结构嗅探 (Scan Tree & Sniff Profile)..."})
	patterns := deps.Patterns
	scan, ok := ScanArchiveStream(deps.ArchiveRoot, job.Owner, job.Repo, sha, patterns, outlineKeep)
	if !ok {
		deps.emit("error", map[string]any{"message": "扫描归档文件树失败，归档文件可能损坏或已被清理，请重试"})
		return ingestFallback
	}

	nodes := scan.Nodes
	if len(outlineKeep) > 0 {
		kept := make([]GitNode, 0, len(outlineKeep))
		for _, n := range scan.Nodes {
			if n.Type != "blob" || outlineKeep[n.Path] {
				kept = append(kept, n)
			}
		}
		nodes = kept
		scan.Nodes = kept
		if len(nodes) == 0 {
			deps.emit("error", map[string]any{"message": "大纲引用的文件在仓库中均不存在（SHA 已变更?），请重新生成大纲"})
			return ingestFallback
		}
	}
	if scopePrefix != "" {
		nodes = filterNodesByScope(scan.Nodes, scopePrefix)
		if len(nodes) == 0 {
			deps.emit("error", map[string]any{"message": fmt.Sprintf("所选目录 %s 下没有可导入的文件", scopePrefix)})
			return ingestFallback
		}
		if scale := patterns.ComputeRepoScale(nodes); scale.Scale == "giant" {
			deps.emit("error", map[string]any{"message": "所选作用域规模过大（巨型），请改用树大纲模式拆分导入或选择更小的目录范围"})
			return ingestFallback
		}
		scan.Nodes = nodes
	}

	if scan.IsGiant && len(customCats) == 0 {
		deps.emit("error", map[string]any{"message": "仓库规模过大（巨型），请使用树大纲模式拆分为子课导入，或选择子目录范围"})
		return ingestFallback
	}
	var profile SniffProfile
	codeRepo := false
	providedProfile := parseProvidedProfile(o.RepoProfile)
	{
		if len(nodes) == 0 {
			deps.emit("error", map[string]any{"message": "扫描得到的有效节点集为空，请检查仓库内容或导入范围"})
			return ingestFallback
		}
		ruleProfile := patterns.SniffRepo(nodes, false)
		if providedProfile != nil {
			profile = mergeProvidedProfile(providedProfile, ruleProfile)
		} else {
			profile = ruleProfile
		}
		if scopePrefix != "" {
			profile.TranslationRoots = resolveTranslationScopeConflict(profile.TranslationRoots, scopePrefix)
			if len(profile.TranslationRoots) == 0 {
				profile.HasTranslations = false
			}
		}
		if profile.IngestMode == "text_only" && deps.Languages != nil && customOutlineHasCodeChapters(customCats, patterns) {
			profile.IngestMode = "hybrid"
			profile.RepoType = "codebase"
			profile.TextRoot = nil
		}
		codeRepo = profile.IngestMode == "code_only" || profile.IngestMode == "hybrid"
		if !codeRepo && profile.IngestMode != "text_only" {
			deps.emit("error", map[string]any{"message": fmt.Sprintf("不支持的导入模式 (ingestMode=%s)，请检查仓库画像配置", profile.IngestMode)})
			return ingestFallback
		}
	}
	reporter.Report(ctx, "[3/5] 代码仓画像与依赖嗅探完成...", 60, false)

	if deps.Gate != nil {
		weight := deps.Gate.CalculateJobWeight(len(nodes), codeRepo)
		reporter.Report(ctx, fmt.Sprintf("[4/5] 申请计算内存加权配额 (权重: %d)...", weight), 65, true)
		deps.emit("log", map[string]any{"message": fmt.Sprintf("[4/5] 申请计算内存加权配额 (权重: %d)...", weight)})
		if err := deps.Gate.Acquire(ctx, weight); err != nil {
			deps.emit("error", map[string]any{"message": fmt.Sprintf("获取内存计算资源超时或失败: %v", err)})
			return ingestFallback
		}
		defer deps.Gate.Release(weight)
	}

	reporter.Report(ctx, "[4/5] 章节规划与认知投影构建...", 75, true)
	deps.emit("log", map[string]any{"message": "[4/5] 构建大纲导航树与章节落库 (Build NavTree & Create Docs)..."})

	textNodes := nodes
	if !codeRepo {
		textNodes = filterNodesByProfile(nodes, profile, o.CustomExtensions, patterns)
	}

	ingestEnv := &IngestContext{
		Cfg:               cfg,
		Deps:              deps,
		Job:               job,
		Sha:               sha,
		Nodes:             nodes,
		TextNodes:         textNodes,
		Patterns:          patterns,
		Profile:           profile,
		ProvidedProfile:   providedProfile,
		CodeRepo:          codeRepo,
		CustomCats:        customCats,
		DraftContent:      draftContent,
		ScopePrefix:       scopePrefix,
		UserId:            userId,
		TargetLanguage:    o.TargetLanguage,
		ActiveModuleNames: o.ActiveModuleNames,
	}

	ladder := DefaultChapterPlanLadder()
	plan, err := ladder.Evaluate(ctx, ingestEnv)
	if err != nil {
		emitIngestError(deps, "大纲章节规划阶梯执行失败: ", err)
		return ingestFallback
	}

	enrichRoot := deps.ArchiveRoot
	if enrichRoot == "" {
		enrichRoot = cfg.ArchiveRoot
	}
	if enrichRoot != "" {
		enrichPlanFileTitles(plan, func(p string) (string, bool) {
			raw, readErr := readLocalArchiveFile(enrichRoot, job.Owner, job.Repo, sha, p)
			if readErr != nil {
				return "", false
			}
			return raw, true
		})
	}

	reporter.Report(ctx, "[5/5] 章节落库与大纲持久化...", 90, true)
	deps.emit("log", map[string]any{"message": "[5/5] 单一持久化尾段落库 (Commit & Settle)..."})
	starPrefetch.wait()
	baseProfile := plan.Profile
	if baseProfile == nil {
		baseProfile = profileToMap(profile)
	}
	applyEnvelopeProfileExtras(baseProfile, o, scopePrefix, envelope.Edition)
	out, _, created := commitIngest(ctx, deps, job, envelope, sha, ChapterPlan{
		Chapters:      plan.Chapters,
		NavTree:       plan.NavTree,
		Draft:         plan.Draft,
		InlineContent: plan.InlineContent,
		Profile:       baseProfile,
		ProfilePatch:  plan.ProfilePatch,
		AppendixDocs:  plan.AppendixDocs,
		ScopePrefix:   scopePrefix,
		BestUsedFor:   ResolveBestUsedFor(draftContent.BestUsedFor, providedProfile, job.Owner, job.Repo),
		RawNodes:      nodes,
	})
	if out != ingestDone {
		return out
	}

	ensurePostCommitSemanticGraph(ctx, cfg, deps, job, sha, nodes, plan.Chapters, plan.ProfilePatch, scan.IsGiant)

	reporter.Report(ctx, "导入完成", 100, true)
	log.Printf("[ingest-body] job %s done: %s/%s@%s docs=%d (go path)", job.Id, job.Owner, job.Repo, sha[:min(7, len(sha))], created)

	archiveRoot := deps.ArchiveRoot
	if archiveRoot == "" {
		archiveRoot = cfg.ArchiveRoot
	}
	if archiveRoot == "" {
		archiveRoot = "storage/repos"
	}
	threshold := archive.ArchiveAutoCompactThresholdBytes()
	dir := archive.ArchiveDirFor(archiveRoot, job.Owner, job.Repo, sha)
	dirSize, _ := archive.ComputeArchiveDirSize(dir)
	if scan.IsGiant || dirSize >= threshold {
		owner := job.Owner
		repo := job.Repo
		jobSha := sha
		go func() {
			compactCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			log.Printf("[ingest-body] triggering background archive compaction for %s/%s@%s (size=%d, giant=%v)...", owner, repo, jobSha[:min(7, len(jobSha))], dirSize, scan.IsGiant)
			freed, err := archive.CompactArchive(compactCtx, archiveRoot, owner, repo, jobSha)
			if err != nil {
				log.Printf("[ingest-body] post-ingest compact warning for %s/%s@%s: %v", owner, repo, jobSha[:min(7, len(jobSha))], err)
			} else {
				log.Printf("[ingest-body] post-ingest compact completed for %s/%s@%s: compressed size %d bytes", owner, repo, jobSha[:min(7, len(jobSha))], freed)
			}
		}()
	}

	return ingestDone
}

func extractCuratedPathsFromPlan(chapters []ChapterInput, profilePatch map[string]any) []string {
	seen := make(map[string]bool)
	var out []string
	addPath := func(raw string) {
		p, _ := mdpat.SplitPathAnchor(strings.TrimSpace(raw))
		if p != "" && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	for _, ch := range chapters {
		for _, f := range ch.Files {
			addPath(f.Path)
		}
	}
	if profilePatch != nil {
		switch clusters := profilePatch["codeClusters"].(type) {
		case []ModuleSnapshot:
			for _, c := range clusters {
				for _, f := range c.Files {
					addPath(f)
				}
			}
		case []any:
			for _, item := range clusters {
				if m, ok := item.(map[string]any); ok {
					if files, ok := m["files"].([]any); ok {
						for _, f := range files {
							if s, ok := f.(string); ok {
								addPath(s)
							}
						}
					}
				}
			}
		}
	}
	return out
}

func ensurePostCommitSemanticGraph(
	ctx context.Context,
	cfg Config,
	deps IngestBodyDeps,
	job JobRow,
	sha string,
	nodes []GitNode,
	chapters []ChapterInput,
	profilePatch map[string]any,
	isGiant bool,
) {
	if deps.Languages == nil || sha == "" || strings.EqualFold(job.Owner, "web-docs") {
		return
	}
	archiveRoot := deps.ArchiveRoot
	if archiveRoot == "" {
		archiveRoot = cfg.ArchiveRoot
	}
	graphDir := deps.GraphDir
	if graphDir == "" {
		graphDir = cfg.SemanticGraphDir
	}

	var candidateNodes []GitNode
	if !isGiant {
		candidateNodes = nodes
	}
	curatedPaths := extractCuratedPathsFromPlan(chapters, profilePatch)

	rsgCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()

	var pat rsg.Patterns
	if deps.Patterns != nil {
		pat = deps.Patterns
	}
	if _, err := rsg.EnsureBoundedSemanticGraph(
		rsgCtx,
		archiveRoot,
		graphDir,
		job.Owner,
		job.Repo,
		sha,
		deps.Languages,
		pat,
		candidateNodes,
		curatedPaths,
		deps.GraphRepo,
		nil, // Outer RunIngestBody holds MemoryGate lease; nil avoids re-entrant deadlock.
	); err != nil {
		msg := err.Error()
		if !strings.Contains(msg, "no parseable source files") && !strings.Contains(msg, "no eligible source files") {
			log.Printf("[ingest-body] post-commit semantic graph build skipped/warn for %s/%s@%s: %v", job.Owner, job.Repo, sha[:min(7, len(sha))], err)
		}
	}
}

func resolveProfileTextRoot(profile SniffProfile) string {
	if profile.TextRoot != nil {
		return *profile.TextRoot
	}
	return ""
}

type starPrefetchHandle struct {
	done chan struct{}
}

func (h starPrefetchHandle) wait() {
	if h.done != nil {
		<-h.done
	}
}

func prefetchRepoStars(ctx context.Context, cfg Config, job JobRow, envelope *ImportJobEnvelope) starPrefetchHandle {
	h := starPrefetchHandle{done: make(chan struct{})}
	if envelope.Options.StarCount > 0 {
		close(h.done)
		return h
	}
	go func() {
		defer close(h.done)
		if stars, err := FetchRepoStars(ctx, cfg, job.Owner, job.Repo); err == nil && stars > 0 {
			envelope.Options.StarCount = stars
		}
	}()
	return h
}
