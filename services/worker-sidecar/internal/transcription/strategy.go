package transcription

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/doc"
	"github.com/opengits/worker-sidecar/internal/mdx"
)

// ─────────────────────────────────────────────────────────────
// 转录执行策略模式（Strategy Pattern & Transcription Coordinator）
// ─────────────────────────────────────────────────────────────

// TranscriptionExecutionContext 转录策略执行上下文。
type TranscriptionExecutionContext struct {
	Cfg         Config
	Deps        BodyDeps
	Prep        *PrepareResult
	RequestedBy string
	Content     string
	HadOriginal bool
	Reporter    *progressReporter
	GatewayVars func(map[string]any) map[string]any
}

// TranscriptionStrategy 单个转录策略执行接口（Strategy Pattern）。
type TranscriptionStrategy interface {
	Name() string
	Match(env TranscriptionExecutionContext) bool
	Execute(ctx context.Context, env TranscriptionExecutionContext) (BodyOutcome, string, error)
}

// virtualCodeChapterStrategy 虚拟代码章节原生转录闭环策略。
type virtualCodeChapterStrategy struct{}

func (virtualCodeChapterStrategy) Name() string { return "virtual_code_chapter" }

func (virtualCodeChapterStrategy) Match(env TranscriptionExecutionContext) bool {
	return env.Prep != nil && env.Prep.Doc.VirtualChapter
}

func (virtualCodeChapterStrategy) Execute(ctx context.Context, env TranscriptionExecutionContext) (BodyOutcome, string, error) {
	return runCodeChapterTranscription(ctx, env.Cfg, env.Deps, env.Prep, env.RequestedBy)
}

// jitTranslateStrategy JIT 已有文档轻量翻译/原文复用策略。
type jitTranslateStrategy struct{}

func (jitTranslateStrategy) Name() string { return "jit_translate" }

func (jitTranslateStrategy) Match(env TranscriptionExecutionContext) bool {
	return env.Prep != nil && !env.Prep.Effective.ForceEnhance && env.HadOriginal
}

func (jitTranslateStrategy) Execute(ctx context.Context, env TranscriptionExecutionContext) (BodyOutcome, string, error) {
	prep := env.Prep
	deps := env.Deps
	content := env.Content
	needLang := prep.Effective.TargetLanguage != nil && *prep.Effective.TargetLanguage != "" && *prep.Effective.TargetLanguage != "none"

	if !needLang || !prep.Doc.IsMarkdown {
		// 原文直过（无翻译请求/非 markdown）：原文收编级
		prep.GenerationLevel = doc.GenerationLevelOriginal
		return BodyDone, content, nil
	}

	llmCtx := env.Reporter.WrapContext(ctx, 20, 85, "文档翻译")
	uid := env.RequestedBy
	res, err := withLlmRetry(ctx, func() (LlmTextResult, error) {
		return deps.Llm.Complete(llmCtx, "doc_translate", env.GatewayVars(map[string]any{"content": content}), &uid)
	})
	if err == nil && res.FinishReason == "length" {
		// 截断即失败（对齐一体化分支的 FinishReason 守门）：半篇译文交任务级
		// 重试，绝不以缺尾译文伪装完整成品
		err = errors.New("doc_translate completion truncated by token limit")
	}
	if err != nil {
		// Fail-Closed：缺 key 是系统配置错误，显式失败交任务级重试/通知——
		// 绝不拿未翻译原文伪装成品定稿（对齐 Node markdown-translator 抛错语义）
		return BodyDone, "", err
	}
	translated, err := translatedTextOrOriginal(res.Text, content)
	if err != nil {
		return BodyDone, "", err
	}

	// 翻译尾部轻量采样质检与微创自愈（Layer 1~3）：检测截断/复读英文夹生饭
	targetLang := derefStrPtr(prep.Effective.TargetLanguage)
	env.Reporter.Report(ctx, "正在采样质检译文完整度...", 88, true)
	verifiedText, degraded := VerifyAndHealTranslation(ctx, deps.Llm, translated, content, targetLang, &uid)
	if degraded {
		// 采样质检未过且自愈失败：直接保全结构化原文，不交 AST 漏斗洗白半截残品
		prep.ContentDegraded = true
		prep.GenerationLevel = doc.GenerationLevelOriginal
		return BodyDone, content, nil
	}
	translated = verifiedText

	// MDX 收敛漏斗（译文与增强产物同闸门）：语法消毒 + AST 校验 + 单次修复 +
	// 原文保底——翻译破坏 JSX/frontmatter 不得直达读者侧编译。原文保底是
	// 降级成品：置 ContentDegraded（finalize 跳过内容层，防指纹钉死放大）。
	env.Reporter.Report(ctx, "正在执行 AST 校验与装甲收敛...", 90, true)
	pipeline := MdxConvergencePipeline{
		LlmClient:     deps.Llm,
		RepairPurpose: "mdx_repair",
		DocPath:       prep.Doc.Path,
		FallbackBuilder: func() string {
			return content
		},
		Validator: func(source string) (bool, string) {
			if deps.Web != nil {
				v, msg, verr := deps.Web.ValidateMdx(ctx, source)
				if verr == nil {
					return v, msg
				}
			}
			return mdx.ValidateDetailed(source)
		},
	}
	convRes := pipeline.Execute(ctx, translated, &uid)
	prep.ContentDegraded = convRes.WasFallbackUsed
	// 内容等级：正常收敛=翻译级；原文保底（降级）=原文级——读者知情分级
	// （哨兵命中保原文亦归翻译级——LLM 判定已是目标语言）
	if convRes.WasFallbackUsed {
		prep.GenerationLevel = doc.GenerationLevelOriginal
	} else {
		prep.GenerationLevel = doc.GenerationLevelTranslated
	}
	return BodyDone, convRes.FinalContent, nil
}

