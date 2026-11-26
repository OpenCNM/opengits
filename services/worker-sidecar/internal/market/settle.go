package market

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/treesitter"
)

const (
	BatchSize  = 50
	MaxBatches = 10
)

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

// Calibrated AST quality floor without regex prose inflation.
func QualityFloor() int {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv("UPDATE_QUALITY_FLOOR"))); err == nil && v > 0 {
		return v
	}
	return 60
}

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

type PipelineScoreDoc struct {
	Path        string
	OwnerUserID string
	Status      string
	Content     string
}

type RepoAuditMeta struct {
	Owner          string
	IngestMode     string
	SourceType     string
	Preset         string
	TargetLanguage string
}

func ParseRepoAuditMeta(owner string, rawProfileJSON string) RepoAuditMeta {
	meta := RepoAuditMeta{Owner: strings.TrimSpace(owner)}
	trimmed := strings.TrimSpace(rawProfileJSON)
	if trimmed == "" || trimmed == "null" {
		return meta
	}
	var payload struct {
		IngestMode          string `json:"ingestMode"`
		SourceType          string `json:"sourceType"`
		TranscriptionPreset string `json:"transcriptionPreset"`
		EditionPreset       string `json:"editionPreset"`
		TargetLanguage      string `json:"targetLanguage"`
	}
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return meta
	}
	meta.IngestMode = strings.TrimSpace(payload.IngestMode)
	meta.SourceType = strings.TrimSpace(payload.SourceType)
	if strings.TrimSpace(payload.TranscriptionPreset) != "" {
		meta.Preset = strings.TrimSpace(payload.TranscriptionPreset)
	} else {
		meta.Preset = strings.TrimSpace(payload.EditionPreset)
	}
	meta.TargetLanguage = strings.TrimSpace(payload.TargetLanguage)
	return meta
}

type PipelineDimensionItem struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Score  int    `json:"score"`
	Detail string `json:"detail"`
}

type ActiveJobDoc struct {
	Title string `json:"title"`
}

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

type ClaimResult struct {
	FrozenCredits int `json:"frozenCredits"`
}

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

type RelayJobView struct {
	ID           string `json:"id"`
	RepositoryID string `json:"repositoryId"`
	Kind         string `json:"kind"`
	Status       string `json:"status"`
}

type RetranslateJobInput struct {
	RepositoryID    string
	DocumentID      string
	Path            string
	GitSha          string
	UserID          string
	StagedContentID string
	StagedModel     string
}

type CreateStaleJobsInput struct {
	RepositoryID string
	FromSha      string
	ToSha        string
	Paths        []string
}

type JobAuthInfo struct {
	ID           string `json:"id"`
	RepositoryID string `json:"repositoryId"`
	Kind         string `json:"kind"`
	Status       string `json:"status"`
	IsPublic     bool   `json:"isPublic"`
}

type Store interface {
	Sweeper
	ListExpiredMarketTrials(ctx context.Context, now time.Time, excludeIDs []string, take int) ([]TrialRow, error)
	SettleSwapTx(ctx context.Context, job TrialRow, stagedContent string, dualWrite bool) (bool, error)
	LoadStagedContent(ctx context.Context, contentID string) (string, error)
	RecordMarketSettledEvent(ctx context.Context, claimedBy *string, jobID string)
	IncrementAutoSwapCount(ctx context.Context, repositoryID string) (int, error)
	SetQualityHold(ctx context.Context, repositoryID string) error

	PostSwapDocument(ctx context.Context, repositoryID, documentID, content string) error
	LoadPipelineScoreInputs(ctx context.Context, repositoryID string) (chapterCount int, meta RepoAuditMeta, docs []PipelineScoreDoc, err error)

	ListActiveJobs(ctx context.Context, repoID string) ([]ActiveJobView, error)
	GetJobAuthInfo(ctx context.Context, id string) (*JobAuthInfo, error)
	ClaimJob(ctx context.Context, jobID, userID string, ttlMinutes int) (*ClaimResult, error)
	ReleaseClaim(ctx context.Context, jobID, userID string) error
	ExtendClaim(ctx context.Context, jobID, userID string, ttlMinutes int) (bool, error)
	SettleRelayTx(ctx context.Context, input RelaySettleInput) error
	MarkJobFailed(ctx context.Context, jobID, userID, errMsg string) error
	EnsureRelayJob(ctx context.Context, documentID string) (*RelayJobView, error)
	CreateRetranslateJob(ctx context.Context, input RetranslateJobInput) error
	CreateStaleJobs(ctx context.Context, input CreateStaleJobsInput) (int, error)
}

