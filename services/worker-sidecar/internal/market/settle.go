package market

import (
	"sync"

	"context"
	"log"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/treesitter"
)

// ─────────────────────────────────────────────────────────────
// 更新市场结算 Go 单实现（单写者收敛尾）。
//
// 「试读与表决」已退役：不再产生新 TRIAL 任务，本文件仅为存量 TRIAL 排水
// （由 orphan-sweeper 60s 互斥与 auto-update runner 周期直调）：
// - 批次排空（50/批 ≤10 批 + processedIds 去重，杜绝批次线头阻塞）；
// - 投票裁定纯函数：no×2 > total → 否决（反对理由拼接），否则换入
//   （TRIAL 超期默认换入 = L0 已过的无罪推定）；
// - swapIn：CAS（TRIAL + stagedContentId 指针一致）→ SWAPPED + 文档
//   晋升同事务——并发双触发只有首个换入，不再产生奖励；
// - postSwap（失败不阻断换入）：chunk 重建 + 概念/边同步 + 索引刷新 +
//   autoSwapCount 记账 + 每 N 次换入的零 LLM 管线分 re-audit（跌破底线
//   置 qualityHold，computePipelineScore 逐字移植）。
// 维护者兜底转录（BYOK 引擎）仍留 Node 窄化端点。
// ─────────────────────────────────────────────────────────────

const (
	BatchSize  = 50
	MaxBatches = 10
)

// Config holds configuration parameters needed for market settlement.
type Config struct {
	ContentDualWrite bool
	ChunkerMaxTokens int
	ChunkerOverlap   int
}

func AuditEveryNSwaps() int {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv("UPDATE_AUDIT_EVERY_N_SWAPS"))); err == nil && v > 0 {
		return v
	}
	return 10
}

func QualityFloor() int {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv("UPDATE_QUALITY_FLOOR"))); err == nil && v > 0 {
		return v
	}
	// AST 口径标定（决策 B）：旧正则尺对散文关键词计分虚高约 10 分，换
	// 诚实尺后同线=实质收紧一档；60 使 next.js 类源码研读仓（实测 61）
	// 放行，纯水文（30-50）依旧远不可及。真实锚点：mini-redis=77 过、
	// next.js=61 过、空洞教程 <50 拦。
	return 60
}

// TrialRow 过期 TRIAL 任务投影（含结算与 postSwap 所需列）。
type TrialRow struct {
	ID              string
	RepositoryID    string
	DocumentID      string
	Path            string
	ToSha           string
	ClaimedBy       *string
	StagedContentID string
	StagedModel     *string
}

// PipelineScoreDoc 管线评分输入文档。
type PipelineScoreDoc struct {
	Status  string
	Content string
}

// ActiveJobDoc 活跃任务关联文档视图。
type ActiveJobDoc struct {
	Title string `json:"title"`
}

// ActiveJobView 活跃更新任务展示视图（与 Node /api/update/jobs 对齐）。
type ActiveJobView struct {
	ID            string        `json:"id"`
	DocumentID    string        `json:"documentId"`
	Path          string        `json:"path"`
	Status        string        `json:"status"`
	Kind          string        `json:"kind"`
	FromSha       string        `json:"fromSha"`
	ToSha         string        `json:"toSha"`
	ClaimedBy     *string       `json:"claimedBy"`
	VoteDeadline  *time.Time    `json:"voteDeadline"`
	FrozenCredits int           `json:"frozenCredits"`
	Document      *ActiveJobDoc `json:"document,omitempty"`
}

// ClaimResult 任务认领结果。
type ClaimResult struct {
	FrozenCredits int `json:"frozenCredits"`
}

// RelaySettleInput 接力桩直换入参（正文由 sidecar 事务内按 StagedContentID
// 从内容寻址层读取——不再全文直传，与 TRIAL 排水同源）。
type RelaySettleInput struct {
	JobID           string
	UserID          string
	DocumentID      string
	RepositoryID    string
	StagedContentID string
	StagedModel     string
	ToSha           string
	DualWrite       bool
}



