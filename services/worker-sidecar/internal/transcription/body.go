package transcription

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/chapter"
	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/doc"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/platform/client"
)

// ─────────────────────────────────────────────────────────────
// 转录执行体 Go 编排（M2c，能力倒置首个闭环）。
//
// 编排对齐 doc-pipeline.generateDocContent 的「已有内容」三类输入：
// - JIT 已有内容（非 forceEnhance）：只按需翻译 → finalize
// - 按需增强（forceEnhance / enableAiEnhance + content）：切块 → 网关 LLM
//   （一体化 → 降级纯翻译 → 原文回退）→ manifest 剥离 → MDX 校验/修复 → finalize
// - 虚拟代码章节（chapters/NN.mdx）：100% Go 原生闭环（ResolveModuleSnapshotFromProfile + 第一性原理装甲）。
// DB 语义 Go 直写：PROCESSING CAS 锁 + 心跳、流式进度、checkpoint 存取、终态、通知。
// Node 锁死能力经 web 内部端点：prepare（指纹/模型/分类）/ mdx-validate /
// transform / finalize；LLM 走网关 purpose（doc_transcribe_enhance_localize /
// doc_translate / doc_enhance / mdx_repair / code_chapter_lesson）。
// ─────────────────────────────────────────────────────────────

type PrepareResult = doc.PrepareResult
type ModuleCognition = cognitive.ModuleCognition
type ModuleGoldenSymbol = cognitive.ModuleGoldenSymbol

func BuildCognitiveScaffoldSection(cog ModuleCognition, teachingOrder int) string {
	return cognitive.BuildCognitiveScaffoldSection(cog, teachingOrder)
}

var presetTeachingDepth = doc.PresetTeachingDepth

// BodyDeps 注入缝（单测 fake；bodyFallback 的 web 端点回落由 runner 层承担）。
type BodyDeps struct {
	Web           InternalWebAPI
	Llm           LlmGatewayAPI
	Store         BodyStore
	FinalizeStore FinalizeStore // M3 分片（nil=回落全链 finalize 端点）
	// PrepareFunc prepare 执行体（D组端点3：进程内 runPrepare 单实现；
	// nil=未配置（Fail-Closed 日志显式留痕，回落 runner 层处置）
	PrepareFunc func(ctx context.Context, docId string, userId string, opts doc.PrepareOptions) (*PrepareResult, error)
	// OnIndexRefresh 转录成功收尾后的 OGIS 索引去抖重建钩子（M5；
	// nil=未启用 Go 打包。对齐 Node finalize.ts 的 scheduleRepoBinaryIndexRefresh）
	OnIndexRefresh func(repoId string)
	// GoTransform Go 原生 transform 执行体（M5 第一期；nil=未启用，
	// fetchDocContent 回落 web 微端点）
	GoTransform func(ctx context.Context, owner, repo, branch string, gitSha *string, path string) (string, error)
}

type TranscriptionBodyDeps = BodyDeps

// InternalWebAPI / LlmGatewayAPI 最小接口面（单测 fake）。
type InternalWebAPI interface {
	ValidateMdx(ctx context.Context, source string) (bool, string, error)
	ExtractManifest(ctx context.Context, content, path string) (string, error)
}

type LlmGatewayAPI interface {
	Complete(ctx context.Context, purpose string, variables map[string]any, userId *string) (LlmTextResult, error)
}

type BodyStore interface {
	CasProcessing(ctx context.Context, documentId string, allowProcessed bool) (bool, error)
	HeartbeatDocument(ctx context.Context, documentId string) error
	ClearProcessingStatus(ctx context.Context, documentId, status, message string) error
	CheckpointLoad(ctx context.Context, documentId, fingerprint string) (map[int]string, error)
	CheckpointSave(ctx context.Context, documentId, requestedBy, fingerprint string, index, total int, content string) error
	// ClearCheckpoint finalize 成功后清空存档块（≈全文副本的 LLM 中间产物不留 DB，
	// 对齐 Node transcription-queue.ts 新 job 重置语义）
	ClearCheckpoint(ctx context.Context, documentId string) error
	NotifyDone(ctx context.Context, documentId, userId string) error
	UpdateProgress(ctx context.Context, documentId string, step string, progress int) error
	GetUpstreamChapterPrecedents(ctx context.Context, repositoryId string, upstreamModules []string, maxTeachingOrder int) ([]UpstreamPrecedentItem, error)
}

// BodyOutcome 与 Node processClaimedTranscriptionJob 三态对齐。
type BodyOutcome int

const (
	BodyDone BodyOutcome = iota
	BodyDeferred
	BodyFailed // 失败已处置（Document ERROR 或瞬时故障），任务按 attempts 语义衰减
)

const (
	bodyDone     = BodyDone
	bodyDeferred = BodyDeferred
	bodyFailed   = BodyFailed
)

type bodyOutcome = BodyOutcome

type progressReporter struct {
	store       BodyStore
	docID       string
	interval    time.Duration
	mu          sync.Mutex
	lastUpdate  time.Time
	maxProgress int
	totalChunks int
	chunkProg   map[int]float64
}

func newProgressReporter(store BodyStore, docID string, interval time.Duration) *progressReporter {
	return &progressReporter{
		store:     store,
		docID:     docID,
		interval:  interval,
		chunkProg: make(map[int]float64),
	}
}

func (r *progressReporter) InitChunks(total int, savedIndices []int) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.totalChunks = total
	for _, idx := range savedIndices {
		r.chunkProg[idx] = 1.0
	}
}

