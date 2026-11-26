package transcription

import (
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/chapter"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

const (
	maxSlotRepairBlocks              = 6
	slotRepairContextRunes           = 240
	slotRepairSymbolsPerFile         = 15
	slotRepairKindHallucinatedSymbol = "hallucinated_symbol"
)

type slotRepairTarget struct {
	blockIndex  int
	kind        string
	fenceLine   string
	lang        string
	dropAllowed bool
}

type slotRepairDecision struct {
	SlotIndex int    `json:"slotIndex"`
	Action    string `json:"action"`
	FileIndex int    `json:"fileIndex"`
	Anchor    string `json:"anchor"`
	Aspect    string `json:"aspect"`
}

type slotRepairResponse struct {
	Slots []slotRepairDecision `json:"slots"`
}

func (p groundingGateParams) trySlotLevelRepair(report cognitive.GroundingReport, residuals []armor.ResidualSlot) (MdxConvergenceResult, string, bool) {
	if p.Llm == nil || len(p.Refs) == 0 || !canSlotRepair(report, residuals) {
		return MdxConvergenceResult{}, "", false
	}
	blocks := armor.EnumerateFencedBlocks(p.FirstPass.FinalContent)
	targets := collectSlotRepairTargets(blocks, residuals, report)
	if len(targets) == 0 || len(targets) > maxSlotRepairBlocks {
		return MdxConvergenceResult{}, "", false
	}

	vars := buildSlotRepairVars(blocks, targets, p.Refs, p.Index, p.Ranks)
	res, err := withLlmRetry(p.Ctx, func() (LlmTextResult, error) {
		return p.Llm.Complete(p.Ctx, "code_slot_repair", vars, p.Uid)
	})
	if err != nil || strings.TrimSpace(res.Text) == "" {
		return MdxConvergenceResult{}, "", false
	}
	var resp slotRepairResponse
	if json.Unmarshal([]byte(normalizeSlotRepairJSON(res.Text)), &resp) != nil {
		return MdxConvergenceResult{}, "", false
	}
	edits := validateSlotDecisions(targets, resp, p.Refs, p.Index)
	if len(edits) != len(targets) {
		return MdxConvergenceResult{}, "", false
	}

	patched := armor.ApplyFencedBlockEdits(p.FirstPass.FinalContent, edits)
	// Reruns funnel without LLM mdx_repair so broken micro-edits escalate cleanly to L2 rewrite.
	replay := *p.Pipeline
	replay.LlmClient = nil
	conv := replay.Execute(p.Ctx, patched, p.Uid, false)
	if conv.ValidationError != "" {
		return MdxConvergenceResult{}, "", false
	}
	conv.Manifest = p.FirstPass.Manifest
	log.Printf("[grounding] slot repair applied for %s: %d blocks edited", p.DocPath, len(edits))
	return conv, res.CallID, true
}

// Rejects file-level hallucinations and prose-level slots (BlockIndex 0) fast since slot repair cannot fix them.
func canSlotRepair(report cognitive.GroundingReport, residuals []armor.ResidualSlot) bool {
	if len(report.HallucinatedFiles) > 0 {
		return false
	}
	for _, r := range residuals {
		if r.BlockIndex == 0 {
			return false
		}
	}
	return len(residuals) > 0 || len(report.HallucinatedSymbols) > 0
}

func collectSlotRepairTargets(blocks []armor.FencedBlockView, residuals []armor.ResidualSlot, report cognitive.GroundingReport) []slotRepairTarget {
	residualByIndex := make(map[int]armor.ResidualSlot, len(residuals))
	for _, r := range residuals {
		if r.BlockIndex > 0 {
			residualByIndex[r.BlockIndex] = r
		}
	}
	hallucinatedClaims := make(map[string]bool, len(report.HallucinatedSymbols))
	for _, h := range report.HallucinatedSymbols {
		cleanFile, _ := mdpat.SplitPathAnchor(h.File)
		if cleanFile == "" {
			cleanFile = h.File
		}
		hallucinatedClaims[cleanFile+"#"+h.Symbol] = true
	}

	targets := make([]slotRepairTarget, 0)
	for _, b := range blocks {
		var target slotRepairTarget
		if r, ok := residualByIndex[b.Index]; ok {
			target = slotRepairTarget{
				blockIndex: b.Index,
				kind:       r.Kind,
				fenceLine:  b.FirstLine,
				lang:       b.Lang,
			}
		} else if claim, ok := resolvedFenceClaim(b.FirstLine); ok && hallucinatedClaims[claim] {
			target = slotRepairTarget{
				blockIndex: b.Index,
				kind:       slotRepairKindHallucinatedSymbol,
				fenceLine:  b.FirstLine,
				lang:       b.Lang,
			}
		} else {
			continue
		}
		target.dropAllowed = b.BodyDroppable && target.kind != slotRepairKindHallucinatedSymbol
		targets = append(targets, target)
	}
	return targets
}

func resolvedFenceClaim(fenceLine string) (string, bool) {
	if m := resolvedFenceSymbolRe.FindStringSubmatch(fenceLine); m != nil {
		cleanFile, _ := mdpat.SplitPathAnchor(m[1])
		if cleanFile == "" {
			cleanFile = m[1]
		}
		return cleanFile + "#" + m[2], true
	}
	return "", false
}

func buildSlotRepairVars(blocks []armor.FencedBlockView, targets []slotRepairTarget, refs []armor.ArmorFileRef, index cognitive.GroundingIndex, ranks map[string]chapter.FileRank) map[string]any {
	blockByIndex := make(map[int]armor.FencedBlockView, len(blocks))
	for _, b := range blocks {
		blockByIndex[b.Index] = b
	}

	var sb strings.Builder
	sb.WriteString("Defective code slots in this chapter:\n\n")
	for i, t := range targets {
		fmt.Fprintf(&sb, "### Slot %d (block #%d, lang=%s, defect=%s)\n", i+1, t.blockIndex, t.lang, t.kind)
		fmt.Fprintf(&sb, "Current fence line: %s\n", truncateForSlotPrompt(t.fenceLine))
		if b, ok := blockByIndex[t.blockIndex]; ok {
			if ctx := strings.TrimSpace(b.PrecedingProse); ctx != "" {
				fmt.Fprintf(&sb, "Preceding prose context: %s\n", truncateForSlotPrompt(tailRunes(ctx, slotRepairContextRunes)))
			}
		}
		if t.dropAllowed {
			sb.WriteString("Allowed actions: map | drop\n\n")
		} else {
			sb.WriteString("Allowed actions: map\n\n")
		}
	}

	return map[string]any{
		"slotsContext": sb.String(),
		"fileMenu":     buildSlotFileMenu(refs, index, ranks),
	}
}

func buildSlotFileMenu(refs []armor.ArmorFileRef, index cognitive.GroundingIndex, ranks map[string]chapter.FileRank) string {
	var sb strings.Builder
	for i, ref := range refs {
		cleanPath, _ := mdpat.SplitPathAnchor(ref.Path)
		if cleanPath == "" {
			cleanPath = ref.Path
		}
		fmt.Fprintf(&sb, "[File %d] %s", i+1, cleanPath)
		entries := chapter.RankedFileSymbols(index.SymbolsByFile, ranks, cleanPath, slotRepairSymbolsPerFile)
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name)
		}
		if len(names) > 0 {
			fmt.Fprintf(&sb, " — declared symbols: %s", strings.Join(names, ", "))
		} else {
			sb.WriteString(" — (no AST symbols; use a #Lx-Ly line-range anchor)")
		}
		sb.WriteString("\n")
	}
	return sb.String()
}

