package chapter

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

func ParseModuleSnapshots(raw any) []cluster.ModuleSnapshot {
	if raw == nil {
		return nil
	}
	switch v := raw.(type) {
	case []cluster.ModuleSnapshot:
		return v
	case []*cluster.ModuleSnapshot:
		res := make([]cluster.ModuleSnapshot, len(v))
		for i, item := range v {
			if item != nil {
				res[i] = *item
			}
		}
		return res
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return nil
		}
		var list []cluster.ModuleSnapshot
		if err := json.Unmarshal(b, &list); err != nil {
			return nil
		}
		return list
	}
}

var (
	chapterDigitsRe = regexp.MustCompile(`\d+`)
	chapterMdxExtRe = mdpat.MdExtRe
)

func ResolveModuleSnapshotFromProfile(repoProfile map[string]any, docPath, docTitle string) *cluster.ModuleSnapshot {
	if repoProfile == nil {
		return nil
	}
	clustersRaw, ok := repoProfile["codeClusters"]
	if !ok || clustersRaw == nil {
		return nil
	}
	list := ParseModuleSnapshots(clustersRaw)
	if len(list) == 0 {
		return nil
	}

	lastSegment := filepath.Base(docPath)
	if docPath == "" {
		lastSegment = ""
	}

	numMatch := chapterDigitsRe.FindString(lastSegment)
	if numMatch != "" {
		if order, err := strconv.Atoi(numMatch); err == nil && order > 0 {
			for _, c := range list {
				if c.ChapterNo == order {
					res := c
					return &res
				}
			}
			for _, c := range list {
				if c.TeachingOrder == order {
					res := c
					return &res
				}
			}
		}
	}

	rawSlug := chapterMdxExtRe.ReplaceAllString(lastSegment, "")
	cleanDocSlug := mdpat.SlugifyUnderscore(rawSlug)
	// Pure punctuation titles fall back to id_<hash> so empty slugs never match via Contains("", "").
	for _, c := range list {
		if strings.TrimSpace(c.Title) == "" {
			continue
		}
		if cleanDocSlug != "" {
			cleanTitle := mdpat.SlugifyUnderscore(c.Title)
			if cleanTitle != "" && (strings.Contains(cleanDocSlug, cleanTitle) || strings.Contains(cleanTitle, cleanDocSlug)) {
				res := c
				return &res
			}
		}
		if docTitle != "" {
			docTitleLower := strings.ToLower(docTitle)
			cTitleLower := strings.ToLower(c.Title)
			if strings.Contains(docTitleLower, cTitleLower) || strings.Contains(cTitleLower, docTitleLower) {
				res := c
				return &res
			}
		}
	}

	return nil
}

func ReadLocalArchiveFile(archiveRoot, owner, repo, shaOrBranch, p string) string {
	if archiveRoot == "" || owner == "" || repo == "" || shaOrBranch == "" || p == "" {
		return ""
	}
	base := filepath.Join(archiveRoot, owner, repo, shaOrBranch)
	full := filepath.Join(base, filepath.FromSlash(p))
	rel, err := filepath.Rel(base, full)
	if err != nil || strings.HasPrefix(rel, "..") {
		return ""
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return ""
	}
	return string(b)
}

// Keeps head-aligned snippet offsets so [File N#Lx-Ly] line numbers match physical file lines.
func PackModuleFilesFromArchive(archiveRoot, owner, repo, sha string, files []string) []armor.ArmorAllocatedSnippet {
	if len(files) == 0 {
		return nil
	}
	var rawFiles []armor.ArmorSourceFile
	for _, p := range files {
		cleanPath, anchor := mdpat.SplitPathAnchor(p)
		if cleanPath == "" {
			continue
		}
		raw := ReadLocalArchiveFile(archiveRoot, owner, repo, sha, cleanPath)
		if raw == "" {
			continue
		}
		totalLines := strings.Count(raw, "\n") + 1
		resolvedPath := p
		if anchor != "" {
			resolvedPath = mdpat.JoinPathAnchor(cleanPath, anchor)
		}
		rawFiles = append(rawFiles, armor.ArmorSourceFile{
			Path:       resolvedPath,
			TotalLines: totalLines,
			RawContent: raw,
		})
	}
	if len(rawFiles) == 0 {
		return nil
	}
	return armor.AllocateBalancedSourceSnippets(rawFiles, chapterSourceBudgetChars)
}