// RelayJobView 接力任务视图。
type RelayJobView struct {
	ID           string `json:"id"`
	RepositoryID string `json:"repositoryId"`
	Kind         string `json:"kind"`
	Status       string `json:"status"`
}

// RetranslateJobInput 重译留痕建单入参。
type RetranslateJobInput struct {
	RepositoryID    string
	DocumentID      string
	Path            string
	GitSha          string
	UserID          string
	StagedContentID string
	StagedModel     string
}

// CreateStaleJobsInput 调度器批量建单入参。
type CreateStaleJobsInput struct {
	RepositoryID string
	FromSha      string
	ToSha        string
	Paths        []string
}

// JobAuthInfo 任务或章节所属仓库鉴权元数据。
type JobAuthInfo struct {
	ID           string `json:"id"`
	RepositoryID string `json:"repositoryId"`
	Kind         string `json:"kind"`
	Status       string `json:"status"`
	IsPublic     bool   `json:"isPublic"`
}

// Store 结算段数据面接口契约（pgxStore 实现；单测 fake）。
type Store interface {
	Sweeper
	ListExpiredMarketTrials(ctx context.Context, now time.Time, excludeIDs []string, take int) ([]TrialRow, error)
	// SettleSwapTx CAS 换入事务：TRIAL+staged 指针一致 → SWAPPED
	// + 文档晋升（contentId/content[双写]/PROCESSED/gitSha/generationModel）
	// 不改动历史奖励。CAS 输家返回 (false, nil)。
	SettleSwapTx(ctx context.Context, job TrialRow, stagedContent string, dualWrite bool) (bool, error)
	// LoadStagedContent 暂存正文（文档晋升的双写载荷；miss 返回空串）。
	LoadStagedContent(ctx context.Context, contentID string) (string, error)
	RecordMarketSettledEvent(ctx context.Context, claimedBy *string, jobID string)
	IncrementAutoSwapCount(ctx context.Context, repositoryID string) (int, error)
	SetQualityHold(ctx context.Context, repositoryID string) error

	// postSwap 重建链（正文切片重建 + 概念/元数据提取落库）与 re-audit
	PostSwapDocument(ctx context.Context, repositoryID, documentID, content string) error
	LoadPipelineScoreInputs(ctx context.Context, repositoryID string) (chapterCount int, docs []PipelineScoreDoc, err error)

	// Phase 10 扩展：更新市场单写者状态机与业务收编
	ListActiveJobs(ctx context.Context, repoID string) ([]ActiveJobView, error)
	GetJobAuthInfo(ctx context.Context, id string) (*JobAuthInfo, error)
	ClaimJob(ctx context.Context, jobID, userID string, ttlMinutes int) (*ClaimResult, error)
	ReleaseClaim(ctx context.Context, jobID, userID string) error
	// ExtendClaim CAS 续期认领租约（仅本人持有且未过期可续；过期已回池不可复活）。
	ExtendClaim(ctx context.Context, jobID, userID string, ttlMinutes int) (bool, error)
	SettleRelayTx(ctx context.Context, input RelaySettleInput) error
	MarkJobFailed(ctx context.Context, jobID, userID, errMsg string) error
	EnsureRelayJob(ctx context.Context, documentID string) (*RelayJobView, error)
	CreateRetranslateJob(ctx context.Context, input RetranslateJobInput) error
	CreateStaleJobs(ctx context.Context, input CreateStaleJobsInput) (int, error)
}