func SettleExpiredMarketTrials(ctx context.Context, cfg Config, store Store, onIndexRefresh func(repoID string)) (swapped, rejected int) {
	now := time.Now().UTC()
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

func swapInJob(ctx context.Context, cfg Config, store Store, job TrialRow, onIndexRefresh func(repoID string)) bool {
	if strings.TrimSpace(job.StagedContentID) == "" {
		return false
	}
	stagedContent, err := store.LoadStagedContent(ctx, job.StagedContentID)
	if err != nil {
		log.Printf("[market-settle] staged content load failed for %s: %v (swap blocked, fail-closed)", job.ID, err)
		return false
	}
	// Abort swap when staged content is missing or empty so documents never promote with NULL content.
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
		return false
	}
	postSwapJob(ctx, cfg, store, job, stagedContent, onIndexRefresh)
	return true
}

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
	chapterCount, meta, docs, err := store.LoadPipelineScoreInputs(ctx, job.RepositoryID)
	if err != nil {
		log.Printf("[market-settle] re-audit inputs failed for %s: %v", job.RepositoryID, err)
		return
	}
	if total, _, _ := EvaluatePhysicalPipelineScore(chapterCount, meta, docs); total < QualityFloor() {
		if err := store.SetQualityHold(ctx, job.RepositoryID); err == nil {
			log.Printf("[market-settle] quality hold: pipeline %d < floor %d for %s", total, QualityFloor(), job.RepositoryID)
		}
	}
}

func clampScore(v float64) int {
	return int(math.Max(0, math.Min(100, math.Round(v))))
}

var (
	astScoreEngineOnce sync.Once
	astScoreEngine     *treesitter.Engine
)

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

type PipelineScoreDims struct {
	Coverage     int `json:"coverage"`
	Practicality int `json:"practicality"`
	Pedagogy     int `json:"pedagogy"`
	Modernity    int `json:"modernity"`
	Production   int `json:"production"`
}

func PipelineScoreTotalAST(_ context.Context, chapterCount int, docs []PipelineScoreDoc) int {
	total, _, _ := EvaluatePhysicalPipelineScore(chapterCount, RepoAuditMeta{}, docs)
	return total
}

func PipelineScoreTotalASTWithDims(_ context.Context, chapterCount int, docs []PipelineScoreDoc) (int, PipelineScoreDims) {
	total, _, dims := EvaluatePhysicalPipelineScore(chapterCount, RepoAuditMeta{}, docs)
	return total, dims
}

var nonSourceFenceLangs = map[string]bool{
	"mermaid": true, "bash": true, "sh": true, "shell": true, "zsh": true, "console": true,
	"powershell": true, "ps1": true, "pwsh": true, "cmd": true, "bat": true,
	"json": true, "jsonc": true, "yaml": true, "yml": true, "toml": true, "ini": true, "xml": true,
	"csv": true, "txt": true, "text": true, "plain": true, "output": true, "diff": true,
	"ascii": true, "md": true, "markdown": true, "math": true, "latex": true, "env": true, "dotenv": true,
}

var validMermaidKeywords = []string{
	"flowchart", "graph", "sequencediagram", "classdiagram", "statediagram",
	"erdiagram", "xychart", "mindmap", "timeline", "gantt", "pie",
	"gitgraph", "journey", "quadrantchart", "requirementdiagram",
	"c4", "architecture", "block", "packet", "kanban", "sankey",
}

var leakedPromptSentinels = []string{
	"===CONTENT_BEGIN===",
	"<source_document>",
	"</source_document>",
	"<concept_manifest>",
	"<ALREADY_IN_TARGET_LANGUAGE>",
}

