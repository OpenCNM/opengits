package pipeline

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/mdx"
	"github.com/opengits/worker-sidecar/internal/platform/client"
)

const (
	sentinelBegin = "===CONTENT_BEGIN==="
	sentinelEnd   = "===CONTENT_END==="
)

var fenceOpenLangRe = mdpat.FenceOpenLangRe
var fenceCloseRe = mdpat.FenceCloseBareRe

func ExtractBySentinel(text string) string {
	res, _ := StripPayloadShell(text)
	return res
}

func extractBySentinel(text string) string {
	return ExtractBySentinel(text)
}

type LlmTextResult = client.LlmTextResult

type LlmCompleter = client.LlmCompleter

type ConceptManifest = concept.ExtractedManifestResult

func ExtractConceptManifest(rawContent string, docPath string) ConceptManifest {
	return concept.ExtractConceptManifest(rawContent, docPath)
}

type MdxConvergencePipeline struct {
	LlmClient            LlmCompleter
	RepairPurpose        string
	DocPath              string
	Refs                 []armor.ArmorFileRef
	FallbackBuilder      func() string
	Validator            func(string) (bool, string)
	ArchitectureSkeleton string
	CodeResolver         armor.CodeSlotResolver
	IsFinalChapter       bool
}

type MdxConvergenceResult struct {
	FinalContent    string
	CleanMdx        string
	Manifest        *ConceptManifest
	WasRepaired     bool
	WasFallbackUsed bool
	OriginalLength  int
	FinalLength     int
	ValidationError string
}

type stageProcessResult struct {
	raw          string
	resolved     string
	manifest     ConceptManifest
	cleanMdx     string
	finalContent string
	valid        bool
	verr         string
}

// Run initial drafts and repaired outputs through the identical pipeline so validation never drifts.
func (p *MdxConvergencePipeline) processStages1to5(ctx context.Context, draft string, uid *string, isTruncated bool) stageProcessResult {
	validateFn := p.Validator
	if validateFn == nil {
		validateFn = mdx.ValidateDetailed
	}

	// Fail blank drafts before skeleton injection when ArchitectureSkeleton is set so skeletons never mask empty LLM output.
	if strings.TrimSpace(draft) == "" && strings.TrimSpace(p.ArchitectureSkeleton) != "" {
		verr := "empty llm completion (skeleton rescue suppressed)"
		if isTruncated {
			verr = "output truncated by token limit with empty completion"
		}
		return stageProcessResult{valid: false, verr: verr}
	}

	raw, strippedShell := StripPayloadShell(draft)
	if strippedShell != "" {
		log.Printf("[convergence-pipeline] Stripped payload shell '%s' for %s", strippedShell, p.DocPath)
	}

	// Fail closed if an unpeeled JSON wrapper survives shell stripping so raw JSON never persists as MDX.
	if HasUnpeeledJSONShell(raw) {
		return stageProcessResult{
			raw:   raw,
			valid: false,
			verr:  "unpeeled JSON payload shell detected: output contains unparsed JSON container instead of markdown",
		}
	}

	if p.CodeResolver != nil && len(p.Refs) > 0 {
		raw = armor.HydrateCodeSlotsAndSnap(raw, p.Refs, p.CodeResolver)
	}

	resolved := armor.ResolveFileHandles(raw, p.Refs)

	sanitized := armor.SanitizeMdxForCompilation(resolved)
	sanitized = armor.NormalizeDeepDiveBlocks(sanitized)

	if p.IsFinalChapter {
		sanitized = armor.PruneTerminalCliffhanger(sanitized)
	}

	sanitized = p.HealMdxMermaidBlocks(ctx, sanitized, uid)

	sanitized = BalanceCodeFences(sanitized)

	manifest := ExtractConceptManifest(sanitized, p.DocPath)
	// Re-extract companion manifest from pre-sanitized text because SanitizeMdxForCompilation strips XML blocks.
	rawManifest := ExtractConceptManifest(resolved, p.DocPath)
	if len(manifest.Concepts) == 0 && len(rawManifest.Concepts) > 0 {
		manifest.Concepts = rawManifest.Concepts
	}
	if len(manifest.Quizzes) == 0 && len(rawManifest.Quizzes) > 0 {
		manifest.Quizzes = rawManifest.Quizzes
	}
	if len(manifest.Takeaways) == 0 && len(rawManifest.Takeaways) > 0 {
		manifest.Takeaways = rawManifest.Takeaways
	}
	if manifest.Summary == "" && rawManifest.Summary != "" {
		manifest.Summary = rawManifest.Summary
	}

	cleanMdx := sanitized
	finalContent := sanitized
	if manifest.HasFrontmatter && manifest.CleanMdx != "" {
		cleanMdx = manifest.CleanMdx
	} else if manifest.CleanContent != "" {
		cleanMdx = manifest.CleanContent
		finalContent = manifest.CleanContent
	}
	if strings.TrimSpace(cleanMdx) == "" && strings.TrimSpace(sanitized) != "" {
		cleanMdx = sanitized
	}

	var valid bool
	var verr string
	if strings.TrimSpace(cleanMdx) == "" {
		valid = false
		verr = "empty mdx content"
	} else if isTruncated {
		valid = false
		verr = "output truncated by token limit"
	} else if HasUnpeeledJSONShell(cleanMdx) {
		valid = false
		verr = "unpeeled JSON payload shell detected: output contains unparsed JSON container instead of markdown"
	} else {
		valid, verr = validateFn(cleanMdx)
		if !valid && strings.Contains(verr, "Expected a closing tag for") {
			if healedMdx, ok := TryAutoCloseTags(cleanMdx, verr, validateFn); ok {
				log.Printf("[convergence-pipeline] Auto-closed unclosed container tag for %s", p.DocPath)
				diff := healedMdx[len(cleanMdx):]
				cleanMdx = healedMdx
				sanitized = sanitized + diff
				finalContent = finalContent + diff
				valid = true
				verr = ""
			}
		}
	}

	return stageProcessResult{
		raw:          raw,
		resolved:     resolved,
		manifest:     manifest,
		cleanMdx:     cleanMdx,
		finalContent: finalContent,
		valid:        valid,
		verr:         verr,
	}
}