func (r *progressReporter) MarkChunkDone(ctx context.Context, chunkIdx int) {
	if r == nil || r.store == nil || r.docID == "" {
		return
	}
	r.mu.Lock()
	r.chunkProg[chunkIdx] = 1.0
	prog := r.calcMultiChunkProgress(20, 85)
	if prog > r.maxProgress {
		r.maxProgress = prog
	} else {
		prog = r.maxProgress
	}
	r.lastUpdate = time.Now()
	completed := r.countCompletedChunks()
	total := r.totalChunks
	r.mu.Unlock()

	step := fmt.Sprintf("分块转录 (已完成 %d/%d 块)...", completed, total)
	_ = r.store.UpdateProgress(ctx, r.docID, step, prog)
}

func (r *progressReporter) countCompletedChunks() int {
	completed := 0
	for _, f := range r.chunkProg {
		if f >= 0.999 {
			completed++
		}
	}
	return completed
}

func (r *progressReporter) calcMultiChunkProgress(baseProgress, maxProgress int) int {
	if r.totalChunks <= 0 {
		return baseProgress
	}
	var sum float64
	for _, f := range r.chunkProg {
		sum += f
	}
	frac := sum / float64(r.totalChunks)
	if frac > 1.0 {
		frac = 1.0
	}
	return baseProgress + int(float64(maxProgress-baseProgress)*frac)
}

