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
	"github.com/opengits/worker-sidecar/internal/platform/policy"
	"github.com/opengits/worker-sidecar/internal/transform"
)

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

type TranscriptionStrategy interface {
	Name() string
	Match(env TranscriptionExecutionContext) bool
	Execute(ctx context.Context, env TranscriptionExecutionContext) (BodyOutcome, string, error)
}

type virtualCodeChapterStrategy struct{}

func (virtualCodeChapterStrategy) Name() string { return "virtual_code_chapter" }

func (virtualCodeChapterStrategy) Match(env TranscriptionExecutionContext) bool {
	return env.Prep != nil && env.Prep.Doc.VirtualChapter
}

func (virtualCodeChapterStrategy) Execute(ctx context.Context, env TranscriptionExecutionContext) (BodyOutcome, string, error) {
	return runCodeChapterTranscription(ctx, env.Cfg, env.Deps, env.Prep, env.RequestedBy)
}

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
		if !prep.Doc.IsMarkdown {
			content = transform.EnsureCodeWrappedAsMdx(prep.Doc.Path, content)
		}
		prep.GenerationLevel = doc.GenerationLevelOriginal
		return BodyDone, content, nil
	}

	llmCtx := env.Reporter.WrapContext(ctx, 20, 85, "文档翻译")
	uid := env.RequestedBy
	res, err := withLlmRetry(ctx, func() (LlmTextResult, error) {
		return deps.Llm.Complete(llmCtx, "doc_translate", env.GatewayVars(map[string]any{"content": content}), &uid)
	})
	if err == nil && res.FinishReason == "length" {
		err = errors.New("doc_translate completion truncated by token limit")
	}
	if err != nil {
		return BodyDone, "", err
	}
	translated, err := translatedTextOrOriginal(res.Text, content)
	if err != nil {
		return BodyDone, "", err
	}

	targetLang := derefStrPtr(prep.Effective.TargetLanguage)
	env.Reporter.Report(ctx, "正在采样质检译文完整度...", 88, true)
	verifiedText, degraded := VerifyAndHealTranslation(ctx, deps.Llm, translated, content, targetLang, &uid)
	if degraded {
		prep.ContentDegraded = true
		prep.GenerationLevel = doc.GenerationLevelOriginal
		return BodyDone, content, nil
	}
	translated = verifiedText

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
	if convRes.WasFallbackUsed {
		prep.GenerationLevel = doc.GenerationLevelOriginal
	} else {
		prep.GenerationLevel = doc.GenerationLevelTranslated
	}
	return BodyDone, convRes.FinalContent, nil
}

type aiEnhanceStrategy struct{}

func (aiEnhanceStrategy) Name() string { return "ai_enhance" }

func (aiEnhanceStrategy) Match(env TranscriptionExecutionContext) bool {
	return true
}

func (s aiEnhanceStrategy) Execute(ctx context.Context, env TranscriptionExecutionContext) (BodyOutcome, string, error) {
	prep := env.Prep
	content := env.Content
	deps := env.Deps
	uid := env.RequestedBy

	if !prep.Doc.IsMarkdown || !prep.Doc.EnableAIEnhance {
		if !prep.Doc.IsMarkdown {
			content = transform.EnsureCodeWrappedAsMdx(prep.Doc.Path, content)
		}
		prep.GenerationLevel = doc.GenerationLevelOriginal
		return BodyDone, content, nil
	}

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

	// Marks fallback outputs ContentDegraded so finalize skips the shared content layer and avoids fingerprint pinning.
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
	if res.WasFallbackUsed {
		prep.GenerationLevel = doc.GenerationLevelOriginal
	} else {
		prep.GenerationLevel = doc.GenerationLevelEnhanced
	}
	return BodyDone, res.FinalContent, nil
}

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
	sem := make(chan struct{}, effectiveChunkConcurrency())

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
				results[idx] = c
				return
			}
			env.Reporter.MarkChunkDone(ctx, idx)
			if archivable {
				// Never checkpoint source-fallback chunks so resume retries LLM processing instead of skipping them.
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
		return "", BodyDone, firstErr
	}
	return joinMarkdownChunks(results), BodyDone, nil
}

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
	// Frame-1 budget preflight rejects before prepare/CAS; non-budget preflight errors fail open to gateway check.
	if bp, ok := c.deps.Store.(BudgetProbeStore); ok && bp != nil {
		if err := bp.CheckLlmBudget(ctx, requestedBy); err != nil {
			if isDeferrableErr(err) {
				return BodyDeferred, ""
			}
			log.Printf("[transcription-body] budget precheck unavailable for %s: %v (gateway gate remains authoritative)", documentId, err)
		}
	}

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

	content, err := c.acquireContent(ctx, prep)
	if err != nil {
		log.Printf("[transcription-body] transform failed for %s: %v", prep.Doc.Path, err)
		return BodyFailed, fmt.Sprintf("transform failed: %v", err)
	}

	stopHeartbeat, locked, err := c.acquireLockAndHeartbeat(ctx, prep.Doc.ID, prep.Effective.ForceEnhance)
	if err != nil {
		log.Printf("[transcription-body] CAS lock failed for %s: %v", prep.Doc.ID, err)
		return BodyFailed, fmt.Sprintf("cas lock failed: %v", err)
	}
	if !locked {
		return BodyDone, ""
	}
	defer stopHeartbeat()

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
			// Leaves Document in PROCESSING on budget/rate-limit deferral to avoid UI polling flicker.
			return BodyDeferred, ""
		}
		persistedMsg := formatTranscriptionError(bodyErr)
		if err := c.deps.Store.ClearProcessingStatus(ctx, documentId, DocStatusError, persistedMsg); err != nil {
			log.Printf("[transcription-body] status writeback to ERROR failed for %s: %v (stale-reaper will recover)", documentId, err)
		}
		return BodyFailed, persistedMsg
	}
	_ = stratOutcome

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

func isZeroLlmOriginalPassThrough(prep *PrepareResult) bool {
	return prep != nil && prep.GenerationLevel == doc.GenerationLevelOriginal && !prep.ContentDegraded
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
	effectiveModel := prep.Model
	if isZeroLlmOriginalPassThrough(prep) {
		effectiveModel = ""
	}
	if err := Finalize(ctx, c.cfg, c.deps.FinalizeStore, prep, finalContent, requestedBy, effectiveModel); err != nil {
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
	c.maybeRunBookAudit(prep, requestedBy)
	return BodyDone, ""
}

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

func chunkConcurrencyFromEnv() int {
	if v := os.Getenv("TRANSCRIPTION_CHUNK_CONCURRENCY"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 16 {
			return n
		}
	}
	return 3
}

func effectiveChunkConcurrency() int {
	return policy.ResolveTranscriptionChunkConcurrency(
		policy.CachedTranscriptionChunkConcurrency(),
		chunkConcurrencyFromEnv(),
	)
}
