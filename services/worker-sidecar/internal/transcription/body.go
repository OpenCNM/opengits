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
	"unicode/utf8"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/chapter"
	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/doc"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/platform/client"
)

type PrepareResult = doc.PrepareResult
type ModuleCognition = cognitive.ModuleCognition
type ModuleGoldenSymbol = cognitive.ModuleGoldenSymbol

func BuildCognitiveScaffoldSection(cog ModuleCognition, teachingOrder int) string {
	return cognitive.BuildCognitiveScaffoldSection(cog, teachingOrder)
}

var presetTeachingDepth = doc.PresetTeachingDepth

type BodyDeps struct {
	Web                InternalWebAPI
	Llm                LlmGatewayAPI
	Store              BodyStore
	FinalizeStore      FinalizeStore
	PrepareFunc        func(ctx context.Context, docId string, userId string, opts doc.PrepareOptions) (*PrepareResult, error)
	OnIndexRefresh     func(repoId string)
	GoTransform        func(ctx context.Context, owner, repo, branch string, gitSha *string, path string) (string, error)
	GraphRepo          cognitive.GraphArtifactRepo
	ExtractFileSymbols func(content, filePath string) []cognitive.SymbolEntry
}

type TranscriptionBodyDeps = BodyDeps

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
	ClearCheckpoint(ctx context.Context, documentId string) error
	NotifyDone(ctx context.Context, documentId, userId string) error
	UpdateProgress(ctx context.Context, documentId string, step string, progress int) error
	GetUpstreamChapterPrecedents(ctx context.Context, repositoryId string, upstreamModules []string, maxTeachingOrder int) ([]UpstreamPrecedentItem, error)
}

type BodyOutcome int