func (r *progressReporter) Report(ctx context.Context, step string, progress int, force bool) {
	if r == nil || r.store == nil || r.docID == "" {
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

	_ = r.store.UpdateProgress(ctx, r.docID, step, progress)
}

func (r *progressReporter) WrapContext(ctx context.Context, baseProgress int, maxProgress int, stepPrefix string) context.Context {
	if r == nil || r.store == nil || r.docID == "" {
		return ctx
	}
	return client.WithStreamProgress(ctx, func(p client.LlmStreamProgress) {
		r.mu.Lock()
		now := time.Now()
		if now.Sub(r.lastUpdate) < r.interval {
			r.mu.Unlock()
			return
		}
		r.lastUpdate = now

		step := ""
		chars := p.ContentChars
		prog := baseProgress
		span := maxProgress - baseProgress
		if span <= 0 {
			span = 1
		}

		if p.Stage == "thinking" {
			chars = p.ReasoningChars
			step = fmt.Sprintf("%s: 正在深度思考 (%d 字符)...", stepPrefix, p.ReasoningChars)
			thinkSpan := span / 4
			ratio := float64(p.ReasoningChars) / (float64(p.ReasoningChars) + 1500.0)
			prog = baseProgress + int(float64(thinkSpan)*ratio)
		} else {
			step = fmt.Sprintf("%s: 正在生成课时正文 (%d 字符)...", stepPrefix, p.ContentChars)
			genBase := baseProgress + span/4
			genSpan := (maxProgress - 1) - genBase
			if genSpan <= 0 {
				genSpan = 1
			}
			ratio := float64(p.ContentChars) / (float64(p.ContentChars) + 3000.0)
			prog = genBase + int(float64(genSpan)*ratio)
		}

		if prog < r.maxProgress {
			prog = r.maxProgress
		} else {
			r.maxProgress = prog
		}
		r.mu.Unlock()

		log.Printf("[transcription-progress] doc=%s stage=%s chars=%d elapsed_s=%.1f prog=%d%%",
			r.docID, p.Stage, chars, float64(p.ElapsedMs)/1000.0, prog)
		_ = r.store.UpdateProgress(ctx, r.docID, step, prog)
	})
}

func (r *progressReporter) WrapChunkContext(ctx context.Context, chunkIdx, totalChunks int) context.Context {
	if r == nil || r.store == nil || r.docID == "" {
		return ctx
	}
	return client.WithStreamProgress(ctx, func(p client.LlmStreamProgress) {
		r.mu.Lock()
		now := time.Now()
		if now.Sub(r.lastUpdate) < r.interval {
			r.mu.Unlock()
			return
		}
		r.lastUpdate = now

		var chunkFrac float64
		step := ""
		chars := p.ContentChars
		if p.Stage == "thinking" {
			chars = p.ReasoningChars
			ratio := float64(p.ReasoningChars) / (float64(p.ReasoningChars) + 1500.0)
			chunkFrac = 0.05 + 0.20*ratio
			step = fmt.Sprintf("分块转录 (第 %d/%d 块): 正在深度思考 (%d 字符)...", chunkIdx+1, totalChunks, p.ReasoningChars)
		} else {
			ratio := float64(p.ContentChars) / (float64(p.ContentChars) + 3000.0)
			chunkFrac = 0.25 + 0.70*ratio
			step = fmt.Sprintf("分块转录 (第 %d/%d 块): 正在生成正文 (%d 字符)...", chunkIdx+1, totalChunks, p.ContentChars)
		}

		r.chunkProg[chunkIdx] = chunkFrac
		prog := r.calcMultiChunkProgress(20, 85)
		if prog < r.maxProgress {
			prog = r.maxProgress
		} else {
			r.maxProgress = prog
		}
		r.mu.Unlock()

		log.Printf("[transcription-progress] doc=%s chunk=%d/%d stage=%s chars=%d elapsed_s=%.1f prog=%d%%",
			r.docID, chunkIdx+1, totalChunks, p.Stage, chars, float64(p.ElapsedMs)/1000.0, prog)
		_ = r.store.UpdateProgress(ctx, r.docID, step, prog)
	})
}

// RunBody 返回 (outcome, errMsg)；errMsg 仅在 bodyFailed 时非空
// （供任务行 lastError 记录，对齐 failTranscriptionJob）。
func RunBody(ctx context.Context, cfg Config, deps BodyDeps, jobId, documentId, requestedBy, optionsJSON string) (BodyOutcome, string) {
	coordinator := NewTranscriptionCoordinator(cfg, deps)
	return coordinator.Coordinate(ctx, jobId, documentId, requestedBy, optionsJSON)
}

func runTranscriptionBody(ctx context.Context, cfg Config, deps BodyDeps, jobId, documentId, requestedBy string) (BodyOutcome, string) {
	return RunBody(ctx, cfg, deps, jobId, documentId, requestedBy, "")
}

// FetchDocContent 文档底稿抓取（D组端点4：Go 单实现，归档直读/raw 回源
// → sanitize → 变换 → 资产预下载；失败显式上抛交调用方 bodyFallback/ERROR）。
func FetchDocContent(ctx context.Context, cfg Config, deps BodyDeps, prep *PrepareResult) (string, error) {
	return fetchDocContent(ctx, cfg, deps, prep)
}

func fetchDocContent(ctx context.Context, cfg Config, deps BodyDeps, prep *PrepareResult) (string, error) {
	if deps.GoTransform == nil {
		return "", fmt.Errorf("go transform executor not configured")
	}
	return deps.GoTransform(ctx, prep.Doc.Repository.Owner, prep.Doc.Repository.Repo,
		prep.Doc.Repository.Branch, prep.Doc.Repository.GitSha, prep.Doc.Path)
}

func finalizeOptions(prep *PrepareResult, userId string) map[string]any {
	opts := map[string]any{"userId": userId}
	if v := prep.Effective.TargetLanguage; v != nil {
		opts["targetLanguage"] = *v
	}
	if v := prep.Effective.CustomPrompt; v != nil {
		opts["customPrompt"] = *v
	}
	if v := prep.Effective.TranscriptionPreset; v != nil {
		opts["transcriptionPreset"] = *v
	}
	if v := prep.Effective.AICondensation; v != nil {
		opts["aiCondensation"] = *v
	}
	return opts
}

// transcribeGoBody 主转录编排；hadOriginal=文档原本就有内容（JIT 短路仅此成立——
// 抓取来的底稿走完整增强管线，与 Node doc.content 判定一致）。
func transcribeGoBody(ctx context.Context, deps BodyDeps, prep *PrepareResult, userId, content string, hadOriginal bool) (BodyOutcome, string, error) {
	reporter := newProgressReporter(deps.Store, prep.Doc.ID, 3*time.Second)
	reporter.Report(ctx, "正在准备转录材料...", 15, true)

	env := TranscriptionExecutionContext{
		Deps:        deps,
		Prep:        prep,
		RequestedBy: userId,
		Content:     content,
		HadOriginal: hadOriginal,
		Reporter:    reporter,
		GatewayVars: buildGatewayVars(prep),
	}

	dispatcher := DefaultTranscriptionStrategyDispatcher()
	return dispatcher.Dispatch(ctx, env)
}

// lookupSymbolRange 语义图谱 AST 行号定位（符号插槽物理事实的唯一来源）：
// 精确名匹配 + 声明区间 [StartLine, EndLine]（1 基闭区间，与事实闸门的
// 行区间核验同源）。图谱缺失/符号未收录/区间非物理有效 → false。
func lookupSymbolRange(index cognitive.GroundingIndex, repoRelPath, symbol string) (int, int, bool) {
	if index.SymbolsByFile == nil || symbol == "" {
		return 0, 0, false
	}
	base, _ := mdpat.SplitPathAnchor(repoRelPath)
	if base == "" {
		base = repoRelPath
	}
	for _, entry := range index.SymbolsByFile[base] {
		if entry.Name == symbol && entry.StartLine > 0 && entry.EndLine >= entry.StartLine {
			return entry.StartLine, entry.EndLine, true
		}
	}
	return 0, 0, false
}

// findDocCodeSnippet 从文档文件（如 README.md）中定位与 symbol 相关的代码围栏切片：
// 1. 扫描所有 ``` 或 ~~~ 围栏块；
// 2. 在每个围栏块中查找包含 symbol 的行；
// 3. 优先匹配声明行（def/func/function/class/const 等），次选调用或包含；
// 4. 若找到最佳代码块，返回该围栏内部代码的 [startLine, endLine]（1-indexed）；
// 5. 若围栏块未命中，兜底查找文档正文中包含 symbol 的锚点行区间。
func findDocCodeSnippet(lines []string, symbol string) (int, int, bool) {
	if len(lines) == 0 || symbol == "" {
		return 0, 0, false
	}

	type codeBlock struct {
		startLine int // 1-indexed first line of code inside fence
		endLine   int // 1-indexed last line of code inside fence
		score     int // 匹配得分
		declLine  int // 声明行号
	}

	var bestBlock *codeBlock
	inFence := false
	var fenceChar byte
	fenceLen := 0
	blockStart := 0

	declPatterns := []string{
		"def " + symbol,
		"func " + symbol,
		"function " + symbol,
		"class " + symbol,
		"const " + symbol,
		"let " + symbol,
		"var " + symbol,
		"type " + symbol,
	}

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !inFence {
			if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
				inFence = true
				fenceChar = trimmed[0]
				fenceLen = len(trimmed) - len(strings.TrimLeft(trimmed, string(fenceChar)))
				blockStart = i + 2 // 1-indexed next line
			}
		} else {
			if len(trimmed) >= fenceLen && trimmed[0] == fenceChar && strings.Trim(trimmed, string(fenceChar)) == "" {
				inFence = false
				blockEnd := i // 1-indexed previous line (since i is 0-indexed closing fence)
				if blockEnd >= blockStart {
					score := 0
					declLine := 0
					for l := blockStart - 1; l < blockEnd; l++ {
						cLine := lines[l]
						for _, dp := range declPatterns {
							if strings.Contains(cLine, dp) {
								score = 3
								declLine = l + 1
								break
							}
						}
						if score < 3 {
							if strings.Contains(cLine, symbol+"(") || strings.Contains(cLine, symbol+" =") || strings.Contains(cLine, symbol+":") {
								if score < 2 {
									score = 2
									declLine = l + 1
								}
							} else if strings.Contains(cLine, symbol) {
								if score < 1 {
									score = 1
									declLine = l + 1
								}
							}
						}
					}

					if score > 0 {
						if bestBlock == nil || score > bestBlock.score {
							bestBlock = &codeBlock{
								startLine: blockStart,
								endLine:   blockEnd,
								score:     score,
								declLine:  declLine,
							}
						}
					}
				}
			}
		}
	}

	if bestBlock != nil {
		totalLines := bestBlock.endLine - bestBlock.startLine + 1
		if totalLines <= 50 {
			return bestBlock.startLine, bestBlock.endLine, true
		}
		s := bestBlock.declLine - 2
		if s < bestBlock.startLine {
			s = bestBlock.startLine
		}
		e := s + 40
		if e > bestBlock.endLine {
			e = bestBlock.endLine
		}
		return s, e, true
	}

	// 兜底：正文中扫描包含 symbol 的行
	for i, line := range lines {
		if strings.Contains(line, symbol) {
			s := i - 1
			if s < 0 {
				s = 0
			}
			e := i + 25
			if e > len(lines) {
				e = len(lines)
			}
			return s + 1, e, true
		}
	}

	return 0, 0, false
}

