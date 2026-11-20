package pipelineb

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/opengits/worker-sidecar/internal/rsg"
)

// ─────────────────────────────────────────────────────────────
// 专题定向增量采样（策略 B 冷启动缓存/归档路径的符号补齐）。
//
// 背景：策略 B 冷启动只给 25~50 个通用采样文件提取 AST，其余叶子
// Exports == nil——"先默认导入建缓存、再带 customPrompt 重试"会命中
// 稀疏 AST 缓存，专题符号不可见。本文件在请求期做增量定向采样补齐：
// 确定性门限触发 → AI 点名 → 并发抓取 → AST 原位升级补提。
//
// 失效封闭与共享只读：缓存树实例共享只读（mapcache.go——消费方不得
// 原地修改），补提产物在全新切片上 upsert 合入并全量重建工作树，
// 绝不触碰共享实例的切片/元素，绝不回写 TreeMapCache；任何失败
// fail-open 留痕后原样返回 m，绝不阻塞主流程。
// ─────────────────────────────────────────────────────────────

const (
	// thematicSparseThreshold AST 稀疏门限：非测试非配置叶子中已提取
	// 导出的占比低于该值视为稀疏（与 tree.go 渲染层 0.1 口径一致）。
	thematicSparseThreshold = 0.1
	// thematicSampleCap 单次专题补提的点名去重总量硬帽（与策略 B 上限同量级）。
	thematicSampleCap = 50
	// thematicFetchTimeout 请求期同步抓取的墙钟上限（预算权归代码）。
	thematicFetchTimeout = 90 * time.Second
)

// thematicAstSparse 缓存/归档树的 AST 稀疏判定（确定性微秒级短路）：
// 非 IsTest 非 IsConfig 叶子中 len(Exports)>0 占比 < 阈值；分母 0 视为稀疏。
func thematicAstSparse(m *RepoMap) bool {
	if m == nil || m.Tree == nil {
		return false
	}
	files := m.Tree.LeafFiles()
	total, exported := 0, 0
	for i := range files {
		if files[i].IsTest || files[i].IsConfig {
			continue
		}
		total++
		if len(files[i].Exports) > 0 {
			exported++
		}
	}
	if total == 0 {
		return true
	}
	return float64(exported)/float64(total) < thematicSparseThreshold
}