// aiEnhanceStrategy 完整 AI 智能增强、分块转录与收敛流水线策略。
type aiEnhanceStrategy struct{}

func (aiEnhanceStrategy) Name() string { return "ai_enhance" }

func (aiEnhanceStrategy) Match(env TranscriptionExecutionContext) bool {
	return true // 兜底增强策略
}

func (s aiEnhanceStrategy) Execute(ctx context.Context, env TranscriptionExecutionContext) (BodyOutcome, string, error) {
	prep := env.Prep
	content := env.Content
	deps := env.Deps
	uid := env.RequestedBy

	// 非 markdown 或非 AI 模式：原文收编（零 LLM）
	if !prep.Doc.IsMarkdown || !prep.Doc.EnableAIEnhance {
		prep.GenerationLevel = doc.GenerationLevelOriginal
		return BodyDone, content, nil
	}

	// 必须有 LLM 客户端
	if deps.Llm == nil {
		return BodyFailed, "", errors.New("llm gateway client not configured")
	}

	transformed := content
	fp := prep.Fingerprint
	savedChunks, _ := deps.Store.CheckpointLoad(ctx, prep.Doc.ID, fp)

	needLang := prep.Effective.TargetLanguage != nil && *prep.Effective.TargetLanguage != "" && *prep.Effective.TargetLanguage != "none"
	condensation := "balanced"
	if v := prep.Effective.AICondensation; v != nil && *v != "" {
		condensation = *v
	}

	var finalContent string
	if len(transformed) > chunkMaxLen {
		fc, outcome, err := executeMultiChunkTranscription(ctx, env, transformed, savedChunks, fp, needLang, condensation)
		if err != nil {
			return outcome, "", err
		}
		finalContent = fc
	} else {
		singleCtx := env.Reporter.WrapContext(ctx, 20, 85, "文档转录")
		out, fb, err := transcribeSingle(singleCtx, deps, prep, uid, needLang, transformed, env.GatewayVars)
		if err != nil {
			return fb, "", err
		}
		if out != transformed {
			_ = deps.Store.CheckpointSave(ctx, prep.Doc.ID, uid, fp, 0, 1, out)
		}
		finalContent = out
	}

	// 翻译尾部轻量采样质检与微创自愈（Layer 1~3）：检测截断/复读英文夹生饭
	if needLang {
		targetLang := derefStrPtr(prep.Effective.TargetLanguage)
		env.Reporter.Report(ctx, "正在采样质检译文完整度...", 88, true)
		verifiedText, degraded := VerifyAndHealTranslation(ctx, deps.Llm, finalContent, transformed, targetLang, &uid)
		if degraded {
			prep.ContentDegraded = true
			prep.GenerationLevel = doc.GenerationLevelOriginal
			return BodyDone, transformed, nil
		}
		finalContent = verifiedText
	}

	env.Reporter.Report(ctx, "正在执行 AST 校验与装甲收敛...", 90, true)

	// 确定性收敛漏斗流水线：D9/D11 manifest 剥离 + 语法消毒 + AST 校验 + 网关修复 + 原文保底。
	// 原文保底（WasFallbackUsed）是降级成品：置 ContentDegraded 标记，finalize 段
	// 跳过内容层写入——指纹钉死会把一次降级永久复用放大（红线2 效果不劣化）。
	pipeline := MdxConvergencePipeline{
		LlmClient:     deps.Llm,
		RepairPurpose: "mdx_repair",
		DocPath:       prep.Doc.Path,
		FallbackBuilder: func() string {
			return transformed
		},
		Validator: func(source string) (bool, string) {
			if deps.Web != nil {
				v, msg, err := deps.Web.ValidateMdx(ctx, source)
				if err == nil {
					return v, msg
				}
			}
			return mdx.ValidateDetailed(source)
		},
	}
	res := pipeline.Execute(ctx, finalContent, &uid)
	prep.ContentDegraded = res.WasFallbackUsed
	// 内容等级：正常收敛=增强级；原文保底（降级）=原文级——读者知情分级
	if res.WasFallbackUsed {
		prep.GenerationLevel = doc.GenerationLevelOriginal
	} else {
		prep.GenerationLevel = doc.GenerationLevelEnhanced
	}
	return BodyDone, res.FinalContent, nil
}

