package transcription

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"maps"
	"sort"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/chapter"
	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

const (
	bookAuditTimeout            = 10 * time.Minute
	bookAuditMaxRepairs         = 5
	bookAuditDigestIntroChars   = 260
	bookAuditDigestSummaryChars = 180
	bookAuditDigestSnippetLines = 25
	bookAuditAnchoredRatioFloor = 0.5
	bookAuditEnrichMaxSlots     = 2

	// Exceeds bookAuditTimeout so active audits are never preempted, while crashed leases remain recoverable.
	bookAuditStaleClaim  = 15 * time.Minute
	bookAuditMaxAttempts = 3
)

const (
	bookAuditStatusRunning              = "running"
	bookAuditStatusDone                 = "done"
	bookAuditStatusFailed               = "failed"
	bookAuditStatusSkippedConflict      = "skipped_conflict"
	bookAuditStatusSkippedNoLLM         = "skipped_no_llm"
	bookAuditStatusSkippedNoAuthor      = "skipped_no_author"
	bookAuditStatusSkippedNoCommitStore = "skipped_no_commit_store"
)

var bookAuditRetryableStatuses = []string{
	bookAuditStatusFailed,
	bookAuditStatusSkippedNoLLM,
	bookAuditStatusSkippedNoAuthor,
	bookAuditStatusSkippedNoCommitStore,
}

const (
	bookDefectIntroMismatch  = "intro_mismatch"
	bookDefectThinCode       = "thin_code"
	bookDefectPeripheralOnly = "peripheral_only"
)

type bookAuditDefect struct {
	ChapterPath   string `json:"chapterPath"`
	IssueType     string `json:"issueType"`
	TargetSection string `json:"targetSection"`
	FixHint       string `json:"fixHint"`
	forced        bool
}

type bookAuditAIResponse struct {
	Defects []bookAuditDefect `json:"defects"`
}

type bookAuditChapterDigest struct {
	Path           string
	Title          string
	CharCount      int
	CodeBlocks     int
	AnchoredCount  int
	Residuals      int
	Intro          string
	Summary        string
	Snippet        string
	HasSourceFiles bool
	Candidates     []string
	MainCodeBlocks int
	MainAnchored   int
	DeepDives      int
	MainDenseParas int
}

func newBookAuditPrep(prep *PrepareResult) *PrepareResult {
	snapshot := *prep
	snapshot.Doc.RepoProfile = maps.Clone(prep.Doc.RepoProfile)
	return &snapshot
}

func bookAuditScopeOf(prep *PrepareResult) BookAuditScope {
	return BookAuditScope{RepositoryID: prep.Doc.RepositoryID, OwnerUserID: prep.Doc.OwnerUserID}
}

func bookAuditScopeHash(scope BookAuditScope, rows []ChapterScopeRow) string {
	h := sha256.New()
	fmt.Fprintf(h, "scope\x00%s\n", scope.identity())
	for _, r := range rows {
		contentID := "-"
		if r.ContentID != nil {
			contentID = *r.ContentID
		}
		fmt.Fprintf(h, "%s\x00%s\n", r.Path, contentID)
	}
	return hex.EncodeToString(h.Sum(nil))
}

func (c *TranscriptionCoordinator) maybeRunBookAudit(prep *PrepareResult, requestedBy string) {
	store, ok := c.deps.Store.(BookAuditStore)
	if !ok || prep.Doc.RepositoryID == "" || prep.Doc.RepoProfile == nil {
		return
	}
	if _, hasClusters := prep.Doc.RepoProfile["codeClusters"]; !hasClusters {
		return
	}
	snapshot := newBookAuditPrep(prep)
	cfg, deps := c.cfg, c.deps
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[book-audit] panic recovered for repo %s: %v", snapshot.Doc.RepositoryID, r)
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), bookAuditTimeout)
		defer cancel()
		claimed, err := runBookAuditOnce(ctx, cfg, deps, store, snapshot, requestedBy)
		if err != nil {
			log.Printf("[book-audit] failed for repo %s: %v", snapshot.Doc.RepositoryID, err)
			if claimed {
				markBookAuditStatus(ctx, store, snapshot, bookAuditStatusFailed)
			}
		}
	}()
}

func markBookAuditStatus(ctx context.Context, store BookAuditStore, prep *PrepareResult, status string) {
	if err := store.MarkBookAuditStatus(ctx, bookAuditScopeOf(prep), status); err != nil {
		log.Printf("[book-audit] mark status %q degraded for repo %s: %v", status, prep.Doc.RepositoryID, err)
	}
}

func runBookAuditOnce(ctx context.Context, cfg Config, deps BodyDeps, store BookAuditStore, prep *PrepareResult, requestedBy string) (claimed bool, err error) {
	scope := bookAuditScopeOf(prep)
	unsettled, err := store.CountUnsettledChapters(ctx, scope)
	if err != nil {
		return false, fmt.Errorf("count unsettled chapters: %w", err)
	}
	if unsettled > 0 {
		return false, nil
	}
	rows, err := store.ListChapterScope(ctx, scope)
	if err != nil {
		return false, fmt.Errorf("chapter scope: %w", err)
	}
	scopeHash := bookAuditScopeHash(scope, rows)

	// Acquires advisory lock before claiming so concurrent final-chapter settles serialize cleanly.
	unlock, locked, err := store.TryLockBookAudit(ctx, scope)
	if err != nil {
		return false, fmt.Errorf("audit lock: %w", err)
	}
	if !locked {
		return false, nil
	}
	defer unlock()

	claimed, err = store.TryClaimBookAudit(ctx, scope, scopeHash, time.Now().Add(-bookAuditStaleClaim), bookAuditMaxAttempts)
	if err != nil {
		return false, fmt.Errorf("claim: %w", err)
	}
	if !claimed {
		return false, nil
	}
	finalStatus, err := runBookAudit(ctx, cfg, deps, store, prep, requestedBy)
	if err != nil {
		return true, err
	}
	if err := store.MarkBookAuditStatus(ctx, scope, finalStatus); err != nil {
		return true, fmt.Errorf("mark status %q: %w", finalStatus, err)
	}
	return true, nil
}

