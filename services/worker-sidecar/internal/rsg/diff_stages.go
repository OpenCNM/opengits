package rsg

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/opengits/worker-sidecar/internal/archive"
)

func extractFileDiffs(
	cfg Config,
	req GraphDiffRequest,
	fromArtifact, toArtifact *SemanticGraphArtifact,
	classifier *InfraClassifier,
	archiveRoot string,
) (map[string]FileSemanticDiff, map[string]map[string]string) {
	fileDiffs := make(map[string]FileSemanticDiff)
	exportedChangedSymbols := make(map[string]map[string]string)

	lc := newFileLinesCache()

	for _, file := range req.ModifiedFiles {
		var oldSyms []SymbolEntry
		var newSyms []SymbolEntry
		if fromArtifact != nil && fromArtifact.SymbolsByFile != nil {
			oldSyms = fromArtifact.SymbolsByFile[file]
		}
		if toArtifact != nil && toArtifact.SymbolsByFile != nil {
			newSyms = toArtifact.SymbolsByFile[file]
		}

		oldMap := make(map[string]SymbolEntry, len(oldSyms))
		for _, s := range oldSyms {
			oldMap[s.Kind+":"+s.Name] = s
		}
		newMap := make(map[string]SymbolEntry, len(newSyms))
		for _, s := range newSyms {
			newMap[s.Kind+":"+s.Name] = s
		}

		oldPath := filepath.Join(archive.ArchiveDirFor(archiveRoot, req.Owner, req.Repo, req.FromSha), filepath.FromSlash(file))
		newPath := filepath.Join(archive.ArchiveDirFor(archiveRoot, req.Owner, req.Repo, req.ToSha), filepath.FromSlash(file))

		var diffItems []SymbolDiffItem

		for _, s := range newSyms {
			key := s.Kind + ":" + s.Name
			if old, exists := oldMap[key]; !exists {
				snippet := ""
				if newCode, err := readLinesCached(lc, newPath, s.StartLine, s.EndLine); err == nil {
					snippet = generateSymbolDiffSnippet("", newCode, "added")
				}
				diffItems = append(diffItems, SymbolDiffItem{
					Name:        s.Name,
					Kind:        s.Kind,
					Change:      "added",
					Exported:    s.Exported,
					StartLine:   s.StartLine,
					EndLine:     s.EndLine,
					DiffSnippet: snippet,
				})
			} else {
				if checkSymbolContentChanged(cfg, req.Owner, req.Repo, req.FromSha, req.ToSha, file, old, s, lc) {
					snippet := ""
					oldCode, _ := readLinesCached(lc, oldPath, old.StartLine, old.EndLine)
					newCode, _ := readLinesCached(lc, newPath, s.StartLine, s.EndLine)
					snippet = generateSymbolDiffSnippet(oldCode, newCode, "modified")
					diffItems = append(diffItems, SymbolDiffItem{
						Name:         s.Name,
						Kind:         s.Kind,
						Change:       "modified",
						Exported:     s.Exported || old.Exported,
						StartLine:    s.StartLine,
						EndLine:      s.EndLine,
						OldStartLine: old.StartLine,
						OldEndLine:   old.EndLine,
						DiffSnippet:  snippet,
					})
				}
			}
		}

		for _, s := range oldSyms {
			key := s.Kind + ":" + s.Name
			if _, exists := newMap[key]; !exists {
				snippet := ""
				if oldCode, err := readLinesCached(lc, oldPath, s.StartLine, s.EndLine); err == nil {
					snippet = generateSymbolDiffSnippet(oldCode, "", "removed")
				}
				diffItems = append(diffItems, SymbolDiffItem{
					Name:         s.Name,
					Kind:         s.Kind,
					Change:       "removed",
					Exported:     s.Exported,
					OldStartLine: s.StartLine,
					OldEndLine:   s.EndLine,
					DiffSnippet:  snippet,
				})
			}
		}

		category, details := evalModifiedFileCategory(modifiedCategoryContext{
			file:         file,
			diffItems:    diffItems,
			oldSyms:      oldSyms,
			newSyms:      newSyms,
			oldPath:      oldPath,
			newPath:      newPath,
			classifier:   classifier,
			fromArtifact: fromArtifact,
			toArtifact:   toArtifact,
			exportedMap:  exportedChangedSymbols,
		})

		fileDiffs[file] = FileSemanticDiff{
			Path:        file,
			Category:    category,
			SymbolDiffs: diffItems,
			Details:     details,
		}
	}

	for _, file := range req.AddedFiles {
		var newSyms []SymbolEntry
		if toArtifact != nil && toArtifact.SymbolsByFile != nil {
			newSyms = toArtifact.SymbolsByFile[file]
		}
		newPath := filepath.Join(archive.ArchiveDirFor(archiveRoot, req.Owner, req.Repo, req.ToSha), filepath.FromSlash(file))
		var diffItems []SymbolDiffItem
		hasExported := false
		for _, s := range newSyms {
			snippet := ""
			if newCode, err := readLinesCached(lc, newPath, s.StartLine, s.EndLine); err == nil {
				snippet = generateSymbolDiffSnippet("", newCode, "added")
			}
			diffItems = append(diffItems, SymbolDiffItem{
				Name:        s.Name,
				Kind:        s.Kind,
				Change:      "added",
				Exported:    s.Exported,
				StartLine:   s.StartLine,
				EndLine:     s.EndLine,
				DiffSnippet: snippet,
			})
			if s.Exported {
				hasExported = true
				if exportedChangedSymbols[file] == nil {
					exportedChangedSymbols[file] = make(map[string]string)
				}
				exportedChangedSymbols[file][s.Name] = "added"
			}
		}
		category, details := evalAddedOrRemovedFileCategory(
			file, "added", newPath, hasExported, len(newSyms), classifier, exportedChangedSymbols,
		)
		fileDiffs[file] = FileSemanticDiff{
			Path:        file,
			Category:    category,
			SymbolDiffs: diffItems,
			Details:     details,
		}
	}

	for _, file := range req.RemovedFiles {
		var oldSyms []SymbolEntry
		if fromArtifact != nil && fromArtifact.SymbolsByFile != nil {
			oldSyms = fromArtifact.SymbolsByFile[file]
		}
		oldPath := filepath.Join(archive.ArchiveDirFor(archiveRoot, req.Owner, req.Repo, req.FromSha), filepath.FromSlash(file))
		var diffItems []SymbolDiffItem
		hasExported := false
		for _, s := range oldSyms {
			snippet := ""
			if oldCode, err := readLinesCached(lc, oldPath, s.StartLine, s.EndLine); err == nil {
				snippet = generateSymbolDiffSnippet(oldCode, "", "removed")
			}
			diffItems = append(diffItems, SymbolDiffItem{
				Name:         s.Name,
				Kind:         s.Kind,
				Change:       "removed",
				Exported:     s.Exported,
				OldStartLine: s.StartLine,
				OldEndLine:   s.EndLine,
				DiffSnippet:  snippet,
			})
			if s.Exported {
				hasExported = true
				if exportedChangedSymbols[file] == nil {
					exportedChangedSymbols[file] = make(map[string]string)
				}
				exportedChangedSymbols[file][s.Name] = "removed"
			}
		}
		category, details := evalAddedOrRemovedFileCategory(
			file, "removed", oldPath, hasExported, len(oldSyms), classifier, exportedChangedSymbols,
		)
		fileDiffs[file] = FileSemanticDiff{
			Path:        file,
			Category:    category,
			SymbolDiffs: diffItems,
			Details:     details,
		}
	}
	return fileDiffs, exportedChangedSymbols
}