func EvaluatePhysicalPipelineScore(chapterCount int, meta RepoAuditMeta, docs []PipelineScoreDoc) (int, []PipelineDimensionItem, PipelineScoreDims) {
	processed, validProcessed, errored, nonEmptyDocs := 0, 0, 0, 0
	for _, d := range docs {
		trimmed := strings.TrimSpace(d.Content)
		if trimmed != "" {
			nonEmptyDocs++
		}
		if d.Status == "PROCESSED" {
			processed++
			if utf8.RuneCountInString(trimmed) >= 80 {
				validProcessed++
			}
		}
		if d.Status == "ERROR" {
			errored++
		}
	}
	expectedChapters := len(docs)
	if chapterCount > expectedChapters {
		expectedChapters = chapterCount
	}
	compScore := 0
	compDetail := "0 章有效交付"
	if expectedChapters > 0 && len(docs) > 0 {
		compScore = clampScore(float64(validProcessed)/float64(expectedChapters)*100.0 - float64(errored)/float64(expectedChapters)*40.0)
		compDetail = fmt.Sprintf("%d/%d 章有效交付 · %d 报错", validProcessed, expectedChapters, errored)
	} else if expectedChapters > 0 {
		compDetail = fmt.Sprintf("0/%d 章有效交付 · 0 报错", expectedChapters)
	}

	synScore := 0
	synDetail := "无正文可检"
	unclosedFenceDocs, residualSlots, brokenMermaid, leakedSentinels := 0, 0, 0, 0
	if nonEmptyDocs > 0 {
		for _, d := range docs {
			if strings.TrimSpace(d.Content) == "" {
				continue
			}
			if hasUnclosedCodeFence(d.Content) {
				unclosedFenceDocs++
			}
			residualSlots += len(armor.ScanResidualCodeSlots(d.Content))
			for _, b := range armor.EnumerateFencedBlocks(d.Content) {
				if strings.EqualFold(b.Lang, "mermaid") && !isValidMermaidBlock(b.Body) {
					brokenMermaid++
				}
			}
			leakedSentinels += countLeakedSentinels(d.Content)
		}
		penalty := unclosedFenceDocs*40 + residualSlots*25 + brokenMermaid*20 + leakedSentinels*30
		synScore = clampScore(100.0 - float64(penalty))
		if penalty == 0 {
			synDetail = "围栏与图表完好 · 0 残余泄漏"
		} else {
			synDetail = fmt.Sprintf("未闭合围栏 %d · 残余槽 %d · 图表/模板异常 %d", unclosedFenceDocs, residualSlots, brokenMermaid+leakedSentinels)
		}
	}

	groundScore := 0
	groundDetail := "无正文可检"
	isWebOrDocMode := strings.EqualFold(meta.Owner, "web-doc") ||
		strings.EqualFold(meta.SourceType, "web") ||
		strings.EqualFold(meta.IngestMode, "text_only") ||
		strings.EqualFold(meta.Preset, "cheatsheet") ||
		strings.EqualFold(meta.Preset, "faithful")

	sourceBlocks, anchoredBlocks := 0, 0
	if !isWebOrDocMode {
		for _, d := range docs {
			if strings.TrimSpace(d.Content) == "" {
				continue
			}
			for _, b := range armor.EnumerateFencedBlocks(d.Content) {
				lang := strings.ToLower(strings.TrimSpace(b.Lang))
				if nonSourceFenceLangs[lang] {
					continue
				}
				if lang == "" && !armor.IsResolvedFenceHeader(b.FirstLine) {
					continue
				}
				sourceBlocks++
				if !b.BodyDroppable && hasClosingFenceLine(b.Body) && armor.IsResolvedFenceHeader(b.FirstLine) {
					anchoredBlocks++
				}
			}
		}
	}

	if !isWebOrDocMode && sourceBlocks > 0 {
		ratio := float64(anchoredBlocks) / float64(sourceBlocks)
		if ratio >= 0.5 {
			groundScore = clampScore(90.0 + (ratio-0.5)*20.0)
		} else {
			groundScore = clampScore(40.0 + ratio*100.0)
		}
		groundDetail = fmt.Sprintf("%d/%d 源码块具物理锚点 (%d%%)", anchoredBlocks, sourceBlocks, int(math.Round(ratio*100)))
	} else if nonEmptyDocs > 0 {
		if !isWebOrDocMode && (strings.EqualFold(meta.IngestMode, "code_only") || strings.EqualFold(meta.IngestMode, "hybrid")) {
			groundScore = 25
			groundDetail = "0 处源码块证据"
		} else if processed > 0 {
			expectZh := strings.HasPrefix(strings.ToLower(strings.TrimSpace(meta.TargetLanguage)), "zh")
			groundedDocs := 0
			for _, d := range docs {
				if d.Status != "PROCESSED" {
					continue
				}
				proseRunes, hanRunes := extractNonWhitespaceProseStats(d.Content)
				if proseRunes < 80 {
					continue
				}
				if expectZh && hanRunes < 20 && float64(hanRunes)/float64(proseRunes) < 0.08 {
					continue
				}
				groundedDocs++
			}
			groundScore = clampScore(float64(groundedDocs) / float64(processed) * 100.0)
			groundDetail = fmt.Sprintf("%d/%d 章正文与语种保真", groundedDocs, processed)
		} else {
			groundScore = 0
			groundDetail = "尚无已交付章节"
		}
	}

	structScore := 0
	structDetail := "尚无成稿章节"
	if processed > 0 {
		docsWithSubheadings := 0
		outOfBoundsRefs := 0
		maxChapter := expectedChapters
		if maxChapter < 1 {
			maxChapter = len(docs)
		}
		for _, d := range docs {
			if hasMarkdownSubheading(d.Content) && d.Status == "PROCESSED" {
				docsWithSubheadings++
			}
			for _, reg := range armor.SplitFencedRegions(d.Content) {
				if reg.IsFence {
					continue
				}
				for _, n := range mdpat.FindChapterRefs(reg.Text) {
					if n < 1 || n > maxChapter {
						outOfBoundsRefs++
					}
				}
			}
		}
		headingPts := float64(docsWithSubheadings) / float64(processed) * 65.0
		outlinePts := 12.0
		if chapterCount > 0 {
			outlinePts = 20.0
		}
		refPts := math.Max(0.0, 15.0-float64(outOfBoundsRefs)*5.0)
		structScore = clampScore(headingPts + outlinePts + refPts)
		structDetail = fmt.Sprintf("%d/%d 章小节层次清晰 · %d 越界引用", docsWithSubheadings, processed, outOfBoundsRefs)
	}

	dimensions := []PipelineDimensionItem{
		{Key: "completeness", Label: "交付完整度", Score: compScore, Detail: compDetail},
		{Key: "syntaxHealth", Label: "语法与渲染", Score: synScore, Detail: synDetail},
		{Key: "grounding", Label: "事实锚定", Score: groundScore, Detail: groundDetail},
		{Key: "structure", Label: "结构编排", Score: structScore, Detail: structDetail},
	}
	legacyDims := PipelineScoreDims{
		Coverage:     compScore,
		Practicality: groundScore,
		Pedagogy:     structScore,
		Modernity:    synScore,
		Production:   synScore,
	}
	total := clampScore(
		float64(compScore)*0.30 +
			float64(synScore)*0.30 +
			float64(groundScore)*0.25 +
			float64(structScore)*0.15,
	)
	return total, dimensions, legacyDims
}

