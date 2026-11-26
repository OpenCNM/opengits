package pipelineb

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

const (
	DimInterfaceFacade = "interface_facade"
	DimDomainState     = "domain_state"
	DimCoreEngine      = "core_engine"
	DimSpecialized     = "specialized_implementations"
	DimVerification    = "verification_invariants"
)

type ArchSubBranch struct {
	Name       string   `json:"name"`
	Prefix     string   `json:"prefix"`
	KeyFiles   []string `json:"keyFiles"`
	TopExports []string `json:"topExports"`
	FileCount  int      `json:"fileCount"`
	LOC        int      `json:"loc"`
}

type ArchDimension struct {
	ID          string          `json:"id"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	KeyFiles    []string        `json:"keyFiles"`
	TopExports  []string        `json:"topExports"`
	SubBranches []ArchSubBranch `json:"subBranches,omitempty"`
	FileCount   int             `json:"fileCount"`
	LOC         int             `json:"loc"`
}

type ArchitecturalModel struct {
	RepoName    string          `json:"repoName"`
	TotalFiles  int             `json:"totalFiles"`
	TotalLOC    int             `json:"totalLOC"`
	IsMicroRepo bool            `json:"isMicroRepo"`
	Dimensions  []ArchDimension `json:"dimensions"`
}

var specializationKeywords = []string{
	"tuners", "adapters", "plugins", "backends", "drivers",
	"strategies", "extensions", "providers", "impl", "algorithms",
	"integrations", "contrib",
}

func detectSpecializedBranch(p string) (bool, string, string) {
	parts := strings.Split(filepath.ToSlash(p), "/")
	for i, part := range parts {
		for _, kw := range specializationKeywords {
			if strings.EqualFold(part, kw) && i+1 < len(parts) {
				branchName := parts[i+1]
				if i+1 == len(parts)-1 && strings.Contains(branchName, ".") {
					stem := strings.TrimSuffix(branchName, filepath.Ext(branchName))
					stemLower := strings.ToLower(stem)
					if strings.HasSuffix(stemLower, "_utils") || strings.HasPrefix(stemLower, "utils") ||
						stemLower == "base" || stemLower == "common" || stemLower == "types" ||
						stemLower == "index" || stemLower == "mod" || stemLower == "__init__" {
						continue
					}
					return true, stem, strings.Join(parts[:i+2], "/")
				}
				prefix := strings.Join(parts[:i+2], "/")
				return true, branchName, prefix
			}
		}
	}
	return false, "", ""
}

func isTestPath(p string) bool {
	lower := strings.ToLower(filepath.ToSlash(p))
	base := filepath.Base(lower)
	return strings.Contains(lower, "/test/") ||
		strings.Contains(lower, "/tests/") ||
		strings.HasPrefix(lower, "test/") ||
		strings.HasPrefix(lower, "tests/") ||
		strings.HasSuffix(lower, "_test.go") ||
		strings.HasSuffix(lower, ".test.ts") ||
		strings.HasSuffix(lower, ".test.js") ||
		strings.HasSuffix(lower, ".spec.ts") ||
		strings.HasSuffix(lower, ".spec.js") ||
		strings.HasSuffix(lower, "_test.py") ||
		strings.HasPrefix(base, "test_")
}

func isVerificationPath(p string) bool {
	lower := strings.ToLower(filepath.ToSlash(p))
	base := filepath.Base(lower)
	return isTestPath(lower) ||
		strings.Contains(lower, "/spec/") ||
		strings.Contains(lower, "/specs/") ||
		strings.Contains(lower, "/invariants/") ||
		strings.Contains(lower, "/verification/") ||
		strings.Contains(base, "invariant") ||
		strings.Contains(base, "verify") ||
		strings.Contains(base, "assert")
}

// Match dataset/dataloader stems only; directory-level /data/ causes false positives on static fixture dirs.
func isDomainModelPath(p string) bool {
	lower := strings.ToLower(filepath.ToSlash(p))
	base := filepath.Base(lower)
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	return strings.Contains(base, "config") ||
		strings.Contains(lower, "/models/") || strings.Contains(lower, "/model/") ||
		strings.Contains(lower, "/entities/") || strings.Contains(lower, "/entity/") ||
		strings.Contains(lower, "/domain/") || strings.Contains(lower, "/schemas/") ||
		strings.Contains(lower, "/schema/") || strings.Contains(lower, "/types/") ||
		strings.Contains(lower, "/datasets/") || strings.Contains(lower, "/dataset/") ||
		base == "model.py" || base == "models.py" || base == "model.ts" || base == "models.go" ||
		base == "dataset.py" || base == "datasets.py" || base == "dataloader.py" ||
		strings.Contains(stem, "dataset") || strings.Contains(stem, "dataloader") ||
		strings.Contains(base, "schema") ||
		strings.Contains(base, "types") ||
		strings.Contains(base, "entity") ||
		strings.Contains(base, "state") ||
		strings.Contains(base, "base")
}

func isExplicitEntryPointLocal(p string) bool {
	lower := strings.ToLower(filepath.ToSlash(p))
	return strings.HasSuffix(lower, "main.go") ||
		strings.HasSuffix(lower, "index.ts") ||
		strings.HasSuffix(lower, "index.js") ||
		strings.HasSuffix(lower, "app.ts") ||
		strings.HasSuffix(lower, "app.tsx") ||
		strings.HasSuffix(lower, "main.py") ||
		strings.HasSuffix(lower, "app.py") ||
		strings.HasSuffix(lower, "cli.py") ||
		strings.HasSuffix(lower, "__main__.py") ||
		strings.HasSuffix(lower, "__init__.py") ||
		strings.HasSuffix(lower, "main.rs") ||
		strings.HasSuffix(lower, "lib.rs") ||
		strings.HasSuffix(lower, "main.cpp") ||
		strings.HasSuffix(lower, "main.cc") ||
		strings.HasSuffix(lower, "main.c") ||
		strings.HasPrefix(lower, "cmd/") ||
		strings.HasPrefix(lower, "cli/")
}

func formatDimensionTitle(id string, order int, lang string) string {
	isEn := strings.HasPrefix(strings.ToLower(lang), "en")
	prefixZh := ""
	prefixEn := ""
	if order > 0 {
		prefixZh = fmt.Sprintf("维度 %d: ", order)
		prefixEn = fmt.Sprintf("Dimension %d: ", order)
	}
	switch id {
	case DimInterfaceFacade:
		if isEn {
			return prefixEn + "Interface & Facade"
		}
		return prefixZh + "交付入口与门面契约 (Interface & Facade)"
	case DimDomainState:
		if isEn {
			return prefixEn + "Domain Models & State"
		}
		return prefixZh + "领域模型与核心状态 (Domain Models & State)"
	case DimCoreEngine:
		if isEn {
			return prefixEn + "Core Engine & Pipelines"
		}
		return prefixZh + "核心执行引擎与管线 (Core Engine & Pipelines)"
	case DimSpecialized:
		if isEn {
			return prefixEn + "Specialized Implementations"
		}
		return prefixZh + "特化算法与扩展实现 (Specialized Implementations)"
	case DimVerification:
		if isEn {
			return prefixEn + "Verification & Invariants"
		}
		return prefixZh + "规范约束与验证边界 (Verification & Invariants)"
	default:
		if order > 0 {
			if isEn {
				return fmt.Sprintf("Dimension %d: %s", order, id)
			}
			return fmt.Sprintf("维度 %d: %s", order, id)
		}
		return id
	}
}

func defaultDimensionTitle(id string, lang string) string {
	switch id {
	case DimInterfaceFacade:
		return formatDimensionTitle(id, 1, lang)
	case DimDomainState:
		return formatDimensionTitle(id, 2, lang)
	case DimCoreEngine:
		return formatDimensionTitle(id, 3, lang)
	case DimSpecialized:
		return formatDimensionTitle(id, 4, lang)
	case DimVerification:
		return formatDimensionTitle(id, 5, lang)
	default:
		return formatDimensionTitle(id, 0, lang)
	}
}

func defaultDimensionDesc(id string, lang string) string {
	isEn := strings.HasPrefix(strings.ToLower(lang), "en")
	switch id {
	case DimInterfaceFacade:
		if isEn {
			return "Public APIs, top-level facades, CLI, and initialization entrypoints"
		}
		return "顶层用户API、门面契约、CLI与初始化工厂函数"
	case DimDomainState:
		if isEn {
			return "Configuration schemas, domain models, and abstract contracts"
		}
		return "配置规范、领域实体模型与抽象契约定义"
	case DimCoreEngine:
		if isEn {
			return "Core execution lifecycle, dispatcher, and pipeline flow"
		}
		return "适配器生命周期、执行调度与核心数据处理管线"
	case DimSpecialized:
		if isEn {
			return "Specialized algorithm modules and extension plugins"
		}
		return "特化算法分支、适配器插件与扩展实现集合"
	case DimVerification:
		if isEn {
			return "Behavior assertions, regression tests, and verification boundaries"
		}
		return "行为断言、回归测试与规范验证边界"
	default:
		return ""
	}
}

func BuildArchitecturalModel(m *RepoMap, patterns cognitive.Patterns) *ArchitecturalModel {
	if m == nil {
		return &ArchitecturalModel{}
	}
	model := &ArchitecturalModel{
		RepoName:    m.RepoName,
		TotalFiles:  len(m.Files),
		TotalLOC:    m.TotalLOC,
		IsMicroRepo: m.IsMicroRepo,
	}
	if len(m.Files) == 0 {
		return model
	}

	edges := make([][2]string, 0, len(m.CallEdges))
	for _, ce := range m.CallEdges {
		edges = append(edges, [2]string{ce.Caller, ce.Callee})
	}
	inDeg, outDeg := computeFileDegrees(m.Files, edges)
	layers := ComputeTopologicalLayers(m.Files, edges, patterns)

	dimFiles := map[string][]FileMap{}
	specializedBranches := map[string][]FileMap{}
	branchNames := map[string]string{}

	for _, f := range m.Files {
		layer := f.Layer
		if layer == 0 {
			layer = layers[f.Path]
		}

		if f.IsTest || (patterns != nil && patterns.IsTestFile(f.Path)) || isVerificationPath(f.Path) {
			dimFiles[DimVerification] = append(dimFiles[DimVerification], f)
			continue
		}

		if isSpec, bName, bPrefix := detectSpecializedBranch(f.Path); isSpec && !f.IsDoc && !f.IsConfig {
			dimFiles[DimSpecialized] = append(dimFiles[DimSpecialized], f)
			specializedBranches[bPrefix] = append(specializedBranches[bPrefix], f)
			branchNames[bPrefix] = bName
			continue
		}

		if layer == LayerInterface || isExplicitEntryPoint(f.Path) || isExplicitEntryPointLocal(f.Path) || isExplicitInterface(f.Path) ||
			(f.IsDoc && strings.Count(f.Path, "/") == 0) {
			dimFiles[DimInterfaceFacade] = append(dimFiles[DimInterfaceFacade], f)
			continue
		}

		if f.IsConfig || isDomainModelPath(f.Path) ||
			(inDeg[f.Path] >= 2*outDeg[f.Path] && inDeg[f.Path] > 0) ||
			(layer == LayerFoundation && f.Hotness < 40) {
			dimFiles[DimDomainState] = append(dimFiles[DimDomainState], f)
			continue
		}

		dimFiles[DimCoreEngine] = append(dimFiles[DimCoreEngine], f)
	}

	if m.IsMicroRepo && len(dimFiles[DimCoreEngine]) == 0 && len(dimFiles[DimInterfaceFacade]) > 0 {
		for _, f := range dimFiles[DimInterfaceFacade] {
			if !f.IsDoc && !f.IsTest {
				dimFiles[DimCoreEngine] = append(dimFiles[DimCoreEngine], f)
			}
		}
	}

	dimOrder := []string{
		DimInterfaceFacade,
		DimDomainState,
		DimCoreEngine,
		DimSpecialized,
		DimVerification,
	}

	dimIdx := 1
	for _, dimID := range dimOrder {
		files := dimFiles[dimID]
		if len(files) == 0 {
			continue
		}

		sort.Slice(files, func(i, j int) bool {
			if files[i].Hotness != files[j].Hotness {
				return files[i].Hotness > files[j].Hotness
			}
			if files[i].LOC != files[j].LOC {
				return files[i].LOC > files[j].LOC
			}
			return files[i].Path < files[j].Path
		})

		totalLOC := 0
		for _, f := range files {
			totalLOC += f.LOC
		}

		maxKey := 4
		if len(files) < maxKey {
			maxKey = len(files)
		}
		keyFiles := make([]string, 0, maxKey)
		seenKey := map[string]bool{}
		for i := 0; i < maxKey; i++ {
			p := files[i].Path
			if !seenKey[p] {
				keyFiles = append(keyFiles, p)
				seenKey[p] = true
			}
		}

		topExports := make([]string, 0, 6)
		seenExp := map[string]bool{}
		for _, f := range files {
			for _, exp := range f.Exports {
				if exp != "" && !seenExp[exp] {
					topExports = append(topExports, exp)
					seenExp[exp] = true
					if len(topExports) >= 6 {
						break
					}
				}
			}
			if len(topExports) >= 6 {
				break
			}
		}

		dim := ArchDimension{
			ID:          dimID,
			Title:       formatDimensionTitle(dimID, dimIdx, "zh-CN"),
			Description: defaultDimensionDesc(dimID, "zh-CN"),
			KeyFiles:    keyFiles,
			TopExports:  topExports,
			FileCount:   len(files),
			LOC:         totalLOC,
		}
		dimIdx++

		if dimID == DimSpecialized && len(specializedBranches) > 0 {
			var branches []ArchSubBranch
			for prefix, bFiles := range specializedBranches {
				bName := branchNames[prefix]
				bLOC := 0
				for _, bf := range bFiles {
					bLOC += bf.LOC
				}

				sort.Slice(bFiles, func(i, j int) bool {
					if bFiles[i].Hotness != bFiles[j].Hotness {
						return bFiles[i].Hotness > bFiles[j].Hotness
					}
					return bFiles[i].LOC > bFiles[j].LOC
				})

				bKey := make([]string, 0, 2)
				for i := 0; i < len(bFiles) && i < 2; i++ {
					bKey = append(bKey, bFiles[i].Path)
				}

				bExports := make([]string, 0, 4)
				seenBExp := map[string]bool{}
				for _, bf := range bFiles {
					for _, exp := range bf.Exports {
						if exp != "" && !seenBExp[exp] {
							bExports = append(bExports, exp)
							seenBExp[exp] = true
							if len(bExports) >= 4 {
								break
							}
						}
					}
					if len(bExports) >= 4 {
						break
					}
				}

				branches = append(branches, ArchSubBranch{
					Name:       bName,
					Prefix:     prefix,
					KeyFiles:   bKey,
					TopExports: bExports,
					FileCount:  len(bFiles),
					LOC:        bLOC,
				})
			}

			sort.Slice(branches, func(i, j int) bool {
				return branches[i].LOC > branches[j].LOC
			})
			if len(branches) > 5 {
				branches = branches[:5]
			}
			dim.SubBranches = branches
		}

		model.Dimensions = append(model.Dimensions, dim)
	}

	return model
}

func RenderArchModel(model *ArchitecturalModel) string {
	if model == nil {
		return ""
	}
	var sb strings.Builder
	if model.IsMicroRepo {
		fmt.Fprintf(&sb, "=== 仓库架构全景模型 (Architectural Dimensions) ===\nrepo: %s | files: %d | loc: %d (micro-repo)\n\n",
			model.RepoName, model.TotalFiles, model.TotalLOC)
	} else {
		fmt.Fprintf(&sb, "=== 仓库架构全景模型 (Architectural Dimensions) ===\nrepo: %s | files: %d | loc: %d\n\n",
			model.RepoName, model.TotalFiles, model.TotalLOC)
	}

	for _, dim := range model.Dimensions {
		sb.WriteString(dim.Title)
		sb.WriteByte('\n')
		if dim.Description != "" {
			fmt.Fprintf(&sb, "- 职责: %s\n", dim.Description)
		}
		if len(dim.KeyFiles) > 0 {
			fmt.Fprintf(&sb, "- 核心文件: %s\n", strings.Join(dim.KeyFiles, ", "))
		}
		if len(dim.TopExports) > 0 {
			fmt.Fprintf(&sb, "- 核心符号: %s\n", strings.Join(dim.TopExports, ", "))
		}
		if len(dim.SubBranches) > 0 {
			sb.WriteString("- 特化分支:\n")
			for _, b := range dim.SubBranches {
				if len(b.TopExports) > 0 {
					fmt.Fprintf(&sb, "  * %s (%s) | 符号: %s\n", b.Name, b.Prefix, strings.Join(b.TopExports, ", "))
				} else {
					fmt.Fprintf(&sb, "  * %s (%s)\n", b.Name, b.Prefix)
				}
			}
		}
		sb.WriteByte('\n')
	}
	return strings.TrimSpace(sb.String())
}

const MultiScaleMapMaxTokens = 4000

const (
	multiScaleAnchorMinK = 2
)

func RenderMultiScaleMap(m *RepoMap, subsystems []SubsystemSpec, topo *MacroTopology, depth string, maxTokens int) string {
	if m == nil {
		return ""
	}
	if maxTokens <= 0 {
		maxTokens = MultiScaleMapMaxTokens
	}
	if topo == nil {
		topo = &MacroTopology{}
	}
	if m.IsMicroRepo {
		return renderMicroRepoMap(m)
	}
	return renderSubsystemMultiScaleMap(m, subsystems, topo, depth, maxTokens)
}

func renderMicroRepoMap(m *RepoMap) string {
	var sb strings.Builder
	sb.WriteString(RenderMap(m))
	if len(m.Anchors) > 0 {
		sb.WriteString("\n=== 微型仓细粒度锚点 (path#anchor | kind) ===\n")
		for _, a := range m.Anchors {
			switch {
			case a.Anchor == "":
				sb.WriteString(a.Path)
				sb.WriteByte('\n')
			case a.Kind == "":
				fmt.Fprintf(&sb, "%s#%s\n", a.Path, a.Anchor)
			default:
				fmt.Fprintf(&sb, "%s#%s | %s\n", a.Path, a.Anchor, a.Kind)
			}
		}
	}
	return strings.TrimSpace(sb.String())
}

func renderSubsystemMultiScaleMap(m *RepoMap, subsystems []SubsystemSpec, topo *MacroTopology, depth string, maxTokens int) string {
	nodeName := make(map[string]string, len(topo.Nodes))
	nodeLang := make(map[string]string, len(topo.Nodes))
	for _, n := range topo.Nodes {
		nodeName[n.ID] = n.Name
		nodeLang[n.ID] = n.PrimaryLang
	}

	grouped := map[string][]FileMap{}
	for _, f := range m.Files {
		if f.IsTest {
			continue
		}
		bestID := ""
		bestLen := -1
		for i := range subsystems {
			sp := subsystems[i].Prefix
			if (f.Path == sp || strings.HasPrefix(f.Path, sp+"/")) && len(sp) > bestLen {
				bestLen = len(sp)
				bestID = subsystems[i].ID
			}
		}
		if bestID != "" {
			grouped[bestID] = append(grouped[bestID], f)
		}
	}

	var actives []SubsystemSpec
	for _, s := range subsystems {
		if !s.IsAuxiliary && len(grouped[s.ID]) > 0 {
			actives = append(actives, s)
		}
	}

	score := make(map[string]int, len(m.Files))
	for id, files := range grouped {
		for _, f := range files {
			score[f.Path] = multiScaleFileScore(f, depth)
		}
		sort.Slice(files, func(i, j int) bool {
			if score[files[i].Path] != score[files[j].Path] {
				return score[files[i].Path] > score[files[j].Path]
			}
			if files[i].Hotness != files[j].Hotness {
				return files[i].Hotness > files[j].Hotness
			}
			return files[i].Path < files[j].Path
		})
		grouped[id] = files
	}

	k := multiScaleAnchorK(len(actives))
	edgeLimit := len(topo.Edges)

	assemble := func(k int, anchorSubs []SubsystemSpec, panoSubs []SubsystemSpec, edgeLimit int) string {
		return assembleMultiScaleMap(m, topo, nodeName, nodeLang, grouped, k, anchorSubs, panoSubs, edgeLimit)
	}

	text := assemble(k, actives, subsystems, edgeLimit)
	for mdpat.EstimateTokens(text) > maxTokens && k > multiScaleAnchorMinK {
		k--
		text = assemble(k, actives, subsystems, edgeLimit)
	}
	for mdpat.EstimateTokens(text) > maxTokens && len(actives) > 0 {
		actives = actives[:len(actives)-1]
		text = assemble(k, actives, subsystems, edgeLimit)
	}
	for mdpat.EstimateTokens(text) > maxTokens && edgeLimit > 0 {
		edgeLimit -= 3
		if edgeLimit < 0 {
			edgeLimit = 0
		}
		text = assemble(k, actives, subsystems, edgeLimit)
	}
	for mdpat.EstimateTokens(text) > maxTokens && len(subsystems) > 0 {
		subsystems = subsystems[:len(subsystems)-1]
		text = assemble(k, actives, subsystems, edgeLimit)
	}
	// Subsystem cap (<=8) bounds overview lines below any positive maxTokens budget.
	return text
}

func assembleMultiScaleMap(
	m *RepoMap,
	topo *MacroTopology,
	nodeName map[string]string,
	nodeLang map[string]string,
	grouped map[string][]FileMap,
	k int,
	anchorSubs []SubsystemSpec,
	panoSubs []SubsystemSpec,
	edgeLimit int,
) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "=== 子系统多尺度地图 (Subsystem Topology) ===\nrepo: %s | files: %d | loc: %d\n",
		m.RepoName, len(m.Files), m.TotalLOC)

	sb.WriteString("\n[子系统全景]\n")
	for _, s := range panoSubs {
		lang := nodeLang[s.ID]
		if lang == "" {
			lang = "-"
		}
		line := fmt.Sprintf("%s | %s | %d files | %d loc | %s", s.Name, s.Prefix, s.FileCount, s.EstLOC, lang)
		if s.IsAuxiliary {
			line += " | auxiliary"
		}
		sb.WriteString(line)
		sb.WriteByte('\n')
	}

	if edgeLimit > 0 && len(topo.Edges) > 0 {
		sb.WriteString("\n[跨子系统依赖]\n")
		limit := edgeLimit
		if limit > len(topo.Edges) {
			limit = len(topo.Edges)
		}
		for _, e := range topo.Edges[:limit] {
			from := nodeName[e.From]
			if from == "" {
				from = e.From
			}
			to := nodeName[e.To]
			if to == "" {
				to = e.To
			}
			if len(e.Symbols) > 0 {
				fmt.Fprintf(&sb, "%s -> %s (%s)\n", from, to, strings.Join(e.Symbols, ", "))
			} else {
				fmt.Fprintf(&sb, "%s -> %s (w%d)\n", from, to, e.Weight)
			}
		}
	}

	for _, s := range anchorSubs {
		files := grouped[s.ID]
		if len(files) == 0 {
			continue
		}
		fmt.Fprintf(&sb, "\n[%s 核心锚点]\n", s.Name)
		limit := k
		if limit > len(files) {
			limit = len(files)
		}
		for _, f := range files[:limit] {
			exp := make([]string, 0, 3)
			for _, e := range f.Exports {
				if e != "" {
					exp = append(exp, e)
				}
				if len(exp) >= 3 {
					break
				}
			}
			exports := "-"
			if len(exp) > 0 {
				exports = strings.Join(exp, ", ")
			}
			fmt.Fprintf(&sb, "%s | %d loc | hot %d | %s | %s\n",
				f.Path, f.LOC, f.Hotness, multiScaleLayerTag(f.Layer), exports)
		}
	}
	return sb.String()
}

func multiScaleAnchorK(activeCount int) int {
	switch {
	case activeCount <= 2:
		return 6
	case activeCount <= 4:
		return 5
	case activeCount <= 6:
		return 4
	case activeCount <= 8:
		return 3
	default:
		return multiScaleAnchorMinK
	}
}

// Weight overview toward docs/entrypoints and deep toward high-hotness/LOC core files.
func multiScaleFileScore(f FileMap, depth string) int {
	score := f.Hotness*2 + f.LOC/20
	if f.IsDoc {
		score += 10
	}
	switch depth {
	case "overview":
		if f.IsDoc {
			score += 50
		}
		if f.Layer == LayerInterface || isExplicitEntryPointLocal(f.Path) || isExplicitInterface(f.Path) {
			score += 45
		}
	case "deep":
		if f.Hotness >= 60 {
			score += 40
		}
		if f.Layer == LayerPipeline {
			score += 20
		}
		score += f.LOC / 10
	default:
		if f.Layer == LayerInterface || isExplicitEntryPointLocal(f.Path) {
			score += 20
		}
	}
	return score
}

func multiScaleLayerTag(l TopologicalLayer) string {
	switch l {
	case LayerInterface:
		return "interface"
	case LayerPipeline:
		return "pipeline"
	default:
		return "foundation"
	}
}

func DeriveDeterministicOutline(model *ArchitecturalModel, targetLanguage string) []cognitive.OutlineChapter {
	if model == nil || len(model.Dimensions) == 0 {
		return nil
	}

	isEn := strings.HasPrefix(strings.ToLower(targetLanguage), "en")
	var chapters []cognitive.OutlineChapter
	chapIdx := 1

	for _, dim := range model.Dimensions {
		if dim.ID == DimSpecialized && len(dim.SubBranches) > 0 {
			for _, b := range dim.SubBranches {
				var name, summary string
				if isEn {
					if len(b.TopExports) > 0 {
						name = fmt.Sprintf("Chapter %d: %s Implementation and %s Mechanics", chapIdx, b.Name, b.TopExports[0])
					} else {
						name = fmt.Sprintf("Chapter %d: %s Module Implementation", chapIdx, b.Name)
					}
					summary = fmt.Sprintf("Implementation mechanics and adaptation logic of %s module", b.Name)
				} else {
					if len(b.TopExports) > 0 {
						name = fmt.Sprintf("第 %d 章：%s 模块实现与 %s 机制", chapIdx, b.Name, b.TopExports[0])
					} else {
						name = fmt.Sprintf("第 %d 章：%s 模块实现与机制", chapIdx, b.Name)
					}
					summary = fmt.Sprintf("解析 %s 模块的具体实现机制与适配逻辑", b.Name)
				}

				filesToUse := b.KeyFiles
				if len(filesToUse) == 0 {
					filesToUse = dim.KeyFiles
				}

				cFiles := make([]cognitive.ChapterFile, 0, len(filesToUse))
				for _, p := range filesToUse {
					cFiles = append(cFiles, cognitive.ChapterFile{Path: p})
				}

				chapters = append(chapters, cognitive.OutlineChapter{
					Name:      name,
					Summary:   summary,
					Files:     cFiles,
					PartTitle: dim.Title,
				})
				chapIdx++
				if chapIdx > maxChapters {
					break
				}
			}
			continue
		}

		var name string
		switch dim.ID {
		case DimInterfaceFacade:
			if isEn {
				if len(dim.TopExports) > 0 {
					name = fmt.Sprintf("Chapter %d: System Entrypoints and %s Facade", chapIdx, dim.TopExports[0])
				} else {
					name = fmt.Sprintf("Chapter %d: System Entrypoints and Interface Contracts", chapIdx)
				}
			} else {
				if len(dim.TopExports) > 0 {
					name = fmt.Sprintf("第 %d 章：系统入口与 %s 门面适配", chapIdx, dim.TopExports[0])
				} else {
					name = fmt.Sprintf("第 %d 章：系统入口与对外接入契约", chapIdx)
				}
			}
		case DimDomainState:
			if isEn {
				if len(dim.TopExports) > 0 {
					name = fmt.Sprintf("Chapter %d: Core Data Models and %s State", chapIdx, dim.TopExports[0])
				} else {
					name = fmt.Sprintf("Chapter %d: Core Domain Models and State Management", chapIdx)
				}
			} else {
				if len(dim.TopExports) > 0 {
					name = fmt.Sprintf("第 %d 章：核心数据模型与 %s 状态管理", chapIdx, dim.TopExports[0])
				} else {
					name = fmt.Sprintf("第 %d 章：核心数据模型与状态设计", chapIdx)
				}
			}
		case DimCoreEngine:
			if isEn {
				if len(dim.TopExports) > 0 {
					name = fmt.Sprintf("Chapter %d: Core Execution Engine and %s Pipelines", chapIdx, dim.TopExports[0])
				} else {
					name = fmt.Sprintf("Chapter %d: Core Execution Engine and Pipeline Dispatch", chapIdx)
				}
			} else {
				if len(dim.TopExports) > 0 {
					name = fmt.Sprintf("第 %d 章：核心执行引擎与 %s 调度管线", chapIdx, dim.TopExports[0])
				} else {
					name = fmt.Sprintf("第 %d 章：核心执行引擎与调度管线", chapIdx)
				}
			}
		case DimSpecialized:
			if isEn {
				if len(dim.TopExports) > 0 {
					name = fmt.Sprintf("Chapter %d: Algorithm Extensions based on %s", chapIdx, dim.TopExports[0])
				} else {
					name = fmt.Sprintf("Chapter %d: Algorithm Extensions and Specialized Plugins", chapIdx)
				}
			} else {
				if len(dim.TopExports) > 0 {
					name = fmt.Sprintf("第 %d 章：基于 %s 的算法扩展与实现", chapIdx, dim.TopExports[0])
				} else {
					name = fmt.Sprintf("第 %d 章：特化算法与插件扩展实现", chapIdx)
				}
			}
		case DimVerification:
			if isEn {
				if len(dim.TopExports) > 0 {
					name = fmt.Sprintf("Chapter %d: Specification Invariants and %s Verification", chapIdx, dim.TopExports[0])
				} else {
					name = fmt.Sprintf("Chapter %d: Specification Invariants and Verification Boundaries", chapIdx)
				}
			} else {
				if len(dim.TopExports) > 0 {
					name = fmt.Sprintf("第 %d 章：规格约束与 %s 行为验证", chapIdx, dim.TopExports[0])
				} else {
					name = fmt.Sprintf("第 %d 章：规格约束与行为验证边界", chapIdx)
				}
			}
		default:
			if isEn {
				name = fmt.Sprintf("Chapter %d: %s", chapIdx, dim.ID)
			} else {
				name = fmt.Sprintf("第 %d 章：%s", chapIdx, dim.ID)
			}
		}

		cFiles := make([]cognitive.ChapterFile, 0, len(dim.KeyFiles))
		for _, p := range dim.KeyFiles {
			cFiles = append(cFiles, cognitive.ChapterFile{Path: p})
		}

		summary := dim.Description
		if summary == "" {
			summary = name
		}

		chapters = append(chapters, cognitive.OutlineChapter{
			Name:      name,
			Summary:   summary,
			Files:     cFiles,
			PartTitle: dim.Title,
		})
		chapIdx++
		if chapIdx > maxChapters {
			break
		}
	}

	return chapters
}