func runBookAudit(ctx context.Context, cfg Config, deps BodyDeps, store BookAuditStore, prep *PrepareResult, requestedBy string) (string, error) {
	repoId := prep.Doc.RepositoryID
	// Yields as retryable when LLM is absent so forced defects neither panic nor falsely mark done.
	if deps.Llm == nil {
		log.Printf("[book-audit] llm unavailable for repo %s, audit skipped", repoId)
		return bookAuditStatusSkippedNoLLM, nil
	}
	authorID := auditAuthorID(prep, requestedBy)
	if authorID == "" {
		log.Printf("[book-audit] no author available for repo %s (shared docs, empty requester), audit skipped", repoId)
		return bookAuditStatusSkippedNoAuthor, nil
	}
	docs, err := store.ListProcessedChapters(ctx, bookAuditScopeOf(prep))
	if err != nil {
		return "", fmt.Errorf("list chapters: %w", err)
	}
	if len(docs) < 2 {
		return bookAuditStatusDone, nil
	}

	filesByPath := map[string][]string{}
	for _, doc := range docs {
		if resolved := chapter.ResolveModuleSnapshotFromProfile(prep.Doc.RepoProfile, doc.Path, doc.Title); resolved != nil {
			filesByPath[doc.Path] = resolved.Files
		}
	}

	digests, forced, _ := bookAuditHealthCheck(docs, filesByPath, len(docs))

	defects := forced
	aiDefects, err := bookAuditAIReview(ctx, deps.Llm, docs, digests, requestedBy)
	if err != nil {
		log.Printf("[book-audit] AI review unavailable for repo %s (deterministic findings proceed): %v", repoId, err)
	} else {
		defects = mergeBookAuditDefects(forced, aiDefects)
	}
	if len(defects) == 0 {
		log.Printf("[book-audit] clean for repo %s (%d chapters)", repoId, len(docs))
		return bookAuditStatusDone, nil
	}
	if len(defects) > bookAuditMaxRepairs {
		defects = defects[:bookAuditMaxRepairs]
	}

	return repairBookAuditDefects(ctx, cfg, deps, store, prep, docs, digests, defects, requestedBy, authorID)
}

func bookAuditHealthCheck(docs []BookAuditDoc, filesByPath map[string][]string, totalChapters int) ([]bookAuditChapterDigest, []bookAuditDefect, []bookAuditDefect) {
	digests := make([]bookAuditChapterDigest, 0, len(docs))
	var forced, candidates []bookAuditDefect

	for _, doc := range docs {
		d := bookAuditChapterDigest{
			Path: doc.Path, Title: doc.Title, CharCount: len(doc.Content),
			HasSourceFiles: len(filesByPath[doc.Path]) > 0,
		}
		blocks := armor.EnumerateFencedBlocks(doc.Content)
		for _, b := range blocks {
			if b.Lang == "mermaid" {
				continue
			}
			d.CodeBlocks++
			if armor.IsResolvedFenceHeader(b.FirstLine) {
				d.AnchoredCount++
			}
			if len(d.Snippet) == 0 && b.BodyDroppable == false {
				d.Snippet = truncateLines(strings.TrimSpace(stripFenceFromBlock(b)), bookAuditDigestSnippetLines)
			}
		}
		d.Residuals = len(armor.ScanResidualCodeSlots(doc.Content))
		d.Intro = truncateRunes(firstProseParagraph(doc.Content), bookAuditDigestIntroChars)
		d.Summary = truncateRunes(lastProseParagraph(doc.Content), bookAuditDigestSummaryChars)
		layers := armor.MeasureLayers(doc.Content)
		d.MainCodeBlocks = layers.MainBlocks
		d.MainAnchored = layers.MainAnchored
		d.DeepDives = layers.DeepDives
		d.MainDenseParas = layers.DenseParas

		var docCandidates []bookAuditDefect
		if d.HasSourceFiles {
			switch {
			case d.CodeBlocks == 0:
				forced = append(forced, bookAuditDefect{
					ChapterPath: doc.Path, IssueType: bookDefectThinCode,
					TargetSection: "", FixHint: "chapter cites zero code blocks despite allocated source files",
					forced: true,
				})
			case d.MainCodeBlocks == 0:
				forced = append(forced, bookAuditDefect{
					ChapterPath: doc.Path, IssueType: bookDefectThinCode,
					TargetSection: "", FixHint: "all code blocks sit inside collapsed deep-dive blocks; the mainline carries no source evidence",
					forced: true,
				})
			case d.MainCodeBlocks <= 1:
				docCandidates = append(docCandidates, bookAuditDefect{
					ChapterPath: doc.Path, IssueType: bookDefectThinCode,
					TargetSection: "", FixHint: "only one code block; judge whether enrichment is needed",
				})
			}

			if d.MainCodeBlocks > 0 && float64(d.MainAnchored)/float64(d.MainCodeBlocks) < bookAuditAnchoredRatioFloor {
				docCandidates = append(docCandidates, bookAuditDefect{
					ChapterPath: doc.Path, IssueType: bookDefectPeripheralOnly,
					TargetSection: "", FixHint: "most mainline code blocks lack real source anchors",
				})
			}
			if d.MainDenseParas >= 2 {
				docCandidates = append(docCandidates, bookAuditDefect{
					ChapterPath: doc.Path, IssueType: bookDefectPeripheralOnly,
					TargetSection: "", FixHint: fmt.Sprintf("mainline prose has %d symbol/capsule-dense paragraphs", d.MainDenseParas),
				})
			}
		}
		outOfBoundsRef := 0
		for _, reg := range armor.SplitFencedRegions(doc.Content) {
			if reg.IsFence {
				continue
			}
			for _, n := range mdpat.FindChapterRefs(reg.Text) {
				if n < 1 || n > totalChapters {
					outOfBoundsRef = n
					break
				}
			}
			if outOfBoundsRef != 0 {
				break
			}
		}
		if outOfBoundsRef != 0 {
			docCandidates = append(docCandidates, bookAuditDefect{
				ChapterPath: doc.Path, IssueType: bookDefectIntroMismatch,
				TargetSection: "intro", FixHint: fmt.Sprintf("references chapter %d beyond the %d-chapter outline", outOfBoundsRef, totalChapters),
			})
		}
		for _, cand := range docCandidates {
			d.Candidates = append(d.Candidates, fmt.Sprintf("[%s] %s", cand.IssueType, cand.FixHint))
			candidates = append(candidates, cand)
		}
		digests = append(digests, d)
	}
	return digests, forced, candidates
}

