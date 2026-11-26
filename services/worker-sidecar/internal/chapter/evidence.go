package chapter

import (
	"fmt"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

const (
	chapterSourceBudgetChars  = 40000
	slotAnchorsPerFile        = 12
	evidenceHeadWindowChars   = 2500
	evidenceMaxLinesPerSymbol = 60
	evidenceBlockOverhead     = 96
)

type FileRank struct {
	Symbols   []cognitive.SymbolEntry
	HasSignal bool
}

type SlotMenuItem struct {
	ID        int    `json:"id"`
	FileIndex int    `json:"fileIndex"`
	Anchor    string `json:"anchor"`
	Aspect    string `json:"aspect"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
}

type ChapterEvidence struct {
	FilesSummary string
	SlotMenu     []SlotMenuItem
}

type EvidenceOptions struct {
	SymbolsByFile map[string][]cognitive.SymbolEntry
	Ranks         map[string]FileRank
	ReadFile      func(cleanPath string) (raw string, ok bool)
}

// Ranks symbols by degree centrality per (file, symbol) and container range to disambiguate same-named methods.
func RankChapterSymbols(symbolsByFile map[string][]cognitive.SymbolEntry, edges []cognitive.CallEdge, files []string) map[string]FileRank {
	chapterFiles := make(map[string]bool, len(files))
	for _, f := range files {
		if clean, _ := mdpat.SplitPathAnchor(f); clean != "" {
			chapterFiles[clean] = true
		}
	}

	indexes := buildFileSymbolIndexes(symbolsByFile)

	callerSets := make(map[string]map[int]map[string]struct{})
	calleeSets := make(map[string]map[int]map[string]struct{})
	add := func(sets map[string]map[int]map[string]struct{}, file string, symIdx int, key string) {
		syms := sets[file]
		if syms == nil {
			syms = make(map[int]map[string]struct{})
			sets[file] = syms
		}
		if syms[symIdx] == nil {
			syms[symIdx] = make(map[string]struct{})
		}
		syms[symIdx][key] = struct{}{}
	}
	for _, e := range edges {
		callerIdx := resolveCallerSymbolIdx(indexes[e.CallerFile], e.CallerSymbol, e.Line)
		calleeIdx := resolveCalleeSymbolIdx(e.CallerFile, e.CalleeFile, e.CalleeSymbol, e.Line, indexes)

		callerKey := e.CallerFile + "\x00" + e.CallerSymbol
		if callerIdx >= 0 {
			callerKey = fmt.Sprintf("%s\x00%s\x00%d", e.CallerFile, e.CallerSymbol, indexes[e.CallerFile].entries[callerIdx].StartLine)
		}
		calleeKey := e.CalleeFile + "\x00" + e.CalleeSymbol
		if calleeIdx >= 0 {
			calleeKey = fmt.Sprintf("%s\x00%s\x00%d", e.CalleeFile, e.CalleeSymbol, indexes[e.CalleeFile].entries[calleeIdx].StartLine)
		}

		if chapterFiles[e.CalleeFile] && e.CalleeSymbol != "" && calleeIdx >= 0 {
			add(callerSets, e.CalleeFile, calleeIdx, callerKey)
		}
		if chapterFiles[e.CallerFile] && e.CallerSymbol != "" && callerIdx >= 0 {
			add(calleeSets, e.CallerFile, callerIdx, calleeKey)
		}
	}

	ranks := make(map[string]FileRank, len(files))
	for _, f := range files {
		clean, _ := mdpat.SplitPathAnchor(f)
		if clean == "" {
			continue
		}
		if _, done := ranks[clean]; done {
			continue
		}
		ranks[clean] = rankFileSymbols(symbolsByFile[clean], callerSets[clean], calleeSets[clean])
	}
	return ranks
}

type fileSymbolIndex struct {
	entries    []cognitive.SymbolEntry
	byName     map[string][]int
	containers []int
}

func buildFileSymbolIndexes(symbolsByFile map[string][]cognitive.SymbolEntry) map[string]*fileSymbolIndex {
	indexes := make(map[string]*fileSymbolIndex, len(symbolsByFile))
	for path, entries := range symbolsByFile {
		idx := &fileSymbolIndex{
			entries: entries,
			byName:  make(map[string][]int, len(entries)),
		}
		for i, e := range entries {
			if e.Name == "" {
				continue
			}
			idx.byName[e.Name] = append(idx.byName[e.Name], i)
			if (e.Kind == "type" || e.Kind == "class") && e.StartLine > 0 && e.EndLine >= e.StartLine {
				idx.containers = append(idx.containers, i)
			}
		}
		indexes[path] = idx
	}
	return indexes
}

func resolveCallerSymbolIdx(idx *fileSymbolIndex, symName string, line int) int {
	if idx == nil || symName == "" {
		return -1
	}
	matches := idx.byName[symName]
	if len(matches) == 0 {
		return -1
	}
	if len(matches) == 1 {
		return matches[0]
	}
	if line > 0 {
		return innermostCoveringMatch(idx.entries, matches, line)
	}
	return matches[0]
}

func resolveCalleeSymbolIdx(callerFile, calleeFile, calleeSym string, line int, indexes map[string]*fileSymbolIndex) int {
	if calleeSym == "" {
		return -1
	}
	calleeIdx := indexes[calleeFile]
	if calleeIdx == nil {
		return -1
	}
	matches := calleeIdx.byName[calleeSym]
	if len(matches) == 0 {
		return -1
	}
	if len(matches) == 1 {
		return matches[0]
	}
	if callerFile == calleeFile && line > 0 {
		containerIdx := innermostCoveringMatch(calleeIdx.entries, calleeIdx.containers, line)
		if containerIdx < 0 {
			return -1
		}
		container := calleeIdx.entries[containerIdx]
		for _, m := range matches {
			e := calleeIdx.entries[m]
			if e.StartLine > 0 && e.StartLine >= container.StartLine && e.EndLine <= container.EndLine {
				return m
			}
		}
		return -1
	}
	if line <= 0 {
		return matches[0]
	}
	return -1
}

func innermostCoveringMatch(entries []cognitive.SymbolEntry, candidates []int, line int) int {
	best := -1
	for _, idx := range candidates {
		e := entries[idx]
		if e.StartLine <= 0 || e.EndLine < e.StartLine || line < e.StartLine || line > e.EndLine {
			continue
		}
		if best < 0 {
			best = idx
			continue
		}
		cur := entries[best]
		if e.StartLine > cur.StartLine || (e.StartLine == cur.StartLine && (e.EndLine-e.StartLine) < (cur.EndLine-cur.StartLine)) {
			best = idx
		}
	}
	return best
}

type symbolScore struct {
	entry cognitive.SymbolEntry
	score int
}

func rankFileSymbols(entries []cognitive.SymbolEntry, callers, callees map[int]map[string]struct{}) FileRank {
	scored := make([]symbolScore, 0, len(entries))
	seen := make(map[string]bool, len(entries))
	hasSignal := false
	for idx, e := range entries {
		in, out := len(callers[idx]), len(callees[idx])
		if in > 0 || out > 0 {
			hasSignal = true
		}
		if e.Name == "" || seen[e.Name] {
			continue
		}
		seen[e.Name] = true
		scored = append(scored, symbolScore{entry: e, score: in + out + e.Importers})
	}
	sort.SliceStable(scored, func(i, j int) bool { return scored[i].score > scored[j].score })

	out := make([]cognitive.SymbolEntry, len(scored))
	for i, s := range scored {
		out[i] = s.entry
	}
	return FileRank{Symbols: out, HasSignal: hasSignal}
}

func BuildChapterEvidence(snippets []armor.ArmorAllocatedSnippet, opts EvidenceOptions) ChapterEvidence {
	return ChapterEvidence{
		FilesSummary: BuildFilesSummary(snippets, opts),
		SlotMenu:     BuildSlotMenu(snippets, opts),
	}
}

// Pre-validates slot anchors from the graph index so planner selections are valid by construction.
func BuildSlotMenu(snippets []armor.ArmorAllocatedSnippet, opts EvidenceOptions) []SlotMenuItem {
	menu := make([]SlotMenuItem, 0)
	for idx, f := range snippets {
		cleanPath, _ := mdpat.SplitPathAnchor(f.Path)
		if cleanPath == "" {
			continue
		}
		for _, s := range anchorSymbolsFor(cleanPath, opts) {
			menu = append(menu, SlotMenuItem{
				ID:        len(menu) + 1,
				FileIndex: idx + 1,
				Anchor:    s.Name,
				Aspect:    slotAspectFor(s.Kind),
				StartLine: s.StartLine,
				EndLine:   s.EndLine,
			})
		}
	}
	return menu
}

func FormatSlotMenu(menu []SlotMenuItem) string {
	if len(menu) == 0 {
		return "(no pre-validated slots — cite only symbols listed in the chapter evidence)"
	}
	lines := make([]string, 0, len(menu))
	for _, item := range menu {
		lines = append(lines, fmt.Sprintf("%d = [File %d#%s:%s] (L%d-L%d)",
			item.ID, item.FileIndex, item.Anchor, item.Aspect, item.StartLine, item.EndLine))
	}
	return strings.Join(lines, "\n")
}

func slotAspectFor(kind string) string {
	if kind == "function" {
		return "core"
	}
	return "contract"
}

func AnchorSymbolEntries(entries []cognitive.SymbolEntry, limit int) []cognitive.SymbolEntry {
	return anchorSymbolEntries(entries, limit)
}

func RankedFileSymbols(symbolsByFile map[string][]cognitive.SymbolEntry, ranks map[string]FileRank, cleanPath string, limit int) []cognitive.SymbolEntry {
	if ranks != nil {
		if syms := anchorSymbolEntries(ranks[cleanPath].Symbols, limit); len(syms) > 0 {
			return syms
		}
	}
	return anchorSymbolEntries(symbolsByFile[cleanPath], limit)
}

func anchorSymbolsFor(cleanPath string, opts EvidenceOptions) []cognitive.SymbolEntry {
	return RankedFileSymbols(opts.SymbolsByFile, opts.Ranks, cleanPath, slotAnchorsPerFile)
}