// translatedTextOrOriginal 翻译结果守门（对齐 Node markdown-translator）：
// 哨兵 <ALREADY_IN_TARGET_LANGUAGE>（模型判定已是目标语言）→ 原文即正确成品；
// 空补全 → 显式报错（红线2 效果不劣化：推理模型烧尽预算返回空串时，绝不能拿
// 未翻译原文伪装成译文成品定稿——对齐 Node "translation returned empty content"）；
// 其余走哨兵解包 + 免责声明规整。
func translatedTextOrOriginal(raw, original string) (string, error) {
	if strings.Contains(raw, alreadyInTargetSentinel) {
		return original, nil
	}
	if strings.TrimSpace(raw) == "" {
		return "", errors.New("doc_translate returned empty completion (reasoning model budget burn?)")
	}
	return ensureDisclaimerFormat(extractBySentinel(raw)), nil
}

// transcribeLlm 共享降级内核：一体化 → 降级纯翻译（保译不回原文）→ 上抛；
// 预算超限上抛。archivable=false 仅表示返回的是原文兜底（哨兵命中——已是
// 目标语言，原文即正确成品，允许存档）；缺 key 与空补全一律显式失败
// （Fail-Closed，公理5：绝不以未翻译/未增强的原文伪装成品定稿）。
func transcribeLlm(ctx context.Context, deps BodyDeps, uid string, needLang bool, content string, gatewayVars func(map[string]any) map[string]any) (string, bool, error) {
	if needLang {
		res, err := withLlmRetry(ctx, func() (LlmTextResult, error) {
			return deps.Llm.Complete(ctx, "doc_transcribe_enhance_localize", gatewayVars(map[string]any{"content": content}), &uid)
		})
		if err == nil && res.FinishReason != "length" {
			out, terr := translatedTextOrOriginal(res.Text, content)
			return out, true, terr
		}
		// 降级纯翻译（保译不回原文）；缺 key 是系统配置错误——上抛显式失败
		res2, err2 := withLlmRetry(ctx, func() (LlmTextResult, error) {
			return deps.Llm.Complete(ctx, "doc_translate", gatewayVars(map[string]any{"content": content}), &uid)
		})
		if err2 == nil && res2.FinishReason != "length" {
			out, terr := translatedTextOrOriginal(res2.Text, content)
			return out, true, terr
		}
		if err2 == nil {
			// 截断的半篇译文不是合格定稿（对齐一体化分支的 FinishReason 守门）：
			// 上抛交任务级重试，绝不以缺尾译文伪装完整成品
			err2 = errors.New("doc_translate completion truncated by token limit")
		}
		// 双段皆败（非预算、非哨兵）：Fail-Closed 上抛，文档置 ERROR 由任务级重试
		// （对齐 Node doc-pipeline 翻译分支：双失败传播异常，绝不把原文伪装成译文）。
		if err == nil {
			err = err2 // length 截断走降级、降级又失败：以降级错误为准
		}
		return "", false, err
	}
	res, err := withLlmRetry(ctx, func() (LlmTextResult, error) {
		return deps.Llm.Complete(ctx, "doc_enhance", gatewayVars(map[string]any{"content": content}), &uid)
	})
	if err != nil {
		return "", false, err
	}
	if res.FinishReason == "length" {
		// 截断即失败（对齐一体化分支的 FinishReason 守门）：语法碰巧合法的
		// 半篇增强不是完整成品，上抛交任务级重试
		return "", false, errors.New("doc_enhance completion truncated by token limit")
	}
	if strings.TrimSpace(res.Text) == "" {
		// 空补全按失败处理（对齐 Node mdx-enhancer 空 content 抛错），绝不落空块
		return "", false, errors.New("doc_enhance returned empty completion")
	}
	return extractBySentinel(res.Text), true, nil
}

// transcribeChunk 多块路径薄包装。
func transcribeChunk(ctx context.Context, deps BodyDeps, prep *PrepareResult, uid string, needLang bool, condensation string, chunk string, gatewayVars func(map[string]any) map[string]any) (string, bool, error) {
	return transcribeLlm(ctx, deps, uid, needLang, chunk, gatewayVars)
}

