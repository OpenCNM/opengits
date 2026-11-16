package cognitive

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// PickDeterministicCandidate breaks ties among equally-named candidates deterministically:
// longest shared directory prefix with current file → shallowest path → lexicographic.
func PickDeterministicCandidate(candidates []string, currentFilePath string) string {
	if len(candidates) == 0 {
		return ""
	}
	if len(candidates) == 1 {
		return candidates[0]
	}

	normCurrent := strings.ReplaceAll(currentFilePath, "\\", "/")
	currentSegments := strings.Split(normCurrent, "/")

	score := func(candidate string) int {
		normCandidate := strings.ReplaceAll(candidate, "\\", "/")
		segments := strings.Split(normCandidate, "/")
		shared := 0
		for shared < len(segments)-1 && shared < len(currentSegments)-1 && segments[shared] == currentSegments[shared] {
			shared++
		}
		// Maximize shared prefix, then prefer shallower files.
		return (100-shared)*10000 + len(segments)
	}

	sorted := make([]string, len(candidates))
	copy(sorted, candidates)

	sort.Slice(sorted, func(i, j int) bool {
		scoreDelta := score(sorted[i]) - score(sorted[j])
		if scoreDelta != 0 {
			return scoreDelta < 0
		}
		return sorted[i] < sorted[j]
	})

	return sorted[0]
}

func VerifyFileGrounding(claimedFiles []string, index GroundingIndex) GroundingVerdict {
	groundedFiles := make([]string, 0)
	hallucinatedFiles := make([]string, 0)
	warnings := make([]string, 0)

	pathSet := make(map[string]bool, len(index.Paths))
	for _, p := range index.Paths {
		pathSet[p] = true
	}

	for _, file := range claimedFiles {
		if file == "" {
			continue
		}
		cleanPath := strings.Trim(strings.ReplaceAll(file, "\\", "/"), "/")
		basePath, anchor := mdpat.SplitPathAnchor(cleanPath)
		if basePath == "" {
			continue
		}

		// 1. Direct match in RSG
		if pathSet[cleanPath] {
			groundedFiles = append(groundedFiles, cleanPath)
			continue
		}
		if anchor != "" && pathSet[basePath] {
			groundedFiles = append(groundedFiles, cleanPath)
			continue
		}

		// 2. Suffix match (LLM provided 'db.ts' when graph has 'src/lib/db.ts')
		suffix := "/" + basePath
		var candidates []string
		for _, p := range index.Paths {
			if strings.HasSuffix(p, suffix) {
				candidates = append(candidates, p)
			}
		}

		if len(candidates) == 1 {
			resolved := candidates[0]
			if anchor != "" {
				resolved = mdpat.JoinPathAnchor(resolved, anchor)
			}
			groundedFiles = append(groundedFiles, resolved)
			warnings = append(warnings, fmt.Sprintf("Fuzzy-aligned '%s' to grounded path '%s'.", cleanPath, resolved))
			continue
		}

		if len(candidates) > 1 {
			resolvedBase := PickDeterministicCandidate(candidates, basePath)
			if resolvedBase != "" {
				resolved := resolvedBase
				if anchor != "" {
					resolved = mdpat.JoinPathAnchor(resolved, anchor)
				}
				groundedFiles = append(groundedFiles, resolved)
				warnings = append(warnings, fmt.Sprintf("Ambiguous '%s' deterministically aligned to '%s'.", cleanPath, resolved))
				continue
			}
		}

		// 3. Hallucination detected
		hallucinatedFiles = append(hallucinatedFiles, cleanPath)
		warnings = append(warnings, fmt.Sprintf("Hallucinated path '%s' rejected: not present in repository graph.", cleanPath))
	}

	adjusted := make([]string, len(groundedFiles))
	copy(adjusted, groundedFiles)

	return GroundingVerdict{
		Valid:               len(hallucinatedFiles) == 0,
		GroundedFiles:       groundedFiles,
		HallucinatedFiles:   hallucinatedFiles,
		AdjustedSourceFiles: adjusted,
		Warnings:            warnings,
	}
}

var docFileExtensions = map[string]bool{
	".md":       true,
	".mdx":      true,
	".markdown": true,
	".txt":      true,
	".rst":      true,
	".adoc":     true,
	".tex":      true,
}