// executeMultiChunkTranscription 多块并行转录执行体（最大 2 并发）。
func executeMultiChunkTranscription(
	ctx context.Context,
	env TranscriptionExecutionContext,
	transformed string,
	savedChunks map[int]string,
	fp string,
	needLang bool,
	condensation string,
) (string, BodyOutcome, error) {
	chunks := splitMarkdownIntoChunks(transformed)
	results := make([]string, len(chunks))
	var missing []int
	var savedIndices []int
	for i := range chunks {
		if s, ok := savedChunks[i]; ok && s != "" {
			results[i] = s
			savedIndices = append(savedIndices, i)
		} else {
			missing = append(missing, i)
		}
	}
	env.Reporter.InitChunks(len(chunks), savedIndices)

	var firstErr error
	var mu sync.Mutex
	var wg sync.WaitGroup
	// chunk 级并发上限可配置（TRANSCRIPTION_CHUNK_CONCURRENCY，默认 2
	// 与历史硬编码一致）；结果按 results[idx] 归位，并发不影响输出。
	sem := make(chan struct{}, chunkConcurrencyFromEnv())

	for _, i := range missing {
		chunk := chunks[i]
		wg.Add(1)
		go func(idx int, c string) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()

			mu.Lock()
			stopped := firstErr != nil
			mu.Unlock()
			if stopped {
				return
			}

			chunkCtx := env.Reporter.WrapChunkContext(ctx, idx, len(chunks))
			out, archivable, err := transcribeChunk(chunkCtx, env.Deps, env.Prep, env.RequestedBy, needLang, condensation, c, env.GatewayVars)
			if err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				mu.Unlock()
				results[idx] = c // 防御性占位（firstErr 已触发整文失败，此块不会进入成品）
				return
			}
			env.Reporter.MarkChunkDone(ctx, idx)
			if archivable {
				// 原文兜底块（零成本可重得）不入档——否则断点续跑将永久跳过该块的 LLM 处理
				_ = env.Deps.Store.CheckpointSave(ctx, env.Prep.Doc.ID, env.RequestedBy, fp, idx, len(chunks), out)
			}
			results[idx] = out
		}(i, chunk)
	}
	wg.Wait()

	if firstErr != nil {
		if isDeferrableErr(firstErr) {
			return "", BodyDeferred, firstErr
		}
		// Fail-Closed：任一块翻译双段失败或增强失败即整文 ERROR 待任务级重试，
		// 绝不把混合降级成品伪装成 DONE（对齐 Node 翻译分支错误传播语义；
		// 成功块已入 checkpoint，任务级重试零额外 LLM 成本）。
		return "", BodyDone, firstErr
	}
	return joinMarkdownChunks(results), BodyDone, nil
}

