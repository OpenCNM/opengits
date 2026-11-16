package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/jobs"
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

// ConfirmedModule 用户确认/大纲派生的子系统模块(draftOutline.modules 消费)。
type ConfirmedModule struct {
	Name        string   `json:"name"`
	Summary     string   `json:"summary"`
	Directories []string `json:"directories"`
	Granularity string   `json:"granularity"`
}

// ImportSettleResult ingest 结果载荷别名（单一事实源自 internal/jobs）。
type ImportSettleResult = jobs.ImportSettleResult

// ─────────────────────────────────────────────────────────────
// ingest 编排体（M5-2 刀 3d 总装 → 2026-09-17 Node 管线收刀终局）：
// repo 摄取 Go 单一执行体（text_only / code_only / hybrid / giant /
// prefix 作用域 / customOutline / 教材 tier S-A 全域接管，Node 侧
// engine/ingest.ts 已物理删除）；web-doc / web-sync 抓取由 Go 原生
// Firecrawl 直连接管，失败即 Fail-Closed（100% Zero-Node Worker 终局）。
// ─────────────────────────────────────────────────────────────

// IngestBodyDeps 注入缝。
type IngestBodyDeps struct {
	Store   Store
	Archive *ArchiveClient
	Web     InternalJobAPI
	// SettleJob 结算执行体（D组端点5：pgx SettleImportJob 单实现注入；
	// nil=未配置（Fail-Closed 显式报错，绝不静默跳过结算）
	SettleJob            func(ctx context.Context, jobId string, result ImportSettleResult) error
	ArchiveRoot          string
	Patterns             *Patterns
	Languages            *LanguageDefinitions
	GraphDir             string
	LLM                  LLMGenerator
	Firecrawl            FirecrawlAPI
	Gate                 *jobs.MemoryGate
	Emit                 func(eventType string, payload map[string]any)
	TriggerTranscription func()
}

// emit 进度事件发射便捷调用（nil 安全）。
func (d IngestBodyDeps) emit(eventType string, payload map[string]any) {
	if d.Emit != nil {
		d.Emit(eventType, payload)
	}
}

// settle 结算注入缝便捷调用（nil=显式报错，Fail-Closed）。
func (d IngestBodyDeps) settle(ctx context.Context, jobId string, result ImportSettleResult) error {
	if d.SettleJob == nil {
		return fmt.Errorf("settle executor not configured")
	}
	return d.SettleJob(ctx, jobId, result)
}

// RunBody 满足 jobs.BodyExecutor 接口。
func (d IngestBodyDeps) RunBody(ctx context.Context, _ jobs.Config, job jobs.JobRow, emit func(string, map[string]any)) bool {
	deps := d
	if emit != nil {
		deps.Emit = emit
	}
	return runIngestBody(ctx, LoadConfigFromEnv(), deps, job) == Done
}

// WebClient 满足 jobs.BodyExecutor 接口。
func (d IngestBodyDeps) WebClient() jobs.InternalJobAPI {
	return d.Web
}

// InternalJobAPI job 层 web 端点（Zero-Node Worker 收官：execute 已移除）。
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

