package pipelineb

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/platform/client"
)

type PlanChapter struct {
	ModuleTitle string   `json:"moduleTitle,omitempty"`
	Name        string   `json:"name"`
	Summary     string   `json:"summary"`
	TargetPaths []string `json:"targetPaths"`
	FocusFiles  []string `json:"focusFiles,omitempty"`
	Phase       string   `json:"phase"`
	DrillDown   bool     `json:"drillDown"`
}

type planResponse struct {
	Chapters       []PlanChapter `json:"chapters"`
	NeedRoll       []string      `json:"needRollup"`
	CurriculumMode string        `json:"curriculumMode"`
	IntentMode     string        `json:"intentMode,omitempty"`
}

type PlannerModel interface {
	Plan(ctx context.Context, skeleton string, rollups map[string]string, feedback string, targetLanguage string) (string, error)
}

type DrillResult struct {
	Chapters       []cognitive.OutlineChapter
	Plan           []PlanChapter
	DroppedPlan    []string
	SkippedTrees   []string
	Replanned      bool
	DroppedPaths   []string
	Duration       time.Duration
	CurriculumMode string
	Thematic       bool
	Diagnostics    PipelineDiagnostics `json:"diagnostics,omitempty"`
}

// Unwrap preserves underlying gateway error codes for errors.As while carrying diagnostics on fail-closed abort.
type PlanErrorWithDiagnostics struct {
	Err         error
	Diagnostics PipelineDiagnostics
}

func (e *PlanErrorWithDiagnostics) Error() string { return e.Err.Error() }

func (e *PlanErrorWithDiagnostics) Unwrap() error { return e.Err }

type PipelineDiagnostics struct {
	NeedRollupRequested     int    `json:"needRollupRequested,omitempty"`
	NeedRollupCapped        bool   `json:"needRollupCapped,omitempty"`
	PlanDegenerateTriggered bool   `json:"planDegenerateTriggered,omitempty"`
	PlanDegenerateRecovered bool   `json:"planDegenerateRecovered,omitempty"`
	UncoveredSubsystemCount int    `json:"uncoveredSubsystemCount,omitempty"`
	NeedRollupQuota         int    `json:"needRollupQuota,omitempty"`
	NeedRollupDepth         int    `json:"needRollupDepth,omitempty"`
	IntentMode              string `json:"intentMode,omitempty"`
}

const drillChapterFileCap = 8

const thematicRollupFileBudget = 12

// Cap default drill concurrency <=2 to avoid saturating the upstream LLM gateway.
const DefaultDrillConcurrency = 2