// TranscriptionStrategyDispatcher 策略分发调度器。
type TranscriptionStrategyDispatcher struct {
	strategies []TranscriptionStrategy
}

func NewTranscriptionStrategyDispatcher(strategies ...TranscriptionStrategy) *TranscriptionStrategyDispatcher {
	return &TranscriptionStrategyDispatcher{strategies: strategies}
}

func DefaultTranscriptionStrategyDispatcher() *TranscriptionStrategyDispatcher {
	return NewTranscriptionStrategyDispatcher(
		virtualCodeChapterStrategy{},
		jitTranslateStrategy{},
		aiEnhanceStrategy{},
	)
}

func (d *TranscriptionStrategyDispatcher) Dispatch(ctx context.Context, env TranscriptionExecutionContext) (BodyOutcome, string, error) {
	for _, s := range d.strategies {
		if s.Match(env) {
			return s.Execute(ctx, env)
		}
	}
	return BodyDone, env.Content, nil
}

// TranscriptionCoordinator 转录全流程生命周期协调器（Coordinator Pattern）。
type TranscriptionCoordinator struct {
	cfg        Config
	deps       BodyDeps
	dispatcher *TranscriptionStrategyDispatcher
}

func NewTranscriptionCoordinator(cfg Config, deps BodyDeps) *TranscriptionCoordinator {
	return &TranscriptionCoordinator{
		cfg:        cfg,
		deps:       deps,
		dispatcher: DefaultTranscriptionStrategyDispatcher(),
	}
}

