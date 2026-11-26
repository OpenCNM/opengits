package transcription

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strings"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/chapter"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

type GroundingGateOutcome string

const (
	GroundingPassed       GroundingGateOutcome = "passed"
	GroundingSlotRepaired GroundingGateOutcome = "slot_repaired"
	GroundingRewritten    GroundingGateOutcome = "rewritten"
	GroundingRejected     GroundingGateOutcome = "rejected"
)

type GroundingLedger struct {
	DocPath       string
	CallID        string
	RewriteCallID string
	Outcome       GroundingGateOutcome
	AnchorsIn     int
	Grounded      int
	Disambiguated int
	Snapped       int
	Invalid       int
	Retries       int
	Slots         int
	Report        cognitive.GroundingReport
	MainAnchored  int
	DeepAnchored  int
	DeepBlocks    int
	DeepDives     int
	DenseParas    int
	BriefState    string
}

func (l GroundingLedger) LogLine() string {
	return fmt.Sprintf(
		"[grounding] doc=%s call=%s rewrite_call=%s outcome=%s anchors_in=%d grounded=%d disambiguated=%d snapped=%d invalid=%d retries=%d slots=%d main_anchored=%d deep_anchored=%d deep_blocks=%d deep_dives=%d dense_paras=%d brief_state=%s",
		l.DocPath, l.CallID, l.RewriteCallID, l.Outcome,
		l.AnchorsIn, l.Grounded, l.Disambiguated, l.Snapped, l.Invalid, l.Retries, l.Slots,
		l.MainAnchored, l.DeepAnchored, l.DeepBlocks, l.DeepDives, l.DenseParas, l.BriefState,
	)
}

func groundingHasHallucination(report cognitive.GroundingReport) bool {
	return len(report.HallucinatedFiles) > 0 || len(report.HallucinatedSymbols) > 0
}

type GroundingRejectError struct {
	DocPath             string
	HallucinatedFiles   []string
	HallucinatedSymbols []cognitive.SymbolClaim
	ResidualSlots       []armor.ResidualSlot
}

func (e *GroundingRejectError) Error() string {
	parts := make([]string, 0, len(e.HallucinatedFiles)+len(e.HallucinatedSymbols)+len(e.ResidualSlots))
	for _, f := range e.HallucinatedFiles {
		parts = append(parts, fmt.Sprintf("file '%s' not in repository", f))
	}
	for _, s := range e.HallucinatedSymbols {
		parts = append(parts, fmt.Sprintf("symbol '%s' not declared in '%s'", s.Symbol, s.File))
	}
	for _, r := range e.ResidualSlots {
		parts = append(parts, fmt.Sprintf("unhydrated code slot remains (block #%d, %s)", r.BlockIndex, r.Kind))
	}
	return fmt.Sprintf("hallucinations persist after rewrite for %s: %s", e.DocPath, strings.Join(parts, "; "))
}