func DrillConcurrency() int {
	if v := os.Getenv("DRILL_CONCURRENCY"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return DefaultDrillConcurrency
}

type ProgressStep struct {
	Stage    string  `json:"stage"`
	Title    string  `json:"title"`
	Detail   string  `json:"detail"`
	Progress float64 `json:"progress,omitempty"`
}

type ProgressCallback func(step ProgressStep)

const (
	TeachingDepthOverview = "overview"
	TeachingDepthStandard = "standard"
	TeachingDepthDeep     = "deep"
)

const (
	RollupLevelMax               = 3
	rollupQuotaL0, rollupDepthL0 = 3, 1
	rollupQuotaL1, rollupDepthL1 = 4, 1
	rollupQuotaL2, rollupDepthL2 = 5, 2
	rollupQuotaL3, rollupDepthL3 = 8, 2
)

func RollupBudgetForLevel(level int) (quota, depth int) {
	if level < 0 {
		level = 0
	}
	if level > RollupLevelMax {
		level = RollupLevelMax
	}
	switch level {
	case 1:
		return rollupQuotaL1, rollupDepthL1
	case 2:
		return rollupQuotaL2, rollupDepthL2
	case 3:
		return rollupQuotaL3, rollupDepthL3
	default:
		return rollupQuotaL0, rollupDepthL0
	}
}

func RunDrill(ctx context.Context, m *RepoMap, planner PlannerModel, model OutlineModel, patterns cognitive.Patterns, targetLanguage string, teachingDepth string, rollupLevel int, progressFn ...ProgressCallback) (*DrillResult, error) {
	start := time.Now()
	var cb ProgressCallback
	if len(progressFn) > 0 && progressFn[0] != nil {
		cb = progressFn[0]
	}
	subsystems := DiscoverSubsystems(SubsystemSourcesFromRepoMap(m), patterns)
	res, err := runDrillLevel(ctx, m, planner, model, patterns, targetLanguage, teachingDepth, subsystems, cb, rollupLevel)
	if err != nil {
		return nil, err
	}
	res.Duration = time.Since(start)
	return res, nil
}

func runDrillLevel(
	ctx context.Context,
	m *RepoMap,
	planner PlannerModel,
	model OutlineModel,
	patterns cognitive.Patterns,
	targetLanguage string,
	teachingDepth string,
	subsystems []SubsystemSpec,
	cb ProgressCallback,
	rollupLevel int,
) (*DrillResult, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	root := skipRootWrapper(m.Tree)

	quota, rollupDepth := RollupBudgetForLevel(rollupLevel)
	planResp, replanned, planDiag, err := obtainPlan(ctx, planner, root, targetLanguage, quota, rollupDepth)
	if err != nil {
		return nil, &PlanErrorWithDiagnostics{Err: fmt.Errorf("plan: %w", err), Diagnostics: planDiag}
	}

	thematic := planResp.IntentMode == "thematic_slice"

	effectiveCap := DrillSubtreeFileCap()

	if planResp.CurriculumMode == "single" {
		thematicSingleFocus := thematic && hasAnyFocusFiles(planResp.Chapters)
		if !thematicSingleFocus {
			if m.Tree.FileCount <= 800 {
				res, err := Run(ctx, m, model, patterns, targetLanguage)
				if err != nil {
					return nil, fmt.Errorf("single mode run: %w", err)
				}
				AttachSubtreeCompanionsWithMap(res.Chapters, root, m, subsystems)
				return &DrillResult{
					Chapters:       res.Chapters,
					Plan:           planResp.Chapters,
					Replanned:      replanned,
					DroppedPaths:   res.DroppedPaths,
					CurriculumMode: "single",
					Diagnostics:    planDiag,
					Thematic:       thematic,
				}, nil
			} else {
				log.Printf("[pipelineb] Guardrail repo size (%d files) exceeds single mode capacity, overriding to matrix mode\n", m.Tree.FileCount)
				planResp.CurriculumMode = "matrix"
			}
		}
	}

	plan := planResp.Chapters

	validPlan := make([]PlanChapter, 0, len(plan))
	droppedPlan := []string{}
	pathSet := map[string]bool{}
	var targets []string

	for _, ch := range plan {
		valid := ch.TargetPaths[:0:0]
		validSeen := make(map[string]bool, len(ch.TargetPaths))
		for _, tp := range ch.TargetPaths {
			sub := findSubtree(root, tp)
			if sub != nil {
				if !validSeen[tp] {
					validSeen[tp] = true
					valid = append(valid, tp)
				}
				if !pathSet[tp] {
					pathSet[tp] = true
					targets = append(targets, tp)
				}
			}
		}
		validFocus, rescuedTargets := resolveFocusTargets(root, ch.FocusFiles)
		for _, rt := range rescuedTargets {
			if !validSeen[rt] {
				validSeen[rt] = true
				valid = append(valid, rt)
			}
			if !pathSet[rt] {
				pathSet[rt] = true
				targets = append(targets, rt)
			}
		}
		ch.FocusFiles = validFocus
		if len(valid) == 0 && len(validFocus) == 0 {
			droppedPlan = append(droppedPlan, ch.Name)
			continue
		}
		ch.TargetPaths = valid
		validPlan = append(validPlan, ch)
	}
	plan = validPlan

	if cb != nil {
		cb(ProgressStep{
			Stage:  "plan",
			Title:  "宏观课程划分完成",
			Detail: fmt.Sprintf("规划出总览课与 %d 个核心子模块", len(validPlan)),
		})
	}

	// Pass full LeafFiles universe to sanitizer because subtree drill extracts files beyond the initial map subset.
	universe, _ := m.Tree.leafFilesIndexed()
	allNodes := make([]cluster.GitNode, 0, len(universe))
	allCandidates := make([]cognitive.CandidateOutlineFile, 0, len(universe))
	for _, f := range universe {
		allNodes = append(allNodes, cluster.GitNode{Path: f.Path, Type: "blob"})
		allCandidates = append(allCandidates, cognitive.CandidateOutlineFile{Path: f.Path, IsDoc: f.IsDoc})
	}

	byPath := map[string][]cognitive.OutlineChapter{}
	skipped := []string{}

	if os.Getenv("DRILL_LLM_SUBTREE") == "1" {
		type subResult struct {
			path     string
			chapters []cognitive.OutlineChapter
			failed   bool
		}
		subCh := make(chan subResult, len(targets))
		var wg sync.WaitGroup
		drillSem := make(chan struct{}, DrillConcurrency())
		totalTargets := len(targets)

		for idx, tp := range targets {
			wg.Add(1)
			go func(targetIdx int, path string) {
				defer wg.Done()
				select {
				case drillSem <- struct{}{}:
				case <-ctx.Done():
					subCh <- subResult{path: path, failed: true}
					return
				}
				defer func() { <-drillSem }()

				if ctx.Err() != nil {
					subCh <- subResult{path: path, failed: true}
					return
				}

				if cb != nil {
					cb(ProgressStep{
						Stage:  "drill",
						Title:  fmt.Sprintf("子课程下钻 (%d/%d)", targetIdx+1, totalTargets),
						Detail: fmt.Sprintf("正在规划: %s", path),
					})
				}

				sub := findSubtree(root, path)
				if sub == nil {
					subCh <- subResult{path: path, failed: true}
					return
				}
				var allSubLeaves []FileMap
				if sub == root {
					allSubLeaves = sub.Files
				} else {
					allSubLeaves = sub.LeafFiles()
				}
				if len(allSubLeaves) == 0 {
					subCh <- subResult{path: path, failed: true}
					return
				}

				leaves := capFiles(allSubLeaves, effectiveCap, thematic)
				subMap := &RepoMap{RepoName: m.RepoName + "/" + sub.Name, Files: leaves, Tree: sub}
				for _, f := range leaves {
					subMap.TotalLOC += f.LOC
				}
				res, err := Run(ctx, subMap, model, patterns, targetLanguage)
				if err != nil || len(res.Chapters) == 0 {
					res, err = Run(ctx, subMap, model, patterns, targetLanguage)
					if err != nil || len(res.Chapters) == 0 {
						subCh <- subResult{path: path, failed: true}
						return
					}
				}
				if cb != nil {
					cb(ProgressStep{
						Stage:  "drill",
						Title:  fmt.Sprintf("子课程下钻 (%d/%d)", targetIdx+1, totalTargets),
						Detail: fmt.Sprintf("完成规划: %s", path),
					})
				}
				subCh <- subResult{path: path, chapters: res.Chapters}
			}(idx, tp)
		}
		wg.Wait()
		close(subCh)

		for r := range subCh {
			if r.failed {
				skipped = append(skipped, r.path)
				continue
			}
			byPath[r.path] = r.chapters
		}
		sort.Strings(skipped)
	} else {
		claimingChapters := make(map[string][]PlanChapter, len(targets))
		for _, pch := range plan {
			if len(pch.FocusFiles) > 0 {
				continue
			}
			for _, tp := range pch.TargetPaths {
				claimingChapters[tp] = append(claimingChapters[tp], pch)
			}
		}
		totalTargets := len(targets)
		for idx, tp := range targets {
			if cb != nil {
				cb(ProgressStep{
					Stage:  "drill",
					Title:  fmt.Sprintf("子课程下钻 (%d/%d)", idx+1, totalTargets),
					Detail: fmt.Sprintf("拓扑装配: %s", tp),
				})
			}
			sub := findSubtree(root, tp)
			if sub == nil {
				skipped = append(skipped, tp)
				continue
			}
			var allSubLeaves []FileMap
			if sub == root {
				allSubLeaves = sub.Files
			} else {
				allSubLeaves = sub.LeafFiles()
			}
			if len(allSubLeaves) == 0 {
				skipped = append(skipped, tp)
				continue
			}
			// Thematic mode skips doc/config entry biases so selection follows AST symbol signal instead of README dominance.
			sortedLeaves := sortSubtreeFilesByRelevance(allSubLeaves, teachingDepth, thematic)
			claims := claimingChapters[tp]
			if len(claims) > 1 {
				byPath[tp] = partitionSubtreeForChapters(sortedLeaves, claims, drillChapterFileCap)
			} else {
				byPath[tp] = chunkFilesIntoOutlineChapters(sortedLeaves, drillChapterFileCap)
			}
		}
		sort.Strings(skipped)
	}

	// Claim shared subtree outlines per chapter in order instead of cloning so cross-chapter dedup does not wipe chapters.
	next := map[string]int{}
	lastClaim := map[string]int{}
	var chapters []cognitive.OutlineChapter
	for _, pch := range plan {
		var files []cognitive.ChapterFile
		if len(pch.FocusFiles) > 0 {
			for _, p := range pch.FocusFiles {
				files = append(files, cognitive.ChapterFile{Path: p})
			}
		} else {
			for _, tp := range pch.TargetPaths {
				pool := byPath[tp]
				i := next[tp]
				if i < len(pool) {
					for _, f := range pool[i].Files {
						if len(files) >= drillChapterFileCap {
							break
						}
						files = append(files, f)
					}
					next[tp] = i + 1
					lastClaim[tp] = len(chapters)
				}
			}
		}
		if len(files) == 0 {
			continue
		}
		chapters = append(chapters, cognitive.OutlineChapter{
			Name: pch.Name, Summary: pch.Summary, Files: files, PartTitle: pch.ModuleTitle,
		})
	}
	for _, tp := range targets {
		pool := byPath[tp]
		if idx, ok := lastClaim[tp]; ok {
			for i := next[tp]; i < len(pool); i++ {
				for _, f := range pool[i].Files {
					if len(chapters[idx].Files) >= drillChapterFileCap {
						break
					}
					chapters[idx].Files = append(chapters[idx].Files, f)
				}
			}
		}
	}

	// Drill into distinct AST symbol anchors or sibling files before sanitization when chapters share one file.
	allCandidates = stabilizeChapterAnchorsAndCandidates(chapters, root, allCandidates)

	var sanOpts []cognitive.SanitizeOption
	if thematic {
		sanOpts = append(sanOpts, cognitive.WithoutReadmeBackfill())
	}
	san := cognitive.SanitizeAndIntersectOutline(chapters, allNodes, "", targetLanguage, allCandidates, patterns, sanOpts...)
	chapters = san.Sanitized
	droppedPaths := san.DroppedPaths

	AttachSubtreeCompanionsWithMap(chapters, root, m, subsystems, thematic)

	observabilityCustomPrompt := ""
	if ca, ok := model.(teachingContextAware); ok {
		_, observabilityCustomPrompt = ca.TeachingContext()
	} else if ca, ok := planner.(teachingContextAware); ok {
		_, observabilityCustomPrompt = ca.TeachingContext()
	}
	if fb := evaluateSubsystemCoverage(subsystems, chapters, "", teachingDepth, observabilityCustomPrompt); fb != nil {
		planDiag.UncoveredSubsystemCount = len(fb.MissingSubsystems)
		log.Printf("[pipelineb] CoverageGate depth2 warning: uncovered core subsystems %v (summary: %s) — observability only, no replan\n",
			fb.MissingSubsystems, subsystemCoverageSummary(subsystems, chapters, ""))
	}

	if cb != nil {
		cb(ProgressStep{
			Stage:  "assemble",
			Title:  "课程树装配完成",
			Detail: fmt.Sprintf("已汇编 %d 个教学章节并完成全集物理装甲校验", len(chapters)),
		})
	}

	return &DrillResult{
		Chapters:       chapters,
		Plan:           plan,
		DroppedPlan:    droppedPlan,
		SkippedTrees:   skipped,
		Replanned:      replanned,
		DroppedPaths:   droppedPaths,
		CurriculumMode: planResp.CurriculumMode,
		Diagnostics:    planDiag,
		Thematic:       thematic,
	}, nil
}

func planDegenerate(plan []PlanChapter, root *RepoTreeNode, thematic bool) bool {
	if thematic {
		if len(plan) == 0 {
			return true
		}
		for _, ch := range plan {
			if !chapterHasResolvableTarget(ch, root) {
				return true
			}
		}
		return false
	}
	if root.FileCount <= 3 {
		return len(plan) < 2
	}
	if len(plan) < 3 {
		return true
	}
	rootName := root.Name
	distinct := map[string]bool{}
	rootHits := 0
	for _, ch := range plan {
		for _, tp := range ch.TargetPaths {
			if tp == rootName || tp == "." {
				rootHits++
			} else if sub := findSubtree(root, tp); sub != nil && sub != root {
				distinct[sub.Path] = true
			}
		}
	}
	if rootHits > len(plan)/2 {
		return true
	}
	minDistinct := max(1, min(len(root.Children), 3))
	return len(distinct) < minDistinct
}

func normalizeTargetPath(rootName, path string) string {
	p := strings.TrimSpace(path)
	p = strings.Trim(p, "`")
	p = strings.TrimSpace(p)
	for len(p) > 0 && (strings.HasPrefix(p, "./") || strings.HasPrefix(p, "/")) {
		p = strings.TrimPrefix(p, "./")
		p = strings.TrimPrefix(p, "/")
	}
	if rootName != "" && p != rootName {
		p = strings.TrimPrefix(p, rootName+"/")
	}
	return p
}

func normalizePlanPaths(plan []PlanChapter, root *RepoTreeNode) {
	for i := range plan {
		for j, tp := range plan[i].TargetPaths {
			plan[i].TargetPaths[j] = normalizeTargetPath(root.Name, tp)
		}
		for j, ff := range plan[i].FocusFiles {
			plan[i].FocusFiles[j] = cleanFocusFileToken(root, ff)
		}
	}
}

func cleanFocusFileToken(root *RepoTreeNode, raw string) string {
	p := strings.TrimSpace(raw)
	p = strings.Trim(p, "`\"'")
	p = strings.TrimSpace(p)
	if i := strings.IndexByte(p, '#'); i >= 0 {
		p = strings.TrimSpace(p[:i])
	}
	p = filepath.ToSlash(p)
	for len(p) > 0 && (strings.HasPrefix(p, "./") || strings.HasPrefix(p, "/")) {
		p = strings.TrimPrefix(p, "./")
		p = strings.TrimPrefix(p, "/")
	}
	p = strings.TrimRight(p, "/")
	if root != nil && root.Path == "" && root.Name != "" && p != root.Name {
		p = strings.TrimPrefix(p, root.Name+"/")
	}
	return p
}

func normalizeFocusFile(rootName, p string) string {
	p = normalizeTargetPath(rootName, p)
	if i := strings.IndexByte(p, '#'); i >= 0 {
		p = strings.TrimSpace(p[:i])
	}
	return p
}

func isDirectorySubtreeMatch(sub, root *RepoTreeNode) bool {
	if sub == nil || sub == root {
		return false
	}
	if len(sub.Children) > 0 || len(sub.Files) > 1 {
		return true
	}
	return len(sub.Files) == 1 && sub.Files[0].Path != sub.Path
}

func lookupLeafFilePath(root *RepoTreeNode, leaves []FileMap, leafIdx map[string]*FileMap, clean string) string {
	if clean == "" {
		return ""
	}
	if _, ok := leafIdx[clean]; ok {
		return clean
	}
	if root != nil && root.Path != "" && !strings.HasPrefix(clean, root.Path+"/") {
		withScope := root.Path + "/" + clean
		if _, ok := leafIdx[withScope]; ok {
			return withScope
		}
	}
	if root != nil && root.Path != "" {
		if slash := strings.IndexByte(clean, '/'); slash > 0 {
			tail := clean[slash+1:]
			if strings.HasPrefix(tail, root.Path+"/") {
				if _, ok := leafIdx[tail]; ok {
					return tail
				}
			}
		}
	}
	if root != nil && root.Name != "" {
		stripped := strings.TrimPrefix(clean, root.Name+"/")
		if stripped != clean {
			if _, ok := leafIdx[stripped]; ok {
				return stripped
			}
		}
	}
	if strings.Contains(clean, "/") {
		var suffixMatch string
		count := 0
		for _, f := range leaves {
			if strings.HasSuffix(f.Path, "/"+clean) {
				suffixMatch = f.Path
				count++
				if count > 1 {
					break
				}
			}
		}
		if count == 1 {
			return suffixMatch
		}
	}
	return ""
}

func resolveFocusTargets(root *RepoTreeNode, rawFocus []string) (validFiles []string, rescuedTargets []string) {
	if root == nil || len(rawFocus) == 0 {
		return nil, nil
	}
	leaves, leafIdx := root.leafFilesIndexed()
	seenFiles := make(map[string]bool, len(rawFocus))
	seenTargets := make(map[string]bool)

	addFile := func(p string) {
		if p == "" || seenFiles[p] || len(validFiles) >= drillChapterFileCap {
			return
		}
		seenFiles[p] = true
		validFiles = append(validFiles, p)
	}

	for _, ff := range rawFocus {
		clean := cleanFocusFileToken(root, ff)
		if clean == "" {
			continue
		}

		if strings.ContainsAny(clean, "*?") {
			var matched []FileMap
			for _, f := range leaves {
				if f.IsTest || f.IsConfig {
					continue
				}
				if MatchRepoGlob(clean, f.Path) ||
					(root.Path != "" && MatchRepoGlob(root.Path+"/"+clean, f.Path)) ||
					(root.Path != "" && strings.HasPrefix(f.Path, root.Path+"/") && MatchRepoGlob(clean, strings.TrimPrefix(f.Path, root.Path+"/"))) {
					matched = append(matched, f)
				}
			}
			sort.Slice(matched, func(i, j int) bool {
				if matched[i].Hotness != matched[j].Hotness {
					return matched[i].Hotness > matched[j].Hotness
				}
				if matched[i].LOC != matched[j].LOC {
					return matched[i].LOC > matched[j].LOC
				}
				return matched[i].Path < matched[j].Path
			})
			for _, mf := range matched {
				addFile(mf.Path)
			}
			continue
		}

		if resolved := lookupLeafFilePath(root, leaves, leafIdx, clean); resolved != "" {
			addFile(resolved)
			continue
		}

		if sub := findSubtree(root, clean); isDirectorySubtreeMatch(sub, root) {
			if !seenTargets[clean] {
				seenTargets[clean] = true
				rescuedTargets = append(rescuedTargets, clean)
			}
			continue
		}
		dirPrefix := clean
		if root.Path != "" && !strings.HasPrefix(dirPrefix, root.Path+"/") {
			dirPrefix = root.Path + "/" + clean
		}
		var dirFiles []FileMap
		for _, f := range leaves {
			if f.IsTest || f.IsConfig {
				continue
			}
			if strings.HasPrefix(f.Path, clean+"/") || strings.HasPrefix(f.Path, dirPrefix+"/") {
				dirFiles = append(dirFiles, f)
			}
		}
		if len(dirFiles) > 0 {
			for _, df := range sortFilesThematic(dirFiles) {
				addFile(df.Path)
			}
		}
	}
	return validFiles, rescuedTargets
}

func chapterHasResolvableTarget(ch PlanChapter, root *RepoTreeNode) bool {
	if root == nil {
		return false
	}
	for _, tp := range ch.TargetPaths {
		if tp == root.Name || tp == "." || findSubtree(root, tp) != nil {
			return true
		}
	}
	vf, rt := resolveFocusTargets(root, ch.FocusFiles)
	return len(vf) > 0 || len(rt) > 0
}

func extractChapterAsciiTokens(ch PlanChapter) []string {
	text := strings.ToLower(ch.Name + " " + ch.Summary)
	var tokens []string
	seen := make(map[string]bool)
	i := 0
	for i < len(text) {
		b := text[i]
		isWord := (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') || b == '_' || b == '-'
		if !isWord {
			i++
			continue
		}
		start := i
		for i < len(text) {
			c := text[i]
			if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-') {
				break
			}
			i++
		}
		tok := strings.Trim(text[start:i], "_-")
		if len(tok) >= 3 && !seen[tok] {
			seen[tok] = true
			tokens = append(tokens, tok)
		}
	}
	return tokens
}

func fileChapterMatchScore(f FileMap, tokens []string) int {
	if len(tokens) == 0 {
		return 0
	}
	lowerPath := strings.ToLower(f.Path)
	var symBuilder strings.Builder
	for _, s := range effectiveSymbols(f) {
		symBuilder.WriteByte(' ')
		symBuilder.WriteString(strings.ToLower(s))
	}
	syms := symBuilder.String()

	score := 0
	for _, tok := range tokens {
		if strings.Contains(lowerPath, tok) {
			score += 3
		}
		if syms != "" && strings.Contains(syms, tok) {
			score += 2
		}
	}
	return score
}

func partitionSubtreeForChapters(sortedLeaves []FileMap, claims []PlanChapter, chunkSize int) []cognitive.OutlineChapter {
	k := len(claims)
	if k <= 1 || len(sortedLeaves) == 0 {
		return chunkFilesIntoOutlineChapters(sortedLeaves, chunkSize)
	}
	if chunkSize <= 0 {
		chunkSize = drillChapterFileCap
	}

	primaryPool := make([]FileMap, 0, len(sortedLeaves))
	for _, f := range sortedLeaves {
		if !f.IsTest && !f.IsConfig {
			primaryPool = append(primaryPool, f)
		}
	}
	if len(primaryPool) == 0 {
		primaryPool = sortedLeaves
	}

	tokensByClaim := make([][]string, k)
	for i, ch := range claims {
		tokensByClaim[i] = extractChapterAsciiTokens(ch)
	}

	buckets := make([][]cognitive.ChapterFile, k)
	usedIdx := make([]bool, len(primaryPool))

	if len(primaryPool) >= k {
		for ci := 0; ci < k; ci++ {
			bestIdx, bestScore := -1, -1
			for fi, f := range primaryPool {
				if usedIdx[fi] {
					continue
				}
				sc := fileChapterMatchScore(f, tokensByClaim[ci])
				if sc > bestScore {
					bestScore = sc
					bestIdx = fi
				}
			}
			if bestIdx >= 0 {
				usedIdx[bestIdx] = true
				buckets[ci] = append(buckets[ci], cognitive.ChapterFile{Path: primaryPool[bestIdx].Path})
			}
		}

		perCap := min(chunkSize, max(1, (len(primaryPool)+k-1)/k))
		for round := 1; round < perCap; round++ {
			progressed := false
			for ci := 0; ci < k; ci++ {
				if len(buckets[ci]) >= perCap {
					continue
				}
				bestIdx, bestScore := -1, -1
				for fi, f := range primaryPool {
					if usedIdx[fi] {
						continue
					}
					sc := fileChapterMatchScore(f, tokensByClaim[ci])
					if sc > bestScore {
						bestScore = sc
						bestIdx = fi
					}
				}
				if bestIdx >= 0 {
					usedIdx[bestIdx] = true
					buckets[ci] = append(buckets[ci], cognitive.ChapterFile{Path: primaryPool[bestIdx].Path})
					progressed = true
				}
			}
			if !progressed {
				break
			}
		}

		out := make([]cognitive.OutlineChapter, k)
		for ci := 0; ci < k; ci++ {
			out[ci] = cognitive.OutlineChapter{Files: buckets[ci]}
		}
		return out
	}

	for fi := 0; fi < len(primaryPool); fi++ {
		buckets[fi] = append(buckets[fi], cognitive.ChapterFile{Path: primaryPool[fi].Path})
	}
	usedSym := make(map[string]bool)
	for ci := len(primaryPool); ci < k; ci++ {
		assigned := false
		for _, f := range primaryPool {
			for _, sym := range effectiveSymbols(f) {
				key := f.Path + "#" + strings.ToLower(sym)
				if !usedSym[key] {
					usedSym[key] = true
					buckets[ci] = append(buckets[ci], cognitive.ChapterFile{Path: f.Path, Anchor: sym})
					assigned = true
					break
				}
			}
			if assigned {
				break
			}
		}
		if !assigned {
			f := primaryPool[ci%len(primaryPool)]
			buckets[ci] = append(buckets[ci], cognitive.ChapterFile{Path: f.Path})
		}
	}

	out := make([]cognitive.OutlineChapter, k)
	for ci := 0; ci < k; ci++ {
		out[ci] = cognitive.OutlineChapter{Files: buckets[ci]}
	}
	return out
}

func stabilizeChapterAnchorsAndCandidates(
	chapters []cognitive.OutlineChapter,
	root *RepoTreeNode,
	candidates []cognitive.CandidateOutlineFile,
) []cognitive.CandidateOutlineFile {
	if len(chapters) == 0 || root == nil {
		return candidates
	}
	leaves, leafIdx := root.leafFilesIndexed()
	byDir := make(map[string][]FileMap)
	for _, f := range leaves {
		if !f.IsTest && !f.IsConfig {
			d := path.Dir(f.Path)
			byDir[d] = append(byDir[d], f)
		}
	}
	for d, list := range byDir {
		byDir[d] = sortFilesThematic(list)
	}

	candSet := make(map[string]bool, len(candidates))
	for _, c := range candidates {
		if c.Anchor != "" {
			candSet[c.Path+"#"+strings.ToLower(c.Anchor)] = true
		}
	}
	registerAnchorCandidate := func(filePath, anchor string) {
		if anchor == "" {
			return
		}
		k := filePath + "#" + strings.ToLower(anchor)
		if !candSet[k] {
			candSet[k] = true
			candidates = append(candidates, cognitive.CandidateOutlineFile{
				Path:   filePath,
				Anchor: anchor,
				Kind:   "symbol",
			})
		}
	}

	usedKeys := make(map[string]bool)
	for ci := range chapters {
		uniqueCount := 0
		for _, f := range chapters[ci].Files {
			if f.Anchor != "" {
				registerAnchorCandidate(f.Path, f.Anchor)
			}
			k := f.Path
			if f.Anchor != "" {
				k = f.Path + "#" + strings.ToLower(f.Anchor)
			}
			if !usedKeys[k] {
				usedKeys[k] = true
				uniqueCount++
			}
		}
		if uniqueCount > 0 || len(chapters[ci].Files) == 0 {
			continue
		}

		rescued := false
		for fi := range chapters[ci].Files {
			fp := chapters[ci].Files[fi].Path
			if fm, ok := leafIdx[fp]; ok {
				for _, sym := range effectiveSymbols(*fm) {
					k := fp + "#" + strings.ToLower(sym)
					if !usedKeys[k] {
						usedKeys[k] = true
						chapters[ci].Files[fi].Anchor = sym
						registerAnchorCandidate(fp, sym)
						rescued = true
						break
					}
				}
			}
			if rescued {
				break
			}
		}
		if rescued {
			continue
		}

		for _, f := range chapters[ci].Files {
			for _, sib := range byDir[path.Dir(f.Path)] {
				if !usedKeys[sib.Path] {
					usedKeys[sib.Path] = true
					chapters[ci].Files = append(chapters[ci].Files, cognitive.ChapterFile{Path: sib.Path})
					rescued = true
					break
				}
			}
			if rescued {
				break
			}
		}
	}
	return candidates
}

func hasAnyFocusFiles(plan []PlanChapter) bool {
	for _, ch := range plan {
		if len(ch.FocusFiles) > 0 {
			return true
		}
	}
	return false
}

func planFeedbackText(plan []PlanChapter, root *RepoTreeNode, thematic bool) string {
	if thematic {
		var unresolved []string
		for _, ch := range plan {
			for _, tp := range ch.TargetPaths {
				if tp != root.Name && tp != "." && findSubtree(root, tp) == nil {
					unresolved = append(unresolved, tp)
				}
			}
			if len(ch.FocusFiles) > 0 {
				vf, rt := resolveFocusTargets(root, ch.FocusFiles)
				if len(vf) == 0 && len(rt) == 0 {
					unresolved = append(unresolved, ch.FocusFiles...)
				}
			}
		}
		var sb strings.Builder
		sb.WriteString("上次专题规划未通过物理校验:")
		if len(unresolved) > 0 {
			fmt.Fprintf(&sb, "以下 targetPaths/focusFiles 无法解析到骨架图与符号索引中的真实路径: %s;", strings.Join(unresolved, ", "))
		}
		if root != nil && len(root.Children) > 0 {
			sampleDirs := make([]string, 0, min(len(root.Children), 6))
			for _, c := range root.Children {
				if len(sampleDirs) >= 6 {
					break
				}
				sampleDirs = append(sampleDirs, c.Path)
			}
			if len(sampleDirs) > 0 {
				fmt.Fprintf(&sb, "可用真实子目录包括: %s;", strings.Join(sampleDirs, ", "))
			}
		}
		sb.WriteString("请逐字复制符号索引或骨架行中的路径标识。")
		return sb.String()
	}
	if root.FileCount <= 3 {
		return "上次大纲规划章数不足:请至少给出 2 个教学章,严格遵循输出结构。"
	}
	var unresolved []string
	rootHits := 0
	for _, ch := range plan {
		for _, tp := range ch.TargetPaths {
			if tp == root.Name || tp == "." {
				rootHits++
				continue
			}
			if findSubtree(root, tp) == nil {
				unresolved = append(unresolved, tp)
			}
		}
	}
	var sb strings.Builder
	sb.WriteString("上次大纲规划未通过物理校验:")
	if len(unresolved) > 0 {
		fmt.Fprintf(&sb, "以下 targetPaths 无法解析到骨架图中的真实分区: %s;", strings.Join(unresolved, ", "))
	}
	if rootHits > len(plan)/2 {
		fmt.Fprintf(&sb, "过半章节(%d 个目标)指向仓库根;", rootHits)
	}
	minDistinct := max(1, min(len(root.Children), 3))
	fmt.Fprintf(&sb, "请重新规划:targetPaths 严格从骨架图行原样复制路径标识(禁止仓库根名前缀、绝对路径或凭记忆改写),确保至少 %d 个不同分区被有效覆盖。", minDistinct)
	return sb.String()
}

// Fail fast on permanent auth/quota/config errors; retries cannot recover missing keys or invalid models.
func isPermanentGatewayConfigError(err error) bool {
	var gw *client.LlmGatewayError
	if !errors.As(err, &gw) {
		return false
	}
	return gw.IsPermanentUpstreamError()
}

func isRetryablePlanError(err error) bool {
	if err == nil {
		return false
	}
	var gw *client.LlmGatewayError
	if errors.As(err, &gw) {
		if gw.IsPermanentUpstreamError() {
			return false
		}
		return gw.IsGenerationFailed() || gw.IsTransient() || gw.IsRateLimited()
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "connection reset") ||
		strings.Contains(msg, "broken pipe") ||
		strings.Contains(msg, "stream closed") ||
		strings.Contains(msg, "eof") ||
		strings.Contains(msg, "timeout")
}

func obtainPlan(ctx context.Context, planner PlannerModel, root *RepoTreeNode, targetLanguage string, rollupQuota, rollupDepth int) (resp *planResponse, replanned bool, diag PipelineDiagnostics, err error) {
	if rollupQuota < 1 {
		rollupQuota = rollupQuotaL0
	}
	if rollupDepth < 1 {
		rollupDepth = rollupDepthL0
	}
	customPrompt := ""
	if ca, ok := planner.(teachingContextAware); ok {
		_, customPrompt = ca.TeachingContext()
	}
	skeleton := RenderSkeleton(root)
	if customPrompt != "" {
		skeleton = RenderThematicSkeletonForPrompt(root, thematicSkeletonBudget, customPrompt)
	}
	var raw string
	for attempt := 0; attempt < 2; attempt++ {
		raw, err = planner.Plan(ctx, skeleton, nil, "", targetLanguage)
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			return nil, false, diag, ctx.Err()
		}
		if !isRetryablePlanError(err) || attempt >= 1 {
			return nil, false, diag, err
		}
		select {
		case <-ctx.Done():
			return nil, false, diag, ctx.Err()
		case <-time.After(time.Duration(1<<attempt) * time.Second):
		}
	}
	resp, err = parsePlan(raw)
	if err != nil {
		return nil, false, diag, err
	}
	normalizePlanPaths(resp.Chapters, root)
	firstIntent := resp.IntentMode
	// Cap rollup requests deterministically at quota rather than rejecting the whole plan.
	diag.NeedRollupRequested = len(resp.NeedRoll)
	diag.NeedRollupCapped = len(resp.NeedRoll) > rollupQuota
	diag.NeedRollupQuota = rollupQuota
	diag.NeedRollupDepth = rollupDepth
	if len(resp.NeedRoll) > rollupQuota {
		resp.NeedRoll = resp.NeedRoll[:rollupQuota]
	}
	// Preserve rollups across feedback replan so replanning sees the same subtree context.
	var lastRollups map[string]string
	if len(resp.NeedRoll) > 0 {
		rollups := map[string]string{}
		for _, p := range resp.NeedRoll {
			if sub := findSubtree(root, p); sub != nil {
				if customPrompt != "" {
					rollups[p] = RenderSubtreeSkeletonWithFiles(sub, rollupDepth, thematicRollupFileBudget)
				} else {
					rollups[p] = RenderSubtreeSkeleton(sub, rollupDepth)
				}
			}
		}
		if p2, ok := tryReplanningWithRollups(ctx, planner, skeleton, rollups, targetLanguage, root); ok {
			resp, replanned = p2, true
			if resp.IntentMode == "" && firstIntent == "thematic_slice" {
				resp.IntentMode = "thematic_slice"
			}
			lastRollups = rollups
		}
	}
	// Force full_repo when customPrompt is empty so model output cannot bypass full-repo coverage.
	if customPrompt == "" || resp.IntentMode == "" {
		resp.IntentMode = "full_repo"
	}
	thematic := customPrompt != "" && resp.IntentMode == "thematic_slice"
	diag.IntentMode = resp.IntentMode
	if planDegenerate(resp.Chapters, root, thematic) {
		diag.PlanDegenerateTriggered = true
		log.Printf("[pipelineb] DrillPlan degenerate plan (root=%s, chapters=%d) -> feedback replan\n", root.Name, len(resp.Chapters))
		raw2, err2 := planner.Plan(ctx, skeleton, lastRollups, planFeedbackText(resp.Chapters, root, thematic), targetLanguage)
		if err2 != nil {
			// Propagate transport/gateway errors verbatim on feedback replan instead of masking them as plan degeneration.
			if ctx.Err() != nil {
				return nil, false, diag, ctx.Err()
			}
			var gw2 *client.LlmGatewayError
			if errors.As(err2, &gw2) {
				return nil, false, diag, fmt.Errorf("feedback replan failed: %w", err2)
			}
		}
		if err2 == nil {
			if resp2, err3 := parsePlan(raw2); err3 == nil {
				normalizePlanPaths(resp2.Chapters, root)
				if customPrompt == "" || resp2.IntentMode == "" {
					resp2.IntentMode = "full_repo"
				}
				if !planDegenerate(resp2.Chapters, root, thematic) {
					if resp2.CurriculumMode == "" {
						resp2.CurriculumMode = "matrix"
					}
					diag.PlanDegenerateRecovered = true
					log.Printf("[pipelineb] DrillPlan feedback replan recovered (root=%s, chapters=%d)\n", root.Name, len(resp2.Chapters))
					return resp2, true, diag, nil
				}
			}
		}
		log.Printf("[pipelineb] DrillPlan plan still degenerated after feedback retry -> fail-closed (root=%s)\n", root.Name)
		return nil, false, diag, fmt.Errorf("outline plan degenerated: 有效分区覆盖不足或过半指向根 (root=%s)", root.Name)
	}
	if resp.CurriculumMode == "" {
		resp.CurriculumMode = "matrix"
	}
	return resp, replanned, diag, nil
}

