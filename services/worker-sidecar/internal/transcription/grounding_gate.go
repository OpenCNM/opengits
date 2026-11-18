package transcription

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strings"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/chapter"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// ─────────────────────────────────────────────────────────────
// 分级幻觉防护门禁 (Grounding Gate)
//
// Tier-4 事实锚定门的分级闭环升级（对齐收敛漏斗"初次与修复同闸门"约定）：
//   - L1 吸附放行：校验干净，或仅存在已被确定性消歧扶正的模糊/歧义对齐
//     （Fuzzy-aligned / Ambiguous warning）→ 直接放行，零额外 Token；
//   - L2 定向重写：存在幻觉文件或幻觉符号 → 以《事实差异清单》回填
//     vars["groundingFeedback"]，重调一次 code_chapter_lesson 并重跑同一
//     收敛漏斗后复审（严格单次，反馈只带差异清单差集）；
//   - L3 Fail-Closed 拒收：重写后仍有幻觉 → 拒绝发布，走 BodyFailed
//     既有链路（产品定夺 2026-09-20：兜底=质量降级,拒绝）。
//
// 门禁只裁决物理可验证声明（路径存在性、符号声明性）；叙事与教学解释
// 仍完全归 LLM（红线三：不用逻辑代码取代 LLM）。
// ─────────────────────────────────────────────────────────────

// GroundingGateOutcome 门禁终判。
type GroundingGateOutcome string

const (
	GroundingPassed    GroundingGateOutcome = "passed"
	GroundingRewritten GroundingGateOutcome = "rewritten"
	GroundingRejected  GroundingGateOutcome = "rejected"
)

// GroundingLedger 每章一行对账记录（In-Band Conservation：入口锚点计数与
// 出口判定计数的差值即可观测吸附率与捏造率）。仅结构化日志一行，不落库
// （Zero-Materialization：过程观测事实，对齐 [llm-stream] call= 先例）。
type GroundingLedger struct {
	DocPath       string
	CallID        string
	RewriteCallID string
	Outcome       GroundingGateOutcome
	AnchorsIn     int
	Grounded      int
	Disambiguated int
	Snapped       int
	Invalid       int
	Retries       int
	Report        cognitive.GroundingReport
}

// LogLine 对账行（单行、空格分隔 key=value，便于日志采集解析）。
func (l GroundingLedger) LogLine() string {
	return fmt.Sprintf(
		"[grounding] doc=%s call=%s rewrite_call=%s outcome=%s anchors_in=%d grounded=%d disambiguated=%d snapped=%d invalid=%d retries=%d",
		l.DocPath, l.CallID, l.RewriteCallID, l.Outcome,
		l.AnchorsIn, l.Grounded, l.Disambiguated, l.Snapped, l.Invalid, l.Retries,
	)
}

// groundingHasHallucination 分级判据（确定性，零魔法阈值）：
// 存在任一幻觉文件或幻觉符号即触发 L2 定向重写。
func groundingHasHallucination(report cognitive.GroundingReport) bool {
	return len(report.HallucinatedFiles) > 0 || len(report.HallucinatedSymbols) > 0
}

// GroundingRejectError L3 拒收：重写一次后核心引用仍与代码库物理事实脱节。
type GroundingRejectError struct {
	DocPath             string
	HallucinatedFiles   []string
	HallucinatedSymbols []cognitive.SymbolClaim
}

func (e *GroundingRejectError) Error() string {
	parts := make([]string, 0, len(e.HallucinatedFiles)+len(e.HallucinatedSymbols))
	for _, f := range e.HallucinatedFiles {
		parts = append(parts, fmt.Sprintf("file '%s' not in repository", f))
	}
	for _, s := range e.HallucinatedSymbols {
		parts = append(parts, fmt.Sprintf("symbol '%s' not declared in '%s'", s.Symbol, s.File))
	}
	return fmt.Sprintf("hallucinations persist after rewrite for %s: %s", e.DocPath, strings.Join(parts, "; "))
}