// EnvelopeOptions 导入信封 options 面（对齐 Node ingest/route.ts:190-216 的完整
// 发送面——此前 repoProfile/转录选项等字段被 json.Unmarshal 静默丢弃）。
type EnvelopeOptions struct {
	GitSha            string          `json:"gitSha"`
	Sha               string          `json:"sha"` // 容错兼容:部分调用方直接传入 sha
	IsPublic          bool            `json:"isPublic"`
	Category          string          `json:"category"`
	Tags              []string        `json:"tags"`
	Prefix            string          `json:"prefix"`
	PrefixFilter      string          `json:"prefixFilter"`
	CustomOutline     json.RawMessage `json:"customOutline"`
	DraftOutline      json.RawMessage `json:"draftOutline"`
	IngestPrefix      string          `json:"ingestPrefix"`
	TargetLanguage    string          `json:"targetLanguage"`
	ActiveModuleNames []string        `json:"activeModuleNames"`
	Url               string          `json:"url"`
	Name              string          `json:"name"`
	MaxPages          int             `json:"maxPages"`
	// 以下为 Node 侧向导始终发送、Go 此前未解码的信封字段
	RepoProfile         json.RawMessage `json:"repoProfile"`
	UseAi               bool            `json:"useAi"`
	CustomPrompt        string          `json:"customPrompt"`
	TranscriptionPreset string          `json:"transcriptionPreset"`
	EditionLabel        string          `json:"editionLabel"`
	AiGranularity       string          `json:"aiGranularity"`
	AiCondensation      string          `json:"aiCondensation"`
	TeachingDepth       string          `json:"teachingDepth"`
	VersionLabel        string          `json:"versionLabel"`
	CustomExtensions    []string        `json:"customExtensions"`
	StarCount           int             `json:"starCount"`
	Model               string          `json:"model"`
	TranscriptionModel  string          `json:"transcriptionModel"`
	// Web-doc 确认页作用域选择器信封（'' = 未探测自动裁决，走 Go 侧拓扑裁决兜底）
	ScopeMode        string             `json:"scopeMode"`
	PrimaryDocPrefix string             `json:"primaryDocPrefix"`
	AllowedPrefixes  []string           `json:"allowedPrefixes"`
	ModuleTabs       []webdoc.ModuleTab `json:"moduleTabs"`
}

// ImportJobEnvelope params Json 的 Go 形态（对齐 JobParamsEnvelope）。
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

// JobRow ImportJob 行最小读取面别名（单一事实源自 internal/jobs）。
type JobRow = jobs.JobRow

// newArchiveProgressHandler 构造归档拉取/解压进度监听回调（统一节流、终态放行与事件发射）。
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
		// 节流至 ~1 秒间隔（终态 100% 或 cached 强制放行，杜绝吞掉最终完成事件）
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