func (c *TranscriptionCoordinator) Coordinate(ctx context.Context, jobId, documentId, requestedBy, optionsJSON string) (BodyOutcome, string) {
	// 阶段 0：预算首帧闸（Frame-1 Fail-Fast，2026-10）——prepare/CAS 之前就地
	// 判定，预算不足直接 BodyDeferred，消除"全套 prepare 后才在 LLM 调用处
	// 被网关拒绝"的每轮空转。预检失败（非预算类）放行：权威闸仍在网关调用
	// 时（预检只提前拦、不构成逃逸双轨）；无该能力的 store（单测 fake）跳过。
	if bp, ok := c.deps.Store.(BudgetProbeStore); ok && bp != nil {
		if err := bp.CheckLlmBudget(ctx, requestedBy); err != nil {
			if isDeferrableErr(err) {
				return BodyDeferred, ""
			}
			log.Printf("[transcription-body] budget precheck unavailable for %s: %v (gateway gate remains authoritative)", documentId, err)
		}
	}

	// 阶段 1：准备与指纹门控（Prepare Phase）。hit/noop 也返回 prep（hit 载有
	// ReuseContent 与 RepositoryID，供图谱边同步——零 LLM 复用不得产生图谱空洞）
	prep, outcome, errMsg := c.runPrepare(ctx, documentId, requestedBy, optionsJSON)
	if outcome != BodyDone || prep == nil {
		return outcome, errMsg
	}
	switch prep.Outcome {
	case "noop":
		return BodyDone, ""
	case "fingerprint-hit":
		if c.deps.FinalizeStore != nil && prep.Model != "" {
			_ = c.deps.FinalizeStore.RecordTranscriptionModel(ctx, repoIdOf(prep), prep.Model)
		}
		c.syncLlmEdgesAsync(prep, requestedBy)
		return BodyDone, ""
	}

	// 阶段 2：底稿加载（Content Acquisition Phase）
	content, err := c.acquireContent(ctx, prep)
	if err != nil {
		log.Printf("[transcription-body] transform failed for %s: %v", prep.Doc.Path, err)
		return BodyFailed, fmt.Sprintf("transform failed: %v", err)
	}

	// 阶段 3：CAS 互斥锁抢占与心跳维持（Concurrency Control Phase）
	stopHeartbeat, locked, err := c.acquireLockAndHeartbeat(ctx, prep.Doc.ID, prep.Effective.ForceEnhance)
	if err != nil {
		log.Printf("[transcription-body] CAS lock failed for %s: %v", prep.Doc.ID, err)
		return BodyFailed, fmt.Sprintf("cas lock failed: %v", err)
	}
	if !locked {
		return BodyDone, "" // 0 命中=并发执行者在跑，按 skipped 返回
	}
	defer stopHeartbeat()

	// 阶段 4：Token 记账装饰与策略分发执行（Strategy Execution Phase）
	var llmUsageTotal int64
	execDeps := c.deps
	if execDeps.Llm != nil {
		execDeps.Llm = &llmUsageWrapper{inner: execDeps.Llm, total: &llmUsageTotal}
	}

	reporter := newProgressReporter(execDeps.Store, prep.Doc.ID, 3*time.Second)
	reporter.Report(ctx, "正在准备转录材料...", 15, true)

	hadOriginal := strings.TrimSpace(derefStrPtr(prep.Doc.Content)) != ""
	env := TranscriptionExecutionContext{
		Cfg:         c.cfg,
		Deps:        execDeps,
		Prep:        prep,
		RequestedBy: requestedBy,
		Content:     content,
		HadOriginal: hadOriginal,
		Reporter:    reporter,
		GatewayVars: buildGatewayVars(prep),
	}

	stratOutcome, finalContent, bodyErr := c.dispatcher.Dispatch(ctx, env)

	if bodyErr != nil {
		if isDeferrableErr(bodyErr) {
			// 预算延后或限流让路：不回拨文档状态——文档停留在入队预置/CAS 的 PROCESSING，
			// 消除"处理中↔未处理"轮询闪烁；所有终态路径（FAILED 级联 ERROR/
			// 重开重置）均有解锁写者，不存在 PROCESSING 假死死角。
			return BodyDeferred, ""
		}
		if err := c.deps.Store.ClearProcessingStatus(ctx, documentId, DocStatusError, truncate(bodyErr.Error(), 500)); err != nil {
			log.Printf("[transcription-body] status writeback to ERROR failed for %s: %v (stale-reaper will recover)", documentId, err)
		}
		return BodyFailed, truncate(bodyErr.Error(), 500)
	}
	_ = stratOutcome

	// 阶段 5：成果物落库与终态收敛（Finalize & Settle Phase）
	return c.finalizeAndSettle(ctx, prep, finalContent, requestedBy, llmUsageTotal)
}