// Drops decisions targeting out-of-range slots, unindexed symbols, or non-droppable code bodies.
func validateSlotDecisions(targets []slotRepairTarget, resp slotRepairResponse, refs []armor.ArmorFileRef, index cognitive.GroundingIndex) []armor.SlotEdit {
	edits := make([]armor.SlotEdit, 0, len(resp.Slots))
	seen := make(map[int]bool)
	for _, d := range resp.Slots {
		if d.SlotIndex < 1 || d.SlotIndex > len(targets) || seen[d.SlotIndex] {
			continue
		}
		t := targets[d.SlotIndex-1]
		switch d.Action {
		case armor.SlotEditModeDrop:
			if !t.dropAllowed {
				continue
			}
			edits = append(edits, armor.SlotEdit{BlockIndex: t.blockIndex, Mode: armor.SlotEditModeDrop})
			seen[d.SlotIndex] = true
		case armor.SlotEditModeMap:
			edit, ok := validateMapDecision(t, d, refs, index)
			if !ok {
				continue
			}
			edits = append(edits, edit)
			seen[d.SlotIndex] = true
		}
	}
	return edits
}

func validateMapDecision(t slotRepairTarget, d slotRepairDecision, refs []armor.ArmorFileRef, index cognitive.GroundingIndex) (armor.SlotEdit, bool) {
	anchor := strings.TrimSpace(d.Anchor)
	aspect, err := validateSlotAnchor(d.FileIndex, anchor, d.Aspect, refs, index)
	if err != nil {
		return armor.SlotEdit{}, false
	}
	return armor.SlotEdit{
		BlockIndex:  t.blockIndex,
		Mode:        armor.SlotEditModeMap,
		FenceHeader: synthSlotFenceHeader(t.lang, d.FileIndex, anchor, aspect),
	}, true
}