func hasUnclosedCodeFence(content string) bool {
	inFence := false
	var fenceChar byte
	fenceLen := 0
	for _, line := range strings.Split(content, "\n") {
		t := strings.TrimSpace(line)
		if !inFence {
			if len(t) >= 3 && (t[0] == '`' || t[0] == '~') {
				n := 0
				for n < len(t) && t[n] == t[0] {
					n++
				}
				if n >= 3 {
					inFence = true
					fenceChar = t[0]
					fenceLen = n
				}
			}
			continue
		}
		if len(t) >= fenceLen && t[0] == fenceChar {
			onlyFence := true
			for i := 0; i < len(t); i++ {
				if t[i] != fenceChar {
					onlyFence = false
					break
				}
			}
			if onlyFence {
				inFence = false
				fenceChar = 0
				fenceLen = 0
			}
		}
	}
	return inFence
}

func hasClosingFenceLine(body string) bool {
	return stripClosingFenceForAudit(body) != body
}

func stripClosingFenceForAudit(body string) string {
	lines := strings.Split(strings.TrimRight(body, "\n"), "\n")
	if len(lines) == 0 {
		return body
	}
	last := strings.TrimSpace(lines[len(lines)-1])
	if len(last) >= 3 && (last[0] == '`' || last[0] == '~') {
		onlyFence := true
		for i := 0; i < len(last); i++ {
			if last[i] != last[0] {
				onlyFence = false
				break
			}
		}
		if onlyFence {
			return strings.Join(lines[:len(lines)-1], "\n")
		}
	}
	return body
}