func tryReplanningWithRollups(ctx context.Context, planner PlannerModel, skeleton string, rollups map[string]string, targetLanguage string, root *RepoTreeNode) (*planResponse, bool) {
	if len(rollups) == 0 {
		return nil, false
	}
	raw2, err2 := planner.Plan(ctx, skeleton, rollups, "", targetLanguage)
	if err2 != nil {
		return nil, false
	}
	resp2, err3 := parsePlan(raw2)
	if err3 != nil {
		return nil, false
	}
	normalizePlanPaths(resp2.Chapters, root)
	if resp2.CurriculumMode == "" {
		resp2.CurriculumMode = "matrix"
	}
	return resp2, true
}

func parsePlan(raw string) (*planResponse, error) {
	start := strings.Index(raw, "{")
	if start < 0 {
		return nil, errors.New("no JSON object in plan response")
	}
	// Decode only the first JSON object because models occasionally emit two consecutive objects.
	dec := json.NewDecoder(strings.NewReader(raw[start:]))
	var p planResponse
	if err := dec.Decode(&p); err != nil {
		return nil, fmt.Errorf("malformed plan JSON: %w", err)
	}
	if len(p.Chapters) == 0 {
		return nil, errors.New("zero plan chapters")
	}
	for _, c := range p.Chapters {
		if strings.TrimSpace(c.Name) == "" || (len(c.TargetPaths) == 0 && len(c.FocusFiles) == 0) {
			return nil, errors.New("invalid plan chapter (empty name, targets and focusFiles)")
		}
	}
	return &p, nil
}