func (c *TranscriptionCoordinator) runPrepare(ctx context.Context, documentId, requestedBy, optionsJSON string) (*PrepareResult, BodyOutcome, string) {
	if c.deps.PrepareFunc == nil {
		log.Printf("[transcription-body] prepare executor not configured for %s", documentId)
		return nil, BodyFailed, "prepare executor not configured"
	}
	prepareOpts := doc.PrepareOptions{UserID: requestedBy}
	if optionsJSON != "" && optionsJSON != "null" {
		var o struct {
			Enhance             bool   `json:"enhance"`
			Model               string `json:"model"`
			TargetLanguage      string `json:"targetLanguage"`
			CustomPrompt        string `json:"customPrompt"`
			TranscriptionPreset string `json:"transcriptionPreset"`
			AICondensation      string `json:"aiCondensation"`
			TeachingDepth       string `json:"teachingDepth"`
		}
		if err := json.Unmarshal([]byte(optionsJSON), &o); err != nil {
			log.Printf("[transcription-body] job options unmarshal failed for %s: %v", documentId, err)
		} else {
			prepareOpts.ForceEnhance = o.Enhance
			prepareOpts.Model = o.Model
			prepareOpts.TargetLanguage = o.TargetLanguage
			prepareOpts.CustomPrompt = o.CustomPrompt
			prepareOpts.TranscriptionPreset = o.TranscriptionPreset
			prepareOpts.AICondensation = o.AICondensation
			prepareOpts.TeachingDepth = o.TeachingDepth
		}
	}
	prep, err := c.deps.PrepareFunc(ctx, documentId, requestedBy, prepareOpts)
	if err != nil {
		log.Printf("[transcription-body] prepare failed for %s: %v", documentId, err)
		return nil, BodyFailed, fmt.Sprintf("prepare failed: %v", err)
	}
	switch prep.Outcome {
	case "noop", "fingerprint-hit", "ready":
		return prep, BodyDone, ""
	default:
		return nil, BodyFailed, fmt.Sprintf("prepare unknown outcome: %s", prep.Outcome)
	}
}

// syncLlmEdgesAsync 指纹零 LLM 复用命中后的 LLM 概念边补同步（异步、静默、
// 不阻断 DONE 终态——对齐 Node 指纹命中路径 document-processor 的图谱补齐语义：
// 跨仓复用时概念节点/确定性边由 prepare 内 StoreDocumentMetadata 承担，LLM 边在此补）。
func (c *TranscriptionCoordinator) syncLlmEdgesAsync(prep *PrepareResult, requestedBy string) {
	if prep.ReuseContent == "" || prep.Doc.RepositoryID == "" {
		return
	}
	edgeStore, ok := c.deps.FinalizeStore.(LlmEdgesStore)
	if !ok || c.deps.Llm == nil {
		return
	}
	llm, store := c.deps.Llm, edgeStore
	repoId, docId, content, uid := prep.Doc.RepositoryID, prep.Doc.ID, prep.ReuseContent, requestedBy
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		SyncLlmEdgesForDocument(ctx, llm, store, repoId, docId, content, uid)
	}()
}

func (c *TranscriptionCoordinator) acquireContent(ctx context.Context, prep *PrepareResult) (string, error) {
	content := derefStrPtr(prep.Doc.Content)
	if !prep.Doc.VirtualChapter && content == "" {
		return fetchDocContent(ctx, c.cfg, c.deps, prep)
	}
	return content, nil
}

func (c *TranscriptionCoordinator) acquireLockAndHeartbeat(ctx context.Context, documentId string, forceEnhance bool) (func(), bool, error) {
	ok, err := c.deps.Store.CasProcessing(ctx, documentId, forceEnhance)
	if err != nil {
		return func() {}, false, err
	}
	if !ok {
		return func() {}, false, nil
	}

	hbStop := make(chan struct{})
	var hbWG sync.WaitGroup
	hbWG.Add(1)
	go func() {
		defer hbWG.Done()
		t := time.NewTicker(60 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-hbStop:
				return
			case <-t.C:
				hbCtx, hbCancel := context.WithTimeout(ctx, 5*time.Second)
				_ = c.deps.Store.HeartbeatDocument(hbCtx, documentId)
				hbCancel()
			}
		}
	}()
	var stopOnce sync.Once
	stopHeartbeat := func() {
		stopOnce.Do(func() {
			close(hbStop)
			hbWG.Wait()
		})
	}
	return stopHeartbeat, true, nil
}