func stripFenceFromBlock(b armor.FencedBlockView) string {
	content := b.Body
	lines := strings.Split(strings.TrimRight(content, "\n"), "\n")
	if len(lines) > 0 {
		last := strings.TrimSpace(lines[len(lines)-1])
		if len(last) >= 3 && (last[0] == '`' || last[0] == '~') && strings.Trim(last, "`~") == "" {
			lines = lines[:len(lines)-1]
		}
	}
	return strings.Join(lines, "\n")
}

func truncateLines(s string, maxLines int) string {
	lines := strings.Split(s, "\n")
	if len(lines) <= maxLines {
		return s
	}
	return strings.Join(lines[:maxLines], "\n") + "\n// ... (truncated)"
}

func truncateRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max]) + "…"
}

func firstProseParagraph(content string) string {
	_, body := splitFrontmatter(content)
	for _, para := range strings.Split(body, "\n\n") {
		p := strings.TrimSpace(para)
		if p != "" && !strings.HasPrefix(p, "```") && !strings.HasPrefix(p, "#") {
			return p
		}
	}
	return ""
}

func lastProseParagraph(content string) string {
	_, body := splitFrontmatter(content)
	regions := armor.SplitLayerRegions(body)
	for i := len(regions) - 1; i >= 0; i-- {
		reg := regions[i]
		if reg.IsFence || reg.IsDeepDive {
			continue
		}
		normalized := strings.ReplaceAll(reg.Text, "\r\n", "\n")
		paras := strings.Split(normalized, "\n\n")
		for j := len(paras) - 1; j >= 0; j-- {
			p := trimDeepDiveBoundaryLines(paras[j])
			if p != "" && !strings.HasPrefix(p, "```") && !strings.HasPrefix(p, "~~~") && !strings.HasPrefix(p, "#") {
				return p
			}
		}
	}
	return ""
}

func trimDeepDiveBoundaryLines(para string) string {
	lines := strings.Split(strings.TrimSpace(para), "\n")
	start := 0
	for start < len(lines) && strings.EqualFold(strings.TrimSpace(lines[start]), "</details>") {
		start++
	}
	end := len(lines)
	for end > start && strings.EqualFold(strings.TrimSpace(lines[end-1]), "</details>") {
		end--
	}
	return strings.TrimSpace(strings.Join(lines[start:end], "\n"))
}

func splitFrontmatter(content string) (frontmatter, body string) {
	t := strings.TrimLeft(content, "\n")
	if !strings.HasPrefix(t, "---") {
		return "", content
	}
	if idx := strings.Index(t[3:], "\n---"); idx >= 0 {
		end := idx + 3 + 4
		rest := t[end:]
		return t[:end], strings.TrimLeft(rest, "\n")
	}
	return "", content
}

func bookAuditAIReview(ctx context.Context, llm LlmGatewayAPI, docs []BookAuditDoc, digests []bookAuditChapterDigest, uid string) ([]bookAuditDefect, error) {
	var outline []string
	for i, d := range digests {
		outline = append(outline, fmt.Sprintf("%d. %s (%s)", i+1, d.Title, d.Path))
	}
	var sb strings.Builder
	for i, d := range digests {
		fmt.Fprintf(&sb, "### Chapter %d: %s [%s]\n", i+1, d.Title, d.Path)
		fmt.Fprintf(&sb, "- chars: %d, code blocks: %d (mainline: %d, mainline anchored: %d, anchored: %d), deep-dive blocks: %d, mainline dense paras: %d, residual slots: %d, has allocated source files: %v\n",
			d.CharCount, d.CodeBlocks, d.MainCodeBlocks, d.MainAnchored, d.AnchoredCount, d.DeepDives, d.MainDenseParas, d.Residuals, d.HasSourceFiles)
		if d.Intro != "" {
			fmt.Fprintf(&sb, "- intro: %s\n", d.Intro)
		}
		if d.Snippet != "" {
			fmt.Fprintf(&sb, "- first code snippet:\n%s\n", d.Snippet)
		}
		if d.Summary != "" {
			fmt.Fprintf(&sb, "- summary: %s\n", d.Summary)
		}
		if len(d.Candidates) > 0 {
			fmt.Fprintf(&sb, "- deterministic signals: %s\n", strings.Join(d.Candidates, "; "))
		}
		sb.WriteString("\n")
	}
	res, err := withLlmRetry(ctx, func() (LlmTextResult, error) {
		return llm.Complete(ctx, "book_final_audit", map[string]any{
			"chapterOutline": strings.Join(outline, "\n"),
			"chaptersDigest": sb.String(),
		}, &uid)
	})
	if err != nil {
		return nil, err
	}
	var resp bookAuditAIResponse
	if err := json.Unmarshal([]byte(normalizeSlotRepairJSON(res.Text)), &resp); err != nil {
		return nil, fmt.Errorf("parse audit JSON: %w", err)
	}
	paths := make(map[string]bool, len(docs))
	for _, d := range docs {
		paths[d.Path] = true
	}
	valid := make([]bookAuditDefect, 0, len(resp.Defects))
	for _, d := range resp.Defects {
		if !paths[d.ChapterPath] {
			continue
		}
		switch d.IssueType {
		case bookDefectIntroMismatch, bookDefectThinCode, bookDefectPeripheralOnly:
		default:
			continue
		}
		valid = append(valid, d)
	}
	return valid, nil
}

func mergeBookAuditDefects(forced, aiDefects []bookAuditDefect) []bookAuditDefect {
	seen := make(map[string]bool, len(forced)+len(aiDefects))
	merged := append([]bookAuditDefect(nil), forced...)
	for _, d := range forced {
		seen[d.ChapterPath+"#"+d.IssueType] = true
	}
	for _, d := range aiDefects {
		key := d.ChapterPath + "#" + d.IssueType
		if seen[key] {
			continue
		}
		seen[key] = true
		merged = append(merged, d)
	}
	sort.SliceStable(merged, func(i, j int) bool { return merged[i].ChapterPath < merged[j].ChapterPath })
	return merged
}