// transcribeSingle 单块路径薄包装：普通失败交调用方（落 ERROR 终态）。
func transcribeSingle(ctx context.Context, deps BodyDeps, prep *PrepareResult, uid string, needLang bool, transformed string, gatewayVars func(map[string]any) map[string]any) (string, BodyOutcome, error) {
	out, _, err := transcribeLlm(ctx, deps, uid, needLang, transformed, gatewayVars)
	if err != nil {
		if isDeferrableErr(err) {
			return "", BodyDeferred, err
		}
		return "", BodyDone, err
	}
	return out, BodyDone, nil
}

// alreadyInTargetSentinel 翻译 purpose 提示词约定：模型判定文档已是目标语言时
// 精确回复该哨兵（prompt-presets markdown_document_translation 规则 1）。
const alreadyInTargetSentinel = "<ALREADY_IN_TARGET_LANGUAGE>"

// llmUsageWrapper LLM 调用 usage 计数装饰器（WP-J：网关 usage 此前被丢弃，
// Repository.transcriptionTokens 恒 +0——对齐 Node llm-stream-transport 按
// 调用累计 recordTranscriptionTokens 的语义）。
type llmUsageWrapper struct {
	inner LlmGatewayAPI
	total *int64
}

func (w *llmUsageWrapper) Complete(ctx context.Context, purpose string, variables map[string]any, userId *string) (LlmTextResult, error) {
	res, err := w.inner.Complete(ctx, purpose, variables, userId)
	if err == nil && res.Usage.TotalTokens > 0 {
		atomic.AddInt64(w.total, int64(res.Usage.TotalTokens))
	}
	return res, err
}

// isMissingApiKeyErr / isRateLimitGatewayErr / isBudgetErr 单一来源见
// errpolicy.go（错误分类学：类 × 阶段 → 动作的集中契约）。

// computeJitteredBackoff 基于 Full Jitter (AWS 工业标准全抖动随机退避) 算法计算重试等待时间：
// t = rand.Float64() * min(maxBackoff, baseBackoff * (1 << attempt))
// 离散化并发任务的重试时点，彻底杜绝成百上千个并发任务同一时刻重试引发的惊群雪崩。
func computeJitteredBackoff(attempt int, baseBackoff time.Duration, maxBackoff time.Duration) time.Duration {
	if maxBackoff <= 0 {
		return 0
	}
	if baseBackoff <= 0 {
		baseBackoff = 1 * time.Second
	}
	if attempt < 0 {
		attempt = 0
	}
	shift := attempt
	if shift > 30 {
		shift = 30
	}
	capDuration := baseBackoff * (1 << shift)
	if capDuration > maxBackoff || capDuration <= 0 {
		capDuration = maxBackoff
	}
	return time.Duration(rand.Float64() * float64(capDuration))
}

// withLlmRetry 限流与瞬态网络错误退避重试（采用 Full Jitter 随机退避，共 3 次尝试）；其余致命错误（缺 key、
// 预算超限、模式校验失败、未知 purpose）立即上抛，避免无谓重试浪费额度。
func withLlmRetry(ctx context.Context, fn func() (LlmTextResult, error)) (LlmTextResult, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			backoff := computeJitteredBackoff(attempt, 1*time.Second, 8*time.Second)
			if raw := strings.TrimSpace(os.Getenv("TRANSCRIPTION_RETRY_BACKOFF_MS")); raw != "" {
				if ms, err := strconv.Atoi(raw); err == nil && ms >= 0 {
					backoff = time.Duration(ms) * time.Millisecond
				}
			}
			select {
			case <-ctx.Done():
				return LlmTextResult{}, ctx.Err()
			case <-time.After(backoff):
			}
		}
		res, err := fn()
		if err == nil {
			return res, nil
		}
		lastErr = err
		if !isRetryableGatewayErr(err) {
			return res, err // 非可重试错误立即上抛
		}
	}
	return LlmTextResult{}, lastErr
}

func derefStrPtr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// docPathDigitsRe 从文档路径基名提取首个数字串（初始化章节序号）。
var docPathDigitsRe = regexp.MustCompile(`\d+`)