// Keeps only the first AST declaration per symbol name because [File N#name] resolves to the first match.
func anchorSymbolEntries(entries []cognitive.SymbolEntry, limit int) []cognitive.SymbolEntry {
	if len(entries) == 0 || limit <= 0 {
		return nil
	}
	syms := make([]cognitive.SymbolEntry, 0, min(len(entries), limit))
	seen := make(map[string]bool, len(entries))
	for _, entry := range entries {
		if entry.Name == "" || entry.StartLine <= 0 || entry.EndLine < entry.StartLine || seen[entry.Name] {
			continue
		}
		seen[entry.Name] = true
		syms = append(syms, entry)
		if len(syms) >= limit {
			break
		}
	}
	return syms
}

func BuildFilesSummary(snippets []armor.ArmorAllocatedSnippet, opts EvidenceOptions) string {
	if len(snippets) == 0 {
		return ""
	}
	var parts []string
	for idx, f := range snippets {
		cleanPath, anchor := mdpat.SplitPathAnchor(f.Path)
		header := fmt.Sprintf("[File %d] %s (%d lines)", idx+1, cleanPath, f.TotalLines)
		if anchor != "" {
			header = fmt.Sprintf("[File %d] %s (focus: %s, %d lines)", idx+1, cleanPath, anchor, f.TotalLines)
		}
		parts = append(parts, fmt.Sprintf("%s%s\n%s", header, slotAnchorsHint(idx+1, cleanPath, opts), fileEvidence(idx+1, f, cleanPath, opts)))
	}
	return strings.Join(parts, "\n\n")
}

func slotAnchorsHint(fileIndex int, cleanPath string, opts EvidenceOptions) string {
	symbols := anchorSymbolsFor(cleanPath, opts)
	if len(symbols) == 0 {
		return ""
	}
	tags := make([]string, 0, len(symbols))
	for _, s := range symbols {
		tags = append(tags, fmt.Sprintf("[File %d#%s]", fileIndex, s.Name))
	}
	label := "Valid slot anchors — cite only the ones you teach"
	if opts.Ranks != nil && opts.Ranks[cleanPath].HasSignal {
		label = "Valid slot anchors, most central first — cite only the ones you teach"
	}
	return fmt.Sprintf("\n(%s: %s)", label, strings.Join(tags, ", "))
}

const (
	minEvidenceSliceLines = 6
	evidenceOmitReserve   = 96
)

func fileEvidence(fileIndex int, f armor.ArmorAllocatedSnippet, cleanPath string, opts EvidenceOptions) string {
	legacy := "```\n" + f.Snippet + "\n```"
	if opts.ReadFile == nil || opts.Ranks == nil || !opts.Ranks[cleanPath].HasSignal {
		return legacy
	}
	raw, ok := opts.ReadFile(cleanPath)
	if !ok || len(raw) <= len(f.Snippet) {
		return legacy
	}

	lang := armor.DetectSourceLanguage(cleanPath)
	lines := strings.Split(raw, "\n")
	budget := len(f.Snippet)
	headCap := min(evidenceHeadWindowChars, max(budget/2, 400))
	if headCap > budget {
		headCap = budget
	}
	head := headWindow(raw, headCap)
	remaining := budget - len(head)

	var blocks strings.Builder
	used := 0
	emitted := make([]cognitive.SymbolEntry, 0, len(opts.Ranks[cleanPath].Symbols))
	for _, s := range opts.Ranks[cleanPath].Symbols {
		if s.StartLine < 1 || s.EndLine < s.StartLine || s.EndLine > len(lines) {
			continue
		}
		if nestedInAny(emitted, s) {
			continue
		}
		symLines := lines[s.StartLine-1 : s.EndLine]
		rawSym := strings.Join(symLines, "\n")
		aspect := armor.AspectAuto
		if isGiantContainerSymbol(s) {
			aspect = armor.AspectContract
		}
		body := armor.SliceCodeByAspect(rawSym, s.Name, lang, aspect, s.StartLine, s.EndLine, evidenceMaxLinesPerSymbol)
		cost := len(body) + evidenceBlockOverhead
		if used > 0 {
			if used+cost > remaining {
				break
			}
		} else if cost > remaining {
			shrunkBody, shrunkAspect, shrunkOk := shrinkFirstEvidenceBlock(symLines, rawSym, s, lang, aspect, remaining)
			if !shrunkOk {
				continue
			}
			body = shrunkBody
			aspect = shrunkAspect
			cost = len(body) + evidenceBlockOverhead
		}
		fmt.Fprintf(&blocks, "Evidence %d — [File %d#%s] (L%d-L%d)\n```%s\n%s\n```\n\n",
			len(emitted)+1, fileIndex, s.Name, s.StartLine, s.EndLine, lang, body)
		used += cost
		covered := s
		covered.EndLine = coveredSymbolEndLine(s, symLines, body, aspect)
		emitted = append(emitted, covered)
	}
	if len(emitted) == 0 {
		return legacy
	}
	if leftover := budget - len(head) - used; leftover > 0 {
		head = headWindow(raw, len(head)+leftover)
	}
	return fmt.Sprintf("File head (imports and module setup):\n```%s\n%s\n```\n\n%s",
		lang, head, strings.TrimRight(blocks.String(), "\n"))
}