func auditAuthorID(prep *PrepareResult, requestedBy string) string {
	if author := strings.TrimSpace(requestedBy); author != "" {
		return author
	}
	if prep.Doc.OwnerUserID != nil {
		return strings.TrimSpace(*prep.Doc.OwnerUserID)
	}
	return ""
}

// Aggregates defects per chapter in memory for one regate and one canonical swap, preventing partial overwrites.
func repairBookAuditDefects(ctx context.Context, cfg Config, deps BodyDeps, store BookAuditStore, prep *PrepareResult, docs []BookAuditDoc, digests []bookAuditChapterDigest, defects []bookAuditDefect, uid, authorID string) (string, error) {
	commitStore, ok := store.(BookAuditCommitStore)
	if !ok {
		log.Printf("[book-audit] store lacks commit capability for repo %s, repairs skipped (skipped_no_commit_store)", prep.Doc.RepositoryID)
		return bookAuditStatusSkippedNoCommitStore, nil
	}
	// Pre-check skips doomed LLM repair calls on PENDING/public repos; authoritative guard lives in swap CAS.
	under, err := store.RepositoryUnderReviewOrPublic(ctx, prep.Doc.RepositoryID)
	if err != nil {
		return "", fmt.Errorf("review-state guard: %w", err)
	}
	if under {
		log.Printf("[book-audit] repo %s under review or public, repairs skipped (skipped_conflict)", prep.Doc.RepositoryID)
		return bookAuditStatusSkippedConflict, nil
	}

	docByID := make(map[string]BookAuditDoc, len(docs))
	filesByPath := map[string][]string{}
	for _, d := range docs {
		docByID[d.Path] = d
		if resolved := chapter.ResolveModuleSnapshotFromProfile(prep.Doc.RepoProfile, d.Path, d.Title); resolved != nil {
			filesByPath[d.Path] = resolved.Files
		}
	}

	repairedChapters, appliedDefects := 0, 0
	for i := 0; i < len(defects); {
		j := i
		for j < len(defects) && defects[j].ChapterPath == defects[i].ChapterPath {
			j++
		}
		chapterDefects := defects[i:j]
		i = j

		doc, ok := docByID[chapterDefects[0].ChapterPath]
		if !ok {
			continue
		}
		working := doc
		applied := 0
		for _, defect := range chapterDefects {
			var patched string
			var err error
			switch defect.IssueType {
			case bookDefectIntroMismatch:
				patched, err = repairChapterIntro(ctx, deps.Llm, prep, working, defect, uid)
			case bookDefectThinCode, bookDefectPeripheralOnly:
				patched, err = enrichChapterCode(ctx, cfg, deps, prep, working, defect, uid)
			}
			if err != nil {
				log.Printf("[book-audit] repair %s (%s) failed, defect left untreated: %v", defect.ChapterPath, defect.IssueType, err)
				continue
			}
			working.Content = patched
			applied++
		}
		if applied == 0 {
			continue
		}
		regated, rerr := regateChapterContent(ctx, cfg, deps, prep, doc.Path, doc.GitSha, working.Content)
		if rerr != nil {
			log.Printf("[book-audit] regate %s failed, keeping original: %v", doc.Path, rerr)
			continue
		}
		swapped, cerr := commitAuditedChapter(ctx, cfg, commitStore, prep, doc, filesByPath[doc.Path], regated, authorID, deps.OnIndexRefresh)
		if cerr != nil {
			log.Printf("[book-audit] writeback %s failed, keeping original: %v", doc.Path, cerr)
			continue
		}
		if !swapped {
			log.Printf("[book-audit] writeback %s skipped: chapter changed concurrently or repo entered review", doc.Path)
			continue
		}
		repairedChapters++
		appliedDefects += applied
	}
	log.Printf("[book-audit] repo %s: %d chapters repaired (%d defects applied of %d)",
		prep.Doc.RepositoryID, repairedChapters, appliedDefects, len(defects))
	return bookAuditStatusDone, nil
}

// Skips StoreDocumentMetadata because reconstructing concepts without frontmatter would overwrite the concept graph.
func commitAuditedChapter(ctx context.Context, cfg Config, commitStore BookAuditCommitStore, prep *PrepareResult, doc BookAuditDoc, sourceFiles []string, patched, authorID string, onIndexRefresh func(string)) (bool, error) {
	body := concept.ExtractConceptManifest(patched, doc.Path).CleanContent
	if strings.TrimSpace(body) == "" {
		return false, fmt.Errorf("repaired content is empty for %s", doc.Path)
	}
	chunkPrep := *prep
	chunkPrep.Doc = prep.Doc
	chunkPrep.Doc.Path = doc.Path
	chunkPrep.Doc.Title = doc.Title
	chunkPrep.Doc.SourceFiles = sourceFiles
	chunks := chunkInProcess(cfg, &chunkPrep, body)
	if len(chunks) > 0 {
		if _, err := commitStore.ReplaceDocumentChunks(ctx, doc.ID, chunks, ReplaceChunksOpts{
			DocPath:       doc.Path,
			DefaultBranch: cfg.DefaultBranch,
			BlueprintRole: chunker.DeriveDocumentRole(body),
		}); err != nil {
			return false, fmt.Errorf("replace chunks for %s: %w", doc.Path, err)
		}
	}
	lang := doc.Lang
	if lang == "" {
		lang = derefStrPtr(prep.Effective.TargetLanguage)
	}
	model := ""
	if doc.GenerationModel != nil {
		model = *doc.GenerationModel
	}
	contentID, err := commitStore.UpsertContentLayer(ctx, normalizeContentHash(body, lang), "", body, lang, model)
	if err != nil {
		return false, fmt.Errorf("content layer for %s: %w", doc.Path, err)
	}
	if err := commitStore.AttachContentChunks(ctx, contentID, doc.ID); err != nil {
		return false, fmt.Errorf("attach chunks for %s: %w", doc.Path, err)
	}
	swapped, err := commitStore.SwapAuditedChapterTx(ctx, BookAuditSwapInput{
		DocumentID:        doc.ID,
		RepositoryID:      prep.Doc.RepositoryID,
		NewContentID:      contentID,
		Content:           body,
		ExpectedContentID: doc.ContentID,
		ExpectedUpdatedAt: doc.UpdatedAt,
		AuthorID:          authorID,
		DualWrite:         cfg.ContentDualWrite,
	})
	if err != nil || !swapped {
		return swapped, err
	}
	if !cfg.ContentDualWrite {
		if err := commitStore.DeleteLegacyChunks(ctx, doc.ID); err != nil {
			log.Printf("[book-audit] legacy chunk cleanup degraded for %s: %v", doc.Path, err)
		}
	}
	if onIndexRefresh != nil {
		onIndexRefresh(prep.Doc.RepositoryID)
	}
	return true, nil
}