func findSubtree(root *RepoTreeNode, path string) *RepoTreeNode {
	if root == nil {
		return nil
	}
	path = normalizeTargetPath(root.Name, path)
	if path == "" || path == root.Name || path == "." {
		return root
	}
	if _, idx := root.leafFilesIndexed(); idx != nil {
		if f, ok := idx[path]; ok {
			return &RepoTreeNode{Path: f.Path, Name: f.Path, Files: []FileMap{*f}, FileCount: 1, LOC: f.LOC, Hotness: f.Hotness}
		}
		if root.Path != "" && !strings.HasPrefix(path, root.Path+"/") {
			if f, ok := idx[root.Path+"/"+path]; ok {
				return &RepoTreeNode{Path: f.Path, Name: f.Path, Files: []FileMap{*f}, FileCount: 1, LOC: f.LOC, Hotness: f.Hotness}
			}
		}
	}

	if found := findSubtreeExact(root, root.Path, path); found != nil {
		return found
	}

	if found := findSubtreeFuzzy(root, path); found != nil {
		return found
	}

	for _, f := range root.LeafFiles() {
		if strings.HasSuffix(f.Path, "/"+path) {
			return &RepoTreeNode{Path: f.Path, Name: f.Path, Files: []FileMap{f}, FileCount: 1, LOC: f.LOC, Hotness: f.Hotness}
		}
	}

	return nil
}