func (p *MdxConvergencePipeline) trySurgicalLinePatch(
	ctx context.Context,
	fullContent string,
	errLine int,
	errMsg string,
	repairPurpose string,
	uid *string,
) (string, bool) {
	lines := strings.Split(fullContent, "\n")
	totalLines := len(lines)
	if errLine < 1 || errLine > totalLines {
		return "", false
	}

	windowSize := 15
	startLine := errLine - windowSize
	if startLine < 1 {
		startLine = 1
	}
	endLine := errLine + windowSize
	if endLine > totalLines {
		endLine = totalLines
	}

	snippetLines := lines[startLine-1 : endLine]
	snippet := strings.Join(snippetLines, "\n")

	log.Printf("[convergence-pipeline] Performing surgical line-window patch for %s around line %d (lines %d-%d)", p.DocPath, errLine, startLine, endLine)

	repairVars := map[string]any{
		"compileError": fmt.Sprintf("Syntax error around line %d: %s. (Note: Repair ONLY the syntax inside this snippet; return ONLY the repaired snippet between ===CONTENT_BEGIN=== and ===CONTENT_END=== without modifying explanations or code outside the syntax bug.)", errLine, errMsg),
		"mdxSource":    snippet,
	}

	repairCtx, repairCancel := context.WithTimeout(ctx, 20*time.Second)
	repRes, repErr := p.LlmClient.Complete(repairCtx, repairPurpose, repairVars, uid)
	repairCancel()

	if repErr != nil || repRes.FinishReason == "length" || strings.TrimSpace(repRes.Text) == "" {
		return "", false
	}

	repairedSnippet, _ := StripPayloadShell(repRes.Text)
	if strings.TrimSpace(repairedSnippet) == "" {
		return "", false
	}

	repairedSliceLines := strings.Split(repairedSnippet, "\n")
	newLines := make([]string, 0, (startLine-1)+len(repairedSliceLines)+(totalLines-endLine))
	newLines = append(newLines, lines[:startLine-1]...)
	newLines = append(newLines, repairedSliceLines...)
	newLines = append(newLines, lines[endLine:]...)

	return strings.Join(newLines, "\n"), true
}