type introBlockKind int

const (
	introBlockProse introBlockKind = iota
	introBlockPreserved
)

type introBlock struct {
	Kind  introBlockKind
	Sep   string
	Raw   string
	Index int
}

func repairChapterIntro(ctx context.Context, llm LlmGatewayAPI, prep *PrepareResult, doc BookAuditDoc, defect bookAuditDefect, uid string) (string, error) {
	spanStart, spanEnd, blocks, trailing := splitIntroBlocks(doc.Content)
	if len(blocks) == 0 {
		return "", fmt.Errorf("intro span empty even after first-section fallback")
	}
	var introParts []string
	for _, b := range blocks {
		if b.Kind == introBlockProse {
			introParts = append(introParts, fmt.Sprintf("[%d]\n%s", b.Index, b.Raw))
		}
	}
	if len(introParts) == 0 {
		return "", fmt.Errorf("no editable prose paragraphs in intro for %s", doc.Path)
	}
	editableCount := len(introParts)

	targetLang := ""
	if prep != nil {
		targetLang = strings.TrimSpace(derefStrPtr(prep.Effective.TargetLanguage))
	}
	if targetLang == "" || targetLang == "none" {
		targetLang = "zh"
	}

	outline := BuildChapterOutlineSection(chapter.ParseModuleSnapshots(prep.Doc.RepoProfile["codeClusters"]), 0)
	res, err := withLlmRetry(ctx, func() (LlmTextResult, error) {
		return llm.Complete(ctx, "chapter_intro_repair", map[string]any{
			"chapterOutline": outline,
			"chapterTitle":   doc.Title,
			"chapterIndex":   chapterOrderOfPath(doc.Path),
			"totalChapters":  len(chapter.ParseModuleSnapshots(prep.Doc.RepoProfile["codeClusters"])),
			"introSection":   strings.Join(introParts, "\n\n"),
			"fixHint":        defect.FixHint,
			"targetLanguage": targetLang,
		}, &uid)
	})
	if err != nil {
		return "", err
	}

	var payload struct {
		Paragraphs []struct {
			Index int    `json:"index"`
			Text  string `json:"text"`
		} `json:"paragraphs"`
	}
	if err := json.Unmarshal([]byte(normalizeSlotRepairJSON(res.Text)), &payload); err != nil {
		return "", fmt.Errorf("parse intro repair JSON: %w", err)
	}
	if len(payload.Paragraphs) == 0 {
		return "", fmt.Errorf("intro repair returned no paragraphs")
	}

	updates := make(map[int]string, len(payload.Paragraphs))
	for _, p := range payload.Paragraphs {
		if p.Index < 1 || p.Index > editableCount {
			return "", fmt.Errorf("intro paragraph index %d out of range [1,%d]", p.Index, editableCount)
		}
		if _, dup := updates[p.Index]; dup {
			return "", fmt.Errorf("duplicate intro paragraph index %d", p.Index)
		}
		text := strings.TrimSpace(p.Text)
		if text == "" || introRewriteContainsForbiddenSyntax(text) {
			return "", fmt.Errorf("intro paragraph %d empty or contains fences/headings", p.Index)
		}
		updates[p.Index] = text
	}

	var sb strings.Builder
	for _, b := range blocks {
		sb.WriteString(b.Sep)
		if b.Kind == introBlockProse {
			if repl, ok := updates[b.Index]; ok {
				sb.WriteString(repl)
				continue
			}
		}
		sb.WriteString(b.Raw)
	}
	sb.WriteString(trailing)
	return doc.Content[:spanStart] + sb.String() + doc.Content[spanEnd:], nil
}

func introRewriteContainsForbiddenSyntax(text string) bool {
	if strings.Contains(text, "```") || strings.Contains(text, "~~~") {
		return true
	}
	for _, ln := range strings.Split(text, "\n") {
		if isMarkdownHeadingLine(strings.TrimSpace(ln)) {
			return true
		}
	}
	return false
}

// Ignores headings inside <details data-layer="deep"> so injected code sections remain on the main layer.
func findH2OffsetsOutsideFences(body string) []int {
	var offsets []int
	regionStart := 0
	for _, reg := range armor.SplitLayerRegions(body) {
		if !reg.IsFence && !reg.IsDeepDive {
			pos := 0
			text := reg.Text
			for pos < len(text) {
				nl := strings.IndexByte(text[pos:], '\n')
				var line string
				var nextPos int
				if nl < 0 {
					line = text[pos:]
					nextPos = len(text)
				} else {
					line = text[pos : pos+nl]
					nextPos = pos + nl + 1
				}
				trimmed := strings.TrimRight(line, "\r")
				if strings.HasPrefix(trimmed, "## ") || strings.HasPrefix(trimmed, "##\t") {
					offsets = append(offsets, regionStart+pos)
				}
				pos = nextPos
			}
		}
		regionStart += len(reg.Text)
	}
	return offsets
}

func locateIntroBounds(content string) (start, end int) {
	_, body := splitFrontmatter(content)
	bodyOffset := len(content) - len(body)
	h2s := findH2OffsetsOutsideFences(body)
	if len(h2s) == 0 {
		return 0, 0
	}
	if h2s[0] > 0 && strings.TrimSpace(body[:h2s[0]]) != "" {
		return bodyOffset, bodyOffset + h2s[0]
	}
	start = bodyOffset + h2s[0]
	if len(h2s) > 1 {
		return start, bodyOffset + h2s[1]
	}
	return start, len(content)
}