// Match collapsed chain prefixes bidirectionally so pre-collapse and post-collapse paths resolve the same subtree.
func collapsedEquivPaths(node *RepoTreeNode) []string {
	if node == nil || node.Path == "" {
		return nil
	}
	if !strings.Contains(node.Name, "/") || (node.Path != node.Name && !strings.HasSuffix(node.Path, "/"+node.Name)) {
		return []string{node.Path}
	}
	chainBase := strings.TrimSuffix(node.Path, node.Name)
	segs := strings.Split(node.Name, "/")
	out := make([]string, 0, len(segs))
	out = append(out, node.Path)
	for i := 1; i < len(segs); i++ {
		if segs[i-1] == "" {
			continue
		}
		out = append(out, chainBase+strings.Join(segs[:i], "/"))
	}
	return out
}

func findSubtreeExact(node *RepoTreeNode, rootPath, target string) *RepoTreeNode {
	if node == nil {
		return nil
	}
	for _, ep := range collapsedEquivPaths(node) {
		if ep == target || (rootPath != "" && ep == rootPath+"/"+target) {
			return node
		}
	}
	for _, child := range node.Children {
		if found := findSubtreeExact(child, rootPath, target); found != nil {
			return found
		}
	}
	return nil
}

func findSubtreeFuzzy(node *RepoTreeNode, target string) *RepoTreeNode {
	if node == nil {
		return nil
	}
	for _, ep := range collapsedEquivPaths(node) {
		if ep == target || strings.HasSuffix(ep, "/"+target) {
			return node
		}
	}
	if node.Path != "" && (node.Name == target || strings.HasSuffix(node.Name, "/"+target)) {
		return node
	}
	for _, child := range node.Children {
		if found := findSubtreeFuzzy(child, target); found != nil {
			return found
		}
	}
	return nil
}