func (c *TranscriptionCoordinator) finalizeAndSettle(ctx context.Context, prep *PrepareResult, finalContent, requestedBy string, llmUsageTotal int64) (BodyOutcome, string) {
	documentId := prep.Doc.ID
	if c.deps.FinalizeStore == nil {
		log.Printf("[transcription-body] finalize store not configured for %s", documentId)
		if err := c.deps.Store.ClearProcessingStatus(ctx, documentId, DocStatusError, "finalize store not configured"); err != nil {
			log.Printf("[transcription-body] status writeback to ERROR failed for %s: %v", documentId, err)
		}
		return BodyFailed, "finalize store not configured"
	}
	if err := Finalize(ctx, c.cfg, c.deps.FinalizeStore, prep, finalContent, requestedBy, prep.Model); err != nil {
		log.Printf("[transcription-body] finalize(go) failed for %s: %v", documentId, err)
		if wbErr := c.deps.Store.ClearProcessingStatus(ctx, documentId, DocStatusError, truncate(err.Error(), 500)); wbErr != nil {
			log.Printf("[transcription-body] status writeback to ERROR failed for %s: %v (stale-reaper will recover)", documentId, wbErr)
		}
		return BodyFailed, truncate(err.Error(), 500)
	}
	if llmUsageTotal > 0 {
		if recorder, ok := c.deps.FinalizeStore.(interface {
			RecordTranscriptionTokens(ctx context.Context, repositoryId string, tokens int) error
		}); ok {
			_ = recorder.RecordTranscriptionTokens(ctx, repoIdOf(prep), int(llmUsageTotal))
		}
	}
	if llmEdgeStore, ok := c.deps.FinalizeStore.(LlmEdgesStore); ok {
		SyncLlmEdgesForDocument(ctx, c.deps.Llm, llmEdgeStore, repoIdOf(prep), documentId, finalContent, requestedBy)
	}
	if c.deps.OnIndexRefresh != nil {
		c.deps.OnIndexRefresh(repoIdOf(prep))
	}
	_ = c.deps.Store.ClearCheckpoint(ctx, documentId)
	_ = c.deps.Store.NotifyDone(ctx, documentId, requestedBy)
	_ = c.deps.Store.UpdateProgress(ctx, documentId, "编纂完成", 100)
	return BodyDone, ""
}

// buildGatewayVars 构建网关通用参数闭包。
func buildGatewayVars(prep *PrepareResult) func(extra map[string]any) map[string]any {
	condensation := "balanced"
	if v := prep.Effective.AICondensation; v != nil && *v != "" {
		condensation = *v
	}
	return func(extra map[string]any) map[string]any {
		vars := map[string]any{
			"targetLanguage":   derefStrPtr(prep.Effective.TargetLanguage),
			"condensationMode": condensation,
			"content":          "",
		}
		if v := prep.Effective.TranscriptionPreset; v != nil {
			vars["stylePreset"] = *v
		}
		if v := prep.Effective.CustomPrompt; v != nil {
			vars["customPrompt"] = *v
		}
		if prep.Effective.TeachingDepth != nil && *prep.Effective.TeachingDepth != "" {
			vars["teachingDepth"] = *prep.Effective.TeachingDepth
		} else if prep.Effective.TranscriptionPreset != nil && *prep.Effective.TranscriptionPreset != "" {
			if d, ok := presetTeachingDepth[*prep.Effective.TranscriptionPreset]; ok {
				vars["teachingDepth"] = d
			}
		}
		for k, v := range extra {
			vars[k] = v
		}
		return vars
	}
}

// chunkConcurrencyFromEnv chunk 级并发上限（默认 3；2026-10-13 由 2 上调——
// 队列级并发默认 6 × chunk 并发 2 = 多块长文任务峰值仅 12 路 LLM，10 块长文要
// 跑 5 个串行波次；3 → 18 路峰值、约 3 个波次）。调大只改并发不改输出
// （结果按 results[idx] 归位）——LLM 网关压力随之上升，BYOK 限流由 withLlmRetry
// 指数退避吸收，按部署配额用 TRANSCRIPTION_CHUNK_CONCURRENCY 调节（1..16）。
func chunkConcurrencyFromEnv() int {
	if v := os.Getenv("TRANSCRIPTION_CHUNK_CONCURRENCY"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 16 {
			return n
		}
	}
	return 3
}