// enrichMapWithThematicSampling 缓存/归档路径的专题定向增量采样（fail-open）。
// 触发全确定性：customPrompt 非空 + 树 AST 稀疏 + 采样器/抓取器已接线。
// 成功时在请求期 upsert 补提专题文件 AST 并全量重建工作树（m.Tree/m.Files/
// TotalLOC/EstTokens/CallEdges），不回写 TreeMapCache；任何失败留痕后原样返回 m。
func (h *Handler) enrichMapWithThematicSampling(ctx context.Context, m *RepoMap, req TreeOutlineRequest, patterns cognitive.Patterns, cb ProgressCallback) *RepoMap {
	// 触发门限（廉价确定性短路在前；customPrompt 为空是绝对热路径）
	if req.CustomPrompt == "" || m == nil || m.Tree == nil || !thematicAstSparse(m) {
		return m
	}
	sampler := h.samplerForReq(req.UserID, req.CustomPrompt, req.TeachingDepth, req.LearnerArchetype)
	if sampler == nil || h.concurrentBlobFetcher == nil {
		return m // 采样器/抓取器未接线（测试直构/旧版部署）：门限直通
	}
	token := h.resolveOutlineToken(req)
	if token == "" || req.Owner == "" || req.Repo == "" || req.SHA == "" {
		// 无远端 Git 上下文（本地 RepoDir 直读/匿名缓存直出）：无从抓取，留痕直通
		log.Printf("[pipelineb] thematic enrich skipped: no remote git context (owner/repo/sha/token)")
		return m
	}
	defs := (*rsg.LanguageDefinitions)(nil)
	if h.defsFn != nil {
		defs = h.defsFn()
	}
	if defs == nil {
		log.Printf("[pipelineb] thematic enrich skipped: language definitions not wired")
		return m
	}

	old := m.Tree.LeafFiles()

	// 子系统分层骨架（契约 C1 SSOT）：无子系统时回退既有全仓骨架
	subsystems := DiscoverSubsystems(SubsystemSourcesFromRepoMap(m), patterns)
	skeleton := RenderSamplingSkeleton(m.Tree, defaultSamplingSkeletonBudget)
	if len(subsystems) > 0 {
		skeleton = RenderStratifiedSamplingSkeleton(m.Tree, subsystems, defaultSamplingSkeletonBudget)
	}

	// AI 定向点名（用户选定条件全链路贯穿）。SampleOrFallbackCoreFiles 在
	// 采样器超时/异常/空点名时内部回退规则兜底——兜底选材不体现用户专题
	// 意图，专题补提只在 AI 真实点名时进行（失效封闭，绝不猜）
	entries := make([]client.GitTreeEntry, 0, len(old))
	for _, f := range old {
		entries = append(entries, client.GitTreeEntry{Path: f.Path, Type: "blob", Size: int64(f.LOC)*32 + 1})
	}
	sreq := SampleRequest{
		Skeleton:         skeleton,
		Prefix:           req.Prefix,
		TeachingDepth:    req.TeachingDepth,
		LearnerArchetype: req.LearnerArchetype,
		CustomPrompt:     req.CustomPrompt,
	}
	corePaths, sampleMode := SampleOrFallbackCoreFiles(ctx, sampler, entries, sreq, patterns, subsystems)
	if sampleMode == SamplingStrategyFallback8 {
		log.Printf("[pipelineb] thematic enrich skipped: sampler produced no directed files (fallback-8)")
		return m
	}

	// 过滤：点名路径必须命中当前工作树叶子索引、尚未有 AST 导出，去重后总量 ≤ 帽
	leafIdx := make(map[string]FileMap, len(old))
	for _, f := range old {
		leafIdx[f.Path] = f
	}
	seen := make(map[string]bool, len(corePaths))
	toFetch := make([]string, 0, len(corePaths))
	for _, p := range corePaths {
		clean := strings.TrimPrefix(filepath.ToSlash(strings.TrimSpace(p)), "/")
		if clean == "" || seen[clean] {
			continue
		}
		if fm, ok := leafIdx[clean]; !ok || len(fm.Exports) > 0 {
			continue
		}
		seen[clean] = true
		toFetch = append(toFetch, clean)
		if len(toFetch) >= thematicSampleCap {
			break
		}
	}
	if len(toFetch) == 0 {
		log.Printf("[pipelineb] thematic enrich skipped: sampler named %d paths but none are sparse leaves", len(corePaths))
		return m
	}

	apiBase := h.GitHubAPIBase
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}
	ua := h.UserAgent
	if ua == "" {
		ua = "OpenGits-Engine/1.0"
	}

	fetchCtx, cancel := context.WithTimeout(ctx, thematicFetchTimeout)
	defer cancel()
	contents, truncated, err := h.concurrentBlobFetcher(fetchCtx, apiBase, req.Owner, req.Repo, req.SHA, toFetch, token, ua)
	if err != nil {
		log.Printf("[pipelineb] thematic enrich blob fetch failed (requested=%d): %v", len(toFetch), err)
		return m
	}
	if truncated {
		// 部分成功 fail-open 续跑：拿到的文件照常补提，缺额如实留痕
		log.Printf("[pipelineb] thematic enrich blob fetch partial: fetched=%d/%d requested", len(contents), len(toFetch))
	}
	if len(contents) == 0 {
		log.Printf("[pipelineb] thematic enrich skipped: fetched 0/%d files", len(toFetch))
		return m
	}

	// 以全量 m.Files 的导出重建符号归属表：同名导出多文件归属记 ambiguous
	// 不连边（宁缺毋滥，与 BuildRepoMapFromTree 同一 fail-closed 口径）
	exportOwner := make(map[string]string, len(m.Files)*4)
	ambiguous := make(map[string]bool)
	for i := range m.Files {
		for _, e := range m.Files[i].Exports {
			if prev, dup := exportOwner[e]; dup && prev != m.Files[i].Path {
				ambiguous[e] = true
			} else if !dup {
				exportOwner[e] = m.Files[i].Path
			}
		}
	}

	// 逐文件 AST 补提（有界近似，如实陈述：旧文件调用点未随缓存持久化，
	// 故仅以新文件外向边计 Hotness、追加单向调用边，不重算全局 PageRank）
	enriched := make([]FileMap, 0, len(contents))
	newEdges := make([]ASTCallEdge, 0)
	for _, path := range toFetch {
		content, ok := contents[path]
		if !ok || content == "" {
			continue
		}
		fm := FileMap{
			Path:     path,
			LOC:      strings.Count(content, "\n") + 1,
			IsDoc:    patterns != nil && patterns.IsDocFile(path),
			IsTest:   patterns != nil && patterns.IsTestFile(path),
			IsConfig: patterns != nil && (patterns.IsConfigFile(path) || isMainConfigFile(strings.ToLower(filepath.Base(path)))),
		}
		ext := defs.ExtractFileAst(content, path)
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
			localNames := make(map[string]bool, len(ext.Symbols))
			for _, sym := range ext.Symbols {
				localNames[sym.Name] = true
			}
			for _, cs := range ext.CallSites {
				if ambiguous[cs.Name] || localNames[cs.Name] {
					continue
				}
				if owner, ok := exportOwner[cs.Name]; ok && owner != path {
					fm.Hotness++
					newEdges = append(newEdges, ASTCallEdge{Caller: path, Callee: owner, Symbol: cs.Name})
				}
			}
		}
		enriched = append(enriched, fm)
	}
	if len(enriched) == 0 {
		log.Printf("[pipelineb] thematic enrich skipped: 0/%d fetched files parsed", len(toFetch))
		return m
	}

	// 合入（防共享缓存污染，关键）：upsert 原位升级——点名路径在 old 中的
	// 稀疏叶子替换为增强副本，其余叶子逐值拷贝；FileCount 不变、零重复叶子、
	// 字典序保持（P1 不变量）；共享缓存树实例零接触（仅读），不回写缓存
	byPath := make(map[string]FileMap, len(enriched))
	for _, f := range enriched {
		byPath[f.Path] = f
	}
	all := make([]FileMap, 0, len(old)+len(byPath))
	for _, f := range old {
		if nf, ok := byPath[f.Path]; ok {
			all = append(all, nf)
			continue
		}
		all = append(all, f)
	}
	m.CallEdges = append(m.CallEdges, newEdges...)
	m.Tree = BuildRepoTree(all, m.RepoName)
	m.Files = all
	m.TotalLOC = 0
	for _, f := range all {
		m.TotalLOC += f.LOC
	}
	m.EstTokens = estimateTokensFor(m)

	if cb != nil {
		cb(ProgressStep{
			Stage:  "sample",
			Title:  "专题定向提取",
			Detail: fmt.Sprintf("已定向补提 %d 个专题文件的 AST 符号", len(enriched)),
		})
	}
	log.Printf("[pipelineb] thematic enrich done: upgraded=%d sampled=%d leaves=%d", len(enriched), len(toFetch), len(old))
	return m
}