// buildGroundingIndexWithDeps 在 buildGroundingIndex 之上叠加 PostgreSQL DB 回退与章节源码增量 AST 固化：
// 1. 本地图谱盘缺失时先尝试从 DB 恢复并回暖本地磁盘；
// 2. 对本章未入图（如巨仓未抽样）源码文件即时跑单文件 AST 提取并立即注入 GroundingIndex + 异步/原子回写 DB。
func buildGroundingIndexWithDeps(
	ctx context.Context,
	archiveRoot, graphDir, owner, repo, sha, branch string,
	chapterFilePaths []string,
	snippets []armor.ArmorAllocatedSnippet,
	graphRepo cognitive.GraphArtifactRepo,
	extractSymbols func(content, filePath string) []cognitive.SymbolEntry,
) cognitive.GroundingIndex {
	if graphRepo != nil && graphDir != "" && owner != "" && repo != "" && sha != "" {
		if _, err := cognitive.OpenSemanticGraphArtifactLazy(graphDir, owner, repo, sha); err != nil {
			if _, lerr := cognitive.LoadSemanticGraphArtifact(graphDir, owner, repo, sha); lerr != nil {
				if persisted, derr := graphRepo.LoadArtifact(ctx, owner, repo, sha); derr == nil && persisted != nil {
					_, _ = cognitive.SaveSemanticGraphArtifact(graphDir, owner, repo, sha, persisted)
				}
			}
		}
	}

	idx := buildGroundingIndex(graphDir, owner, repo, sha, chapterFilePaths)
	if extractSymbols == nil || len(chapterFilePaths) == 0 && len(snippets) == 0 {
		return idx
	}

	snippetByPath := make(map[string]string, len(snippets))
	for _, s := range snippets {
		cleanP, _ := mdpat.SplitPathAnchor(s.Path)
		if cleanP != "" && s.Snippet != "" && snippetByPath[cleanP] == "" {
			snippetByPath[cleanP] = s.Snippet
		}
	}

	// 收集候选文件路径（章节清单 + snippets）
	candSet := make(map[string]bool, len(chapterFilePaths)+len(snippets))
	var candPaths []string
	for _, rawP := range chapterFilePaths {
		cleanP, _ := mdpat.SplitPathAnchor(rawP)
		if cleanP != "" && !candSet[cleanP] {
			candSet[cleanP] = true
			candPaths = append(candPaths, cleanP)
		}
	}
	for cleanP := range snippetByPath {
		if !candSet[cleanP] {
			candSet[cleanP] = true
			candPaths = append(candPaths, cleanP)
		}
	}

	newFileSymbols := make(map[string][]cognitive.SymbolEntry)
	for _, cleanP := range candPaths {
		if len(idx.SymbolsByFile[cleanP]) > 0 {
			continue
		}
		var raw string
		if archiveRoot != "" && owner != "" && repo != "" {
			for _, ref := range []string{sha, branch} {
				if ref == "" {
					continue
				}
				if raw = chapter.ReadLocalArchiveFile(archiveRoot, owner, repo, ref, cleanP); raw != "" {
					break
				}
			}
		}
		if raw == "" {
			raw = snippetByPath[cleanP]
		}
		if raw == "" {
			continue
		}
		syms := extractSymbols(raw, cleanP)
		if len(syms) == 0 {
			continue
		}
		if idx.SymbolsByFile == nil {
			idx.SymbolsByFile = make(map[string][]cognitive.SymbolEntry)
		}
		idx.SymbolsByFile[cleanP] = syms
		newFileSymbols[cleanP] = syms
	}

	if len(newFileSymbols) > 0 {
		if incRepo, ok := graphRepo.(cognitive.IncrementalGraphRepo); ok && owner != "" && repo != "" && sha != "" {
			if merged, err := incRepo.MergeFileSymbols(ctx, owner, repo, sha, newFileSymbols); err == nil && merged != nil && graphDir != "" {
				_, _ = cognitive.SaveSemanticGraphArtifact(graphDir, owner, repo, sha, merged)
			}
		}
	}
	return idx
}