// RunIngestBody 执行 ingest 编排体（M5-2 刀 3d 总装）。
func RunIngestBody(ctx context.Context, cfg Config, deps IngestBodyDeps, job JobRow) Outcome {
	return runIngestBody(ctx, cfg, deps, job)
}
func runIngestBody(ctx context.Context, cfg Config, deps IngestBodyDeps, job JobRow) ingestOutcome {
	var envelope ImportJobEnvelope
	if err := json.Unmarshal(job.Params, &envelope); err != nil {
		deps.emit("error", map[string]any{"message": fmt.Sprintf("任务参数信封解析失败: %v", err)})
		return ingestFallback
	}

	// 回落面（保守高置信收窄）
	if envelope.Kind == "web-doc" {
		return runWebDocIngest(ctx, cfg, deps, job, envelope)
	}
	if envelope.Kind == "web-sync" {
		return runWebDocSync(ctx, cfg, deps, job, envelope)
	}
	o := envelope.Options
	// 作用域分流（Scope-First）：prefix 作用域按选定范围过滤后再判规模——
	// 巨型仓里选普通子目录走常规管线；作用域本身巨型则显式失败引导拆分
	scopePrefix := resolveScopePrefix(o.PrefixFilter, o.Prefix)
	userId := envelope.UserId
	if userId == "" {
		userId = derefStrPtr(job.UserId)
	}

	draftContent, draftOK := parseDraftOutline(o.DraftOutline)
	// 失效封闭：载荷存在但解析失败（JSON 损坏）必须显式失败——静默当
	// "无大纲"会让巨仓用户收到"仓库规模过大"的误导性错误，真实原因
	// （载荷损坏）无人知晓。空载荷（<=2 字节）视为未提供，正常降级。
	if len(o.DraftOutline) > 2 && !draftOK {
		deps.emit("error", map[string]any{"message": "草稿大纲载荷解析失败（JSON 无效），请重新生成大纲后重试"})
		return ingestFallback
	}

	// 大纲即作用域(统一树管线衔接):用户确认的 customOutline 是证据阶梯
	// 最高权威(4.0 格),巨型闸不得凌驾——树管线产物常为巨仓整仓导入,
	// 扫描流按大纲文件集保留节点,下游各格只见大纲宇宙。
	// (子课多跨子树,单 prefix 表达不了;大纲文件集天然是完备作用域)
	customCats, customOK := parseCustomOutline(o.CustomOutline)
	if len(o.CustomOutline) > 2 && !customOK {
		deps.emit("error", map[string]any{"message": "自定义大纲载荷解析失败（JSON 无效），请返回向导重新确认大纲"})
		return ingestFallback
	}
	var outlineKeep map[string]bool
	if len(customCats) > 0 {
		outlineKeep = make(map[string]bool, 64)
		for _, c := range customCats {
			for _, f := range c.Files {
				if f.Path != "" {
					outlineKeep[f.Path] = true
				}
			}
		}
	}

	reporter := newIngestProgressReporter(deps.Store, job.Id, 3*time.Second)

	// 1. sha 解析（无冻结 sha 时打 GitHub）
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

	// 1.1 若 options.starCount <= 0 且为 GitHub 仓库（非 web-doc），尝试从 GitHub 探测真实 starCount。
	// 星标数与归档/扫描无数据依赖——goroutine 预取与步骤 2/3 重叠，首次
	// 消费点（commitIngest 的仓库行 upsert）前 join；失败语义不变（保持 0）。
	// 写入目标为 envelope.Options（commitIngest 自行从中取值）；本函数局部
	// 副本 o 在预取区间内无 StarCount 读取（grep 锁定），无数据竞争。
	starPrefetch := prefetchRepoStars(ctx, cfg, job, &envelope)

	// 计算仓库信誉梯队（动态分配物理容量配额）
	starPrefetch.wait()
	rep := reputation.EvaluateRepoReputation(reputation.RepoMeta{
		Owner: job.Owner,
		Repo:  job.Repo,
		Stars: envelope.Options.StarCount,
	})

	// 2. 归档 ensure（复用 archive 容器，按信誉梯队配额放行）
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

	// 3. 流式归档探测（内存封顶，单趟扫描完成剪枝与规模判定；
	// outlineKeep 非空时巨仓截断不影响大纲文件——用户证据恒入节点集）
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
		// 大纲作用域收敛:下游各格(画像/阶梯/装配)只见大纲宇宙
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
		// 作用域级规模判定（对齐客户端 Scope-First 口径）：过滤后仍巨型 → 显式失败
		if scale := patterns.ComputeRepoScale(nodes); scale.Scale == "giant" {
			deps.emit("error", map[string]any{"message": "所选作用域规模过大（巨型），请改用树大纲模式拆分导入或选择更小的目录范围"})
			return ingestFallback
		}
		// 下游（语义图谱/模块快照/画像）统一消费过滤后的作用域树
		scan.Nodes = nodes
	}

	// 巨型无大纲=显式引导失败:巨仓必须经树大纲模式(大纲即作用域)或
	// 选定子目录作用域导入——物理扫描已流式截断,全量节点格不可行;
	// 旧子系统聚类格(巨型泳道)已随统一树管线退役。
	if scan.IsGiant && len(customCats) == 0 {
		deps.emit("error", map[string]any{"message": "仓库规模过大（巨型），请使用树大纲模式拆分为子课导入，或选择子目录范围"})
		return ingestFallback
	}
	var profile SniffProfile
	codeRepo := false
	// 信封画像（向导嗅探产物）权威消费：零额外 LLM，rule 侧 translationRoots
	// 并集合并、isTreeTruncated 恒以物理扫描为准（Node ingest.ts:171-186）
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
		// 作用域与翻译目录冲突消解：所选前缀即正文，剔除重叠的翻译过滤项（防作用域被滤空）
		if scopePrefix != "" {
			profile.TranslationRoots = resolveTranslationScopeConflict(profile.TranslationRoots, scopePrefix)
			if len(profile.TranslationRoots) == 0 {
				profile.HasTranslations = false
			}
		}
		codeRepo = profile.IngestMode == "code_only" || profile.IngestMode == "hybrid"
		if !codeRepo && profile.IngestMode != "text_only" {
			deps.emit("error", map[string]any{"message": fmt.Sprintf("不支持的导入模式 (ingestMode=%s)，请检查仓库画像配置", profile.IngestMode)})
			return ingestFallback
		}
	}
	reporter.Report(ctx, "[3/5] 代码仓画像与依赖嗅探完成...", 60, false)

	// Stage 2 重度加权准入：根据扫描出的真实节点数和仓类型计算加权配额，
	// 避免多个大仓并发进入 RSG 建图与全量 AST 解析冲爆内存。
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

	// 4. 证据阶梯：章节派生单一有序链，按证据权威降级，命中即停——
	// customOutline(用户确认/树管线产物) → draftOutline(LLM草稿) → chapterMap(tier S/A 教材)
	// → RSG 认知投影(code仓，建图惰性化) → 规则树兜底。
	// 规模/tier 只决定格子资格（tier S/A 激活 chapterMap 格；code 仓激活 RSG 格），
	// 不写按规模分叉的编排体。
	reporter.Report(ctx, "[4/5] 章节规划与认知投影构建...", 75, true)
	deps.emit("log", map[string]any{"message": "[4/5] 构建大纲导航树与章节落库 (Build NavTree & Create Docs)..."})

	// 文本路径建树前画像过滤（Node ingest.ts:275 filterNodesByProfile）：翻译目录、
	// 答案/元配置文件不入正典树；代码路径消费原始作用域树（Node 分派序：code 先行）
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
		deps.emit("error", map[string]any{"message": fmt.Sprintf("大纲章节规划阶梯执行失败: %v", err)})
		return ingestFallback
	}

	// 4.5 大纲节点标题认知摩热（File ≠ Cognitive Unit，零 LLM 确定性快路径）：
	// 文档仓 markdown 文件的裸文件名 shortTitle 提升为文件首个 ATX H1，章内
	// 碰撞以父目录消歧；物理读取失败保持原状（增强而非硬门，不阻塞主链路）。
	// code 口径虚拟章（chapters/NN.mdx，标题=章标题）天然零命中零开销。
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

	// 5. 单一持久化尾段（四元 upsert → 章节文档 → 导入快照 → 大纲 → 结算）
	// 画像：常规仓 SniffProfile 投影 + 信封转录选项（enableAiEnhance/edition 三件套/
	// 转录偏好——Node ingest.ts:209-252 持久化面）；巨型格自带专用画像
	reporter.Report(ctx, "[5/5] 章节落库与大纲持久化...", 90, true)
	deps.emit("log", map[string]any{"message": "[5/5] 单一持久化尾段落库 (Commit & Settle)..."})
	// 星标预取 join：仓库行 upsert（commitIngest 首步）消费 o.StarCount
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
	reporter.Report(ctx, "导入完成", 100, true)
	log.Printf("[ingest-body] job %s done: %s/%s@%s docs=%d (go path)", job.Id, job.Owner, job.Repo, sha[:min(7, len(sha))], created)

	// 6. 生命周期收尾：针对大仓库或超阈值仓库触发后台异步收卷（释放 Inode 与磁盘空间）
	// （web-doc/web-sync 已在 kind 分流提前返回，此处仅 GitHub 仓可达，无需 owner 守卫）
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

// DraftOutlineFile 大纲章节文件条目。

func resolveProfileTextRoot(profile SniffProfile) string {
	if profile.TextRoot != nil {
		return *profile.TextRoot
	}
	return ""
}

// starPrefetchHandle 星标探测预取句柄（与归档 ensure/扫描重叠执行）。
type starPrefetchHandle struct {
	done chan struct{}
}

// wait join 预取（channel 关闭幂等，可安全多次调用；nil 句柄立即返回）。
func (h starPrefetchHandle) wait() {
	if h.done != nil {
		<-h.done
	}
}

// prefetchRepoStars 条件满足时后台预取仓库星标数并写回 envelope.Options。
// 不满足条件（已有星标）返回已完成句柄，主链零阻塞。
// （web-doc/web-sync 已在 kind 分流提前返回，本函数仅 GitHub 仓可达，无需 owner 守卫。）
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