func validateSlotAnchor(fileIndex int, anchor, aspect string, refs []armor.ArmorFileRef, index cognitive.GroundingIndex) (armor.CodeAspect, error) {
	if fileIndex < 1 || fileIndex > len(refs) {
		return "", fmt.Errorf("fileIndex %d outside the %d-file chapter menu", fileIndex, len(refs))
	}
	if strings.TrimSpace(anchor) == "" {
		return "", fmt.Errorf("empty anchor for file %d", fileIndex)
	}
	anchor = strings.TrimSpace(anchor)
	probe := "``` // [File " + strconv.Itoa(fileIndex) + "#" + anchor + "]"
	header, ok := armor.ParseCodeSlotHeader(probe)
	if !ok || header.FileIndex != fileIndex {
		return "", fmt.Errorf("anchor unparsable: %s", anchor)
	}
	if header.Symbol != "" {
		cleanPath, _ := mdpat.SplitPathAnchor(refs[fileIndex-1].Path)
		if cleanPath == "" {
			cleanPath = refs[fileIndex-1].Path
		}
		if !symbolDeclaredInIndex(index, cleanPath, header.Symbol) {
			return "", fmt.Errorf("symbol %s not declared in %s", header.Symbol, cleanPath)
		}
	}
	return armor.NormalizeCodeAspect(aspect), nil
}

func synthSlotFenceHeader(lang string, fileIndex int, anchor string, aspect armor.CodeAspect) string {
	fence := "```" + lang + " // [File " + strconv.Itoa(fileIndex) + "#" + anchor
	if aspect != "" && aspect != armor.AspectAuto {
		fence += ":" + string(aspect)
	}
	return fence + "]"
}

func symbolDeclaredInIndex(index cognitive.GroundingIndex, cleanPath, symbol string) bool {
	if index.SymbolsByFile == nil {
		return false
	}
	for _, e := range index.SymbolsByFile[cleanPath] {
		if e.Name == symbol {
			return true
		}
	}
	return false
}

func normalizeSlotRepairJSON(text string) string {
	s := strings.TrimSpace(text)
	if strings.HasPrefix(s, "```") {
		if nl := strings.Index(s, "\n"); nl >= 0 {
			s = s[nl+1:]
		}
		s = strings.TrimSpace(s)
		if strings.HasSuffix(s, "```") {
			s = strings.TrimSpace(strings.TrimSuffix(s, "```"))
		}
	}
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return ""
}

const slotPromptLineRunes = 160

func truncateForSlotPrompt(s string) string {
	return mdpat.TruncateRunes(strings.TrimSpace(s), slotPromptLineRunes, "…")
}

func tailRunes(s string, max int) string {
	runes := []rune(s)
	if max <= 0 || len(runes) <= max {
		return s
	}
	return string(runes[len(runes)-max:])
}