// SettleExpiredMarketTrials resolveTimeouts 结算段主体（批次排空 + 换入）。
// 返回 (swapped, rejected)——仅操作真正成功才计数（监控口径不虚报，失败任务
// 留待下轮重试）。rejected 历史语义为投票否决计数，试读表决退役后恒为 0
// （保留返回形状以稳定监控面）。
func SettleExpiredMarketTrials(ctx context.Context, cfg Config, store Store, onIndexRefresh func(repoID string)) (swapped, rejected int) {
	now := time.Now().UTC() // D3-3：对齐 timestamp without time zone 的 UTC 字面量语义
	processed := map[string]bool{}
	for batch := 0; batch < MaxBatches; batch++ {
		var exclude []string
		for id := range processed {
			exclude = append(exclude, id)
		}
		trials, err := store.ListExpiredMarketTrials(ctx, now, exclude, BatchSize)
		if err != nil {
			log.Printf("[market-settle] list expired trials failed: %v", err)
			return
		}
		if len(trials) == 0 {
			return
		}
		for _, job := range trials {
			processed[job.ID] = true
			// 试读表决已退役（ChapterUpdateVote 表零写入、VoteVerdict 链摘除）：
			// 超期 TRIAL 无票 → 默认换入（无罪推定），排水归零后本循环自然空转
			if swapInJob(ctx, cfg, store, job, onIndexRefresh) {
				swapped++
			}
		}
		if len(trials) < BatchSize {
			return
		}
	}
	return
}

// swapInJob 单任务换入；CAS 输家静默 false，postSwap 失败不阻断换入。
// 失效封闭：暂存正文读取失败/为空时阻断换入（返回 false）——否则文档将以
// 悬垂 contentId + NULL content 晋升 PROCESSED，制造「完工空文档」
// （任务留 TRIAL 态，待 GC/清扫器终态化或下次重试，绝不半价换入）。
func swapInJob(ctx context.Context, cfg Config, store Store, job TrialRow, onIndexRefresh func(repoID string)) bool {
	if strings.TrimSpace(job.StagedContentID) == "" {
		return false
	}
	stagedContent, err := store.LoadStagedContent(ctx, job.StagedContentID)
	if err != nil {
		log.Printf("[market-settle] staged content load failed for %s: %v (swap blocked, fail-closed)", job.ID, err)
		return false
	}
	if strings.TrimSpace(stagedContent) == "" {
		log.Printf("[market-settle] staged content empty for %s (swap blocked, fail-closed)", job.ID)
		return false
	}

	store.RecordMarketSettledEvent(ctx, job.ClaimedBy, job.ID)
	ok, err := store.SettleSwapTx(ctx, job, stagedContent, cfg.ContentDualWrite)
	if err != nil {
		log.Printf("[market-settle] swap tx failed for %s: %v", job.ID, err)
		return false
	}
	if !ok {
		return false // CAS 输家：已被并发结算
	}
	postSwapJob(ctx, cfg, store, job, stagedContent, onIndexRefresh)
	return true
}

// postSwapJob 换入后重建（对齐 postSwap，失败不阻断）：chunk 重建 +
// 概念/边同步 + 索引刷新 + autoSwapCount 记账 + 周期性 re-audit 置 qualityHold。
func postSwapJob(ctx context.Context, _ Config, store Store, job TrialRow, content string, onIndexRefresh func(repoID string)) {
	if strings.TrimSpace(content) != "" {
		if err := store.PostSwapDocument(ctx, job.RepositoryID, job.DocumentID, content); err != nil {
			log.Printf("[market-settle] post-swap document rebuild degraded for %s: %v", job.DocumentID, err)
		}
	}
	if onIndexRefresh != nil {
		onIndexRefresh(job.RepositoryID)
	}

	count, err := store.IncrementAutoSwapCount(ctx, job.RepositoryID)
	if err != nil {
		log.Printf("[market-settle] autoSwapCount increment degraded for %s: %v", job.RepositoryID, err)
		return
	}
	if count%AuditEveryNSwaps() != 0 {
		return
	}
	// 绝对底线 re-audit：AST 真特性管线分（正则版对正文散文里的
	// "retry/timeout" 一类词一律计分，分数虚高使 qualityHold 形同虚设），
	// 跌破置 qualityHold（失败跳过本轮）
	chapterCount, docs, err := store.LoadPipelineScoreInputs(ctx, job.RepositoryID)
	if err != nil {
		log.Printf("[market-settle] re-audit inputs failed for %s: %v", job.RepositoryID, err)
		return
	}
	if total := PipelineScoreTotalAST(ctx, chapterCount, docs); total < QualityFloor() {
		if err := store.SetQualityHold(ctx, job.RepositoryID); err == nil {
			log.Printf("[market-settle] quality hold: pipeline %d < floor %d for %s", total, QualityFloor(), job.RepositoryID)
		}
	}
}