func propagateRipple(
	fromArtifact, toArtifact *SemanticGraphArtifact,
	exportedChangedSymbols map[string]map[string]string,
	fileDiffs map[string]FileSemanticDiff,
) map[string][]SurgicalAnchor {

	edgeMap := make(map[string]bool)
	var rawCallEdges []CallEdge
	if fromArtifact != nil {
		rawCallEdges = append(rawCallEdges, fromArtifact.CallEdges...)
	}
	if toArtifact != nil {
		rawCallEdges = append(rawCallEdges, toArtifact.CallEdges...)
	}

	var uniqueEdges []CallEdge
	for _, edge := range rawCallEdges {
		key := fmt.Sprintf("%s:%s->%s:%s@%d", edge.CallerFile, edge.CallerSymbol, edge.CalleeFile, edge.CalleeSymbol, edge.Line)
		if !edgeMap[key] {
			edgeMap[key] = true
			uniqueEdges = append(uniqueEdges, edge)
		}
	}

	edgesByCallee := make(map[string][]CallEdge)
	for _, edge := range uniqueEdges {
		edgesByCallee[edge.CalleeFile] = append(edgesByCallee[edge.CalleeFile], edge)
	}

	findSymbolExported := func(file, symName string) bool {
		if toArtifact != nil && toArtifact.SymbolsByFile != nil {
			for _, s := range toArtifact.SymbolsByFile[file] {
				if s.Name == symName {
					return s.Exported
				}
			}
		}
		if fromArtifact != nil && fromArtifact.SymbolsByFile != nil {
			for _, s := range fromArtifact.SymbolsByFile[file] {
				if s.Name == symName {
					return s.Exported
				}
			}
		}
		return false
	}

	rippleCallers := make(map[string][]SurgicalAnchor)
	seenAnchorKeys := make(map[string]bool)

	type rippleTarget struct {
		file   string
		symbol string
		change string
		depth  int
	}

	var queue []rippleTarget
	for file, symMap := range exportedChangedSymbols {
		for symName, change := range symMap {
			queue = append(queue, rippleTarget{file: file, symbol: symName, change: change, depth: 1})
		}
	}

	visitedTargets := make(map[string]bool)
	for len(queue) > 0 {
		curr := queue[0]
		queue = queue[1:]

		vKey := fmt.Sprintf("%s:%s", curr.file, curr.symbol)
		if visitedTargets[vKey] {
			continue
		}
		visitedTargets[vKey] = true

		if curr.depth > 5 {
			continue
		}

		edges := edgesByCallee[curr.file]
		for _, edge := range edges {
			if edge.CallerFile == edge.CalleeFile {
				continue
			}
			if curr.symbol != "*" && edge.CalleeSymbol != "" && edge.CalleeSymbol != curr.symbol {
				continue
			}

			anchorKey := fmt.Sprintf("%s:%s:%s:%s@%d", edge.CallerFile, edge.CallerSymbol, edge.CalleeFile, edge.CalleeSymbol, edge.Line)
			if seenAnchorKeys[anchorKey] {
				continue
			}
			seenAnchorKeys[anchorKey] = true

			reason := fmt.Sprintf("调用了已变更的上游导出符号 %s::%s (%s)", edge.CalleeFile, edge.CalleeSymbol, curr.change)
			if curr.change == "removed" {
				reason = fmt.Sprintf("调用了已被删除的上游公共符号 %s::%s", edge.CalleeFile, edge.CalleeSymbol)
			}

			callerExported := findSymbolExported(edge.CallerFile, edge.CallerSymbol)
			diffSnippet := fmt.Sprintf("~ calls %s::%s (%s)", edge.CalleeFile, edge.CalleeSymbol, curr.change)
			anchor := SurgicalAnchor{
				SymbolName:  edge.CallerSymbol,
				Kind:        "function",
				File:        edge.CallerFile,
				Change:      "ripple",
				Exported:    callerExported,
				Line:        edge.Line,
				Reason:      reason,
				DiffSnippet: diffSnippet,
			}
			rippleCallers[edge.CallerFile] = append(rippleCallers[edge.CallerFile], anchor)

			existing, found := fileDiffs[edge.CallerFile]
			if !found || existing.Category == FileCategoryAstIdentical || existing.Category == FileCategoryUntouched || existing.Category == FileCategoryPrivateOnly {
				fileDiffs[edge.CallerFile] = FileSemanticDiff{
					Path:     edge.CallerFile,
					Category: FileCategoryRippleAffected,
					SymbolDiffs: append(existing.SymbolDiffs, SymbolDiffItem{
						Name:        edge.CallerSymbol,
						Kind:        "function",
						Change:      "ripple",
						Exported:    callerExported,
						StartLine:   edge.Line,
						EndLine:     edge.Line,
						DiffSnippet: diffSnippet,
					}),
					Details: fmt.Sprintf("调用了上游已变更的导出符号 %s::%s", edge.CalleeFile, edge.CalleeSymbol),
				}
			}

			if callerExported && edge.CallerSymbol != "" {
				queue = append(queue, rippleTarget{
					file:   edge.CallerFile,
					symbol: edge.CallerSymbol,
					change: "ripple",
					depth:  curr.depth + 1,
				})
			}
		}
	}
	return rippleCallers
}