const (
	BodyDone BodyOutcome = iota
	BodyDeferred
	BodyFailed
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

func RunBody(ctx context.Context, cfg Config, deps BodyDeps, jobId, documentId, requestedBy, optionsJSON string) (BodyOutcome, string) {
	coordinator := NewTranscriptionCoordinator(cfg, deps)
	return coordinator.Coordinate(ctx, jobId, documentId, requestedBy, optionsJSON)
}

func runTranscriptionBody(ctx context.Context, cfg Config, deps BodyDeps, jobId, documentId, requestedBy string) (BodyOutcome, string) {
	return RunBody(ctx, cfg, deps, jobId, documentId, requestedBy, "")
}

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

// JIT short-circuit applies only when content existed beforehand; freshly fetched source runs full enhancement.
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

func findDocCodeSnippet(lines []string, symbol string) (int, int, bool) {
	if len(lines) == 0 || symbol == "" {
		return 0, 0, false
	}

	type codeBlock struct {
		startLine int
		endLine   int
		score     int
		declLine  int
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
				blockStart = i + 2
			}
		} else {
			if len(trimmed) >= fenceLen && trimmed[0] == fenceChar && strings.Trim(trimmed, string(fenceChar)) == "" {
				inFence = false
				blockEnd := i
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

// Empty completion fails closed so untranslated source never passes as translated; sentinel means target language.
func translatedTextOrOriginal(raw, original string) (string, error) {
	if strings.Contains(raw, alreadyInTargetSentinel) {
		return original, nil
	}
	if strings.TrimSpace(raw) == "" {
		return "", errors.New("doc_translate returned empty completion (reasoning model budget burn?)")
	}
	return ensureDisclaimerFormat(extractBySentinel(raw)), nil
}

// Missing key and length truncation fail closed; archivable=false marks target-language sentinel pass-through.
func transcribeLlm(ctx context.Context, deps BodyDeps, uid string, needLang bool, content string, gatewayVars func(map[string]any) map[string]any) (string, bool, error) {
	if needLang {
		res, err := withLlmRetry(ctx, func() (LlmTextResult, error) {
			return deps.Llm.Complete(ctx, "doc_transcribe_enhance_localize", gatewayVars(map[string]any{"content": content}), &uid)
		})
		if err == nil && res.FinishReason != "length" {
			out, terr := translatedTextOrOriginal(res.Text, content)
			return out, true, terr
		}
		if err != nil && isNoFallbackLlmErr(err) {
			return "", false, err
		}
		res2, err2 := withLlmRetry(ctx, func() (LlmTextResult, error) {
			return deps.Llm.Complete(ctx, "doc_translate", gatewayVars(map[string]any{"content": content}), &uid)
		})
		if err2 == nil && res2.FinishReason != "length" {
			out, terr := translatedTextOrOriginal(res2.Text, content)
			return out, true, terr
		}
		if err2 == nil {
			err2 = errors.New("doc_translate completion truncated by token limit")
		}
		if err == nil {
			err = err2
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
		return "", false, errors.New("doc_enhance completion truncated by token limit")
	}
	if strings.TrimSpace(res.Text) == "" {
		return "", false, errors.New("doc_enhance returned empty completion")
	}
	return extractBySentinel(res.Text), true, nil
}

func transcribeChunk(ctx context.Context, deps BodyDeps, prep *PrepareResult, uid string, needLang bool, condensation string, chunk string, gatewayVars func(map[string]any) map[string]any) (string, bool, error) {
	return transcribeLlm(ctx, deps, uid, needLang, chunk, gatewayVars)
}

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

const alreadyInTargetSentinel = "<ALREADY_IN_TARGET_LANGUAGE>"

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

// Full jitter spreads concurrent retry timestamps to prevent thundering-herd retries.
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
			return res, err
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
	if n <= 0 {
		return ""
	}
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

var docPathDigitsRe = regexp.MustCompile(`\d+`)

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
	groundingSha := ""
	if prep.Doc.Repository.GitSha != nil {
		groundingSha = *prep.Doc.Repository.GitSha
	}
	groundingIndex := buildGroundingIndexWithDeps(
		ctx,
		cfg.ArchiveRoot,
		cfg.SemanticGraphDir,
		prep.Doc.Repository.Owner,
		prep.Doc.Repository.Repo,
		groundingSha,
		prep.Doc.Repository.Branch,
		filePaths,
		snippets,
		deps.GraphRepo,
		deps.ExtractFileSymbols,
	)
	callEdges := loadChapterCallEdges(cfg.SemanticGraphDir, prep.Doc.Repository.Owner, prep.Doc.Repository.Repo, groundingSha)
	ranks := chapter.RankChapterSymbols(groundingIndex.SymbolsByFile, callEdges, filePaths)
	evidence := chapter.BuildChapterEvidence(snippets, chapter.EvidenceOptions{
		SymbolsByFile: groundingIndex.SymbolsByFile,
		Ranks:         ranks,
		ReadFile: func(cleanPath string) (string, bool) {
			raw := chapter.ReadLocalArchiveFile(cfg.ArchiveRoot, prep.Doc.Repository.Owner, prep.Doc.Repository.Repo, ref, cleanPath)
			if raw == "" && prep.Doc.Repository.Branch != "" && prep.Doc.Repository.Branch != ref {
				raw = chapter.ReadLocalArchiveFile(cfg.ArchiveRoot, prep.Doc.Repository.Owner, prep.Doc.Repository.Repo, prep.Doc.Repository.Branch, cleanPath)
			}
			return raw, raw != ""
		},
	})
	filesSummary := evidence.FilesSummary

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
		"slotMenu":                    evidence.SlotMenu,
		"slotMenuText":                chapter.FormatSlotMenu(evidence.SlotMenu),
		"chapterOutlineSection":       BuildChapterOutlineSection(allSnapshots, chapterOrder),
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
		// Failed or empty LLM output fails closed rather than publishing a scaffold fallback.
		return BodyFailed, fmt.Sprintf("code-chapter LLM failed for %s: %v", prep.Doc.Path, err), fmt.Errorf("code-chapter llm: %w", err)
	}
	if strings.TrimSpace(llmRes.Text) == "" {
		return BodyFailed,
			fmt.Sprintf("code-chapter empty completion for %s (finish_reason=%s — reasoning budget burn?)", prep.Doc.Path, llmRes.FinishReason),
			fmt.Errorf("code-chapter llm: empty completion (finish_reason=%s)", llmRes.FinishReason)
	}
	reporter.Report(ctx, "正在执行 AST 校验与装甲收敛...", 90, true)

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

	snappedSlots := 0

	codeResolver := buildCodeResolver(codeResolverDeps{
		archiveRoot:    cfg.ArchiveRoot,
		owner:          prep.Doc.Repository.Owner,
		repo:           prep.Doc.Repository.Repo,
		ref:            ref,
		branch:         prep.Doc.Repository.Branch,
		snippets:       snippets,
		groundingIndex: groundingIndex,
	}, &snappedSlots)

	// Omitting FallbackBuilder retains sanitized LLM text with ValidationError set for the final fail-closed gate.
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

	res, ledger, gateErr := runGroundingGate(groundingGateParams{
		Ctx:              ctx,
		Llm:              deps.Llm,
		RewriteCtx:       reporter.WrapContext(ctx, 92, 96, "定向重写"),
		Uid:              uid,
		Vars:             vars,
		Pipeline:         &pipeline,
		Index:            groundingIndex,
		Ranks:            ranks,
		Refs:             refs,
		DocPath:          prep.Doc.Path,
		ChapterFilePaths: filePaths,
		FirstPass:        firstPass,
		FirstCallID:      llmRes.CallID,
		FirstBriefState:  llmRes.BriefState,
		SnappedSlots:     &snappedSlots,
		OnRewrite: func() {
			reporter.Report(ctx, "事实校验未通过，正在定向重写...", 92, true)
		},
	})
	if gateErr != nil {
		if isDeferrableErr(gateErr) {
			return BodyDeferred, "", gateErr
		}
		return BodyFailed, fmt.Sprintf("code-chapter grounding gate rejected %s: %v", prep.Doc.Path, gateErr), fmt.Errorf("code-chapter grounding: %w", gateErr)
	}
	log.Printf("%s", ledger.LogLine())

	// Final fail-closed gate rejects unrepairable JSX/frontmatter so broken MDX never reaches readers.
	if res.ValidationError != "" {
		return BodyFailed,
			fmt.Sprintf("code-chapter mdx convergence failed for %s: %s", prep.Doc.Path, res.ValidationError),
			fmt.Errorf("code-chapter mdx convergence: %s", res.ValidationError)
	}

	sourceFiles := intersectChapterSourceFiles(ledger.Report, filePaths)

	prep.Doc.Title = chapterTitle
	prep.Doc.SourceFiles = sourceFiles
	prep.GenerationLevel = doc.GenerationLevelCodeLesson
	return BodyDone, res.FinalContent, nil
}
