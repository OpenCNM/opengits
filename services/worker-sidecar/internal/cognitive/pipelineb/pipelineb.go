package pipelineb

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/opengits/worker-sidecar/internal/rsg"
)

type FileMap struct {
	Path       string
	Lang       string
	LOC        int
	Exports    []string
	TopSymbols []string `json:"topSymbols,omitempty"`
	Imports    []string
	Hotness    int
	Layer      TopologicalLayer
	IsDoc      bool
	IsTest     bool
	IsConfig   bool
}

// Kept separate from Exports so top-level script declarations do not pollute CallEdges or sparse-AST detection.
func collectFallbackTopSymbols(ext *rsg.FileAstExtraction, hasExports bool) []string {
	if hasExports || ext == nil || len(ext.Symbols) == 0 {
		return nil
	}
	seen := make(map[string]bool, min(len(ext.Symbols), MaxExportsPerFile))
	out := make([]string, 0, min(len(ext.Symbols), MaxExportsPerFile))
	for _, s := range ext.Symbols {
		name := strings.TrimSpace(s.Name)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
		if len(out) >= MaxExportsPerFile {
			break
		}
	}
	return out
}

type ASTCallEdge struct {
	Caller string `json:"caller"`
	Callee string `json:"callee"`
	Symbol string `json:"symbol,omitempty"`
}

type RepoMap struct {
	Files     []FileMap
	TotalLOC  int
	EstTokens int
	Truncated bool
	RepoName  string
	// LeafFiles() preserves full lexicographic order matching Files.
	Tree        *RepoTreeNode                    `json:"tree,omitempty"`
	IsMicroRepo bool                             `json:"isMicroRepo,omitempty"`
	Anchors     []cognitive.CandidateOutlineFile `json:"anchors,omitempty"`
	CallEdges   []ASTCallEdge                    `json:"callEdges,omitempty"`
}

const (
	DefaultMaxFilesInMap       = 1200
	DefaultDrillSubtreeFileCap = 400
	MaxExportsPerFile          = 12
	MaxImportsPerFile          = 8
)