const (
	overviewDocBonus        = 200
	overviewEntryBonus      = 180
	overviewFacadeBonus     = 60
	overviewTestPenalty     = 100
	overviewDeepInternalPen = 120
	deepHotBonusHigh        = 120
	deepHotBonusMid         = 60
	deepLocBonus            = 60
	deepSpecBonus           = 150
	facadeExportThreshold   = 6
)

func scoreSubtreeFile(f FileMap, teachingDepth string, thematic bool) int {
	score := 0
	if f.IsDoc && !thematic {
		score += 500
	}
	if f.IsConfig && !thematic {
		score += 200
	}
	switch f.Layer {
	case LayerFoundation:
		score += 150
	case LayerPipeline:
		score += 100
	case LayerInterface:
		score += 80
	}
	expCount := len(f.Exports)
	if expCount > 12 {
		expCount = 12
	}
	score += expCount * 10

	if f.Hotness > 100 {
		score += 100
	} else if f.Hotness > 0 {
		score += f.Hotness
	}
	if f.LOC >= 50 && f.LOC <= 800 {
		score += 30
	}
	if f.IsTest {
		score -= 150
	}
	switch teachingDepth {
	case TeachingDepthOverview:
		if f.IsDoc {
			score += overviewDocBonus
		}
		if isEntrypointPath(f.Path) {
			score += overviewEntryBonus
		}
		if len(f.Exports) >= facadeExportThreshold {
			score += overviewFacadeBonus
		}
		if f.IsTest {
			score -= overviewTestPenalty
		}
		if isDeepInternalPath(f.Path) {
			score -= overviewDeepInternalPen
		}
	case TeachingDepthDeep:
		if !f.IsTest {
			if f.Hotness >= 60 {
				score += deepHotBonusHigh
			} else if f.Hotness >= 30 {
				score += deepHotBonusMid
			}
			if f.LOC >= 300 {
				score += deepLocBonus
			}
		}
		if isSpecInvariantPath(f.Path) {
			score += deepSpecBonus
		}
	}
	return score
}