func splitIntroBlocks(content string) (spanStart, spanEnd int, blocks []introBlock, trailing string) {
	spanStart, spanEnd = locateIntroBounds(content)
	if spanEnd <= spanStart {
		return 0, 0, nil, ""
	}
	span := content[spanStart:spanEnd]
	regions := armor.SplitFencedRegions(span)

	var pendingSep strings.Builder
	proseIndex := 0

	for _, reg := range regions {
		if reg.IsFence {
			if reg.Text != "" {
				blocks = append(blocks, introBlock{
					Kind: introBlockPreserved,
					Sep:  pendingSep.String(),
					Raw:  reg.Text,
				})
				pendingSep.Reset()
			}
			continue
		}

		type blockState int
		const (
			stateNone blockState = iota
			stateProse
			statePreserved
		)
		state := stateNone
		var currSep string
		var currRaw strings.Builder
		var currTrailingNL string
		inDirective := false
		inHTMLComment := false
		var jsxStack []string
		pendingOpenTag := false

		flush := func() {
			if state == stateNone {
				return
			}
			kind := introBlockPreserved
			idx := 0
			if state == stateProse {
				kind = introBlockProse
				proseIndex++
				idx = proseIndex
			}
			blocks = append(blocks, introBlock{
				Kind:  kind,
				Sep:   currSep,
				Raw:   currRaw.String(),
				Index: idx,
			})
			pendingSep.WriteString(currTrailingNL)
			currSep = ""
			currRaw.Reset()
			currTrailingNL = ""
			state = stateNone
		}

		appendLine := func(newState blockState, line, nl string) {
			if state == stateNone {
				state = newState
				currSep = pendingSep.String()
				pendingSep.Reset()
				currRaw.WriteString(line)
				currTrailingNL = nl
				return
			}
			currRaw.WriteString(currTrailingNL)
			currRaw.WriteString(line)
			currTrailingNL = nl
		}

		text := reg.Text
		pos := 0
		for pos < len(text) {
			nlIdx := strings.IndexByte(text[pos:], '\n')
			var line, nl string
			if nlIdx < 0 {
				line = text[pos:]
				nl = ""
				pos = len(text)
			} else {
				line = text[pos : pos+nlIdx]
				nl = "\n"
				pos = pos + nlIdx + 1
			}
			trimmed := strings.TrimSpace(strings.TrimRight(line, "\r"))

			if inDirective {
				appendLine(statePreserved, line, nl)
				if trimmed == ":::" {
					inDirective = false
					flush()
				}
				continue
			}
			if inHTMLComment {
				appendLine(statePreserved, line, nl)
				if strings.Contains(trimmed, "-->") {
					inHTMLComment = false
					flush()
				}
				continue
			}
			if len(jsxStack) > 0 || pendingOpenTag {
				appendLine(statePreserved, line, nl)
				jsxStack, pendingOpenTag = updateJSXStack(line, jsxStack, pendingOpenTag)
				if len(jsxStack) == 0 && !pendingOpenTag {
					flush()
				}
				continue
			}

			if trimmed == "" {
				flush()
				pendingSep.WriteString(line)
				pendingSep.WriteString(nl)
				continue
			}

			if isMarkdownHeadingLine(trimmed) || isHorizontalRuleLine(trimmed) {
				flush()
				appendLine(statePreserved, line, nl)
				flush()
				continue
			}

			if strings.HasPrefix(trimmed, ":::") {
				flush()
				appendLine(statePreserved, line, nl)
				inDirective = true
				continue
			}

			if strings.HasPrefix(trimmed, "<") {
				flush()
				appendLine(statePreserved, line, nl)
				if strings.HasPrefix(trimmed, "<!--") {
					if !strings.Contains(trimmed, "-->") {
						inHTMLComment = true
					} else {
						flush()
					}
					continue
				}
				jsxStack, pendingOpenTag = updateJSXStack(line, jsxStack, pendingOpenTag)
				if len(jsxStack) == 0 && !pendingOpenTag {
					flush()
				}
				continue
			}

			if isStructuralProseBreaker(trimmed) {
				if state == stateProse {
					flush()
				}
				appendLine(statePreserved, line, nl)
				continue
			}

			if state == statePreserved {
				appendLine(statePreserved, line, nl)
				continue
			}
			appendLine(stateProse, line, nl)
		}
		flush()
	}

	return spanStart, spanEnd, blocks, pendingSep.String()
}

func isMarkdownHeadingLine(trimmed string) bool {
	if trimmed == "" || trimmed[0] != '#' {
		return false
	}
	n := 0
	for n < len(trimmed) && trimmed[n] == '#' {
		n++
	}
	if n > 6 {
		return false
	}
	return n == len(trimmed) || trimmed[n] == ' ' || trimmed[n] == '\t'
}

func isHorizontalRuleLine(trimmed string) bool {
	if len(trimmed) < 3 {
		return false
	}
	ch := trimmed[0]
	if ch != '-' && ch != '*' && ch != '_' {
		return false
	}
	count := 0
	for i := 0; i < len(trimmed); i++ {
		if trimmed[i] == ch {
			count++
		} else if trimmed[i] != ' ' && trimmed[i] != '\t' {
			return false
		}
	}
	return count >= 3
}

func isStructuralProseBreaker(trimmed string) bool {
	if strings.HasPrefix(trimmed, ">") || strings.HasPrefix(trimmed, "|") {
		return true
	}
	if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") || strings.HasPrefix(trimmed, "+ ") ||
		trimmed == "-" || trimmed == "*" || trimmed == "+" ||
		strings.HasPrefix(trimmed, "-\t") || strings.HasPrefix(trimmed, "*\t") || strings.HasPrefix(trimmed, "+\t") {
		return true
	}
	i := 0
	for i < len(trimmed) && trimmed[i] >= '0' && trimmed[i] <= '9' {
		i++
	}
	if i > 0 && i+1 < len(trimmed) && (trimmed[i] == '.' || trimmed[i] == ')') && (trimmed[i+1] == ' ' || trimmed[i+1] == '\t') {
		return true
	}
	return false
}