func (p *MdxConvergencePipeline) Execute(ctx context.Context, rawDraft string, uid *string, isTokenTruncated ...bool) MdxConvergenceResult {
	if ctx == nil {
		ctx = context.Background()
	}
	truncated := len(isTokenTruncated) > 0 && isTokenTruncated[0]
	r := p.processStages1to5(ctx, rawDraft, uid, truncated)

	if r.valid {
		return MdxConvergenceResult{
			FinalContent:    r.finalContent,
			CleanMdx:        r.cleanMdx,
			Manifest:        &r.manifest,
			WasRepaired:     false,
			WasFallbackUsed: false,
			OriginalLength:  len(rawDraft),
			FinalLength:     len(r.finalContent),
			ValidationError: "",
		}
	}

	firstError := r.verr

	if p.LlmClient != nil && strings.TrimSpace(r.finalContent) != "" {
		repairPurpose := p.RepairPurpose
		if repairPurpose == "" {
			repairPurpose = "mdx_repair"
		}

		errLine := ExtractErrorLine(r.verr, r.finalContent)
		if errLine > 0 {
			if patchedContent, ok := p.trySurgicalLinePatch(ctx, r.finalContent, errLine, r.verr, repairPurpose, uid); ok {
				repR := p.processStages1to5(ctx, patchedContent, uid, false)
				if repR.valid {
					log.Printf("[convergence-pipeline] Surgical line-window repair SUCCEEDED for %s at line %d", p.DocPath, errLine)
					return MdxConvergenceResult{
						FinalContent:    repR.finalContent,
						CleanMdx:        repR.cleanMdx,
						Manifest:        &repR.manifest,
						WasRepaired:     true,
						WasFallbackUsed: false,
						OriginalLength:  len(rawDraft),
						FinalLength:     len(repR.finalContent),
						ValidationError: "",
					}
				}
				log.Printf("[convergence-pipeline] Surgical repair candidate invalid for %s: %s", p.DocPath, repR.verr)
			}
		} else {
			log.Printf("[convergence-pipeline] MDX validation failed for %s (%s), attempting targeted full repair with %s", p.DocPath, r.verr, repairPurpose)
			repairVars := map[string]any{
				"compileError": r.verr,
				"mdxSource":    r.finalContent,
			}
			repairCtx, repairCancel := context.WithTimeout(ctx, 45*time.Second)
			repRes, repErr := p.LlmClient.Complete(repairCtx, repairPurpose, repairVars, uid)
			repairCancel()
			if repErr == nil && repRes.FinishReason != "length" {
				repR := p.processStages1to5(ctx, repRes.Text, uid, false)
				if repR.valid {
					return MdxConvergenceResult{
						FinalContent:    repR.finalContent,
						CleanMdx:        repR.cleanMdx,
						Manifest:        &repR.manifest,
						WasRepaired:     true,
						WasFallbackUsed: false,
						OriginalLength:  len(rawDraft),
						FinalLength:     len(repR.finalContent),
						ValidationError: "",
					}
				}
				log.Printf("[convergence-pipeline] MDX full repair produced invalid syntax for %s: %s", p.DocPath, repR.verr)
			} else {
				log.Printf("[convergence-pipeline] MDX full repair invocation failed or truncated for %s: err=%v, finishReason=%s", p.DocPath, repErr, repRes.FinishReason)
			}
		}
	}

	if p.FallbackBuilder != nil {
		fallbackContent := strings.TrimSpace(p.FallbackBuilder())
		if fallbackContent != "" {
			log.Printf("[convergence-pipeline] Falling back to deterministic builder for %s", p.DocPath)
			fbManifest := ExtractConceptManifest(fallbackContent, p.DocPath)
			fbClean := fallbackContent
			if fbManifest.HasFrontmatter && fbManifest.CleanMdx != "" {
				fbClean = fbManifest.CleanMdx
			} else if fbManifest.CleanContent != "" {
				fbClean = fbManifest.CleanContent
			}
			return MdxConvergenceResult{
				FinalContent:    fallbackContent,
				CleanMdx:        fbClean,
				Manifest:        &fbManifest,
				WasRepaired:     false,
				WasFallbackUsed: true,
				OriginalLength:  len(rawDraft),
				FinalLength:     len(fallbackContent),
				ValidationError: firstError,
			}
		}
	}

	return MdxConvergenceResult{
		FinalContent:    r.finalContent,
		CleanMdx:        r.cleanMdx,
		Manifest:        &r.manifest,
		WasRepaired:     false,
		WasFallbackUsed: false,
		OriginalLength:  len(rawDraft),
		FinalLength:     len(r.finalContent),
		ValidationError: firstError,
	}
}