// IsDocFile 判断文件路径是否为文档类型文件（Markdown/Text/RST等）。
// 文档文件包含示例代码与说明，但不构建 Tree-sitter 代码 AST 符号表。
func IsDocFile(filePath string) bool {
	if filePath == "" {
		return false
	}
	base := filePath
	if lastSlash := strings.LastIndexAny(filePath, "/\\"); lastSlash >= 0 {
		base = filePath[lastSlash+1:]
	}
	lower := strings.ToLower(base)
	if lower == "readme" || strings.HasPrefix(lower, "readme.") {
		return true
	}
	lastDot := strings.LastIndex(base, ".")
	if lastDot < 0 {
		return false
	}
	return docFileExtensions[strings.ToLower(base[lastDot:])]
}

func VerifySymbolGrounding(claims []SymbolClaim, index GroundingIndex) ([]AlignedSymbol, []SymbolClaim, []string) {
	groundedSymbols := make([]AlignedSymbol, 0)
	hallucinatedSymbols := make([]SymbolClaim, 0)
	warnings := make([]string, 0)

	// Resolve unique claimed files
	uniqueFiles := make([]string, 0)
	seenFile := make(map[string]bool)
	for _, c := range claims {
		if c.File != "" && !seenFile[c.File] {
			seenFile[c.File] = true
			uniqueFiles = append(uniqueFiles, c.File)
		}
	}

	resolvedByClaimed := make(map[string]string)
	for _, f := range uniqueFiles {
		v := VerifyFileGrounding([]string{f}, index)
		if len(v.GroundedFiles) > 0 {
			resolvedByClaimed[f] = v.GroundedFiles[0]
		}
	}

	for _, claim := range claims {
		if claim.File == "" {
			hallucinatedSymbols = append(hallucinatedSymbols, claim)
			warnings = append(warnings, fmt.Sprintf("Symbol claim '%s' rejected: empty file reference.", claim.Symbol))
			continue
		}

		resolvedFile, isGrounded := resolvedByClaimed[claim.File]
		physicalFile, _ := mdpat.SplitPathAnchor(resolvedFile)
		var symbols []SymbolEntry
		var hasSymbolTable bool
		if isGrounded && index.SymbolsByFile != nil {
			symbols, hasSymbolTable = index.SymbolsByFile[physicalFile]
		}

		if !isGrounded {
			hallucinatedSymbols = append(hallucinatedSymbols, claim)
			warnings = append(warnings, fmt.Sprintf("Symbol claim '%s' rejected: file '%s' is not grounded.", claim.Symbol, claim.File))
			continue
		}

		// 文档类型文件（README.md 等）不构建 Tree-sitter AST 代码符号表，
		// 但包含合法的示例代码与教学锚点，判定为已物理对齐符号，严禁误判为硬幻觉拒收。
		if IsDocFile(physicalFile) {
			groundedSymbols = append(groundedSymbols, AlignedSymbol{
				File:         claim.File,
				Symbol:       claim.Symbol,
				Line:         claim.Line,
				ResolvedFile: resolvedFile,
			})
			continue
		}

		if !hasSymbolTable {
			hallucinatedSymbols = append(hallucinatedSymbols, claim)
			warnings = append(warnings, fmt.Sprintf("Symbol claim '%s' rejected: file '%s' is not grounded.", claim.Symbol, claim.File))
			continue
		}

		var match *SymbolEntry
		for i := range symbols {
			if symbols[i].Name == claim.Symbol {
				match = &symbols[i]
				break
			}
		}

		if match == nil {
			hallucinatedSymbols = append(hallucinatedSymbols, claim)
			warnings = append(warnings, fmt.Sprintf("Symbol '%s' is not declared in grounded file '%s'.", claim.Symbol, resolvedFile))
			continue
		}

		if claim.Line != nil && (*claim.Line < match.StartLine || *claim.Line > match.EndLine) {
			hallucinatedSymbols = append(hallucinatedSymbols, claim)
			warnings = append(warnings, fmt.Sprintf("Line %d for '%s' falls outside its declaration range [%d, %d] in '%s'.", *claim.Line, claim.Symbol, match.StartLine, match.EndLine, resolvedFile))
			continue
		}

		groundedSymbols = append(groundedSymbols, AlignedSymbol{
			File:         claim.File,
			Symbol:       claim.Symbol,
			Line:         claim.Line,
			ResolvedFile: resolvedFile,
		})
	}

	return groundedSymbols, hallucinatedSymbols, warnings
}