func buildGroundingIndexWithDeps(
	ctx context.Context,
	archiveRoot, graphDir, owner, repo, sha, branch string,
	chapterFilePaths []string,
	snippets []armor.ArmorAllocatedSnippet,
	graphRepo cognitive.GraphArtifactRepo,
	extractSymbols func(content, filePath string) []cognitive.SymbolEntry,
) cognitive.GroundingIndex {
	if graphRepo != nil && graphDir != "" && owner != "" && repo != "" && sha != "" {
		if _, err := cognitive.OpenSemanticGraphArtifactLazy(graphDir, owner, repo, sha); err != nil {
			if _, lerr := cognitive.LoadSemanticGraphArtifact(graphDir, owner, repo, sha); lerr != nil {
				if persisted, derr := graphRepo.LoadArtifact(ctx, owner, repo, sha); derr == nil && persisted != nil {
					_, _ = cognitive.SaveSemanticGraphArtifact(graphDir, owner, repo, sha, persisted)
				}
			}
		}
	}

	idx := buildGroundingIndex(graphDir, owner, repo, sha, chapterFilePaths)
	if extractSymbols == nil || len(chapterFilePaths) == 0 && len(snippets) == 0 {
		return idx
	}

	snippetByPath := make(map[string]string, len(snippets))
	for _, s := range snippets {
		cleanP, _ := mdpat.SplitPathAnchor(s.Path)
		if cleanP != "" && s.Snippet != "" && snippetByPath[cleanP] == "" {
			snippetByPath[cleanP] = s.Snippet
		}
	}

	candSet := make(map[string]bool, len(chapterFilePaths)+len(snippets))
	var candPaths []string
	for _, rawP := range chapterFilePaths {
		cleanP, _ := mdpat.SplitPathAnchor(rawP)
		if cleanP != "" && !candSet[cleanP] {
			candSet[cleanP] = true
			candPaths = append(candPaths, cleanP)
		}
	}
	for cleanP := range snippetByPath {
		if !candSet[cleanP] {
			candSet[cleanP] = true
			candPaths = append(candPaths, cleanP)
		}
	}

	newFileSymbols := make(map[string][]cognitive.SymbolEntry)
	for _, cleanP := range candPaths {
		if len(idx.SymbolsByFile[cleanP]) > 0 {
			continue
		}
		var raw string
		if archiveRoot != "" && owner != "" && repo != "" {
			for _, ref := range []string{sha, branch} {
				if ref == "" {
					continue
				}
				if raw = chapter.ReadLocalArchiveFile(archiveRoot, owner, repo, ref, cleanP); raw != "" {
					break
				}
			}
		}
		if raw == "" {
			raw = snippetByPath[cleanP]
		}
		if raw == "" {
			continue
		}
		syms := extractSymbols(raw, cleanP)
		if len(syms) == 0 {
			continue
		}
		if idx.SymbolsByFile == nil {
			idx.SymbolsByFile = make(map[string][]cognitive.SymbolEntry)
		}
		idx.SymbolsByFile[cleanP] = syms
		newFileSymbols[cleanP] = syms
	}

	if len(newFileSymbols) > 0 {
		if incRepo, ok := graphRepo.(cognitive.IncrementalGraphRepo); ok && owner != "" && repo != "" && sha != "" {
			if merged, err := incRepo.MergeFileSymbols(ctx, owner, repo, sha, newFileSymbols); err == nil && merged != nil && graphDir != "" {
				_, _ = cognitive.SaveSemanticGraphArtifact(graphDir, owner, repo, sha, merged)
			}
		}
	}
	return idx
}

// Prefers full-repo semantic graph to avoid false hallucinations; missing/corrupt graph fails open to chapter files.
func buildGroundingIndex(graphDir, owner, repo, sha string, chapterFilePaths []string) cognitive.GroundingIndex {
	if graphDir == "" || owner == "" || repo == "" || sha == "" {
		return cognitive.GroundingIndex{Paths: append([]string(nil), chapterFilePaths...)}
	}
	if lz, lerr := cognitive.OpenSemanticGraphArtifactLazy(graphDir, owner, repo, sha); lerr == nil {
		defer lz.Close()
		if idx, ierr := groundingIndexFromLazy(lz, chapterFilePaths); ierr == nil {
			return idx
		}
	}
	artifact, err := cognitive.LoadSemanticGraphArtifact(graphDir, owner, repo, sha)
	if err != nil || artifact == nil {
		log.Printf("[grounding] semantic graph artifact unavailable for %s/%s@%s, fail-open to chapter file scope: %v", owner, repo, sha, err)
		return cognitive.GroundingIndex{Paths: append([]string(nil), chapterFilePaths...)}
	}
	paths := make([]string, 0, len(artifact.Nodes)+len(chapterFilePaths))
	seen := make(map[string]bool, len(artifact.Nodes)+len(chapterFilePaths))
	for _, node := range artifact.Nodes {
		if node.Path != "" && !seen[node.Path] {
			seen[node.Path] = true
			paths = append(paths, node.Path)
		}
	}
	for _, p := range chapterFilePaths {
		if p != "" && !seen[p] {
			seen[p] = true
			paths = append(paths, p)
		}
	}
	return cognitive.GroundingIndex{Paths: paths, SymbolsByFile: artifact.SymbolsByFile}
}