func isGiantContainerSymbol(s cognitive.SymbolEntry) bool {
	return (s.Kind == "type" || s.Kind == "class") && (s.EndLine-s.StartLine+1) > evidenceMaxLinesPerSymbol
}

func shrinkFirstEvidenceBlock(symLines []string, rawSym string, s cognitive.SymbolEntry, lang string, aspect armor.CodeAspect, remaining int) (string, armor.CodeAspect, bool) {
	availBody := remaining - evidenceBlockOverhead
	if availBody <= 0 {
		return "", aspect, false
	}
	if aspect != armor.AspectContract {
		fitLines := fitEvidenceLineLimit(symLines, availBody-evidenceOmitReserve)
		if fitLines >= minEvidenceSliceLines {
			lineCap := min(fitLines+2, evidenceMaxLinesPerSymbol)
			if lineCap >= len(symLines) {
				lineCap = len(symLines) - 1
			}
			if lineCap >= minEvidenceSliceLines {
				shrunk := armor.SliceCodeByAspect(rawSym, s.Name, lang, aspect, s.StartLine, s.EndLine, lineCap)
				if len(shrunk)+evidenceBlockOverhead <= remaining {
					return shrunk, aspect, true
				}
			}
		}
	}
	contract := armor.SliceCodeByAspect(rawSym, s.Name, lang, armor.AspectContract, s.StartLine, s.EndLine, evidenceMaxLinesPerSymbol)
	if len(contract)+evidenceBlockOverhead <= remaining {
		return contract, armor.AspectContract, true
	}
	return "", aspect, false
}

func fitEvidenceLineLimit(symLines []string, maxChars int) int {
	if maxChars <= 0 {
		return 0
	}
	total := 0
	count := 0
	for i, line := range symLines {
		add := len(line)
		if i > 0 {
			add++
		}
		if total+add > maxChars {
			break
		}
		total += add
		count++
	}
	return count
}

func coveredSymbolEndLine(s cognitive.SymbolEntry, rawLines []string, body string, aspect armor.CodeAspect) int {
	bodyLines := strings.Split(body, "\n")
	if aspect == armor.AspectContract {
		n := len(bodyLines)
		if n > 0 && strings.TrimSpace(bodyLines[n-1]) == "// ... [contract truncated]" {
			n--
		}
		if n < 1 {
			n = 1
		}
		end := s.StartLine + n - 1
		if end > s.EndLine {
			return s.EndLine
		}
		return end
	}
	matched := 0
	for matched < len(bodyLines) && matched < len(rawLines) {
		if strings.TrimRight(bodyLines[matched], "\r") != strings.TrimRight(rawLines[matched], "\r") {
			break
		}
		matched++
	}
	if matched <= 0 {
		return s.StartLine
	}
	end := s.StartLine + matched - 1
	if end > s.EndLine {
		return s.EndLine
	}
	return end
}

func headWindow(raw string, n int) string {
	if n <= 0 || len(raw) == 0 {
		return ""
	}
	if n >= len(raw) {
		return strings.TrimRight(raw, "\n")
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(raw[cut]) {
		cut--
	}
	if cut <= 0 {
		return ""
	}
	if raw[cut-1] != '\n' {
		if i := strings.LastIndexByte(raw[:cut], '\n'); i > 0 {
			cut = i
		}
	}
	return strings.TrimRight(raw[:cut], "\n")
}

func nestedInAny(outer []cognitive.SymbolEntry, s cognitive.SymbolEntry) bool {
	for _, p := range outer {
		if s.StartLine >= p.StartLine && s.EndLine <= p.EndLine {
			return true
		}
	}
	return false
}