func checkBreakingChange(fromArtifact *SemanticGraphArtifact, removedSet map[string]bool, fileDiffs map[string]FileSemanticDiff) bool {
	isBreaking := false

	if fromArtifact != nil {
		for _, golden := range fromArtifact.GoldenSymbols {
			if removedSet[golden.File] {
				isBreaking = true
				break
			}
			if fDiff, ok := fileDiffs[golden.File]; ok {
				for _, sym := range fDiff.SymbolDiffs {
					if sym.Name == golden.Name && (sym.Change == "removed" || !sym.Exported) {
						isBreaking = true
						break
					}
				}
			}
			if isBreaking {
				break
			}
		}
	}

	if fromArtifact != nil {
		for _, bb := range fromArtifact.BackboneNodes {
			if removedSet[bb] {
				isBreaking = true
				break
			}
		}
	}
	return isBreaking
}

func classifyChapters(
	req GraphDiffRequest,
	fileDiffs map[string]FileSemanticDiff,
	rippleCallers map[string][]SurgicalAnchor,
	addedSet, removedSet, modifiedSet map[string]bool,
	classifier *InfraClassifier,
	isBreaking bool,
) ([]ChapterSemanticDecision, int, int) {
	chapterDecisions := make([]ChapterSemanticDecision, 0, len(req.Chapters))
	exemptCount := 0
	updateCount := 0

	for _, ch := range req.Chapters {
		builder := newChapterDecisionBuilder(ch.Path, isBreaking, fileDiffs, classifier)
		for _, f := range ch.Files {
			builder.RecordFile(f, addedSet[f], removedSet[f], modifiedSet[f], rippleCallers)
		}
		dec := builder.Build()
		if dec.Action == ActionUpdate {
			updateCount++
		} else if dec.KeepExemption != nil {
			exemptCount++
		}
		chapterDecisions = append(chapterDecisions, dec)
	}
	return chapterDecisions, exemptCount, updateCount
}