// Missing or v2 call edges return nil so symbol ranking falls back cleanly to declaration order.
func loadChapterCallEdges(graphDir, owner, repo, sha string) []cognitive.CallEdge {
	if graphDir == "" || owner == "" || repo == "" || sha == "" {
		return nil
	}
	lz, err := cognitive.OpenSemanticGraphArtifactLazy(graphDir, owner, repo, sha)
	if err != nil {
		return nil
	}
	defer func() {
		_ = lz.Close()
	}()
	edges, err := lz.CallEdges()
	if err != nil {
		return nil
	}
	return edges
}

func groundingIndexFromLazy(lz *cognitive.LazyArtifact, chapterFilePaths []string) (cognitive.GroundingIndex, error) {
	nodes, err := lz.Nodes()
	if err != nil {
		return cognitive.GroundingIndex{}, err
	}
	paths := make([]string, 0, len(nodes)+len(chapterFilePaths))
	seen := make(map[string]bool, len(nodes)+len(chapterFilePaths))
	for _, node := range nodes {
		if node.Path != "" && !seen[node.Path] {
			seen[node.Path] = true
			paths = append(paths, node.Path)
		}
	}
	for _, p := range chapterFilePaths {
		if p != "" && !seen[p] {
			seen[p] = true
			paths = append(paths, p)
		}
	}
	symbolsByFile := make(map[string][]cognitive.SymbolEntry, len(seen))
	for _, f := range lz.Files() {
		entries, serr := lz.SymbolsForFile(f)
		if serr != nil {
			return cognitive.GroundingIndex{}, serr
		}
		symbolsByFile[f] = entries
	}
	return cognitive.GroundingIndex{Paths: paths, SymbolsByFile: symbolsByFile}, nil
}

var resolvedFenceSymbolRe = regexp.MustCompile("(?m)^(?:`{3,}|~{3,})[a-zA-Z0-9_-]*[ \\t]*(?://|#|--)[ \\t]*([^\\s#]+)#([a-zA-Z0-9_$]+)[ \\t]*$")

func extractSymbolClaims(mdxContent string) []cognitive.SymbolClaim {
	claims := make([]cognitive.SymbolClaim, 0)
	seen := make(map[string]bool)
	for _, m := range resolvedFenceSymbolRe.FindAllStringSubmatch(mdxContent, -1) {
		path, symbol := m[1], m[2]
		if path == "" || symbol == "" {
			continue
		}
		key := path + "#" + symbol
		if seen[key] {
			continue
		}
		seen[key] = true
		claims = append(claims, cognitive.SymbolClaim{File: path, Symbol: symbol})
	}
	return claims
}

func verifyGrounding(mdxContent string, index cognitive.GroundingIndex) cognitive.GroundingReport {
	claimedFiles := cognitive.ExtractClaimedPathsFromMdx(mdxContent)
	symbolClaims := extractSymbolClaims(mdxContent)
	return cognitive.VerifyFactGrounding(claimedFiles, symbolClaims, index)
}

type groundingGateParams struct {
	Ctx              context.Context
	Llm              LlmGatewayAPI
	RewriteCtx       context.Context
	Uid              *string
	Vars             map[string]any
	Pipeline         *MdxConvergencePipeline
	Index            cognitive.GroundingIndex
	Ranks            map[string]chapter.FileRank
	Refs             []armor.ArmorFileRef
	DocPath          string
	ChapterFilePaths []string
	FirstPass        MdxConvergenceResult
	FirstCallID      string
	FirstBriefState  string
	SnappedSlots     *int
	OnRewrite        func()
}

func formatGroundingFeedbackWithIndex(report cognitive.GroundingReport, index cognitive.GroundingIndex, ranks map[string]chapter.FileRank) *string {
	base := cognitive.FormatGroundingFeedback(report)
	if base == nil || len(report.HallucinatedSymbols) == 0 {
		return base
	}
	var extra []string
	seenFiles := make(map[string]bool, len(report.HallucinatedSymbols))
	for _, h := range report.HallucinatedSymbols {
		cleanFile, _ := mdpat.SplitPathAnchor(h.File)
		if cleanFile == "" {
			cleanFile = h.File
		}
		if cleanFile == "" || seenFiles[cleanFile] {
			continue
		}
		seenFiles[cleanFile] = true
		entries := chapter.RankedFileSymbols(index.SymbolsByFile, ranks, cleanFile, 15)
		if len(entries) == 0 {
			extra = append(extra, fmt.Sprintf("- No AST symbols are indexed for '%s'; use a line range anchor (#Lx-Ly) instead of #Symbol.", cleanFile))
			continue
		}
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name)
		}
		extra = append(extra, fmt.Sprintf("- Declared AST symbols in '%s' (or use #Lx-Ly): %s", cleanFile, strings.Join(names, ", ")))
	}
	if len(extra) == 0 {
		return base
	}
	combined := *base + "\n" + strings.Join(extra, "\n")
	return &combined
}