type KeyDataStructure struct {
	Name        string `json:"name"`
	Subsystem   string `json:"subsystem"`
	Description string `json:"description"`
	FilePath    string `json:"filePath"`
}

type GroundingAudit struct {
	TotalProposed     int  `json:"totalProposed"`
	KeptCount         int  `json:"keptCount"`
	DiscardedCount    int  `json:"discardedCount"`
	FallbackTriggered bool `json:"fallbackTriggered"`
}

func normalizeOverviewPath(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimPrefix(p, "./")
	return strings.TrimPrefix(p, "/")
}

func GroundKeyDataStructures(raw []KeyDataStructure, filePathInTree func(string) bool, fallback func() []KeyDataStructure) ([]KeyDataStructure, GroundingAudit) {
	audit := GroundingAudit{TotalProposed: len(raw)}
	if filePathInTree == nil {
		audit.KeptCount = len(raw)
		return raw, audit
	}

	verified := make([]KeyDataStructure, 0, len(raw))
	for _, ds := range raw {
		if strings.TrimSpace(ds.FilePath) == "" || filePathInTree(normalizeOverviewPath(ds.FilePath)) {
			verified = append(verified, ds)
		} else {
			audit.DiscardedCount++
		}
	}
	audit.KeptCount = len(verified)

	if len(verified) == 0 && len(raw) > 0 {
		audit.FallbackTriggered = true
		if fallback != nil {
			fb := fallback()
			return fb, audit
		}
	}
	return verified, audit
}

func (p *MdxConvergencePipeline) HealMdxMermaidBlocks(ctx context.Context, content string, uid *string) string {
	if strings.TrimSpace(content) == "" {
		return content
	}

	lines := strings.Split(content, "\n")
	type blockPos struct {
		startLine int
		endLine   int
		rawCode   string
	}

	var blocks []blockPos
	inMermaid := false
	blockStart := -1
	var blockLines []string

	for i, line := range lines {
		if !inMermaid {
			if mdpat.MermaidFenceOpenRe.MatchString(line) {
				inMermaid = true
				blockStart = i
				blockLines = nil
			}
		} else {
			if mdpat.FenceCloseRe.MatchString(line) {
				blocks = append(blocks, blockPos{
					startLine: blockStart,
					endLine:   i,
					rawCode:   strings.Join(blockLines, "\n"),
				})
				inMermaid = false
			} else {
				blockLines = append(blockLines, line)
			}
		}
	}

	if inMermaid {
		blocks = append(blocks, blockPos{
			startLine: blockStart,
			endLine:   len(lines) - 1,
			rawCode:   strings.Join(blockLines, "\n"),
		})
	}

	if len(blocks) == 0 {
		if strings.TrimSpace(p.ArchitectureSkeleton) != "" && !isDummySkeleton(p.ArchitectureSkeleton) {
			return injectMermaidSkeleton(lines, strings.TrimSpace(p.ArchitectureSkeleton))
		}
		return content
	}

	for bIdx := len(blocks) - 1; bIdx >= 0; bIdx-- {
		b := blocks[bIdx]
		healed, ok := HealMermaidSyntax(b.rawCode)
		if ok {
			var replacement []string
			replacement = append(replacement, "```mermaid")
			replacement = append(replacement, strings.Split(healed, "\n")...)
			replacement = append(replacement, "```")

			var newLines []string
			newLines = append(newLines, lines[:b.startLine]...)
			newLines = append(newLines, replacement...)
			newLines = append(newLines, lines[b.endLine+1:]...)
			lines = newLines
			continue
		}

		if p.LlmClient != nil && ctx != nil {
			doctorRepaired, err := RepairMermaidWithLlm(ctx, p.LlmClient, b.rawCode, uid)
			if err == nil && doctorRepaired != "" {
				var replacement []string
				replacement = append(replacement, "```mermaid")
				replacement = append(replacement, strings.Split(doctorRepaired, "\n")...)
				replacement = append(replacement, "```")

				var newLines []string
				newLines = append(newLines, lines[:b.startLine]...)
				newLines = append(newLines, replacement...)
				newLines = append(newLines, lines[b.endLine+1:]...)
				lines = newLines
				continue
			}
		}

		if strings.TrimSpace(p.ArchitectureSkeleton) != "" && !isDummySkeleton(p.ArchitectureSkeleton) {
			cleanSkel := strings.TrimSpace(p.ArchitectureSkeleton)
			var newLines []string
			newLines = append(newLines, lines[:b.startLine]...)
			newLines = append(newLines, cleanSkel)
			newLines = append(newLines, lines[b.endLine+1:]...)
			lines = newLines
			continue
		}

		var newLines []string
		newLines = append(newLines, lines[:b.startLine]...)
		newLines = append(newLines, lines[b.endLine+1:]...)
		lines = newLines
	}

	return strings.Join(lines, "\n")
}