// buildGroundingIndex 全仓语义图谱优先构建校验索引（消除"路径存在于仓库
// 他处却被章节域索引误判幻觉"，并启用符号级校验）；图谱缺失/损坏时
// fail-open 降级为章节文件域（对齐 cognitive-driver 404 fail-open 先例），
// 保证无图谱仓库的转录能力不回退（红线一：能力不倒退）。
func buildGroundingIndex(graphDir, owner, repo, sha string, chapterFilePaths []string) cognitive.GroundingIndex {
	if graphDir == "" || owner == "" || repo == "" || sha == "" {
		return cognitive.GroundingIndex{Paths: append([]string(nil), chapterFilePaths...)}
	}
	// v3 分段产物优先走惰性加载（paths + 逐文件符号点查，免去全量
	// 反序列化巨仓 symbolsData）；老 v2 产物回退全量加载——语义等价。
	if lz, lerr := cognitive.OpenSemanticGraphArtifactLazy(graphDir, owner, repo, sha); lerr == nil {
		defer lz.Close()
		if idx, ierr := groundingIndexFromLazy(lz, chapterFilePaths); ierr == nil {
			return idx
		}
	}
	artifact, err := cognitive.LoadSemanticGraphArtifact(graphDir, owner, repo, sha)
	if err != nil || artifact == nil {
		log.Printf("[grounding] semantic graph artifact unavailable for %s/%s@%s, fail-open to chapter file scope: %v", owner, repo, sha, err)
		return cognitive.GroundingIndex{Paths: append([]string(nil), chapterFilePaths...)}
	}
	paths := make([]string, 0, len(artifact.Nodes)+len(chapterFilePaths))
	seen := make(map[string]bool, len(artifact.Nodes)+len(chapterFilePaths))
	for _, node := range artifact.Nodes {
		if node.Path != "" && !seen[node.Path] {
			seen[node.Path] = true
			paths = append(paths, node.Path)
		}
	}
	// 章节域文件恒入索引（归档按 branch 回退等场景下快照文件依然真实）
	for _, p := range chapterFilePaths {
		if p != "" && !seen[p] {
			seen[p] = true
			paths = append(paths, p)
		}
	}
	return cognitive.GroundingIndex{Paths: paths, SymbolsByFile: artifact.SymbolsByFile}
}

// groundingIndexFromLazy 惰性构建（nodes 段取 paths；符号按需逐文件
// 解码进 SymbolsByFile——与全量路径产出的索引逐字段一致）。
func groundingIndexFromLazy(lz *cognitive.LazyArtifact, chapterFilePaths []string) (cognitive.GroundingIndex, error) {
	nodes, err := lz.Nodes()
	if err != nil {
		return cognitive.GroundingIndex{}, err
	}
	paths := make([]string, 0, len(nodes)+len(chapterFilePaths))
	seen := make(map[string]bool, len(nodes)+len(chapterFilePaths))
	for _, node := range nodes {
		if node.Path != "" && !seen[node.Path] {
			seen[node.Path] = true
			paths = append(paths, node.Path)
		}
	}
	for _, p := range chapterFilePaths {
		if p != "" && !seen[p] {
			seen[p] = true
			paths = append(paths, p)
		}
	}
	symbolsByFile := make(map[string][]cognitive.SymbolEntry, len(seen))
	for _, f := range lz.Files() {
		entries, serr := lz.SymbolsForFile(f)
		if serr != nil {
			return cognitive.GroundingIndex{}, serr
		}
		symbolsByFile[f] = entries
	}
	return cognitive.GroundingIndex{Paths: paths, SymbolsByFile: symbolsByFile}, nil
}

// resolvedFenceSymbolRe 已解析围栏符号头（Stage 2 ResolveFileHandles 产物
// 形态：```lang // path#Symbol）。1D 行锚定、系统规范形，正则安全区；
// 行号区间头 (Lx-Ly) 无符号名，不匹配、仅参与路径级校验。
var resolvedFenceSymbolRe = regexp.MustCompile("(?m)^(?:`{3,}|~{3,})[a-zA-Z0-9_-]*[ \\t]*(?://|#|--)[ \\t]*([^\\s#]+)#([a-zA-Z0-9_$]+)[ \\t]*$")

// extractSymbolClaims 从终稿已解析围栏头提取符号声明（File 为物理全路径）。
// 符号名对 AST SymbolsByFile 的精确匹配是反捏造主载荷；行号区间为次级
// 校验（armor 水合回写区间后自然通过，不产生误杀）。
func extractSymbolClaims(mdxContent string) []cognitive.SymbolClaim {
	claims := make([]cognitive.SymbolClaim, 0)
	seen := make(map[string]bool)
	for _, m := range resolvedFenceSymbolRe.FindAllStringSubmatch(mdxContent, -1) {
		path, symbol := m[1], m[2]
		if path == "" || symbol == "" {
			continue
		}
		key := path + "#" + symbol
		if seen[key] {
			continue
		}
		seen[key] = true
		claims = append(claims, cognitive.SymbolClaim{File: path, Symbol: symbol})
	}
	return claims
}