// ── 零 LLM 管线分（computePipelineScore 逐字移植，细节文案为 UI 专属不移植）──

// LINT-EXEMPT: code-syntax-regex-scoring（特性计数计分信号，逐字对齐 Node
// review/pipeline-score.ts——非符号提取，不建 AST 边）
var (
	productionPattern = regexp.MustCompile(`(?i)try\s*\{|catch\s*\(|onError|fallback|retry|timeout|abortController`)
	modernPattern     = regexp.MustCompile(`(?i)import\s+|export\s+|async\s+function|const\s+\w+\s*=\s*async|await\s+`)
)

// clampScore 同 Node clampScore：0..100 四舍五入。
func clampScore(v float64) int {
	return int(math.Max(0, math.Min(100, math.Round(v))))
}

// PipelineScoreTotal 加权总分（五维权重 coverage .25 / practicality .25 /
// pedagogy .20 / production .15 / modernity .15，逐字对齐 review/pipeline-score.ts）。
func PipelineScoreTotal(chapterCount int, docs []PipelineScoreDoc) int {
	total := len(docs)
	processed, errored := 0, 0
	totalLines, codeLines, codeBlockCount := 0, 0, 0
	errorHandlingCount, modernPatternCount := 0, 0
	for _, d := range docs {
		if d.Status == "PROCESSED" {
			processed++
		}
		if d.Status == "ERROR" {
			errored++
		}
		text := d.Content
		if strings.TrimSpace(text) == "" {
			continue
		}
		lines := strings.Split(text, "\n")
		totalLines += len(lines)
		inCode := false
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "```") {
				inCode = !inCode
				if inCode {
					codeBlockCount++
				}
			} else if inCode {
				codeLines++
			}
		}
		if productionPattern.MatchString(text) {
			errorHandlingCount++
		}
		if modernPattern.MatchString(text) {
			modernPatternCount++
		}
	}

	coverage := 0.0
	if total > 0 {
		coverage = float64(processed)/float64(total)*100 - float64(errored)/float64(total)*40
	}
	codeRatio := 0.0
	if totalLines > 0 {
		codeRatio = float64(codeLines) / float64(totalLines)
	}
	practicality := 0.0
	switch {
	case codeRatio >= 0.20:
		practicality = 90 + math.Min(10, float64(codeBlockCount)*0.5)
	case codeRatio >= 0.10:
		practicality = 75 + codeRatio*100
	case codeRatio > 0:
		practicality = 50 + codeRatio*250
	default:
		practicality = math.Min(45, float64(codeBlockCount)*5)
	}
	pedagogy := 0.0
	if chapterCount > 0 {
		switch {
		case chapterCount >= 8:
			pedagogy = 95
		case chapterCount >= 4:
			pedagogy = 80 + float64(chapterCount-4)*3.75
		default:
			pedagogy = 65 + float64(chapterCount)*3.75
		}
	} else {
		pedagogy = math.Min(60, float64(total)*8)
	}
	modernity := 0.0
	if total > 0 {
		modernity = float64(modernPatternCount) / float64(total) * 100
	}
	production := 0.0
	if total > 0 {
		production = float64(errorHandlingCount) / float64(total) * 100
	}

	final := float64(clampScore(coverage))*0.25 +
		float64(clampScore(practicality))*0.25 +
		float64(clampScore(pedagogy))*0.20 +
		float64(clampScore(modernity))*0.15 +
		float64(clampScore(production))*0.15
	return clampScore(final)
}

// astScoreEngine 懒加载 tree-sitter 引擎（进程级单例；初始化失败
// 返回 nil——下游按零特性计分，失效封闭收紧闸门而非放水，引擎恢复后自愈）。
// daemon 启动时经 SetTsEngine 注入共享引擎（与其他 Tree-sitter 消费方
// 共用同一 worker 池）；未注入时回退本地懒加载小池。
var (
	astScoreEngineOnce sync.Once
	astScoreEngine     *treesitter.Engine
)