func isEntrypointPath(p string) bool {
	base := path.Base(p)
	return strings.HasPrefix(base, "index.") ||
		strings.HasPrefix(base, "main.") ||
		base == "mod.rs" ||
		base == "__init__.py"
}

func isDeepInternalPath(p string) bool {
	if strings.Contains(p, "/internal/") ||
		strings.HasPrefix(p, "internal/") ||
		strings.Contains(p, "/.internal/") {
		return true
	}
	return strings.Count(p, "/") >= 4
}

// Split basename on . - _ tokens so "inspect" never false-matches "spec".
func isSpecInvariantPath(p string) bool {
	base := path.Base(p)
	for _, tok := range strings.FieldsFunc(base, func(r rune) bool {
		return r == '.' || r == '-' || r == '_'
	}) {
		switch tok {
		case "spec", "specs", "specification", "invariant", "invariants":
			return true
		}
	}
	return false
}

func sortSubtreeFilesByRelevance(files []FileMap, teachingDepth string, thematic bool) []FileMap {
	sorted := make([]FileMap, len(files))
	copy(sorted, files)
	sort.SliceStable(sorted, func(i, j int) bool {
		si := scoreSubtreeFile(sorted[i], teachingDepth, thematic)
		sj := scoreSubtreeFile(sorted[j], teachingDepth, thematic)
		if si != sj {
			return si > sj
		}
		return sorted[i].Path < sorted[j].Path
	})
	return sorted
}

// Limit mixed subtrees to 1 doc per chapter via FIFO deferral so doc clusters never crowd out source files.
func chunkFilesIntoOutlineChapters(files []FileMap, chunkSize int) []cognitive.OutlineChapter {
	if len(files) == 0 {
		return nil
	}
	if chunkSize <= 0 {
		chunkSize = drillChapterFileCap
	}

	hasDoc, hasCode := false, false
	for _, f := range files {
		if f.IsDoc {
			hasDoc = true
		} else {
			hasCode = true
		}
	}
	if !hasDoc || !hasCode {
		return sequentialChunk(files, chunkSize)
	}
	codePerChunk := chunkSize - 1
	if codePerChunk < 1 {
		codePerChunk = 1
	}
	docPaths := make(map[string]bool)
	for _, f := range files {
		if f.IsDoc {
			docPaths[f.Path] = true
		}
	}

	var res []cognitive.OutlineChapter
	var deferred []FileMap
	var cur []cognitive.ChapterFile
	curHasDoc := false

	flush := func() {
		if len(cur) == 0 {
			return
		}
		if !curHasDoc && len(deferred) > 0 {
			cur = append(cur, cognitive.ChapterFile{Path: deferred[0].Path})
			deferred = deferred[1:]
			curHasDoc = true
		}
		res = append(res, cognitive.OutlineChapter{Files: cur})
		cur = nil
		curHasDoc = false
	}

	for _, f := range files {
		if f.IsDoc {
			if curHasDoc || len(deferred) > 0 {
				deferred = append(deferred, f)
				continue
			}
			cur = append(cur, cognitive.ChapterFile{Path: f.Path})
			curHasDoc = true
			continue
		}
		if len(cur) >= codePerChunk+boolToInt(curHasDoc) {
			flush()
		}
		cur = append(cur, cognitive.ChapterFile{Path: f.Path})
	}
	flush()

	return backfillCodeIntoUnderfilledChunks(res, chunkSize, docPaths)
}

func backfillCodeIntoUnderfilledChunks(res []cognitive.OutlineChapter, chunkSize int, docPaths map[string]bool) []cognitive.OutlineChapter {
	for i := 0; i+1 < len(res); i++ {
		for len(res[i].Files) < chunkSize {
			donors := res[i+1].Files
			firstCode, codeInDonor := -1, 0
			for k, f := range donors {
				if !docPaths[f.Path] {
					if firstCode < 0 {
						firstCode = k
					}
					codeInDonor++
				}
			}
			if firstCode < 0 || codeInDonor <= 1 {
				break
			}
			res[i].Files = append(res[i].Files, donors[firstCode])
			res[i+1].Files = append(donors[:firstCode:firstCode], donors[firstCode+1:]...)
		}
	}
	return res
}

func sequentialChunk(files []FileMap, chunkSize int) []cognitive.OutlineChapter {
	var res []cognitive.OutlineChapter
	for i := 0; i < len(files); i += chunkSize {
		end := i + chunkSize
		if end > len(files) {
			end = len(files)
		}
		var cfiles []cognitive.ChapterFile
		for _, f := range files[i:end] {
			cfiles = append(cfiles, cognitive.ChapterFile{Path: f.Path})
		}
		res = append(res, cognitive.OutlineChapter{Files: cfiles})
	}
	return res
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func docParentDensity(p string, density map[string]int) int {
	parent := ""
	if idx := strings.LastIndex(p, "/"); idx >= 0 {
		parent = p[:idx]
	}
	return density[parent]
}

func capFiles(files []FileMap, cap int, thematic bool) []FileMap {
	if len(files) <= cap {
		return files
	}
	byTop := map[string][]FileMap{}
	var order []string
	for _, f := range files {
		seg := subSegment(f.Path)
		if _, ok := byTop[seg]; !ok {
			order = append(order, seg)
		}
		byTop[seg] = append(byTop[seg], f)
	}
	out := make([]FileMap, 0, cap)
	if !thematic && cap > 0 {
		density := make(map[string]int)
		for _, f := range files {
			if f.IsDoc {
				continue
			}
			parts := strings.Split(f.Path, "/")
			for i := 0; i < len(parts); i++ {
				density[strings.Join(parts[:i], "/")]++
			}
		}
		bestIdx := -1
		bestDensity := -1
		for i, f := range files {
			if !f.IsDoc {
				continue
			}
			if d := docParentDensity(f.Path, density); d > bestDensity {
				bestDensity = d
				bestIdx = i
			}
		}
		if bestIdx >= 0 {
			out = append(out, files[bestIdx])
		}
	}
	taken := map[string]bool{}
	var skippedDocs []FileMap
	docTaken := false
	hasNonDoc := false
	for _, f := range files {
		if !f.IsDoc {
			hasNonDoc = true
			break
		}
	}
	for _, f := range out {
		taken[f.Path] = true
		if f.IsDoc {
			docTaken = true
		}
	}
	idx := make(map[string]int, len(order))
	for len(out) < cap {
		progressed := false
		for _, seg := range order {
			if len(out) >= cap {
				break
			}
			list := byTop[seg]
			i := idx[seg]
			if i < len(list) {
				if !taken[list[i].Path] {
					if list[i].IsDoc && docTaken && hasNonDoc {
						skippedDocs = append(skippedDocs, list[i])
					} else {
						out = append(out, list[i])
					}
					taken[list[i].Path] = true
					if list[i].IsDoc {
						docTaken = true
					}
				}
				idx[seg] = i + 1
				progressed = true
			}
		}
		if !progressed {
			break
		}
	}
	for _, f := range skippedDocs {
		if len(out) >= cap {
			break
		}
		out = append(out, f)
	}
	return out
}

func subSegment(rel string) string {
	rest := rel
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		rest = rest[i+1:]
	}
	if i := strings.IndexByte(rest, '/'); i > 0 {
		return rest[:i]
	}
	return "(root)"
}