type modifiedCategoryContext struct {
	file         string
	diffItems    []SymbolDiffItem
	oldSyms      []SymbolEntry
	newSyms      []SymbolEntry
	oldPath      string
	newPath      string
	classifier   *InfraClassifier
	fromArtifact *SemanticGraphArtifact
	toArtifact   *SemanticGraphArtifact
	exportedMap  map[string]map[string]string
}

func evalModifiedFileCategory(ctx modifiedCategoryContext) (FileSemanticCategory, string) {
	headerSample := readHeaderSample(ctx.newPath)
	if len(headerSample) == 0 {
		headerSample = readHeaderSample(ctx.oldPath)
	}

	if ctx.classifier.IsNonTeachingInfra(ctx.file, headerSample) {
		return FileCategoryAstIdentical, "基础设施文件（无需更新）"
	}

	if len(ctx.diffItems) == 0 {
		return evalEmptyDiffModifiedCategory(ctx)
	}

	return evalNonEmptyDiffModifiedCategory(ctx)
}

func evalEmptyDiffModifiedCategory(ctx modifiedCategoryContext) (FileSemanticCategory, string) {
	hasOldSymbols := len(ctx.oldSyms) > 0
	hasNewSymbols := len(ctx.newSyms) > 0
	if ctx.fromArtifact != nil && ctx.toArtifact != nil && hasOldSymbols && hasNewSymbols {
		return FileCategoryAstIdentical, "AST 语义全等（仅格式化或注释变更）"
	}

	oldData, errOld := os.ReadFile(ctx.oldPath)
	newData, errNew := os.ReadFile(ctx.newPath)
	if errOld == nil && errNew == nil && string(oldData) == string(newData) {
		return FileCategoryAstIdentical, "文件内容物理一致"
	}

	recordExportedChange(ctx.exportedMap, ctx.file, "*", "modified")
	return FileCategoryExportedChanged, "无 AST 符号比对证据，按潜在契约变更处理"
}