// SetTsEngine 注入进程级共享 tree-sitter 引擎（daemon 装配期调用一次）。
func SetTsEngine(engine *treesitter.Engine) {
	if engine == nil {
		return
	}
	astScoreEngine = engine
}

func getAstScoreEngine() *treesitter.Engine {
	if astScoreEngine != nil {
		return astScoreEngine
	}
	astScoreEngineOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if eng, err := treesitter.NewEngineWithPoolSize(ctx, 2); err == nil {
			astScoreEngine = eng
		} else {
			log.Printf("[market-settle] WARN ast score engine init failed (%v) — re-audit counts zero code features (fail-closed)", err)
		}
	})
	return astScoreEngine
}

// PipelineScoreTotalAST AST 口径管线分：五维与 PipelineScoreTotal 相同，
// 但 production/modernity 两维改用 AssessCodeBlockAstQuality 的真语法节点
// 计数（注释/散文里的 "retry"、"import" 不再计分）。引擎缺失时两维按 0
// 计——宁严勿滥（qualityHold 多触发可自愈，虚高放行不可逆）。
// PipelineScoreDims 五维分（0-100）：供 repo-audit 维度透出（Node 初审
// 雷达图消费），total 仍由 PipelineScoreTotalAST 统一加权。
type PipelineScoreDims struct {
	Coverage     int `json:"coverage"`
	Practicality int `json:"practicality"`
	Pedagogy     int `json:"pedagogy"`
	Modernity    int `json:"modernity"`
	Production   int `json:"production"`
}

func PipelineScoreTotalAST(ctx context.Context, chapterCount int, docs []PipelineScoreDoc) int {
	total, _ := PipelineScoreTotalASTWithDims(ctx, chapterCount, docs)
	return total
}

func PipelineScoreTotalASTWithDims(ctx context.Context, chapterCount int, docs []PipelineScoreDoc) (int, PipelineScoreDims) {
	engine := getAstScoreEngine()
	modernDocs, productionDocs := 0, 0
	if engine != nil {
		// 有界并行（4 工作协程 × 引擎池 2 WASM 实例流水线化）：逐文档串行
		// 审计在 54 章仓实测超 120s（每章逐代码块 DebugAST）；结果按索引
		// 收集后顺序聚合，输出与串行版逐位一致（确定性不变）
		const workers = 4
		modern := make([]bool, len(docs))
		production := make([]bool, len(docs))
		sem := make(chan struct{}, workers)
		var wg sync.WaitGroup
		for i := range docs {
			if strings.TrimSpace(docs[i].Content) == "" {
				continue
			}
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				// 独立 goroutine 的 panic 不被 net/http 兜住——recover 记
				// 零信号降级（该文档不计特性），绝不让评分杀掉整个 daemon
				defer func() {
					if r := recover(); r != nil {
						log.Printf("[market-audit] WARN ast quality panic on doc#%d: %v", i, r)
					}
				}()
				sem <- struct{}{}
				defer func() { <-sem }()
				report := AssessCodeBlockAstQuality(ctx, engine, docs[i].Content)
				modern[i] = report.ModernNodes > 0
				production[i] = report.ProductionNodes > 0
			}(i)
		}
		wg.Wait()
		for i := range docs {
			if modern[i] {
				modernDocs++
			}
			if production[i] {
				productionDocs++
			}
		}
	}
	// 覆盖率/实操性/教学法三维与正则版逐字一致（与文本统计无关 AST）
	total := len(docs)
	processed, errored := 0, 0
	totalLines, codeLines, codeBlockCount := 0, 0, 0
	for _, d := range docs {
		if d.Status == "PROCESSED" {
			processed++
		}
		if d.Status == "ERROR" {
			errored++
		}
		if strings.TrimSpace(d.Content) == "" {
			continue
		}
		lines := strings.Split(d.Content, "\n")
		totalLines += len(lines)
		inCode := false
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "```") {
				inCode = !inCode
				if inCode {
					codeBlockCount++
				}
			} else if inCode {
				codeLines++
			}
		}
	}
	coverage := 0.0
	if total > 0 {
		coverage = float64(processed)/float64(total)*100 - float64(errored)/float64(total)*40
	}
	codeRatio := 0.0
	if totalLines > 0 {
		codeRatio = float64(codeLines) / float64(totalLines)
	}
	practicality := 0.0
	switch {
	case codeRatio >= 0.20:
		practicality = 90 + math.Min(10, float64(codeBlockCount)*0.5)
	case codeRatio >= 0.10:
		practicality = 75 + codeRatio*100
	case codeRatio > 0:
		practicality = 50 + codeRatio*250
	default:
		practicality = math.Min(45, float64(codeBlockCount)*5)
	}
	pedagogy := 0.0
	if chapterCount > 0 {
		switch {
		case chapterCount >= 8:
			pedagogy = 95
		case chapterCount >= 4:
			pedagogy = 80 + float64(chapterCount-4)*3.75
		default:
			pedagogy = 65 + float64(chapterCount)*3.75
		}
	} else {
		pedagogy = math.Min(60, float64(total)*8)
	}
	modernity := 0.0
	if total > 0 {
		modernity = float64(modernDocs) / float64(total) * 100
	}
	production := 0.0
	if total > 0 {
		production = float64(productionDocs) / float64(total) * 100
	}

	dims := PipelineScoreDims{
		Coverage:     clampScore(coverage),
		Practicality: clampScore(practicality),
		Pedagogy:     clampScore(pedagogy),
		Modernity:    clampScore(modernity),
		Production:   clampScore(production),
	}
	final := float64(dims.Coverage)*0.25 +
		float64(dims.Practicality)*0.25 +
		float64(dims.Pedagogy)*0.20 +
		float64(dims.Modernity)*0.15 +
		float64(dims.Production)*0.15
	return clampScore(final), dims
}