// runCodeChapterTranscription 虚拟代码章节 Go 原生转录执行体：
// 1. 纯函数解析模块快照；
// 2. 本地归档直读源码材料并分配平滑预算；
// 3. 构建认知梯度脚手架（若存在）；
// 4. 经由 LLM 网关一站式生成课时 MDX；
// 5. 第一性原理装甲闭环（句柄还原 + MDX 消毒 + Frontmatter 提取 + AST 校验 + 单次修复/模板兜底）；
// 6. 赋值 SourceFiles 与 Title，返回生成正文。
func runCodeChapterTranscription(ctx context.Context, cfg Config, deps BodyDeps, prep *PrepareResult, requestedBy string) (BodyOutcome, string, error) {
	reporter := newProgressReporter(deps.Store, prep.Doc.ID, 3*time.Second)
	reporter.Report(ctx, "正在准备章节材料与上下文...", 15, true)

	snapshot := chapter.ResolveModuleSnapshotFromProfile(prep.Doc.RepoProfile, prep.Doc.Path, prep.Doc.Title)

	var allSnapshots []cluster.ModuleSnapshot
	if prep.Doc.RepoProfile != nil {
		allSnapshots = chapter.ParseModuleSnapshots(prep.Doc.RepoProfile["codeClusters"])
	}

	chapterOrder := 1
	if numMatch := docPathDigitsRe.FindString(filepath.Base(prep.Doc.Path)); numMatch != "" {
		if n, err := strconv.Atoi(numMatch); err == nil && n > 0 {
			chapterOrder = n
		}
	}
	if snapshot != nil {
		if snapshot.TeachingOrder > 0 {
			chapterOrder = snapshot.TeachingOrder
		} else if snapshot.ChapterNo > 0 {
			chapterOrder = snapshot.ChapterNo
		}
	}

	totalChapters := len(allSnapshots)
	if totalChapters == 0 {
		totalChapters = chapterOrder
	}
	isFinalChapter := totalChapters > 0 && chapterOrder >= totalChapters

	nextChapterTitle := ""
	if !isFinalChapter && totalChapters > 0 {
		nextOrder := chapterOrder + 1
		for _, s := range allSnapshots {
			order := s.TeachingOrder
			if order <= 0 {
				order = s.ChapterNo
			}
			if order == nextOrder {
				nextChapterTitle = s.Title
				break
			}
		}
		if nextChapterTitle == "" && chapterOrder < len(allSnapshots) {
			nextChapterTitle = allSnapshots[chapterOrder].Title
		}
	}

	chapterTitle := prep.Doc.Title
	if chapterTitle == "" && snapshot != nil {
		chapterTitle = snapshot.Title
	}
	if chapterTitle == "" {
		chapterTitle = filepath.Base(prep.Doc.Path)
	}
	if chapterTitle == "" {
		chapterTitle = "Untitled Chapter"
	}

	chapterDesc := ""
	if snapshot != nil {
		chapterDesc = snapshot.Summary
	}
	if chapterDesc == "" {
		chapterDesc = fmt.Sprintf("Architectural analysis for %s", chapterTitle)
	}

	var directories []string
	var filePaths []string
	if snapshot != nil {
		directories = snapshot.Directories
		filePaths = snapshot.Files
	}
	if len(filePaths) == 0 && prep.Doc.Path != "" {
		filePaths = []string{prep.Doc.Path}
	}

	ref := prep.Doc.Repository.Branch
	if prep.Doc.Repository.GitSha != nil && *prep.Doc.Repository.GitSha != "" {
		ref = *prep.Doc.Repository.GitSha
	}

	snippets := chapter.PackModuleFilesFromArchive(cfg.ArchiveRoot, prep.Doc.Repository.Owner, prep.Doc.Repository.Repo, ref, filePaths)
	if len(snippets) == 0 && prep.Doc.Repository.Branch != "" && prep.Doc.Repository.Branch != ref {
		snippets = chapter.PackModuleFilesFromArchive(cfg.ArchiveRoot, prep.Doc.Repository.Owner, prep.Doc.Repository.Repo, prep.Doc.Repository.Branch, filePaths)
	}
	// 语义图谱索引上提构建：既供 Prompt 锚点清单（BuildFilesSummary）、Tier-4 事实闸门，
	// 也供插槽解析器的符号 AST 行号定位（单一事实源，全链路消费同一 SymbolsByFile）
	groundingSha := ""
	if prep.Doc.Repository.GitSha != nil {
		groundingSha = *prep.Doc.Repository.GitSha
	}
	groundingIndex := buildGroundingIndex(cfg.SemanticGraphDir, prep.Doc.Repository.Owner, prep.Doc.Repository.Repo, groundingSha, filePaths)
	filesSummary := chapter.BuildFilesSummary(snippets, groundingIndex.SymbolsByFile)

	scaffold := ""
	var cog ModuleCognition
	if snapshot != nil && len(snapshot.Cognitive) > 0 {
		if err := json.Unmarshal(snapshot.Cognitive, &cog); err == nil && cog.Phase != "" {
			scaffold = BuildCognitiveScaffoldSection(cog, chapterOrder)
		}
	}

	var precedentItems []UpstreamPrecedentItem
	if deps.Store != nil && prep.Doc.RepositoryID != "" {
		items, err := deps.Store.GetUpstreamChapterPrecedents(ctx, prep.Doc.RepositoryID, cog.UpstreamModules, chapterOrder)
		if err == nil && len(items) > 0 {
			precedentItems = items
		}
	}
	if len(precedentItems) == 0 && len(allSnapshots) > 0 {
		precedentItems = ExtractPrecedentsFromSnapshots(allSnapshots, cog.UpstreamModules, chapterOrder)
	}
	upstreamTerminology := BuildUpstreamTerminologySection(precedentItems)

	architectureSkeleton := chapter.BuildModuleArchitectureMermaidSkeleton(
		chapterTitle,
		&cog,
		cog.GoldenSymbols,
		chapter.SkeletonOptions{MaxCallSteps: 6, IncludeExternal: true},
	)
	if chapterOrder == 1 && prep.Doc.RepoProfile != nil {
		if macroDiag, ok := prep.Doc.RepoProfile["macroTopologyMermaid"].(string); ok && strings.TrimSpace(macroDiag) != "" {
			architectureSkeleton = strings.TrimSpace(macroDiag)
		} else if rawTopo, ok := prep.Doc.RepoProfile["macroTopology"].(map[string]any); ok {
			if m, ok := rawTopo["mermaid"].(string); ok && strings.TrimSpace(m) != "" {
				architectureSkeleton = strings.TrimSpace(m)
			} else if rm, ok := rawTopo["rawMermaid"].(string); ok && strings.TrimSpace(rm) != "" {
				architectureSkeleton = strings.TrimSpace(rm)
			}
		}
	}

	targetLang := "zh"
	if prep.Effective.TargetLanguage != nil && *prep.Effective.TargetLanguage != "" && *prep.Effective.TargetLanguage != "none" {
		targetLang = *prep.Effective.TargetLanguage
	}

	// teachingDepth 来源序（对齐 Node code-chapter-pipeline options 优先）：
	// 显式选项（Effective，信封/prepare 下沉）→ 画像 → preset 默认
	teachingDepth := "standard"
	if prep.Effective.TeachingDepth != nil && strings.TrimSpace(*prep.Effective.TeachingDepth) != "" {
		teachingDepth = strings.ToLower(strings.TrimSpace(*prep.Effective.TeachingDepth))
	} else if td, ok := prep.Doc.RepoProfile["teachingDepth"].(string); ok && strings.TrimSpace(td) != "" {
		teachingDepth = strings.ToLower(strings.TrimSpace(td))
	} else if prep.Effective.TranscriptionPreset != nil && *prep.Effective.TranscriptionPreset != "" {
		if d, ok := presetTeachingDepth[*prep.Effective.TranscriptionPreset]; ok {
			teachingDepth = d
		}
	}

	vars := map[string]any{
		"chapterIndex":                chapterOrder,
		"totalChapters":               totalChapters,
		"isFinalChapter":              isFinalChapter,
		"nextChapterTitle":            nextChapterTitle,
		"chapterTitle":                chapterTitle,
		"chapterDescription":          chapterDesc,
		"targetLanguage":              targetLang,
		"teachingDepth":               teachingDepth,
		"moduleDirectories":           directories,
		"cognitiveScaffold":           scaffold,
		"architectureSkeletonSection": architectureSkeleton,
		"upstreamTerminologySection":  upstreamTerminology,
		"groundingFeedback":           "",
		"filesSummary":                filesSummary,
	}
	if v := prep.Effective.CustomPrompt; v != nil && *v != "" {
		vars["styleDirective"] = *v
	}
	if v := prep.Effective.TranscriptionPreset; v != nil && *v != "" {
		vars["stylePreset"] = *v
	}

	var uid *string
	if strings.TrimSpace(requestedBy) != "" {
		uid = &requestedBy
	} else if prep.Doc.OwnerUserID != nil && strings.TrimSpace(*prep.Doc.OwnerUserID) != "" {
		uid = prep.Doc.OwnerUserID
	}

	llmCtx := reporter.WrapContext(ctx, 20, 85, "代码章节")
	llmRes, err := withLlmRetry(ctx, func() (LlmTextResult, error) {
		return deps.Llm.Complete(llmCtx, "code_chapter_lesson", vars, uid)
	})
	if err != nil {
		if isDeferrableErr(err) {
			return BodyDeferred, "", err
		}
		// Fail-Closed(产品定夺 2026-09-20:兜底=质量降级,拒绝):LLM 失败
		// 显式上抛 → 文档 ERROR + 任务按 attempts 衰减重试;绝不以模板
		// 骨架伪装成品(240 字符脚手架混入内容层还会被指纹复用放大)
		return BodyFailed, fmt.Sprintf("code-chapter LLM failed for %s: %v", prep.Doc.Path, err), fmt.Errorf("code-chapter llm: %w", err)
	}
	// 空补全守卫（对齐 doc_translate 同款先例）：空正文进漏斗会被
	// Stage 3.5 骨架保底洗白成"仅骨架的合法 MDX"（112 字空壳案例：
	// finish=stop 但正文为空，典型为推理模型把补全预算烧在思考上）。
	// 空补全=生成失败，与上方 err 分支同权处置：显式 ERROR + attempts 重试
	if strings.TrimSpace(llmRes.Text) == "" {
		return BodyFailed,
			fmt.Sprintf("code-chapter empty completion for %s (finish_reason=%s — reasoning budget burn?)", prep.Doc.Path, llmRes.FinishReason),
			fmt.Errorf("code-chapter llm: empty completion (finish_reason=%s)", llmRes.FinishReason)
	}
	reporter.Report(ctx, "正在执行 AST 校验与装甲收敛...", 90, true)

	// 第一性原理装甲闭环：委托统一确定性收敛漏斗流水线
	refs := make([]armor.ArmorFileRef, len(snippets))
	for i, s := range snippets {
		refs[i] = armor.ArmorFileRef{Path: s.Path}
	}
	if len(refs) == 0 {
		refs = make([]armor.ArmorFileRef, len(filePaths))
		for i, p := range filePaths {
			refs[i] = armor.ArmorFileRef{Path: p}
		}
	}

	// 区间吸附代理计数（对账行 snapped 字段：物理切片区间与 LLM 请求区间
	// 的偏离次数，初次与重写两遍累计；不侵入 armor 包统计）
	snappedSlots := 0

	// 构造物理源码插槽解析器（Stage 1.5 认知切片与隐式智能吸附，绝对零幻觉闭环）。
	// 符号定位严格走图谱 AST 行号（Chomsky Boundary：符号提取零子串启发式）；
	// 图谱缺失/未收录时返回未命中——插槽保持原样并交事实闸门裁决（无符号表
	// 即拒收符号锚点，两处判定同源于 SymbolsByFile，不产生第二套口径）。
	// 归档级行缓存（作用域=本闭包生命周期）：同一文件的多个代码插槽
	// 此前每次重新读盘+全文件切行。仅缓存归档命中级——snippet 回退级
	// 同 path 不同 fileIndex 取值不同，不得缓存。
	archiveLines := make(map[string][]string)
	codeResolver := func(fileIndex int, relPath, symbol string, reqStart, reqEnd int) (string, int, int, bool) {
		cleanPath, _ := mdpat.SplitPathAnchor(relPath)
		if cleanPath == "" {
			cleanPath = relPath
		}
		lines, cached := archiveLines[cleanPath]
		if !cached {
			raw := chapter.ReadLocalArchiveFile(cfg.ArchiveRoot, prep.Doc.Repository.Owner, prep.Doc.Repository.Repo, ref, cleanPath)
			if raw == "" && prep.Doc.Repository.Branch != "" && prep.Doc.Repository.Branch != ref {
				raw = chapter.ReadLocalArchiveFile(cfg.ArchiveRoot, prep.Doc.Repository.Owner, prep.Doc.Repository.Repo, prep.Doc.Repository.Branch, cleanPath)
			}
			if raw != "" {
				lines = strings.Split(raw, "\n")
				archiveLines[cleanPath] = lines
				cached = true
			}
		}
		if !cached && fileIndex >= 1 && fileIndex <= len(snippets) {
			if snippet := snippets[fileIndex-1].Snippet; snippet != "" {
				lines = strings.Split(snippet, "\n")
				cached = true
			}
		}
		if !cached {
			return "", 0, 0, false
		}
		if reqStart > 0 && reqEnd >= reqStart && reqStart <= len(lines) {
			end := reqEnd
			if end > len(lines) {
				end = len(lines)
				snappedSlots++
			}
			return strings.Join(lines[reqStart-1:end], "\n"), reqStart, end, true
		}

		if symbol != "" {
			symStart, symEnd, ok := lookupSymbolRange(groundingIndex, cleanPath, symbol)
			if !ok && cognitive.IsDocFile(cleanPath) {
				symStart, symEnd, ok = findDocCodeSnippet(lines, symbol)
			}
			if !ok || symStart > len(lines) {
				return "", 0, 0, false
			}
			if symEnd > len(lines) {
				symEnd = len(lines)
			}
			return strings.Join(lines[symStart-1:symEnd], "\n"), symStart, symEnd, true
		}

		end := 60
		if len(lines) < end {
			end = len(lines)
		}
		return strings.Join(lines[:end], "\n"), 1, end, true
	}

	// FallbackBuilder 不接模板(产品定夺:兜底=质量降级):repair 失败时
	// 保留真实 LLM 正文的确定性净化版本 + ValidationError 显式标记
	// (终检消费:非空即 Fail-Closed,见下方收敛终检),绝不以 240 字符
	// 脚手架替换整章教学内容
	pipeline := MdxConvergencePipeline{
		LlmClient:            deps.Llm,
		RepairPurpose:        "mdx_repair",
		DocPath:              prep.Doc.Path,
		Refs:                 refs,
		ArchitectureSkeleton: architectureSkeleton,
		CodeResolver:         codeResolver,
		IsFinalChapter:       isFinalChapter,
	}

	isTruncated := llmRes.FinishReason == "length"
	firstPass := pipeline.Execute(ctx, llmRes.Text, uid, isTruncated)

	// Tier-4 分级幻觉防护门禁（L1 吸附放行 / L2 带事实差异清单定向重写一次 /
	// L3 Fail-Closed 拒收）：索引已在插槽解析器前构建（groundingIndex，
	// 图谱缺失时 fail-open 降级为章节文件域——能力不倒退）
	res, ledger, gateErr := runGroundingGate(groundingGateParams{
		Ctx:              ctx,
		Llm:              deps.Llm,
		RewriteCtx:       reporter.WrapContext(ctx, 92, 96, "定向重写"),
		Uid:              uid,
		Vars:             vars,
		Pipeline:         &pipeline,
		Index:            groundingIndex,
		DocPath:          prep.Doc.Path,
		ChapterFilePaths: filePaths,
		FirstPass:        firstPass,
		FirstCallID:      llmRes.CallID,
		SnappedSlots:     &snappedSlots,
		OnRewrite: func() {
			reporter.Report(ctx, "事实校验未通过，正在定向重写...", 92, true)
		},
	})
	if gateErr != nil {
		if isDeferrableErr(gateErr) {
			return BodyDeferred, "", gateErr
		}
		// Fail-Closed(产品定夺 2026-09-20:兜底=质量降级,拒绝)：重写一次后
		// 仍存在幻觉引用（或重写遍网关失败）→ 显式上抛拒收，绝不带毒发布
		return BodyFailed, fmt.Sprintf("code-chapter grounding gate rejected %s: %v", prep.Doc.Path, gateErr), fmt.Errorf("code-chapter grounding: %w", gateErr)
	}
	log.Printf("%s", ledger.LogLine())

	// MDX 收敛终检（Fail-Closed，补齐漏斗末端）：代码章节无确定性保底（产品
	// 定夺：兜底=质量降级，拒绝），repair 失败后的残破语法若放行，破 JSX 将
	// 直达读者侧编译。ValidationError 非空 = 终稿未过 AST 校验（初次或重写遍
	// 的漏斗产物）——与 L3 拒收同权处置：显式 ERROR + attempts 重试（LLM
	// 非确定性，重生成可能收敛）。
	if res.ValidationError != "" {
		return BodyFailed,
			fmt.Sprintf("code-chapter mdx convergence failed for %s: %s", prep.Doc.Path, res.ValidationError),
			fmt.Errorf("code-chapter mdx convergence: %s", res.ValidationError)
	}

	// SourceFiles：终判 grounded 路径与章节域交集，空集保底真实清单
	sourceFiles := intersectChapterSourceFiles(ledger.Report, filePaths)

	prep.Doc.Title = chapterTitle
	prep.Doc.SourceFiles = sourceFiles
	// 代码章 LLM 写课级（无论收敛漏斗是否触发修复——正文恒为 LLM 课稿）
	prep.GenerationLevel = doc.GenerationLevelCodeLesson
	return BodyDone, res.FinalContent, nil
}