func evalNonEmptyDiffModifiedCategory(ctx modifiedCategoryContext) (FileSemanticCategory, string) {
	hasExported := false
	for _, item := range ctx.diffItems {
		if item.Exported {
			hasExported = true
			recordExportedChange(ctx.exportedMap, ctx.file, item.Name, item.Change)
		}
	}
	if hasExported {
		return FileCategoryExportedChanged, "公共导出符号发生变更"
	}
	return FileCategoryPrivateOnly, "仅内部私有实现发生变更，导出契约未受影响"
}

func evalAddedOrRemovedFileCategory(
	file, changeType, filePath string,
	hasExported bool,
	symCount int,
	classifier *InfraClassifier,
	exportedChangedSymbols map[string]map[string]string,
) (FileSemanticCategory, string) {
	category := FileCategoryExportedChanged
	details := "新增源文件"
	infraDetails := "新增基础设施文件"
	if changeType == "removed" {
		details = "删除源文件"
		infraDetails = "删除基础设施文件"
	}

	headerSample := readHeaderSample(filePath)
	if classifier.IsNonTeachingInfra(file, headerSample) {
		delete(exportedChangedSymbols, file)
		return FileCategoryAstIdentical, infraDetails
	}
	if !hasExported && symCount > 0 {
		return FileCategoryPrivateOnly, details
	}
	if hasExported {
		if exportedChangedSymbols[file] == nil {
			exportedChangedSymbols[file] = make(map[string]string)
		}
		exportedChangedSymbols[file]["*"] = changeType
	}
	return category, details
}

type chapterDecisionBuilder struct {
	path              string
	isGlobalBreaking  bool
	fileDiffs         map[string]FileSemanticDiff
	classifier        *InfraClassifier
	affectedFiles     []string
	hasStructural     bool
	hasExported       bool
	hasRipple         bool
	allExemptible     bool
	chapterIsBreaking bool
	surgicalAnchors   []SurgicalAnchor
}

func newChapterDecisionBuilder(
	path string,
	isGlobalBreaking bool,
	fileDiffs map[string]FileSemanticDiff,
	classifier *InfraClassifier,
) *chapterDecisionBuilder {
	return &chapterDecisionBuilder{
		path:             path,
		isGlobalBreaking: isGlobalBreaking,
		fileDiffs:        fileDiffs,
		classifier:       classifier,
		allExemptible:    true,
	}
}