func isValidMermaidBlock(bodyWithClose string) bool {
	body := strings.TrimSpace(stripClosingFenceForAudit(bodyWithClose))
	if body == "" {
		return false
	}
	lines := strings.Split(body, "\n")
	idx := 0
	if strings.TrimSpace(lines[0]) == "---" {
		closedFM := false
		for idx = 1; idx < len(lines); idx++ {
			if strings.TrimSpace(lines[idx]) == "---" {
				closedFM = true
				idx++
				break
			}
		}
		if !closedFM {
			return false
		}
	}
	for idx < len(lines) {
		t := strings.TrimSpace(lines[idx])
		if t == "" || strings.HasPrefix(t, "%%") {
			idx++
			continue
		}
		lower := strings.ToLower(t)
		for _, kw := range validMermaidKeywords {
			if strings.HasPrefix(lower, kw) {
				if len(lower) == len(kw) {
					return true
				}
				next := lower[len(kw)]
				if next == ' ' || next == '\t' || next == '-' || next == ':' || next == '(' || kw == "c4" {
					return true
				}
			}
		}
		return false
	}
	return false
}

func countLeakedSentinels(content string) int {
	leaks := 0
	for _, reg := range armor.SplitFencedRegions(content) {
		if reg.IsFence {
			continue
		}
		for _, s := range leakedPromptSentinels {
			if strings.Contains(reg.Text, s) {
				leaks++
			}
		}
	}
	return leaks
}

func extractNonWhitespaceProseStats(content string) (proseRunes, hanRunes int) {
	for _, reg := range armor.SplitFencedRegions(content) {
		if reg.IsFence {
			continue
		}
		for _, r := range reg.Text {
			if unicode.IsSpace(r) {
				continue
			}
			proseRunes++
			if unicode.Is(unicode.Han, r) {
				hanRunes++
			}
		}
	}
	return proseRunes, hanRunes
}

func hasMarkdownSubheading(content string) bool {
	for _, reg := range armor.SplitFencedRegions(content) {
		if reg.IsFence {
			continue
		}
		for _, line := range strings.Split(reg.Text, "\n") {
			t := strings.TrimSpace(line)
			if strings.HasPrefix(t, "## ") || strings.HasPrefix(t, "### ") {
				return true
			}
		}
	}
	return false
}

type CodeBlockAstReport struct {
	TotalBlocks     int `json:"totalBlocks"`
	ValidAstBlocks  int `json:"validAstBlocks"`
	AstErrors       int `json:"astErrors"`
	ProductionNodes int `json:"productionNodes"`
	ModernNodes     int `json:"modernNodes"`
}

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

func containsProductionAstNodes(astStr string, code string) bool {
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
		strings.Contains(astStr, "on_part") ||
		strings.Contains(astStr, "else_block") ||
		strings.Contains(astStr, "after_block") {
		return true
	}

	if strings.Contains(astStr, "raise_statement") ||
		strings.Contains(astStr, "throw_statement") ||
		strings.Contains(astStr, "throw_expression") ||
		strings.Contains(astStr, "rethrow_expression") ||
		strings.Contains(astStr, "assert_statement") ||
		strings.Contains(astStr, "assert_expression") ||
		strings.Contains(astStr, "revert_statement") ||
		strings.Contains(astStr, "try_expression") ||
		strings.Contains(astStr, "error_union_type") {
		return true
	}

	if strings.Contains(astStr, "defer_statement") ||
		strings.Contains(astStr, "errdefer_statement") ||
		strings.Contains(astStr, "with_statement") ||
		strings.Contains(astStr, "using_statement") ||
		strings.Contains(astStr, "using_declaration") ||
		strings.Contains(astStr, "try_with_resources_statement") {
		return true
	}

	if strings.Contains(astStr, "(nil)") ||
		strings.Contains(astStr, "(null)") ||
		strings.Contains(astStr, "nullptr") {
		if strings.Contains(astStr, "if_statement") ||
			strings.Contains(astStr, "binary_expression") ||
			strings.Contains(astStr, "unary_expression") {
			return true
		}
	}

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

	if (strings.Contains(astStr, "match_arm") || strings.Contains(astStr, "case_clause") || strings.Contains(astStr, "stab_clause")) &&
		(strings.Contains(code, "Err") || strings.Contains(code, "None") || strings.Contains(code, ":error") || strings.Contains(code, "Failure")) {
		return true
	}

	if strings.Contains(astStr, "list_lit") && (strings.Contains(code, "catch") || strings.Contains(code, "throw")) {
		return true
	}

	return false
}

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
		if containsProductionAstNodes(astStr, code) {
			report.ProductionNodes++
		}
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
				// Guard against empty language tokens on unfenced code blocks before indexing [0].
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