// CodeBlockAstReport contains AST health and quality metrics for code blocks in MDX content.
type CodeBlockAstReport struct {
	TotalBlocks     int `json:"totalBlocks"`
	ValidAstBlocks  int `json:"validAstBlocks"`
	AstErrors       int `json:"astErrors"`
	ProductionNodes int `json:"productionNodes"` // genuine AST try/catch/error handling
	ModernNodes     int `json:"modernNodes"`     // genuine AST imports/exports/async
}

// normalizeCodeBlockLang normalizes fenced code block language tags and aliases to canonical Tree-sitter grammar names.
func normalizeCodeBlockLang(l string) string {
	l = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(l)), ".")
	switch l {
	case "ts", "typescript", "mts", "cts", "tsx":
		return "tsx"
	case "js", "javascript", "mjs", "cjs", "jsx":
		return "javascript"
	case "go", "golang":
		return "go"
	case "py", "python", "py3", "python3":
		return "python"
	case "rs", "rust":
		return "rust"
	case "java":
		return "java"
	case "c":
		return "c"
	case "cpp", "c++", "cc", "cxx", "hpp", "h++":
		return "cpp"
	case "cs", "csharp", "c#":
		return "csharp"
	case "rb", "ruby":
		return "ruby"
	case "kt", "kotlin":
		return "kotlin"
	case "swift":
		return "swift"
	case "dart":
		return "dart"
	case "scala":
		return "scala"
	case "sh", "bash", "shell", "zsh":
		return "bash"
	case "ps1", "powershell", "pwsh":
		return "powershell"
	case "lua":
		return "lua"
	case "php":
		return "php"
	case "zig":
		return "zig"
	case "elixir", "ex", "exs":
		return "elixir"
	case "clj", "clojure":
		return "clojure"
	case "hs", "haskell":
		return "haskell"
	case "ml", "ocaml":
		return "ocaml"
	case "sol", "solidity":
		return "solidity"
	case "sql":
		return "sql"
	default:
		if detected := treesitter.DetectLanguage("file." + l); detected != "" {
			return detected
		}
		return l
	}
}