// verifyGrounding 单次物理事实校验（纯函数组合，零 IO）。
func verifyGrounding(mdxContent string, index cognitive.GroundingIndex) cognitive.GroundingReport {
	claimedFiles := cognitive.ExtractClaimedPathsFromMdx(mdxContent)
	symbolClaims := extractSymbolClaims(mdxContent)
	return cognitive.VerifyFactGrounding(claimedFiles, symbolClaims, index)
}

// groundingGateParams 门禁执行参数。
type groundingGateParams struct {
	Ctx              context.Context
	Llm              LlmGatewayAPI
	RewriteCtx       context.Context // 重写遍调用上下文（进度映射区间独立）
	Uid              *string
	Vars             map[string]any // 门禁在重写前回填 vars["groundingFeedback"]
	Pipeline         *MdxConvergencePipeline
	Index            cognitive.GroundingIndex
	DocPath          string
	ChapterFilePaths []string
	FirstPass        MdxConvergenceResult
	FirstCallID      string
	SnappedSlots     *int // codeResolver 闭包计数（区间吸附代理指标，两遍累计）
	OnRewrite        func()
}

// formatGroundingFeedbackWithIndex 在标准《事实差异清单》基础上，为被拒收的符号补充该文件
// 在 Tree-sitter AST 中实际声明的合法符号清单（或行号区间指引），消除 L2 定向重写时的盲猜。
func formatGroundingFeedbackWithIndex(report cognitive.GroundingReport, index cognitive.GroundingIndex) *string {
	base := cognitive.FormatGroundingFeedback(report)
	if base == nil || len(report.HallucinatedSymbols) == 0 {
		return base
	}
	var extra []string
	seenFiles := make(map[string]bool, len(report.HallucinatedSymbols))
	for _, h := range report.HallucinatedSymbols {
		cleanFile, _ := mdpat.SplitPathAnchor(h.File)
		if cleanFile == "" {
			cleanFile = h.File
		}
		if cleanFile == "" || seenFiles[cleanFile] {
			continue
		}
		seenFiles[cleanFile] = true
		var entries []cognitive.SymbolEntry
		if index.SymbolsByFile != nil {
			entries = index.SymbolsByFile[cleanFile]
		}
		if len(entries) == 0 {
			extra = append(extra, fmt.Sprintf("- No AST symbols are indexed for '%s'; use a line range anchor (#Lx-Ly) instead of #Symbol.", cleanFile))
			continue
		}
		names := make([]string, 0, min(len(entries), 15))
		seenSym := make(map[string]bool, len(entries))
		for _, e := range entries {
			if e.Name == "" || seenSym[e.Name] {
				continue
			}
			seenSym[e.Name] = true
			names = append(names, e.Name)
			if len(names) >= 15 {
				break
			}
		}
		if len(names) > 0 {
			extra = append(extra, fmt.Sprintf("- Declared AST symbols in '%s' (or use #Lx-Ly): %s", cleanFile, strings.Join(names, ", ")))
		}
	}
	if len(extra) == 0 {
		return base
	}
	combined := *base + "\n" + strings.Join(extra, "\n")
	return &combined
}

