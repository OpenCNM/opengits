// Package pipelineb 是「LLM 当作者、AST 当目录」假设的实验管线（对拍 A 管线）。
//
// 设计假设（2026-09 立项）：确定性决策层（RSG 权重/认知投影/启发式大纲）
// 是小上下文时代的"预消化"；现代 LLM 拿一张紧凑的 AST 目录表即可直接
// 产出高质量教程大纲。本管线只保留四件确定性的事：
//  1. 提取（tree-sitter 36 门语法 → 文件/符号/导入/热度目录表）；
//  2. 预算（目录表规模与 token 估算封顶）；
//  3. 收敛闸门（严格 JSON 解析 + 路径幻觉装甲 = SanitizeAndIntersectOutline）；
//  4. 回落（解析/校验失败显式失败，由调用方回落 A 管线，绝不静默给垃圾）。
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

// FileMap 单文件的目录表条目。
type FileMap struct {
	Path     string
	Lang     string
	LOC      int
	Exports  []string         // 导出符号（封顶 maxExportsPerFile）
	Imports  []string         // 导入模块（封顶）
	Hotness  int              // 被调热度（全仓调用点计数，LLM 选材的轻重信号）
	Layer    TopologicalLayer // 拓扑分层 (0=Foundation, 1=Pipeline, 2=Interface)
	IsDoc    bool
	IsTest   bool
	IsConfig bool
}

// ASTCallEdge 表示 AST 静态解析的跨文件调用边与调用符号。
type ASTCallEdge struct {
	Caller string `json:"caller"`
	Callee string `json:"callee"`
	Symbol string `json:"symbol,omitempty"`
}

// RepoMap 整仓 AST 目录表。
type RepoMap struct {
	Files     []FileMap
	TotalLOC  int
	EstTokens int
	Truncated bool // 超出文件数封顶被截断
	RepoName  string
	// Tree 折叠目录树(P1 起常驻;P2 下钻的骨架/子树输入)。
	// 字节等价保证:LeafFiles() 与 Files 全序一致(字典序)。
	Tree *RepoTreeNode `json:"tree,omitempty"`
	// IsMicroRepo 是否触发微型仓自适应尺度下钻 (Zoom-2, 有效源码文件 <= 3)
	IsMicroRepo bool `json:"isMicroRepo,omitempty"`
	// Anchors 微型仓提取的细粒度符号、规格与教学锚点 (候选集装甲注入与 RenderMap 展开)
	Anchors []cognitive.CandidateOutlineFile `json:"anchors,omitempty"`
	// CallEdges 物理 AST 跨文件调用边 (调用方、被调方、调用符号)
	CallEdges []ASTCallEdge `json:"callEdges,omitempty"`
}

// 提取封顶基准（单次 Prompt 预算保护帽；全量树与骨架永远 100% 遍历，零盲区）。
const (
	DefaultMaxFilesInMap       = 1200
	DefaultDrillSubtreeFileCap = 400
	MaxExportsPerFile          = 12
	MaxImportsPerFile          = 8
)

// MaxFilesInMap 获取平铺地图提取上限（单次 Prompt 预算保护帽）。
// 优先级: 显式覆盖值 > 环境变量 OUTLINE_MAP_FILE_CAP > 默认值 DefaultMaxFilesInMap。
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

// DrillSubtreeFileCap 获取子树下钻叶子文件上限。
// 优先级: 显式覆盖值 > 环境变量 DRILL_SUBTREE_FILE_CAP > 默认值 DefaultDrillSubtreeFileCap。
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

// BuildRepoMap 从本地目录构建目录表（确定性提取层）。
func BuildRepoMap(root, repoName string, defs *rsg.LanguageDefinitions, patterns cognitive.Patterns, fileCap ...int) (*RepoMap, error) {
	return BuildScopedRepoMap(root, repoName, "", defs, patterns, fileCap...)
}