func MaxFilesInMap(override ...int) int {
	if len(override) > 0 && override[0] > 0 {
		return override[0]
	}
	if v := os.Getenv("OUTLINE_MAP_FILE_CAP"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return DefaultMaxFilesInMap
}

func DrillSubtreeFileCap(override ...int) int {
	if len(override) > 0 && override[0] > 0 {
		return override[0]
	}
	if v := os.Getenv("DRILL_SUBTREE_FILE_CAP"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return DefaultDrillSubtreeFileCap
}

func BuildRepoMap(root, repoName string, defs *rsg.LanguageDefinitions, patterns cognitive.Patterns, fileCap ...int) (*RepoMap, error) {
	return BuildScopedRepoMap(root, repoName, "", defs, patterns, fileCap...)
}

func BuildScopedRepoMap(root, repoName, prefixScope string, defs *rsg.LanguageDefinitions, patterns cognitive.Patterns, fileCap ...int) (*RepoMap, error) {
	all, err := walkContentFiles(root, patterns, prefixScope)
	if err != nil {
		return nil, err
	}
	fullTreeFiles := make([]FileMap, 0, len(all))
	for _, f := range all {
		fullTreeFiles = append(fullTreeFiles, FileMap{
			Path: f.rel, LOC: int(f.size)/32 + 1,
			IsDoc: patterns.IsDocFile(f.rel), IsTest: patterns.IsTestFile(f.rel),
			IsConfig: patterns.IsConfigFile(f.rel),
		})
	}
	files := all
	cap := MaxFilesInMap(fileCap...)
	m := &RepoMap{RepoName: repoName, Truncated: len(all) > cap}
	if m.Truncated {
		files = spreadSelect(all, cap, patterns)
	}
	extracted := make([]FileMap, 0, len(files))
	fileAsts := make([]*rsg.FileAstExtraction, len(files))
	for i, f := range files {
		content, err := readFileLimited(f.full, 1<<20)
		if err != nil {
			continue
		}
		fm := FileMap{
			Path: f.rel, LOC: strings.Count(content, "\n") + 1,
			IsDoc: patterns.IsDocFile(f.rel), IsTest: patterns.IsTestFile(f.rel),
		}
		if patterns.IsConfigFile(f.rel) {
			fm.IsConfig = true
		}
		if defs != nil {
			ext := defs.ExtractFileAst(content, f.rel)
			fileAsts[i] = ext
			if ext != nil {
				for _, s := range ext.Symbols {
					if s.Exported && len(fm.Exports) < MaxExportsPerFile {
						fm.Exports = append(fm.Exports, s.Name)
					}
				}
				fm.TopSymbols = collectFallbackTopSymbols(ext, len(fm.Exports) > 0)
				for _, imp := range ext.Imports {
					if len(fm.Imports) < MaxImportsPerFile {
						fm.Imports = append(fm.Imports, imp.Module)
					}
				}
			}
		}
		extracted = append(extracted, fm)
	}
	var edges [][2]string
	if defs != nil {
		// Leave multiply-exported symbol names unlinked so ambiguous bare names never misattribute CallEdges or Hotness.
		exportOwner := map[string]string{}
		ambiguous := map[string]bool{}
		for i := range extracted {
			for _, e := range extracted[i].Exports {
				if prev, dup := exportOwner[e]; dup && prev != extracted[i].Path {
					ambiguous[e] = true
				} else if !dup {
					exportOwner[e] = extracted[i].Path
				}
			}
		}
		for i, f := range files {
			ext := fileAsts[i]
			if ext == nil {
				continue
			}
			localNames := make(map[string]bool, len(ext.Symbols))
			for _, sym := range ext.Symbols {
				localNames[sym.Name] = true
			}
			for _, cs := range ext.CallSites {
				if ambiguous[cs.Name] || localNames[cs.Name] {
					continue
				}
				if owner, ok := exportOwner[cs.Name]; ok && owner != f.rel {
					edges = append(edges, [2]string{f.rel, owner})
					m.CallEdges = append(m.CallEdges, ASTCallEdge{
						Caller: f.rel,
						Callee: owner,
						Symbol: cs.Name,
					})
				}
			}
		}
		hot := ComputeHotnessPageRank(extracted, edges)
		for i := range extracted {
			extracted[i].Hotness = hot[extracted[i].Path]
		}
	}
	layers := ComputeTopologicalLayers(extracted, edges, patterns)
	for i := range extracted {
		extracted[i].Layer = layers[extracted[i].Path]
	}
	m.Files = extracted
	for _, fm := range extracted {
		m.TotalLOC += fm.LOC
	}

	var codeCandidates, docCandidates []cognitive.CandidateOutlineFile
	for _, f := range extracted {
		if f.IsDoc {
			docCandidates = append(docCandidates, cognitive.CandidateOutlineFile{Path: f.Path, IsDoc: true})
		} else if !f.IsTest && !f.IsConfig && patterns.IsCodeFile(f.Path) {
			codeCandidates = append(codeCandidates, cognitive.CandidateOutlineFile{Path: f.Path, IsDoc: false})
		}
	}
	if len(codeCandidates) > 0 && len(codeCandidates) <= 3 {
		m.IsMicroRepo = true
		allNodes := make([]cluster.GitNode, 0, len(all))
		for _, f := range all {
			allNodes = append(allNodes, cluster.GitNode{Path: f.rel, Type: "blob", Size: f.size})
		}
		fileReader := func(path string) ([]byte, error) {
			return os.ReadFile(filepath.Join(root, path))
		}
		m.Anchors = cognitive.ExtractSubFileAnchors(codeCandidates, docCandidates, allNodes, fileReader, defs, patterns)
	}

	m.EstTokens = mdpat.EstimateTokens(RenderMap(m))
	m.Tree = BuildRepoTree(fullTreeFiles, m.RepoName)
	if !m.Truncated {
		m.Tree = BuildRepoTree(m.Files, m.RepoName)
	}
	return m, nil
}

func spreadSelect(files []walkedFile, cap int, patterns cognitive.Patterns) []walkedFile {
	byTop := map[string][]walkedFile{}
	var order []string
	for _, f := range files {
		top := topSegment(f.rel)
		if _, ok := byTop[top]; !ok {
			byTop[top] = nil
			order = append(order, top)
		}
		byTop[top] = append(byTop[top], f)
	}
	out := make([]walkedFile, 0, cap)
	seen := map[string]bool{}
	for _, f := range files {
		if patterns.IsDocFile(f.rel) && strings.Count(f.rel, "/") == 0 {
			out = append(out, f)
			seen[f.rel] = true
			if len(out) >= cap {
				return out
			}
		}
	}
	idx := 0
	for len(out) < cap {
		progressed := false
		for _, top := range order {
			list := byTop[top]
			if idx < len(list) {
				candidate := list[idx]
				if !seen[candidate.rel] {
					out = append(out, candidate)
					seen[candidate.rel] = true
					progressed = true
					if len(out) >= cap {
						return out
					}
				}
			}
		}
		if !progressed {
			break
		}
		idx++
	}
	return out
}

func topSegment(p string) string {
	p = strings.TrimPrefix(p, "/")
	if idx := strings.Index(p, "/"); idx > 0 {
		return p[:idx]
	}
	return "(root)"
}

func RenderMap(m *RepoMap) string {
	var sb strings.Builder
	if m.IsMicroRepo {
		fmt.Fprintf(&sb, "repo: %s | files: %d | loc: %d (micro-repo mode: fine-grained anchors enabled)\n", m.RepoName, len(m.Files), m.TotalLOC)
	} else {
		fmt.Fprintf(&sb, "repo: %s | files: %d | loc: %d\n", m.RepoName, len(m.Files), m.TotalLOC)
	}

	anchorsByPath := map[string][]cognitive.CandidateOutlineFile{}
	if m.IsMicroRepo && len(m.Anchors) > 0 {
		for _, a := range m.Anchors {
			anchorsByPath[a.Path] = append(anchorsByPath[a.Path], a)
		}
	}

	grouped := [3][]FileMap{}
	for _, f := range m.Files {
		layer := int(f.Layer)
		if layer < 0 || layer > 2 {
			layer = 1
		}
		grouped[layer] = append(grouped[layer], f)
	}

	for i := 0; i < 3; i++ {
		sort.Slice(grouped[i], func(a, b int) bool {
			if grouped[i][a].Hotness != grouped[i][b].Hotness {
				return grouped[i][a].Hotness > grouped[i][b].Hotness
			}
			return grouped[i][a].Path < grouped[i][b].Path
		})
	}

	layerHeaders := [3]string{
		"=== [Layer 0: 基础底座与数据契约 (Foundation & Contracts)] ===",
		"=== [Layer 1: 核心引擎与数据管道 (Core Engine & Pipelines)] ===",
		"=== [Layer 2: 交付入口与接口契约 (Entrypoints & Interfaces)] ===",
	}

	for i := 0; i < 3; i++ {
		if len(grouped[i]) == 0 {
			continue
		}
		sb.WriteString(layerHeaders[i])
		sb.WriteByte('\n')
		for _, f := range grouped[i] {
			fmt.Fprintf(&sb, "%s | loc=%d | hot=%d", f.Path, f.LOC, f.Hotness)
			if m.IsMicroRepo && f.LOC < 150 && !f.IsDoc && !f.IsTest {
				sb.WriteString(" | compact-core")
			}
			if f.IsDoc {
				sb.WriteString(" | doc")
			}
			if f.IsTest {
				sb.WriteString(" | test")
			}
			if f.IsConfig {
				sb.WriteString(" | config")
			}
			if len(f.Exports) > 0 {
				sb.WriteString(" | exports: " + strings.Join(f.Exports, ","))
			}
			if len(f.Imports) > 0 {
				sb.WriteString(" | imports: " + strings.Join(f.Imports, ","))
			}
			sb.WriteByte('\n')

			if m.IsMicroRepo {
				for _, a := range anchorsByPath[f.Path] {
					if a.Anchor != "" {
						kind := a.Kind
						if kind == "" {
							kind = "symbol"
						}
						detail := ""
						if a.Detail != "" {
							detail = " | " + a.Detail
						}
						fmt.Fprintf(&sb, "  - %s#%s | %s%s\n", a.Path, a.Anchor, kind, detail)
					}
				}
			}
		}
	}

	if m.Truncated {
		sb.WriteString("(map truncated to file cap)\n")
	}
	return sb.String()
}

type ModelRequest struct {
	RepoMap            *RepoMap
	ArchModel          *ArchitecturalModel
	TargetLanguage     string
	ContinuationPrompt string
	CoverageFeedback   string
}

type OutlineModel interface {
	Complete(ctx context.Context, req ModelRequest) (string, error)
}

type OutlineResult struct {
	Chapters     []cognitive.OutlineChapter
	DroppedPaths []string
	ModelRawLen  int
	EstPromptTok int
	Duration     time.Duration
}

func Run(ctx context.Context, m *RepoMap, model OutlineModel, patterns cognitive.Patterns, targetLanguage string) (*OutlineResult, error) {
	start := time.Now()
	arch := BuildArchitecturalModel(m, patterns)
	// Estimate prompt tokens from the actual multi-scale or arch-model text sent to the model.
	promptTok := mdpat.EstimateTokens(RenderArchModel(arch))
	if model != nil {
		depth := TeachingDepthStandard
		if ca, ok := model.(teachingContextAware); ok {
			if d, _ := ca.TeachingContext(); d != "" {
				depth = d
			}
		}
		subsystems := DiscoverSubsystems(SubsystemSourcesFromRepoMap(m), patterns)
		topo := BuildMacroTopology(m, outlineMapScope, outlineMapScale, patterns)
		promptTok = mdpat.EstimateTokens(RenderMultiScaleMap(m, subsystems, topo, depth, MultiScaleMapMaxTokens))
	}

	nodes := make([]cluster.GitNode, 0, len(m.Files))
	candidates := make([]cognitive.CandidateOutlineFile, 0, len(m.Files)+len(m.Anchors))
	for _, f := range m.Files {
		nodes = append(nodes, cluster.GitNode{Path: f.Path, Type: "blob"})
		candidates = append(candidates, cognitive.CandidateOutlineFile{Path: f.Path, IsDoc: f.IsDoc})
	}
	if m.IsMicroRepo && len(m.Anchors) > 0 {
		candidates = append(candidates, m.Anchors...)
	}

	if model == nil {
		deterministicChapters := DeriveDeterministicOutline(arch, targetLanguage)
		san := cognitive.SanitizeAndIntersectOutline(deterministicChapters, nodes, "", targetLanguage, candidates, patterns)
		if subsystems := DiscoverSubsystems(SubsystemSourcesFromRepoMap(m), patterns); len(subsystems) > 0 {
			if fb := evaluateSubsystemCoverageFromFiles(subsystems, san.Sanitized, m.Files, "", "", ""); fb != nil {
				log.Printf("[pipelineb] CoverageGate deterministic baseline missing core subsystems %v (%s) — observability only\n",
					fb.MissingSubsystems, subsystemCoverageSummary(subsystems, san.Sanitized, ""))
			}
		}
		return &OutlineResult{
			Chapters:     san.Sanitized,
			DroppedPaths: san.DroppedPaths,
			ModelRawLen:  0,
			EstPromptTok: promptTok,
			Duration:     time.Since(start),
		}, nil
	}

	llmCtx, llmCancel := context.WithTimeout(ctx, outlineLlmBudget(ctx))
	defer llmCancel()

	raw, err := model.Complete(llmCtx, ModelRequest{
		RepoMap:        m,
		ArchModel:      arch,
		TargetLanguage: targetLanguage,
	})

	var draft []cognitive.OutlineChapter
	if err == nil {
		draft, _ = ParseOutlineJSON(raw)
	}

	isStreamPartial := errors.Is(err, client.ErrStreamPartial)

	if len(draft) == 0 && raw != "" {
		if salvaged := SalvageOutlineChapters(raw); len(salvaged) > 0 {
			log.Printf("[pipelineb] OutlineRun Layer 1 salvage: %d chapters recovered from raw (len=%d)\n", len(salvaged), len(raw))
			draft = salvaged
			err = nil
		}
	}

	needsContinuation := len(draft) >= 1 && (isStreamPartial || (len(draft) < 3 && len(m.Files) > 10))
	if needsContinuation && ctx.Err() == nil {
		contBudget := 20 * time.Second
		if d, ok := ctx.Deadline(); ok {
			rem := time.Until(d) - outlineArmorReserve
			if rem < contBudget {
				contBudget = rem
			}
		}
		if contBudget >= 5*time.Second {
			var contSb strings.Builder
			contSb.WriteString("【断点续写模式】：前序章节已生成完毕如下：\n")
			for i, ch := range draft {
				contSb.WriteString(fmt.Sprintf("%d. %s: %s\n", i+1, ch.Name, ch.Summary))
			}
			contSb.WriteString(fmt.Sprintf("请紧接上方已规划的进度，仅规划并输出后续剩余章节的 JSON 数组（从第 %d 章开始）。严禁重复前序章节！直接输出纯 JSON 数组或包含 chapters 的 JSON 对象。\n", len(draft)+1))

			contCtx, contCancel := context.WithTimeout(ctx, contBudget)
			contRaw, contErr := model.Complete(contCtx, ModelRequest{
				RepoMap:            m,
				ArchModel:          arch,
				TargetLanguage:     targetLanguage,
				ContinuationPrompt: contSb.String(),
			})
			contCancel()

			if contErr == nil || contRaw != "" {
				contDraft, _ := ParseOutlineJSON(contRaw)
				if len(contDraft) == 0 {
					contDraft = SalvageOutlineChapters(contRaw)
				}
				if len(contDraft) > 0 {
					log.Printf("[pipelineb] OutlineRun Layer 2 continuation: %d additional chapters appended\n", len(contDraft))
					draft = append(draft, contDraft...)
					err = nil
				}
			}
		}
	}

	// Skip repair on permanent auth/quota/config errors so key failures are never masked as format errors.
	if len(draft) == 0 && ctx.Err() == nil && !isPermanentGatewayConfigError(err) {
		repBudget := 15 * time.Second
		if d, ok := ctx.Deadline(); ok {
			rem := time.Until(d) - outlineArmorReserve
			if rem < repBudget {
				repBudget = rem
			}
		}
		if repBudget >= 5*time.Second {
			repairPrompt := "【格式警告与急救】：前次响应未能解析出有效章节。请严格按照 schema 仅输出纯 JSON 数组：[{\"name\": \"章节标题\", \"summary\": \"核心动机\", \"files\": [\"代表文件\"], \"phase\": \"入门\"}]，严禁包含任何前缀、思考过程或 markdown 围栏。"
			repCtx, repCancel := context.WithTimeout(ctx, repBudget)
			repRaw, repErr := model.Complete(repCtx, ModelRequest{
				RepoMap:            m,
				ArchModel:          arch,
				TargetLanguage:     targetLanguage,
				ContinuationPrompt: repairPrompt,
			})
			repCancel()

			if repErr == nil || repRaw != "" {
				repDraft, _ := ParseOutlineJSON(repRaw)
				if len(repDraft) == 0 {
					repDraft = SalvageOutlineChapters(repRaw)
				}
				if len(repDraft) > 0 {
					log.Printf("[pipelineb] OutlineRun Layer 2 repair: %d chapters recovered\n", len(repDraft))
					draft = repDraft
					err = nil
				}
			}
		}
	}

	if len(draft) == 0 {
		if err != nil {
			return nil, fmt.Errorf("curriculum outline generation failed to converge: %w", err)
		}
		return nil, errors.New("curriculum outline generation failed: model produced zero valid chapters")
	}

	san := cognitive.SanitizeAndIntersectOutline(draft, nodes, "", targetLanguage, candidates, patterns)
	if len(san.Sanitized) == 0 {
		return nil, errors.New("curriculum outline hallucination armor rejected all candidate paths (no physical matches)")
	}

	decorateChapterDimensions(san.Sanitized, arch)

	chapters := applyCoverageGate(ctx, m, arch, model, patterns, nodes, candidates, targetLanguage, san.Sanitized)

	return &OutlineResult{
		Chapters:     chapters,
		DroppedPaths: san.DroppedPaths,
		ModelRawLen:  len(raw),
		EstPromptTok: promptTok,
		Duration:     time.Since(start),
	}, nil
}

const (
	outlineLlmBudgetFloor   = 10 * time.Second
	outlineLlmBudgetCeiling = 90 * time.Second
	outlineArmorReserve     = 8 * time.Second
	outlineLlmDefaultBudget = 30 * time.Second
)

// Derive LLM slice budget from remaining context deadline minus finalization reserve; default 30s if unbounded.
func outlineLlmBudget(ctx context.Context) time.Duration {
	deadline, ok := ctx.Deadline()
	if !ok {
		return outlineLlmDefaultBudget
	}
	remaining := time.Until(deadline) - outlineArmorReserve
	if remaining < outlineLlmBudgetFloor {
		return outlineLlmBudgetFloor
	}
	if remaining > outlineLlmBudgetCeiling {
		return outlineLlmBudgetCeiling
	}
	return remaining
}

func decorateChapterDimensions(chapters []cognitive.OutlineChapter, arch *ArchitecturalModel) {
	if len(chapters) == 0 {
		return
	}

	if canonicalizeLLMPartTitles(chapters) {
		return
	}

	if arch == nil || len(arch.Dimensions) == 0 {
		return
	}

	fileToDim := make(map[string]string)
	branchToDim := make(map[string]string)
	for _, dim := range arch.Dimensions {
		for _, kf := range dim.KeyFiles {
			fileToDim[kf] = dim.Title
		}
		for _, b := range dim.SubBranches {
			for _, bkf := range b.KeyFiles {
				fileToDim[bkf] = dim.Title
			}
			branchToDim[b.Prefix] = dim.Title
		}
	}

	for i := range chapters {
		if chapters[i].PartTitle != "" {
			continue
		}
		matched := ""
		for _, cf := range chapters[i].Files {
			if dt, ok := fileToDim[cf.Path]; ok {
				matched = dt
				break
			}
			for prefix, dt := range branchToDim {
				if strings.HasPrefix(cf.Path, prefix) {
					matched = dt
					break
				}
			}
			if matched != "" {
				break
			}
		}
		if matched != "" {
			chapters[i].PartTitle = matched
			continue
		}

		dimIdx := i
		if dimIdx >= len(arch.Dimensions) {
			dimIdx = len(arch.Dimensions) - 1
		}
		chapters[i].PartTitle = arch.Dimensions[dimIdx].Title
	}
}

func estimateTokensFor(m *RepoMap) int {
	if m == nil {
		return 0
	}
	arch := BuildArchitecturalModel(m, nil)
	return mdpat.EstimateTokens(RenderArchModel(arch))
}