// containsProductionAstNodes detects genuine error handling, active defense, and fault tolerance AST structures
// across all supported language paradigms (OOP try/catch, Go nil-checks/defer, Rust try/Result, Swift guard,
// Zig/Solidity/Shell, Python context managers, C# using, functional error patterns).
func containsProductionAstNodes(astStr string, code string) bool {
	// 1. Classical OOP Try/Catch/Except/Rescue/Finally/Guard & Modern Error Handling
	if strings.Contains(astStr, "try_statement") ||
		strings.Contains(astStr, "catch_clause") ||
		strings.Contains(astStr, "except_clause") ||
		strings.Contains(astStr, "finally_clause") ||
		strings.Contains(astStr, "rescue") ||
		strings.Contains(astStr, "rescue_block") ||
		strings.Contains(astStr, "catch_block") ||
		strings.Contains(astStr, "catch_expression") ||
		strings.Contains(astStr, "guard_statement") ||
		strings.Contains(astStr, "do_statement") ||
		strings.Contains(astStr, "on_part") || // Dart: on Exception catch
		strings.Contains(astStr, "else_block") || // Elixir: with {:ok, _} <- ... else
		strings.Contains(astStr, "after_block") {
		return true
	}

	// 2. Active Defense & Throw/Raise/Panic/Revert/Assert
	if strings.Contains(astStr, "raise_statement") ||
		strings.Contains(astStr, "throw_statement") ||
		strings.Contains(astStr, "throw_expression") ||
		strings.Contains(astStr, "rethrow_expression") ||
		strings.Contains(astStr, "assert_statement") ||
		strings.Contains(astStr, "assert_expression") ||
		strings.Contains(astStr, "revert_statement") ||
		strings.Contains(astStr, "try_expression") || // Rust ?, Swift/Zig try
		strings.Contains(astStr, "error_union_type") {
		return true
	}

	// 3. Safe Resource Management & RAII (defer, with, using, try-with-resources)
	if strings.Contains(astStr, "defer_statement") || // Go, Swift, Zig
		strings.Contains(astStr, "errdefer_statement") || // Zig
		strings.Contains(astStr, "with_statement") || // Python context managers
		strings.Contains(astStr, "using_statement") || // C#
		strings.Contains(astStr, "using_declaration") || // C# modern
		strings.Contains(astStr, "try_with_resources_statement") { // Java
		return true
	}

	// 4. Go / C / C++ / Nil & Pointer Error Checking in AST:
	// Detects if_statement conditions checking nil/null/nullptr
	if strings.Contains(astStr, "(nil)") ||
		strings.Contains(astStr, "(null)") ||
		strings.Contains(astStr, "nullptr") {
		if strings.Contains(astStr, "if_statement") ||
			strings.Contains(astStr, "binary_expression") ||
			strings.Contains(astStr, "unary_expression") {
			return true
		}
	}

	// 5. Invocations of panic/recover/require/assert/expect/pcall/trap in AST calls, macros, and commands
	if strings.Contains(astStr, "call_expression") ||
		strings.Contains(astStr, "call function:") ||
		strings.Contains(astStr, "call target:") ||
		strings.Contains(astStr, "macro_invocation") ||
		strings.Contains(astStr, "command") {
		if strings.Contains(code, "panic") ||
			strings.Contains(code, "recover") ||
			strings.Contains(code, "require") ||
			strings.Contains(code, "assert") ||
			strings.Contains(code, "checkNotNull") ||
			strings.Contains(code, "check(") ||
			strings.Contains(code, "pcall") ||
			strings.Contains(code, "xpcall") ||
			strings.Contains(code, "unwrap_or") ||
			strings.Contains(code, "expect(") ||
			strings.Contains(code, "map_err") ||
			strings.Contains(code, "ok_or") ||
			strings.Contains(code, "trap") ||
			strings.Contains(code, "set -e") ||
			strings.Contains(code, "set -euo") ||
			strings.Contains(code, "exit 1") ||
			strings.Contains(code, "exit $?") ||
			strings.Contains(code, "die(") ||
			strings.Contains(code, "stop(") {
			return true
		}
	}

	// 6. Algebraic Pattern Matching Error Handlers (Rust, Elixir, Scala, OCaml, Gleam)
	if (strings.Contains(astStr, "match_arm") || strings.Contains(astStr, "case_clause") || strings.Contains(astStr, "stab_clause")) &&
		(strings.Contains(code, "Err") || strings.Contains(code, "None") || strings.Contains(code, ":error") || strings.Contains(code, "Failure")) {
		return true
	}

	// 7. Lisp / S-Expression Exception Handling (Clojure)
	if strings.Contains(astStr, "list_lit") && (strings.Contains(code, "catch") || strings.Contains(code, "throw")) {
		return true
	}

	return false
}