// BuildScopedRepoMap 从本地目录构建带卷作用域的目录表（确定性提取层，支持子卷目录隔离）。
func BuildScopedRepoMap(root, repoName, prefixScope string, defs *rsg.LanguageDefinitions, patterns cognitive.Patterns, fileCap ...int) (*RepoMap, error) {
	all, err := walkContentFiles(root, patterns, prefixScope)
	if err != nil {
		return nil, err
	}
	// 树与骨架永远全量(仅 stat 代价，巨仓上万文件 100% 完整入树，零盲区);
	// 截断只作用于平铺单次 Prompt 预算保护帽——
	// 超配额时按顶层分区摊开(避免单一顶级目录独吞全部配额，其他关键子系统照样入骨架)。
	// 未提取文件的 LOC 以 size/32 估(仅骨架展示用)。
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
	// pass 1 的 AST 提取结果按 files 序保留，供热度二次遍历复用——
	// 免除第二遍逐文件重读盘+重提取（AST 缓存虽命中，仍有磁盘读、
	// SHA-1 与 LRU Clone 深拷贝）。
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
				for _, imp := range ext.Imports {
					if len(fm.Imports) < MaxImportsPerFile {
						fm.Imports = append(fm.Imports, imp.Module)
					}
				}
			}
		}
		extracted = append(extracted, fm)
	}
	// 热度(A1,P2)：跨文件调用边 → PageRank(0.85×30,与语义图同参;
	// aider 先例:图排序优于局部计数)。归一化 0-100。
	var edges [][2]string
	if defs != nil {
		// 裸符号名全局解析的歧义防护：多文件导出同名符号时后写会覆盖
		// 前写（owner 随遍历序漂移），且调用点不校验 import 归属——本地
		// 同名符号会被错连到他人文件。歧义名（≥2 个 owner）与本地同名
		// 一律不连边：宁缺毋滥（fail-closed），热度/分层/拓扑边权不再被污染。
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

	// 探测微型仓尺度（Zoom-2）：有效源码文件数 <= 3
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
		m.Tree = BuildRepoTree(m.Files, m.RepoName) // 未截断:精确 LOC 树
	}
	return m, nil
}

// spreadSelect 超配额提取的分区摊开选择:README/docs 保底 + 顶层目录
// 轮转(round-robin),保证每个分区都有代表进入提取(而非字典序前段独吞)。
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
	// 保底：README 与顶层 doc 先进
	for _, f := range files {
		if patterns.IsDocFile(f.rel) && strings.Count(f.rel, "/") == 0 {
			out = append(out, f)
			seen[f.rel] = true
			if len(out) >= cap {
				return out
			}
		}
	}
	// round-robin
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

// RenderMap 目录表紧凑渲染（进 prompt 的形态，按 AST 拓扑分层组织）。
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

	// 按拓扑层级 (0: Foundation -> 1: Pipeline -> 2: Interface) 分组
	grouped := [3][]FileMap{}
	for _, f := range m.Files {
		layer := int(f.Layer)
		if layer < 0 || layer > 2 {
			layer = 1
		}
		grouped[layer] = append(grouped[layer], f)
	}

	// 组内稳定排序：热度降序，路径升序
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

// ModelRequest 模型调用请求：RepoMap/ArchModel/TargetLanguage 即网关 purpose 变量
// （prompt 由 registry.ts compile，Go 零拼装）。
type ModelRequest struct {
	RepoMap            *RepoMap
	ArchModel          *ArchitecturalModel
	TargetLanguage     string
	ContinuationPrompt string // 可选断点续写或靶向修复指令
	// CoverageFeedback 可选覆盖率门禁修订指令（契约 C7，WP4.1 深度 1
	// 单次回流；仅非空才进 vars["coverageFeedback"]）。
	CoverageFeedback string
}