var htmlVoidTags = map[string]bool{
	"area": true, "base": true, "br": true, "col": true, "embed": true,
	"hr": true, "img": true, "input": true, "link": true, "meta": true,
	"param": true, "source": true, "track": true, "wbr": true,
}

func updateJSXStack(line string, stack []string, pendingOpen bool) ([]string, bool) {
	i := 0
	if pendingOpen {
		gt := strings.IndexByte(line, '>')
		if gt < 0 {
			return stack, true
		}
		if gt > 0 && line[gt-1] == '/' && len(stack) > 0 {
			stack = stack[:len(stack)-1]
		}
		pendingOpen = false
		i = gt + 1
	}
	for i < len(line) {
		lt := strings.IndexByte(line[i:], '<')
		if lt < 0 {
			break
		}
		pos := i + lt
		if strings.HasPrefix(line[pos:], "<!--") {
			if end := strings.Index(line[pos+4:], "-->"); end >= 0 {
				i = pos + 4 + end + 3
				continue
			}
			break
		}
		if pos+1 >= len(line) {
			break
		}
		if line[pos+1] == '/' {
			end := pos + 2
			for end < len(line) && isTagNameChar(line[end]) {
				end++
			}
			name := line[pos+2 : end]
			for j := len(stack) - 1; j >= 0; j-- {
				if stack[j] == name {
					stack = stack[:j]
					break
				}
			}
			if gt := strings.IndexByte(line[end:], '>'); gt >= 0 {
				i = end + gt + 1
			} else {
				i = end
			}
			continue
		}
		if !isTagStartChar(line[pos+1]) {
			i = pos + 1
			continue
		}
		end := pos + 1
		for end < len(line) && isTagNameChar(line[end]) {
			end++
		}
		name := line[pos+1 : end]
		gt := strings.IndexByte(line[end:], '>')
		if gt < 0 {
			if !htmlVoidTags[strings.ToLower(name)] {
				stack = append(stack, name)
				pendingOpen = true
			}
			break
		}
		closeIdx := end + gt
		selfClosing := closeIdx > end && line[closeIdx-1] == '/'
		if !selfClosing && !htmlVoidTags[strings.ToLower(name)] {
			stack = append(stack, name)
		}
		i = closeIdx + 1
	}
	return stack, pendingOpen
}