func EnsureMermaidArchitecture(content string, skeleton string) string {
	return EnsureGroundedMermaidArchitecture(content, skeleton, nil)
}

func EnsureGroundedMermaidArchitecture(content string, skeleton string, verifiedSymbols []string) string {
	pipeline := MdxConvergencePipeline{
		ArchitectureSkeleton: skeleton,
	}
	return pipeline.HealMdxMermaidBlocks(context.Background(), content, nil)
}

func isDummySkeleton(skeleton string) bool {
	clean := strings.TrimSpace(skeleton)
	if clean == "" {
		return true
	}
	symbols := extractSkeletonSymbols(clean)
	return len(symbols) == 0
}

var skeletonLabelRe = mdpat.SkeletonLabelRe

func extractSkeletonSymbols(skeleton string) []string {
	lines := strings.Split(skeleton, "\n")
	var symbols []string
	seen := make(map[string]bool)

	for _, line := range lines {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "subgraph ") {
			continue
		}
		if strings.HasSuffix(trim, ` Core"]`) || strings.HasSuffix(trim, ` Core"])`) {
			continue
		}

		matches := skeletonLabelRe.FindAllStringSubmatch(trim, -1)
		for _, m := range matches {
			raw := m[1]
			if raw == "" {
				raw = m[2]
			}
			raw = strings.TrimSpace(raw)
			if idx := strings.Index(raw, "<br/>"); idx >= 0 {
				raw = raw[:idx]
			}
			raw = strings.TrimSuffix(raw, "()")
			if idx := strings.Index(raw, " ("); idx >= 0 {
				raw = raw[:idx]
			}
			raw = strings.TrimPrefix(raw, "Prerequisite: ")
			raw = strings.TrimPrefix(raw, "Dependent: ")
			clean := strings.TrimSpace(raw)
			lower := strings.ToLower(clean)
			if len(clean) >= 2 && !seen[lower] && lower != "flowchart" && lower != "td" && lower != "lr" && lower != "subgraph" && lower != "end" && lower != "graph" && lower != "empty" && lower != "module architecture" {
				seen[lower] = true
				symbols = append(symbols, clean)
			}
		}
	}
	return symbols
}

func injectMermaidSkeleton(lines []string, skeleton string) string {
	firstH2Idx := -1
	for i, line := range lines {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "## ") {
			firstH2Idx = i
			break
		}
	}

	if firstH2Idx >= 0 {
		insertIdx := firstH2Idx + 1
		for insertIdx < len(lines) && strings.TrimSpace(lines[insertIdx]) == "" {
			insertIdx++
		}
		for insertIdx < len(lines) && strings.TrimSpace(lines[insertIdx]) != "" && !strings.HasPrefix(strings.TrimSpace(lines[insertIdx]), "#") {
			insertIdx++
		}
		var result []string
		result = append(result, lines[:insertIdx]...)
		result = append(result, "", skeleton)
		result = append(result, lines[insertIdx:]...)
		return strings.Join(result, "\n")
	}

	firstH1Idx := -1
	for i, line := range lines {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "# ") {
			firstH1Idx = i
			break
		}
	}

	if firstH1Idx >= 0 {
		insertIdx := firstH1Idx + 1
		for insertIdx < len(lines) && (strings.TrimSpace(lines[insertIdx]) == "" || strings.HasPrefix(strings.TrimSpace(lines[insertIdx]), ">")) {
			insertIdx++
		}
		for insertIdx < len(lines) && strings.TrimSpace(lines[insertIdx]) != "" && !strings.HasPrefix(strings.TrimSpace(lines[insertIdx]), "#") {
			insertIdx++
		}
		var result []string
		result = append(result, lines[:insertIdx]...)
		result = append(result, "", skeleton)
		result = append(result, lines[insertIdx:]...)
		return strings.Join(result, "\n")
	}

	return skeleton + "\n\n" + strings.Join(lines, "\n")
}