var _ = mdpat.EstimateTokens

const MaxCompanionsPerLesson = 10

func commonDirDepth(p1, p2 string) int {
	d1 := strings.Split(strings.Trim(path.Dir(p1), "/."), "/")
	d2 := strings.Split(strings.Trim(path.Dir(p2), "/."), "/")
	if len(d1) == 1 && d1[0] == "" {
		d1 = nil
	}
	if len(d2) == 1 && d2[0] == "" {
		d2 = nil
	}
	if len(d1) == 0 && len(d2) == 0 {
		return 1
	}
	if len(d1) == 0 || len(d2) == 0 {
		return 0
	}
	depth := 0
	minLen := len(d1)
	if len(d2) < minLen {
		minLen = len(d2)
	}
	for i := 0; i < minLen; i++ {
		if d1[i] == d2[i] {
			depth++
		} else {
			break
		}
	}
	return depth
}

const astEdgeCompanionPriority = 10000

var genericImportDirSegments = map[string]struct{}{
	"src": {}, "lib": {}, "internal": {}, "pkg": {}, "cmd": {},
	"public": {}, "dist": {}, "build": {}, "types": {}, "node_modules": {},
}

// Rank direct AST edges (+10000) above depth proximity and block cross-subsystem matches; thematic mode runs AST pass only.
func AttachSubtreeCompanionsWithMap(chapters []cognitive.OutlineChapter, root *RepoTreeNode, m *RepoMap, subsystems []SubsystemSpec, thematic ...bool) {
	th := false
	if len(thematic) > 0 {
		th = thematic[0]
	}
	attachSubtreeCompanions(chapters, root, m, subsystems, th)
}

func attachSubtreeCompanions(chapters []cognitive.OutlineChapter, root *RepoTreeNode, m *RepoMap, subsystems []SubsystemSpec, thematic bool) {
	if len(chapters) == 0 || root == nil {
		return
	}

	primarySet := make(map[string]bool)
	for _, ch := range chapters {
		for _, f := range ch.Files {
			if f.Path != "" {
				primarySet[f.Path] = true
			}
		}
	}

	allLeaves := root.LeafFiles()
	var unselected []FileMap
	for _, lf := range allLeaves {
		if !primarySet[lf.Path] {
			unselected = append(unselected, lf)
		}
	}
	if len(unselected) == 0 {
		return
	}

	sort.Slice(unselected, func(i, j int) bool {
		if unselected[i].LOC != unselected[j].LOC {
			return unselected[i].LOC > unselected[j].LOC
		}
		return unselected[i].Path < unselected[j].Path
	})

	var callAdj map[string]map[string]bool
	primaryImports := map[string][]string{}
	if m != nil {
		if len(m.CallEdges) > 0 {
			callAdj = make(map[string]map[string]bool, len(m.CallEdges))
			for _, e := range m.CallEdges {
				if callAdj[e.Caller] == nil {
					callAdj[e.Caller] = make(map[string]bool)
				}
				callAdj[e.Caller][e.Callee] = true
			}
		}
		for _, f := range m.Files {
			primaryImports[f.Path] = f.Imports
		}
	}

	subsystemExists := len(subsystems) > 0
	prefixIndex := make(map[string]int, len(subsystems))
	prefixes := make([]string, 0, len(subsystems))
	for i, s := range subsystems {
		if _, dup := prefixIndex[s.Prefix]; !dup {
			prefixIndex[s.Prefix] = i
			prefixes = append(prefixes, s.Prefix)
		}
	}
	subsystemIndexOf := func(p string) int {
		best := longestMatchingPrefix(p, prefixes)
		if best == "" {
			return -1
		}
		return prefixIndex[best]
	}

	mounted := make(map[string]bool, len(unselected))
	passLimit := 2
	if thematic {
		passLimit = 1
	}
	for pass := 0; pass < passLimit; pass++ {
		for _, u := range unselected {
			if mounted[u.Path] {
				continue
			}
			bestChIdx, bestFileIdx := -1, -1
			bestScore := -1

			for chIdx := range chapters {
				for fIdx := range chapters[chIdx].Files {
					pFile := &chapters[chIdx].Files[fIdx]
					if len(pFile.CompanionFiles) >= MaxCompanionsPerLesson {
						continue
					}
					depth := commonDirDepth(u.Path, pFile.Path)
					if depth <= 0 {
						continue
					}
					uSub, pSub := subsystemIndexOf(u.Path), subsystemIndexOf(pFile.Path)
					score := -1
					if pass == 0 {
						if uSub < 0 || uSub != pSub {
							continue
						}
						if !hasAstEdge(u, pFile.Path, primaryImports[pFile.Path], callAdj) {
							continue
						}
						score = astEdgeCompanionPriority + depth*100 - len(pFile.CompanionFiles)
					} else {
						if subsystemExists && uSub != pSub {
							continue
						}
						score = depth*100 - len(pFile.CompanionFiles)
					}
					if score > bestScore {
						bestScore = score
						bestChIdx = chIdx
						bestFileIdx = fIdx
					}
				}
			}

			if bestChIdx >= 0 && bestFileIdx >= 0 {
				chapters[bestChIdx].Files[bestFileIdx].CompanionFiles = append(
					chapters[bestChIdx].Files[bestFileIdx].CompanionFiles,
					u.Path,
				)
				mounted[u.Path] = true
			}
		}
	}

	for chIdx := range chapters {
		for fIdx := range chapters[chIdx].Files {
			comps := chapters[chIdx].Files[fIdx].CompanionFiles
			if len(comps) > 1 {
				sort.Strings(comps)
			}
		}
	}
}

func hasAstEdge(u FileMap, pPath string, pImports []string, callAdj map[string]map[string]bool) bool {
	if callAdj != nil && (callAdj[u.Path][pPath] || callAdj[pPath][u.Path]) {
		return true
	}
	for _, imp := range u.Imports {
		if importMatchesFile(imp, pPath) {
			return true
		}
	}
	for _, imp := range pImports {
		if importMatchesFile(imp, u.Path) {
			return true
		}
	}
	return false
}

// Ignore generic segments (src, lib, etc.) to prevent weak false-positive import edges.
func importMatchesFile(imp, filePath string) bool {
	imp = strings.Trim(strings.TrimSpace(imp), "\"'")
	if i := strings.LastIndexByte(imp, '/'); i >= 0 {
		imp = imp[i+1:]
	}
	if imp == "" {
		return false
	}
	if _, generic := genericImportDirSegments[imp]; generic {
		return false
	}
	for _, seg := range strings.Split(path.Dir(filePath), "/") {
		if seg != "" && seg == imp {
			return true
		}
	}
	return false
}