func isTagStartChar(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

func isTagNameChar(b byte) bool {
	return isTagStartChar(b) || (b >= '0' && b <= '9') || b == '_' || b == '-' || b == '.'
}

func chapterOrderOfPath(path string) string {
	digits := docPathDigitsRe.FindString(baseName(path))
	if digits == "" {
		return "1"
	}
	return digits
}

func baseName(p string) string {
	if idx := strings.LastIndex(p, "/"); idx >= 0 {
		return p[idx+1:]
	}
	return p
}

// Prefers the chapter's own gitSha so incremental repo updates do not hydrate old chapters with newer source.
func resolveChapterGitRef(docGitSha, repoGitSha *string, branch string) (sha string, ref string) {
	sha = strings.TrimSpace(derefStr(docGitSha))
	if sha == "" {
		sha = strings.TrimSpace(derefStr(repoGitSha))
	}
	ref = branch
	if sha != "" {
		ref = sha
	}
	return sha, ref
}

func insertSectionBeforeLastH2(content, section string) string {
	section = strings.TrimSpace(section)
	_, body := splitFrontmatter(content)
	bodyOffset := len(content) - len(body)
	h2s := findH2OffsetsOutsideFences(body)
	if len(h2s) == 0 {
		return strings.TrimRight(content, "\n") + "\n\n" + section + "\n"
	}
	insertAt := bodyOffset + h2s[len(h2s)-1]
	before := strings.TrimRight(content[:insertAt], "\n")
	after := strings.TrimLeft(content[insertAt:], "\n")
	if before == "" {
		return section + "\n\n" + after
	}
	return before + "\n\n" + section + "\n\n" + after
}

func enrichChapterCode(ctx context.Context, cfg Config, deps BodyDeps, prep *PrepareResult, doc BookAuditDoc, defect bookAuditDefect, uid string) (string, error) {
	snapshot := chapter.ResolveModuleSnapshotFromProfile(prep.Doc.RepoProfile, doc.Path, doc.Title)
	if snapshot == nil || len(snapshot.Files) == 0 {
		return "", fmt.Errorf("no allocated source files for %s", doc.Path)
	}
	sha, ref := resolveChapterGitRef(doc.GitSha, prep.Doc.Repository.GitSha, prep.Doc.Repository.Branch)
	refs := make([]armor.ArmorFileRef, 0, len(snapshot.Files))
	snippets := chapter.PackModuleFilesFromArchive(cfg.ArchiveRoot, prep.Doc.Repository.Owner, prep.Doc.Repository.Repo, ref, snapshot.Files)
	if len(snippets) > 0 {
		for _, s := range snippets {
			refs = append(refs, armor.ArmorFileRef{Path: s.Path})
		}
	} else {
		for _, p := range snapshot.Files {
			refs = append(refs, armor.ArmorFileRef{Path: p})
		}
	}

	index := buildGroundingIndexWithDeps(ctx, cfg.ArchiveRoot, cfg.SemanticGraphDir,
		prep.Doc.Repository.Owner, prep.Doc.Repository.Repo,
		sha, prep.Doc.Repository.Branch, snapshot.Files, snippets,
		deps.GraphRepo, deps.ExtractFileSymbols)

	callEdges := loadChapterCallEdges(cfg.SemanticGraphDir, prep.Doc.Repository.Owner, prep.Doc.Repository.Repo, sha)
	ranks := chapter.RankChapterSymbols(index.SymbolsByFile, callEdges, snapshot.Files)

	res, err := withLlmRetry(ctx, func() (LlmTextResult, error) {
		return deps.Llm.Complete(ctx, "chapter_code_enrich", map[string]any{
			"fileMenu":      buildSlotFileMenu(refs, index, ranks),
			"sectionTitles": sectionTitlesOf(doc.Content),
			"fixHint":       defect.FixHint,
		}, &uid)
	})
	if err != nil {
		return "", err
	}
	var payload struct {
		SectionTitle string `json:"sectionTitle"`
		LeadIn       string `json:"leadIn"`
		Slots        []struct {
			FileIndex   int    `json:"fileIndex"`
			Anchor      string `json:"anchor"`
			Aspect      string `json:"aspect"`
			Explanation string `json:"explanation"`
		} `json:"slots"`
	}
	if err := json.Unmarshal([]byte(normalizeSlotRepairJSON(res.Text)), &payload); err != nil {
		return "", fmt.Errorf("parse enrich JSON: %w", err)
	}
	title := strings.TrimSpace(payload.SectionTitle)
	if title == "" || len(payload.Slots) == 0 {
		return "", fmt.Errorf("enrich payload invalid")
	}
	lead := strings.TrimSpace(payload.LeadIn)
	if lead != "" && introRewriteContainsForbiddenSyntax(lead) {
		return "", fmt.Errorf("enrich leadIn contains fences or headings")
	}

	type acceptedSlot struct {
		fenceHeader string
		explanation string
	}
	accepted := make([]acceptedSlot, 0, bookAuditEnrichMaxSlots)
	seen := make(map[string]bool, bookAuditEnrichMaxSlots)
	for _, slot := range payload.Slots {
		anchor := strings.TrimSpace(slot.Anchor)
		aspect, err := validateSlotAnchor(slot.FileIndex, anchor, slot.Aspect, refs, index)
		if err != nil {
			return "", fmt.Errorf("slot rejected: %w", err)
		}
		key := fmt.Sprintf("%d#%s", slot.FileIndex, anchor)
		if seen[key] {
			continue
		}
		seen[key] = true
		expl := strings.TrimSpace(slot.Explanation)
		if expl != "" && introRewriteContainsForbiddenSyntax(expl) {
			return "", fmt.Errorf("slot explanation contains fences or headings")
		}
		cleanPath, _ := mdpat.SplitPathAnchor(refs[slot.FileIndex-1].Path)
		if cleanPath == "" {
			cleanPath = refs[slot.FileIndex-1].Path
		}
		accepted = append(accepted, acceptedSlot{
			fenceHeader: synthSlotFenceHeader(detectFenceLangForPath(cleanPath), slot.FileIndex, anchor, aspect),
			explanation: expl,
		})
		if len(accepted) >= bookAuditEnrichMaxSlots {
			break
		}
	}

	var sb strings.Builder
	sb.WriteString("## " + title + "\n\n")
	if lead != "" {
		sb.WriteString(lead + "\n\n")
	}
	for _, item := range accepted {
		if item.explanation != "" {
			sb.WriteString(item.explanation + "\n\n")
		}
		sb.WriteString(item.fenceHeader + "\n```\n\n")
	}
	return insertSectionBeforeLastH2(doc.Content, sb.String()), nil
}

func detectFenceLangForPath(path string) string {
	return armor.DetectSourceLanguage(path)
}

func sectionTitlesOf(content string) string {
	var titles []string
	for _, reg := range armor.SplitFencedRegions(content) {
		if reg.IsFence {
			continue
		}
		for _, ln := range strings.Split(reg.Text, "\n") {
			t := strings.TrimSpace(ln)
			if strings.HasPrefix(t, "## ") {
				titles = append(titles, strings.TrimSpace(t[3:]))
				if len(titles) >= 20 {
					return strings.Join(titles, " | ")
				}
			}
		}
	}
	return strings.Join(titles, " | ")
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func regateChapterContent(ctx context.Context, cfg Config, deps BodyDeps, prep *PrepareResult, docPath string, docGitSha *string, content string) (string, error) {
	snapshot := chapter.ResolveModuleSnapshotFromProfile(prep.Doc.RepoProfile, docPath, "")
	filePaths := []string{docPath}
	if snapshot != nil && len(snapshot.Files) > 0 {
		filePaths = snapshot.Files
	}
	sha, ref := resolveChapterGitRef(docGitSha, prep.Doc.Repository.GitSha, prep.Doc.Repository.Branch)
	snippets := chapter.PackModuleFilesFromArchive(cfg.ArchiveRoot, prep.Doc.Repository.Owner, prep.Doc.Repository.Repo, ref, filePaths)
	refs := make([]armor.ArmorFileRef, 0, len(filePaths))
	if len(snippets) > 0 {
		for _, s := range snippets {
			refs = append(refs, armor.ArmorFileRef{Path: s.Path})
		}
	} else {
		for _, p := range filePaths {
			refs = append(refs, armor.ArmorFileRef{Path: p})
		}
	}

	index := buildGroundingIndexWithDeps(ctx, cfg.ArchiveRoot, cfg.SemanticGraphDir,
		prep.Doc.Repository.Owner, prep.Doc.Repository.Repo,
		sha, prep.Doc.Repository.Branch, filePaths, snippets,
		deps.GraphRepo, deps.ExtractFileSymbols)

	codeResolver := buildCodeResolver(codeResolverDeps{
		archiveRoot:    cfg.ArchiveRoot,
		owner:          prep.Doc.Repository.Owner,
		repo:           prep.Doc.Repository.Repo,
		ref:            ref,
		branch:         prep.Doc.Repository.Branch,
		snippets:       snippets,
		groundingIndex: index,
	}, nil)

	pipeline := MdxConvergencePipeline{
		LlmClient:     deps.Llm,
		RepairPurpose: "mdx_repair",
		DocPath:       docPath,
		Refs:          refs,
		CodeResolver:  codeResolver,
	}
	res := pipeline.Execute(ctx, content, nil, false)
	if res.ValidationError != "" {
		return "", fmt.Errorf("regate validation: %s", res.ValidationError)
	}
	if residuals := armor.ScanResidualCodeSlots(res.FinalContent); len(residuals) > 0 {
		return "", fmt.Errorf("regate residual slots: %d", len(residuals))
	}
	if report := verifyGrounding(res.FinalContent, index); groundingHasHallucination(report) {
		return "", fmt.Errorf("regate hallucination persists")
	}
	return res.FinalContent, nil
}