// containsModernAstNodes detects modern language features (modules, async/await, goroutines, arrows, generics).
func containsModernAstNodes(astStr string) bool {
	return strings.Contains(astStr, "import_") ||
		strings.Contains(astStr, "import_spec") ||
		strings.Contains(astStr, "use_declaration") ||
		strings.Contains(astStr, "package_clause") ||
		strings.Contains(astStr, "export_statement") ||
		strings.Contains(astStr, "export_clause") ||
		strings.Contains(astStr, "namespace_use_declaration") ||
		strings.Contains(astStr, "await_expression") ||
		strings.Contains(astStr, "arrow_function") ||
		strings.Contains(astStr, "go_statement") ||
		strings.Contains(astStr, "channel_type") ||
		strings.Contains(astStr, "match_expression") ||
		strings.Contains(astStr, "lambda") ||
		strings.Contains(astStr, "closure_expression") ||
		strings.Contains(astStr, "type_parameter_list") ||
		strings.Contains(astStr, "actor_declaration") ||
		strings.Contains(astStr, "data_class") ||
		strings.Contains(astStr, "record_declaration") ||
		strings.Contains(astStr, "async_function_definition")
}

// AssessCodeBlockAstQuality inspects fenced code blocks in MDX documents using Tree-sitter,
// verifying AST validity and counting genuine language features (free from comment/string false positives).
func AssessCodeBlockAstQuality(ctx context.Context, engine *treesitter.Engine, mdxContent string) CodeBlockAstReport {
	report := CodeBlockAstReport{}
	if engine == nil || strings.TrimSpace(mdxContent) == "" {
		return report
	}

	lines := strings.Split(mdxContent, "\n")
	inCode := false
	var curLang string
	var codeLines []string

	checkBlock := func() {
		if len(codeLines) == 0 {
			return
		}
		report.TotalBlocks++
		code := strings.Join(codeLines, "\n")

		canonicalLang := normalizeCodeBlockLang(curLang)
		parseCode := code
		if canonicalLang == "php" && !strings.Contains(code, "<?php") {
			parseCode = "<?php\n" + code
		}

		astStr, err := engine.DebugAST(canonicalLang, []byte(parseCode))
		if err != nil {
			report.AstErrors++
			return
		}

		report.ValidAstBlocks++
		// Check genuine AST nodes for production error handling
		if containsProductionAstNodes(astStr, code) {
			report.ProductionNodes++
		}
		// Check genuine AST nodes for modern features
		if containsModernAstNodes(astStr) {
			report.ModernNodes++
		}
	}

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			if !inCode {
				inCode = true
				curLang = strings.TrimPrefix(trimmed, "```")
				// 裸围栏（无语言标注）Fields 得空切片：[0] 直接越界 panic
				//（真实流量在 next.js 文档上击杀过整个 sidecar）
				if fl := strings.Fields(curLang); len(fl) > 0 {
					curLang = strings.ToLower(fl[0])
				} else {
					curLang = ""
				}
				codeLines = nil
			} else {
				inCode = false
				checkBlock()
				codeLines = nil
			}
		} else if inCode {
			codeLines = append(codeLines, line)
		}
	}

	return report
}