// Tier-4 gate: L1 snap pass -> L1.5 slot micro-repair -> single L2 rewrite -> L3 fail-closed rejection.
func runGroundingGate(p groundingGateParams) (MdxConvergenceResult, GroundingLedger, error) {
	report := verifyGrounding(p.FirstPass.FinalContent, p.Index)
	residuals := armor.ScanResidualCodeSlots(p.FirstPass.FinalContent)
	slotsDetected := len(residuals)

	if !groundingHasHallucination(report) && slotsDetected == 0 {
		return p.FirstPass, buildGroundingLedger(p, report, GroundingPassed, "", 0, slotsDetected, p.FirstPass.FinalContent), nil
	}

	if canSlotRepair(report, residuals) {
		if repaired, repairCallID, ok := p.trySlotLevelRepair(report, residuals); ok {
			repairedReport := verifyGrounding(repaired.FinalContent, p.Index)
			repairedResiduals := armor.ScanResidualCodeSlots(repaired.FinalContent)
			if repaired.ValidationError == "" && !groundingHasHallucination(repairedReport) && len(repairedResiduals) == 0 {
				return repaired, buildGroundingLedger(p, repairedReport, GroundingSlotRepaired, repairCallID, 0, slotsDetected, repaired.FinalContent), nil
			}
			log.Printf("[grounding] slot repair incomplete for %s (%d residuals remain), escalating to L2", p.DocPath, len(repairedResiduals))
		}
	}

	feedback := formatGroundingFeedbackWithIndex(report, p.Index, p.Ranks)
	if residualFeedback := formatResidualSlotsFeedback(residuals); residualFeedback != "" {
		if feedback == nil {
			combined := residualFeedback
			feedback = &combined
		} else {
			combined := *feedback + "\n" + residualFeedback
			feedback = &combined
		}
	}
	if feedback == nil {
		return p.FirstPass, buildGroundingLedger(p, report, GroundingPassed, "", 0, slotsDetected, p.FirstPass.FinalContent), nil
	}
	log.Printf("[grounding] rewrite triggered for %s: %d hallucinated files, %d hallucinated symbols, %d residual slots",
		p.DocPath, len(report.HallucinatedFiles), len(report.HallucinatedSymbols), slotsDetected)
	if p.OnRewrite != nil {
		p.OnRewrite()
	}
	// Sets skipMetaCompiler=true on L2 rewrite so targeted repair does not re-run the 40K planner.
	rewriteVars := make(map[string]any, len(p.Vars)+2)
	for k, v := range p.Vars {
		rewriteVars[k] = v
	}
	rewriteVars["groundingFeedback"] = *feedback
	rewriteVars["skipMetaCompiler"] = true
	rewriteRes, err := withLlmRetry(p.Ctx, func() (LlmTextResult, error) {
		return p.Llm.Complete(p.RewriteCtx, "code_chapter_lesson", rewriteVars, p.Uid)
	})
	if err != nil {
		return MdxConvergenceResult{}, GroundingLedger{}, err
	}

	rewriteTruncated := rewriteRes.FinishReason == "length"
	rewriteConv := p.Pipeline.Execute(p.Ctx, rewriteRes.Text, p.Uid, rewriteTruncated)
	rewriteReport := verifyGrounding(rewriteConv.FinalContent, p.Index)
	rewriteResiduals := armor.ScanResidualCodeSlots(rewriteConv.FinalContent)
	if !groundingHasHallucination(rewriteReport) && len(rewriteResiduals) == 0 {
		return rewriteConv, buildGroundingLedger(p, rewriteReport, GroundingRewritten, rewriteRes.CallID, 1, slotsDetected, rewriteConv.FinalContent), nil
	}

	return rewriteConv, buildGroundingLedger(p, rewriteReport, GroundingRejected, rewriteRes.CallID, 1, slotsDetected, rewriteConv.FinalContent),
		&GroundingRejectError{
			DocPath:             p.DocPath,
			HallucinatedFiles:   append([]string(nil), rewriteReport.HallucinatedFiles...),
			HallucinatedSymbols: append([]cognitive.SymbolClaim(nil), rewriteReport.HallucinatedSymbols...),
			ResidualSlots:       append([]armor.ResidualSlot(nil), rewriteResiduals...),
		}
}