// OutlineModel LLM 调用抽象：实现把 req.ArchModel/TargetLanguage 组装为
// purpose 变量（gateway.go，outline_map_v1）。
type OutlineModel interface {
	// Complete 返回 JSON 文本。ctx 超时由调用方包裹。
	Complete(ctx context.Context, req ModelRequest) (string, error)
}

// OutlineResult B 管线产出。
type OutlineResult struct {
	Chapters     []cognitive.OutlineChapter
	DroppedPaths []string // 路径幻觉装甲砍掉的 LLM 编造路径
	ModelRawLen  int
	EstPromptTok int
	Duration     time.Duration
}

// Run 执行 B 管线（统一树算法的深度 1 路径，P1——基于 5 大架构维度极速出纲）:
//  1. 0ms 本地微秒级拓扑降维（400 Token 架构模型）；
//  2. 确定性瞬出 (model == nil 离线桩) + 流式 LLM 语义点睛；
//  3. 三层第一性原理自愈阶梯：
//     - Layer 1: 内存 0ms 物理急救（StripPayloadShell 剥壳 + SalvageOutlineChapters 状态机逐章抢救完整对象）；
//     - Layer 2: 断点增量续写 / 靶向微创修复（以已生成章节作为上下文断点，仅续写剩余章节，提速 10x）；
//     - Layer 3: 坚决拒收·失效封闭（彻底废除伪弹性兜底，零幻觉路径求交，确保交付真实 AI 意图）；
//  4. 严格通过候选集交集与真实路径装甲过滤幻觉路径。
func Run(ctx context.Context, m *RepoMap, model OutlineModel, patterns cognitive.Patterns, targetLanguage string) (*OutlineResult, error) {
	start := time.Now()
	// arch 仍被 decorateChapterDimensions 与确定性基线消费，保留不删
	arch := BuildArchitecturalModel(m, patterns)
	// EstPromptTok 观测按 LLM 实际收到的输入估算（Grounding Dilemma——观测
	// 绝不低报一个量级）：LLM 路径主道是多尺度子系统地图（gateway.go Complete
	// 同构组装），确定性路径（model == nil）保留 RenderArchModel 估算基线。
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

	// 1. 幻觉装甲基础数据准备
	nodes := make([]cluster.GitNode, 0, len(m.Files))
	candidates := make([]cognitive.CandidateOutlineFile, 0, len(m.Files)+len(m.Anchors))
	for _, f := range m.Files {
		nodes = append(nodes, cluster.GitNode{Path: f.Path, Type: "blob"})
		candidates = append(candidates, cognitive.CandidateOutlineFile{Path: f.Path, IsDoc: f.IsDoc})
	}
	if m.IsMicroRepo && len(m.Anchors) > 0 {
		candidates = append(candidates, m.Anchors...)
	}

	// 2. 若无模型 (model == nil)，直接输出确定性极速大纲 (纯本地离线测试基线)
	if model == nil {
		deterministicChapters := DeriveDeterministicOutline(arch, targetLanguage)
		san := cognitive.SanitizeAndIntersectOutline(deterministicChapters, nodes, "", targetLanguage, candidates, patterns)
		// 离线基线无 LLM 可修订：覆盖率门禁仅记录指标与告警，绝不伪造修订
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

	// 3. 轻量 LLM 语义点睛（动态交互预算）：预算 = ctx 剩余额度 − 装甲收尾预留
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

	// Layer 1: 0ms 纯内存物理急救（剥壳 + 逐章状态机抢救）
	// 流被预算切断（ErrStreamPartial 残文上抛）或尾部截断时，已完整落章的 JSON 对象确定性回收
	if len(draft) == 0 && raw != "" {
		if salvaged := SalvageOutlineChapters(raw); len(salvaged) > 0 {
			log.Printf("[pipelineb] OutlineRun Layer 1 salvage: %d chapters recovered from raw (len=%d)\n", len(salvaged), len(raw))
			draft = salvaged
			err = nil
		}
	}

	// Layer 2: 断点增量续写 (Checkpoint Continuation)
	// 若前序抢救出部分章节 (len >= 1)，但存在截断未尽迹象（如遇到 ErrStreamPartial 或多文件仓库章数过少且 ctx 仍有预算）：
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

	// Layer 2: 单次微创靶向修复 (Targeted Repair)
	// 若 draft 仍然为空但 context 未取消，尝试针对格式瑕疵发起快速单次修复。
	// 永久性配置/授权错误（缺 Key/解密失败/预算/未知 purpose）跳过——
	// 零成本退出契约（与 drill isRetryablePlanError 同一语义），重试只会
	// 空耗预算并把密钥类故障伪装成"格式瑕疵"（2026-11 A 类收口）。
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

	// Layer 3: 坚决拒收·失效封闭（彻底废除伪弹性兜底）
	if len(draft) == 0 {
		if err != nil {
			return nil, fmt.Errorf("curriculum outline generation failed to converge: %w", err)
		}
		return nil, errors.New("curriculum outline generation failed: model produced zero valid chapters")
	}

	// 幻觉装甲求交校验
	san := cognitive.SanitizeAndIntersectOutline(draft, nodes, "", targetLanguage, candidates, patterns)
	if len(san.Sanitized) == 0 {
		return nil, errors.New("curriculum outline hallucination armor rejected all candidate paths (no physical matches)")
	}

	decorateChapterDimensions(san.Sanitized, arch)

	// WP4.1 深度 1：后置覆盖率门禁（确定性冲突裁决 + 至多 1 次
	// outline_map_v1 修订回流，修订过同一装甲收尾；仍缺失告警放行，绝不循环）
	chapters := applyCoverageGate(ctx, m, arch, model, patterns, nodes, candidates, targetLanguage, san.Sanitized)

	return &OutlineResult{
		Chapters:     chapters,
		DroppedPaths: san.DroppedPaths,
		ModelRawLen:  len(raw),
		EstPromptTok: promptTok,
		Duration:     time.Since(start),
	}, nil
}

// LLM 交互预算钳制：下限保证小剩余额度下仍有一搏，上限封病理悬挂；
// 预留为装甲/拓扑/序列化等收尾确定性开销的保守估值。
const (
	outlineLlmBudgetFloor   = 10 * time.Second
	outlineLlmBudgetCeiling = 90 * time.Second
	outlineArmorReserve     = 8 * time.Second
	outlineLlmDefaultBudget = 30 * time.Second
)

// outlineLlmBudget 从 ctx 剩余额度推导 LLM 切片预算（预算所有权归调用方）：
// 无 deadline（测试直调等）取缺省 30s；有 deadline 扣除收尾预留后钳制。
// 归档下载/提取耗时长则 LLM 自动收缩，快则拿到大预算——服务端不再猜测。
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

// decorateChapterDimensions 确保每个章节都具备明确的物理架构维度标签与分段归属。
func decorateChapterDimensions(chapters []cognitive.OutlineChapter, arch *ArchitecturalModel) {
	if len(chapters) == 0 {
		return
	}

	// 1. LLM 优先：合法分卷业务命名经收敛漏斗（剥序数壳/缺漏自愈/尺度护栏/
	// Part N 自然序重编）后直接采信，坚决不覆写其业务语境
	if canonicalizeLLMPartTitles(chapters) {
		return
	}

	if arch == nil || len(arch.Dimensions) == 0 {
		return
	}

	// 2. 确定性映射保底（LLM 未产出分卷或全为机械序数空壳时）
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

// estimateTokensFor 架构模型 token 估算 (handler 缓存命中路径复用)。
func estimateTokensFor(m *RepoMap) int {
	if m == nil {
		return 0
	}
	arch := BuildArchitecturalModel(m, nil)
	return mdpat.EstimateTokens(RenderArchModel(arch))
}