var ambiguousAlignPattern = regexp.MustCompile(`Ambiguous '(.+?)' deterministically aligned to '(.+?)'\.`)

func extractAmbiguities(warnings []string) []AmbiguousAlignment {
	alignments := make([]AmbiguousAlignment, 0)
	for _, w := range warnings {
		m := ambiguousAlignPattern.FindStringSubmatch(w)
		if len(m) == 3 {
			alignments = append(alignments, AmbiguousAlignment{
				Claimed:    m[1],
				ResolvedTo: m[2],
			})
		}
	}
	return alignments
}

func VerifyFactGrounding(claimedFiles []string, symbolClaims []SymbolClaim, index GroundingIndex) GroundingReport {
	fileVerdict := VerifyFileGrounding(claimedFiles, index)
	groundedSymbols, hallucinatedSymbols, symbolWarnings := VerifySymbolGrounding(symbolClaims, index)

	allWarnings := make([]string, 0, len(fileVerdict.Warnings)+len(symbolWarnings))
	allWarnings = append(allWarnings, fileVerdict.Warnings...)
	allWarnings = append(allWarnings, symbolWarnings...)

	return GroundingReport{
		GroundingVerdict: GroundingVerdict{
			Valid:               fileVerdict.Valid,
			GroundedFiles:       fileVerdict.GroundedFiles,
			HallucinatedFiles:   fileVerdict.HallucinatedFiles,
			AdjustedSourceFiles: fileVerdict.AdjustedSourceFiles,
			Warnings:            allWarnings,
		},
		AmbiguousAlignments: extractAmbiguities(fileVerdict.Warnings),
		GroundedSymbols:     groundedSymbols,
		HallucinatedSymbols: hallucinatedSymbols,
	}
}

var (
	mdxPathMarkerPattern      = regexp.MustCompile(`<!--\s*path:\s*([^>]+?)\s*-->`)
	mdxFenceHeaderPathPattern = regexp.MustCompile("(?m)^```[a-zA-Z0-9]*[ \t]*(?://|#|--)[ \t]*(\\S+)")
	residualHandlePattern     = regexp.MustCompile(`^(?i)\[?(?:File[ \t]+)?\d+(?:#|:|\]|$)`)
)

func ExtractClaimedPathsFromMdx(mdxContent string) []string {
	if mdxContent == "" {
		return make([]string, 0)
	}

	claims := make([]string, 0)
	seen := make(map[string]bool)

	// 1. Matches in entire content for <!-- path: ... -->
	markerMatches := mdxPathMarkerPattern.FindAllStringSubmatch(mdxContent, -1)
	for _, m := range markerMatches {
		if len(m) > 1 {
			p := strings.TrimSpace(m[1])
			if p != "" && !residualHandlePattern.MatchString(p) && !seen[p] {
				seen[p] = true
				claims = append(claims, p)
			}
		}
	}

	// 2. Line-by-line fence headers
	lines := strings.Split(strings.ReplaceAll(mdxContent, "\r", ""), "\n")
	for _, line := range lines {
		fenceMatch := mdxFenceHeaderPathPattern.FindStringSubmatch(line)
		if len(fenceMatch) > 1 {
			p := strings.TrimSpace(fenceMatch[1])
			if p != "" && !residualHandlePattern.MatchString(p) && !seen[p] {
				seen[p] = true
				claims = append(claims, p)
			}
		}
	}

	return claims
}

func FormatGroundingFeedback(report GroundingReport) *string {
	if report.Valid && len(report.HallucinatedSymbols) == 0 {
		return nil
	}

	lines := []string{
		"### FACT-GROUNDING VIOLATIONS (your previous draft referenced repository facts that do not exist)",
		"Rewrite using ONLY the grounded references listed below.",
	}
	for _, hallucinated := range report.HallucinatedFiles {
		lines = append(lines, fmt.Sprintf("- REJECTED file path: '%s' does not exist in the repository.", hallucinated))
	}
	for _, hallucinated := range report.HallucinatedSymbols {
		lines = append(lines, fmt.Sprintf("- REJECTED symbol: '%s' is not declared in '%s'.", hallucinated.Symbol, hallucinated.File))
	}
	if len(report.AdjustedSourceFiles) > 0 {
		lines = append(lines, fmt.Sprintf("- Grounded file paths you may reference: %s", strings.Join(report.AdjustedSourceFiles, ", ")))
	}

	out := strings.Join(lines, "\n")
	return &out
}