// runGroundingGate 驱动 L1/L2/L3 分级闭环，返回终稿收敛结果与对账记录。
// L3 拒收或重写遍传输失败时返回 error，由调用方按既有错误分类处置
// （isBudgetErr → BodyDeferred，其余 → BodyFailed）。
func runGroundingGate(p groundingGateParams) (MdxConvergenceResult, GroundingLedger, error) {
	report := verifyGrounding(p.FirstPass.FinalContent, p.Index)
	if !groundingHasHallucination(report) {
		return p.FirstPass, buildGroundingLedger(p, report, GroundingPassed, "", 0), nil
	}

	// L2：事实差异清单回填 + 严格单次定向重写 + 同一收敛漏斗复审
	feedback := formatGroundingFeedbackWithIndex(report, p.Index)
	if feedback == nil {
		// 防御：存在幻觉时 FormatGroundingFeedback 恒非 nil，此处不可达兜底
		return p.FirstPass, buildGroundingLedger(p, report, GroundingPassed, "", 0), nil
	}
	log.Printf("[grounding] rewrite triggered for %s: %d hallucinated files, %d hallucinated symbols",
		p.DocPath, len(report.HallucinatedFiles), len(report.HallucinatedSymbols))
	if p.OnRewrite != nil {
		p.OnRewrite()
	}
	// 浅拷贝构造重写遍变量：首遍调用历史不被回溯污染，差异仅在反馈段
	rewriteVars := make(map[string]any, len(p.Vars)+1)
	for k, v := range p.Vars {
		rewriteVars[k] = v
	}
	rewriteVars["groundingFeedback"] = *feedback
	rewriteRes, err := withLlmRetry(p.Ctx, func() (LlmTextResult, error) {
		return p.Llm.Complete(p.RewriteCtx, "code_chapter_lesson", rewriteVars, p.Uid)
	})
	if err != nil {
		// 传输失败非捏造：上抛调用方按既有错误分类处置，不产出对账行
		return MdxConvergenceResult{}, GroundingLedger{}, err
	}

	rewriteTruncated := rewriteRes.FinishReason == "length"
	rewriteConv := p.Pipeline.Execute(p.Ctx, rewriteRes.Text, p.Uid, rewriteTruncated)
	rewriteReport := verifyGrounding(rewriteConv.FinalContent, p.Index)
	if !groundingHasHallucination(rewriteReport) {
		return rewriteConv, buildGroundingLedger(p, rewriteReport, GroundingRewritten, rewriteRes.CallID, 1), nil
	}

	// L3：重写后仍脱节 → Fail-Closed 拒收，绝不带毒发布
	return rewriteConv, buildGroundingLedger(p, rewriteReport, GroundingRejected, rewriteRes.CallID, 1),
		&GroundingRejectError{
			DocPath:             p.DocPath,
			HallucinatedFiles:   append([]string(nil), rewriteReport.HallucinatedFiles...),
			HallucinatedSymbols: append([]cognitive.SymbolClaim(nil), rewriteReport.HallucinatedSymbols...),
		}
}

func buildGroundingLedger(p groundingGateParams, report cognitive.GroundingReport, outcome GroundingGateOutcome, rewriteCallID string, retries int) GroundingLedger {
	fuzzy := 0
	for _, w := range report.Warnings {
		if strings.HasPrefix(w, "Fuzzy-aligned") {
			fuzzy++
		}
	}
	snapped := 0
	if p.SnappedSlots != nil {
		snapped = *p.SnappedSlots
	}
	return GroundingLedger{
		DocPath:       p.DocPath,
		CallID:        p.FirstCallID,
		RewriteCallID: rewriteCallID,
		Outcome:       outcome,
		AnchorsIn:     len(report.GroundedFiles) + len(report.HallucinatedFiles) + len(report.GroundedSymbols) + len(report.HallucinatedSymbols),
		Grounded:      len(report.GroundedFiles) + len(report.GroundedSymbols),
		Disambiguated: len(report.AmbiguousAlignments) + fuzzy,
		Snapped:       snapped,
		Invalid:       len(report.HallucinatedFiles) + len(report.HallucinatedSymbols),
		Retries:       retries,
		Report:        report,
	}
}

// intersectChapterSourceFiles 终判 grounded 路径与本章文件域求交集，保持
// SourceFiles 章节域语义不因全仓索引扩大而泄漏；空集保底真实清单
// （对齐既有 Tier-4 全幻觉保底行为）。
func intersectChapterSourceFiles(report cognitive.GroundingReport, chapterFilePaths []string) []string {
	if len(report.GroundedFiles) == 0 {
		return chapterFilePaths
	}
	scope := make(map[string]bool, len(chapterFilePaths))
	for _, p := range chapterFilePaths {
		scope[p] = true
	}
	out := make([]string, 0, len(chapterFilePaths))
	seen := make(map[string]bool, len(report.GroundedFiles))
	for _, p := range report.GroundedFiles {
		base, _ := mdpat.SplitPathAnchor(p)
		if base != "" && scope[base] && !seen[base] {
			seen[base] = true
			out = append(out, base)
		}
	}
	if len(out) == 0 {
		return chapterFilePaths
	}
	return out
}