func (b *chapterDecisionBuilder) RecordFile(
	f string,
	isAdded, isRemoved, isModified bool,
	rippleCallers map[string][]SurgicalAnchor,
) {
	diff, found := b.fileDiffs[f]
	if found && diff.Category == FileCategoryAstIdentical {
		b.affectedFiles = append(b.affectedFiles, f)
		return
	}

	if isAdded || isRemoved {
		b.hasStructural = true
		b.allExemptible = false
		b.affectedFiles = append(b.affectedFiles, f)
		b.surgicalAnchors = append(b.surgicalAnchors, SurgicalAnchor{
			SymbolName: "",
			Kind:       "file",
			File:       f,
			Change:     "structural",
			Exported:   true,
			Line:       0,
			Reason:     "文件结构变更（新增或删除）",
		})
		return
	}

	if found {
		switch diff.Category {
		case FileCategoryExportedChanged:
			b.hasExported = true
			b.allExemptible = false
			b.affectedFiles = append(b.affectedFiles, f)
			for _, sym := range diff.SymbolDiffs {
				if sym.Exported {
					b.surgicalAnchors = append(b.surgicalAnchors, SurgicalAnchor{
						SymbolName:  sym.Name,
						Kind:        sym.Kind,
						File:        f,
						Change:      sym.Change,
						Exported:    true,
						Line:        sym.StartLine,
						Reason:      fmt.Sprintf("导出符号 %s 发生变更 (%s)", sym.Name, sym.Change),
						DiffSnippet: sym.DiffSnippet,
					})
					if sym.Change == "removed" {
						b.chapterIsBreaking = true
					}
				}
			}
		case FileCategoryRippleAffected:
			b.hasRipple = true
			b.allExemptible = false
			b.affectedFiles = append(b.affectedFiles, f)
			if anchors, ok := rippleCallers[f]; ok {
				b.surgicalAnchors = append(b.surgicalAnchors, anchors...)
			}
		case FileCategoryPrivateOnly:
			b.affectedFiles = append(b.affectedFiles, f)
		}
	} else if isModified {
		b.affectedFiles = append(b.affectedFiles, f)
		if !b.classifier.IsNonTeachingInfra(f) {
			b.allExemptible = false
		}
	}
}

func (b *chapterDecisionBuilder) Build() ChapterSemanticDecision {
	decision := ChapterSemanticDecision{
		Path:       b.path,
		IsBreaking: b.chapterIsBreaking || (b.isGlobalBreaking && (b.hasExported || b.hasStructural)),
	}

	for _, a := range b.surgicalAnchors {
		if a.Change == "ripple" && strings.Contains(a.Reason, "已被删除") {
			decision.IsBreaking = true
		}
	}

	if b.hasStructural || b.hasExported || b.hasRipple || !b.allExemptible {
		decision.Action = ActionUpdate
		decision.SurgicalAnchors = b.surgicalAnchors
		return decision
	}

	decision.Action = ActionKeep
	if len(b.affectedFiles) == 0 {
		decision.KeepExemption = nil
		return decision
	}

	decision.KeepExemption = &KeepExemption{
		Reason:   b.deriveKeepReason(),
		Evidence: strings.Join(b.affectedFiles, ", "),
	}
	return decision
}

func (b *chapterDecisionBuilder) deriveKeepReason() string {
	reason := "AST 语义无实质变动（纯注释/格式化），教程内容不受影响，零 LLM 豁免"
	for _, f := range b.affectedFiles {
		if d, ok := b.fileDiffs[f]; ok && d.Category == FileCategoryPrivateOnly {
			return "仅内部私有实现发生变动（公共导出契约未变），教程内容不受影响，零 LLM 豁免"
		}
		if d, ok := b.fileDiffs[f]; ok && (strings.Contains(d.Details, "基础设施") || b.classifier.IsNonTeachingInfra(f)) {
			reason = "受影响文件全部为基础设施角色，教学核心未受影响，零 LLM 豁免"
		}
	}
	return reason
}

func recordExportedChange(m map[string]map[string]string, file, name, change string) {
	if m[file] == nil {
		m[file] = make(map[string]string)
	}
	m[file][name] = change
}