func formatResidualSlotsFeedback(residuals []armor.ResidualSlot) string {
	if len(residuals) == 0 {
		return ""
	}
	lines := []string{
		"[UNHYDRATED CODE SLOT DEFECTS — MANDATORY FIX]",
		"The following code blocks remain unhydrated placeholders or defective empty blocks:",
	}
	for _, r := range residuals {
		where := fmt.Sprintf("code block #%d", r.BlockIndex)
		if r.BlockIndex == 0 {
			where = "a standalone placeholder in prose"
		}
		lines = append(lines, fmt.Sprintf("- %s (%s): %s", where, r.Kind, r.Snippet))
	}
	lines = append(lines, "Fix each defective block: put its [File N#anchor(:aspect)] handle ON the fence opening line (e.g. ```ts // [File 2#InitScheduler:core]) with an empty body, or remove the block entirely. NEVER write file paths or (Lx-Ly) inside a CODE_SLOT comment.")
	return strings.Join(lines, "\n")
}

func normalizeBriefState(raw string) string {
	switch strings.TrimSpace(raw) {
	case "plan":
		return "plan"
	case "arc":
		return "arc"
	default:
		return ""
	}
}

func buildGroundingLedger(p groundingGateParams, report cognitive.GroundingReport, outcome GroundingGateOutcome, rewriteCallID string, retries int, slotsDetected int, content string) GroundingLedger {
	fuzzy := 0
	for _, w := range report.Warnings {
		if strings.HasPrefix(w, "Fuzzy-aligned") {
			fuzzy++
		}
	}
	snapped := 0
	if p.SnappedSlots != nil {
		snapped = *p.SnappedSlots
	}
	_, body := splitFrontmatter(content)
	layers := armor.MeasureLayers(body)
	return GroundingLedger{
		DocPath:       p.DocPath,
		CallID:        p.FirstCallID,
		RewriteCallID: rewriteCallID,
		BriefState:    normalizeBriefState(p.FirstBriefState),
		Outcome:       outcome,
		AnchorsIn:     len(report.GroundedFiles) + len(report.HallucinatedFiles) + len(report.GroundedSymbols) + len(report.HallucinatedSymbols),
		Grounded:      len(report.GroundedFiles) + len(report.GroundedSymbols),
		Disambiguated: len(report.AmbiguousAlignments) + fuzzy,
		Snapped:       snapped,
		Invalid:       len(report.HallucinatedFiles) + len(report.HallucinatedSymbols),
		Retries:       retries,
		Slots:         slotsDetected,
		Report:        report,
		MainAnchored:  layers.MainAnchored,
		DeepAnchored:  layers.DeepAnchored,
		DeepBlocks:    layers.DeepBlocks,
		DeepDives:     layers.DeepDives,
		DenseParas:    layers.DenseParas,
	}
}

// Intersects grounded paths with chapter files so full-repo graph hits never leak into chapter SourceFiles.
func intersectChapterSourceFiles(report cognitive.GroundingReport, chapterFilePaths []string) []string {
	if len(report.GroundedFiles) == 0 {
		return chapterFilePaths
	}
	scope := make(map[string]bool, len(chapterFilePaths))
	for _, p := range chapterFilePaths {
		scope[p] = true
	}
	out := make([]string, 0, len(chapterFilePaths))
	seen := make(map[string]bool, len(report.GroundedFiles))
	for _, p := range report.GroundedFiles {
		base, _ := mdpat.SplitPathAnchor(p)
		if base != "" && scope[base] && !seen[base] {
			seen[base] = true
			out = append(out, base)
		}
	}
	if len(out) == 0 {
		return chapterFilePaths
	}
	return out
}
