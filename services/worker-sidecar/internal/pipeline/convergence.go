package pipeline

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/mdx"
	"github.com/opengits/worker-sidecar/internal/platform/client"
)

const (
	sentinelBegin = "===CONTENT_BEGIN==="
	sentinelEnd   = "===CONTENT_END==="
)

var fenceOpenLangRe = mdpat.FenceOpenLangRe
var fenceCloseRe = mdpat.FenceCloseBareRe

// ExtractBySentinel 哨兵抽取（内部统一委托 StripPayloadShell 确定性剥壳器）。
func ExtractBySentinel(text string) string {
	res, _ := StripPayloadShell(text)
	return res
}

func extractBySentinel(text string) string {
	return ExtractBySentinel(text)
}

// LlmTextResult text purpose 的补全结果（对齐 client.LlmTextResult）。
type LlmTextResult = client.LlmTextResult

// LlmCompleter LLM 完成接口（对齐 client.LlmCompleter）。
type LlmCompleter = client.LlmCompleter

// ConceptManifest 别名对齐 concept.ExtractedManifestResult，保持单一事实源与类型契约。
type ConceptManifest = concept.ExtractedManifestResult

// ExtractConceptManifest 提取伴生元数据清单。
func ExtractConceptManifest(rawContent string, docPath string) ConceptManifest {
	return concept.ExtractConceptManifest(rawContent, docPath)
}

// MdxConvergencePipeline MDX 文本装甲收敛漏斗：
// 串联解包 ➔ 句柄还原 ➔ 语法消毒 ➔ 元数据剥离 ➔ AST 校验 ➔ 自愈修复 ➔ 确定性保底。
type MdxConvergencePipeline struct {
	LlmClient            LlmCompleter // 可为 nil（纯确定性离线模式）
	RepairPurpose        string       // 缺省 "mdx_repair"
	DocPath              string
	Refs                 []armor.ArmorFileRef
	FallbackBuilder      func() string               // 确定性保底生成器
	Validator            func(string) (bool, string) // 可为 nil（缺省 mdx.ValidateDetailed）
	ArchitectureSkeleton string                      // 确定性物理拓扑骨架保底（若 LLM 遗漏或损坏 Mermaid 时自动补入）
	CodeResolver         armor.CodeSlotResolver      // 物理源码切片插槽与隐式吸附解析器（V2 认知阶梯闭环）
	IsFinalChapter       bool                        // 是否为教程终章（用于修剪末尾的下一课时虚构预告）
}

// MdxConvergenceResult MDX 收敛漏斗执行结果。
type MdxConvergenceResult struct {
	FinalContent    string
	CleanMdx        string
	Manifest        *ConceptManifest
	WasRepaired     bool
	WasFallbackUsed bool
	OriginalLength  int
	FinalLength     int
	ValidationError string
}

type stageProcessResult struct {
	raw          string
	resolved     string
	manifest     ConceptManifest
	cleanMdx     string
	finalContent string
	valid        bool
	verr         string
}

// processStages1to5 统一运行 Stage 1~5（解包 ➔ 插槽吸附 ➔ 句柄还原 ➔ 语法消毒 ➔ 架构图保底 ➔ 元数据剥离 ➔ AST校验）。
// 确保初次生成与 repair 自愈修复产物通过完全一致的装甲与校验闸门，杜绝逻辑漂移与单点疏漏。
func (p *MdxConvergencePipeline) processStages1to5(ctx context.Context, draft string, uid *string, isTruncated bool) stageProcessResult {
	validateFn := p.Validator
	if validateFn == nil {
		validateFn = mdx.ValidateDetailed
	}

	// Stage 0 [空正文短路]：骨架保底（Stage 3.5）的职责是"给缺图的正文补图"，
	// 不是"给没有正文的输出造身"。空 LLM 补全若放行到 Stage 3.5，会被注入
	// 确定性骨架洗白成"仅骨架的合法 MDX"（112 字空壳案例）——携带骨架的
	// 管线必须在救援之前显式判无效；无骨架管线维持历史行为（Stage 5 的
	// "empty mdx content" 契约串与 🧪 冻结测试向量不 alter）
	if strings.TrimSpace(draft) == "" && strings.TrimSpace(p.ArchitectureSkeleton) != "" {
		verr := "empty llm completion (skeleton rescue suppressed)"
		if isTruncated {
			verr = "output truncated by token limit with empty completion"
		}
		return stageProcessResult{valid: false, verr: verr}
	}

	// Stage 1 [确定性解包与剥壳]: StripPayloadShell(draft)
	raw, strippedShell := StripPayloadShell(draft)
	if strippedShell != "" {
		log.Printf("[convergence-pipeline] Stripped payload shell '%s' for %s", strippedShell, p.DocPath)
	}

	// Stage 1.1 [未解包 JSON 外壳拦截 - 失效封闭公理 (Fail-Closed over Pseudo-Resilience)]:
	// 若经 StripPayloadShell 剥离后，正文依然残留未解包的 JSON 容器，说明 LLM 输出了非法的 JSON 包装且剥壳失败。
	// 严禁作为合法 MDX 静默放行，必须立即判无效并拦截，迫使管线进入自愈修复或确定性保底。
	if HasUnpeeledJSONShell(raw) {
		return stageProcessResult{
			raw:   raw,
			valid: false,
			verr:  "unpeeled JSON payload shell detected: output contains unparsed JSON container instead of markdown",
		}
	}

	// Stage 1.5 [AST 插槽水合与隐式智能吸附 (V2)]: HydrateCodeSlotsAndSnap
	if p.CodeResolver != nil && len(p.Refs) > 0 {
		raw = armor.HydrateCodeSlotsAndSnap(raw, p.Refs, p.CodeResolver)
	}

	// Stage 2 [句柄还原]: ResolveFileHandles(raw, p.Refs)
	resolved := armor.ResolveFileHandles(raw, p.Refs)

	// Stage 3 [编译前语法消毒]: SanitizeMdxForCompilation(resolved)
	sanitized := armor.SanitizeMdxForCompilation(resolved)

	// Stage 3.2 [终章结语闭环确定性装甲]: 终章修剪末尾下一课时/下一章预告等幻觉过渡句
	if p.IsFinalChapter {
		sanitized = armor.PruneTerminalCliffhanger(sanitized)
	}

	// Stage 3.5 [Mermaid 拓扑健全性检测与解耦自愈体系]
	sanitized = p.HealMdxMermaidBlocks(ctx, sanitized, uid)

	// Stage 3.8 [Layer 1 确定性围栏配平]: 防御代码截断或遗漏反引号
	sanitized = BalanceCodeFences(sanitized)

	// Stage 4 [元数据剥离]: ExtractConceptManifest(sanitized, p.DocPath)
	manifest := ExtractConceptManifest(sanitized, p.DocPath)
	// SanitizeMdxForCompilation 会剔除 XML 块，若原 resolved 带有 companion manifest 则逐项回补
	rawManifest := ExtractConceptManifest(resolved, p.DocPath)
	if len(manifest.Concepts) == 0 && len(rawManifest.Concepts) > 0 {
		manifest.Concepts = rawManifest.Concepts
	}
	if len(manifest.Quizzes) == 0 && len(rawManifest.Quizzes) > 0 {
		manifest.Quizzes = rawManifest.Quizzes
	}
	if len(manifest.Takeaways) == 0 && len(rawManifest.Takeaways) > 0 {
		manifest.Takeaways = rawManifest.Takeaways
	}
	if manifest.Summary == "" && rawManifest.Summary != "" {
		manifest.Summary = rawManifest.Summary
	}

	cleanMdx := sanitized
	finalContent := sanitized
	if manifest.HasFrontmatter && manifest.CleanMdx != "" {
		cleanMdx = manifest.CleanMdx
	} else if manifest.CleanContent != "" {
		cleanMdx = manifest.CleanContent
		finalContent = manifest.CleanContent
	}
	if strings.TrimSpace(cleanMdx) == "" && strings.TrimSpace(sanitized) != "" {
		cleanMdx = sanitized
	}

	// Stage 5 [预编译 AST 校验]: mdx.ValidateDetailed(cleanMdx)
	var valid bool
	var verr string
	if strings.TrimSpace(cleanMdx) == "" {
		valid = false
		verr = "empty mdx content"
	} else if isTruncated {
		valid = false
		verr = "output truncated by token limit"
	} else if HasUnpeeledJSONShell(cleanMdx) {
		valid = false
		verr = "unpeeled JSON payload shell detected: output contains unparsed JSON container instead of markdown"
	} else {
		valid, verr = validateFn(cleanMdx)
		// Layer 1 确定性容器补全：若报错为已知富组件容器未闭合，尝试原地自动闭合（0ms 纯内存免除 LLM 慢调用）
		if !valid && strings.Contains(verr, "Expected a closing tag for") {
			if healedMdx, ok := TryAutoCloseTags(cleanMdx, verr, validateFn); ok {
				log.Printf("[convergence-pipeline] Auto-closed unclosed container tag for %s", p.DocPath)
				diff := healedMdx[len(cleanMdx):]
				cleanMdx = healedMdx
				sanitized = sanitized + diff
				finalContent = finalContent + diff
				valid = true
				verr = ""
			}
		}
	}

	return stageProcessResult{
		raw:          raw,
		resolved:     resolved,
		manifest:     manifest,
		cleanMdx:     cleanMdx,
		finalContent: finalContent,
		valid:        valid,
		verr:         verr,
	}
}

// trySurgicalLinePatch 靶向局部外科手术切片微创修复（Layer 2）：
// 基于精准物理行号，仅提取报错行上下 ±15 行切片，调度模型仅修复该切片后就地拼接回原文（提速 100 倍）。
func (p *MdxConvergencePipeline) trySurgicalLinePatch(
	ctx context.Context,
	fullContent string,
	errLine int,
	errMsg string,
	repairPurpose string,
	uid *string,
) (string, bool) {
	lines := strings.Split(fullContent, "\n")
	totalLines := len(lines)
	if errLine < 1 || errLine > totalLines {
		return "", false
	}

	windowSize := 15
	startLine := errLine - windowSize
	if startLine < 1 {
		startLine = 1
	}
	endLine := errLine + windowSize
	if endLine > totalLines {
		endLine = totalLines
	}

	snippetLines := lines[startLine-1 : endLine]
	snippet := strings.Join(snippetLines, "\n")

	log.Printf("[convergence-pipeline] Performing surgical line-window patch for %s around line %d (lines %d-%d)", p.DocPath, errLine, startLine, endLine)

	repairVars := map[string]any{
		"compileError": fmt.Sprintf("Syntax error around line %d: %s. (Note: Repair ONLY the syntax inside this snippet; return ONLY the repaired snippet between ===CONTENT_BEGIN=== and ===CONTENT_END=== without modifying explanations or code outside the syntax bug.)", errLine, errMsg),
		"mdxSource":    snippet,
	}

	repairCtx, repairCancel := context.WithTimeout(ctx, 20*time.Second)
	repRes, repErr := p.LlmClient.Complete(repairCtx, repairPurpose, repairVars, uid)
	repairCancel()

	if repErr != nil || repRes.FinishReason == "length" || strings.TrimSpace(repRes.Text) == "" {
		return "", false
	}

	// 剥离修复片段可能的围栏或哨兵
	repairedSnippet, _ := StripPayloadShell(repRes.Text)
	if strings.TrimSpace(repairedSnippet) == "" {
		return "", false
	}

	// 就地拼接缝合回原长文
	repairedSliceLines := strings.Split(repairedSnippet, "\n")
	newLines := make([]string, 0, (startLine-1)+len(repairedSliceLines)+(totalLines-endLine))
	newLines = append(newLines, lines[:startLine-1]...)
	newLines = append(newLines, repairedSliceLines...)
	newLines = append(newLines, lines[endLine:]...)

	return strings.Join(newLines, "\n"), true
}

// Execute 驱动 MDX 文本装甲收敛漏斗完整 Stage 1~7 流水线。
func (p *MdxConvergencePipeline) Execute(ctx context.Context, rawDraft string, uid *string, isTokenTruncated ...bool) MdxConvergenceResult {
	if ctx == nil {
		ctx = context.Background()
	}
	truncated := len(isTokenTruncated) > 0 && isTokenTruncated[0]
	r := p.processStages1to5(ctx, rawDraft, uid, truncated)

	if r.valid {
		return MdxConvergenceResult{
			FinalContent:    r.finalContent,
			CleanMdx:        r.cleanMdx,
			Manifest:        &r.manifest,
			WasRepaired:     false,
			WasFallbackUsed: false,
			OriginalLength:  len(rawDraft),
			FinalLength:     len(r.finalContent),
			ValidationError: "",
		}
	}

	firstError := r.verr

	// Stage 6 [自愈修复]: 若校验失败且 p.LlmClient != nil，且具备待修复实体内容
	if p.LlmClient != nil && strings.TrimSpace(r.finalContent) != "" {
		repairPurpose := p.RepairPurpose
		if repairPurpose == "" {
			repairPurpose = "mdx_repair"
		}

		// Layer 2 [靶向局部外科手术 - Line-Window Patching]:
		// 若能提取出精确物理行号，仅切片上下 ±15 行发送定点修复，就地拼接缝合（提速 100 倍）
		errLine := ExtractErrorLine(r.verr, r.finalContent)
		if errLine > 0 {
			if patchedContent, ok := p.trySurgicalLinePatch(ctx, r.finalContent, errLine, r.verr, repairPurpose, uid); ok {
				repR := p.processStages1to5(ctx, patchedContent, uid, false)
				if repR.valid {
					log.Printf("[convergence-pipeline] Surgical line-window repair SUCCEEDED for %s at line %d", p.DocPath, errLine)
					return MdxConvergenceResult{
						FinalContent:    repR.finalContent,
						CleanMdx:        repR.cleanMdx,
						Manifest:        &repR.manifest,
						WasRepaired:     true,
						WasFallbackUsed: false,
						OriginalLength:  len(rawDraft),
						FinalLength:     len(repR.finalContent),
						ValidationError: "",
					}
				}
				log.Printf("[convergence-pipeline] Surgical repair candidate invalid for %s: %s", p.DocPath, repR.verr)
			}
		} else {
			// 全文定点修复（当无法定位物理行号时）
			log.Printf("[convergence-pipeline] MDX validation failed for %s (%s), attempting targeted full repair with %s", p.DocPath, r.verr, repairPurpose)
			repairVars := map[string]any{
				"compileError": r.verr,
				"mdxSource":    r.finalContent,
			}
			repairCtx, repairCancel := context.WithTimeout(ctx, 45*time.Second)
			repRes, repErr := p.LlmClient.Complete(repairCtx, repairPurpose, repairVars, uid)
			repairCancel()
			if repErr == nil && repRes.FinishReason != "length" {
				// 对 repair 产物严格重新跑完整 Stage 1~5 装甲与校验
				repR := p.processStages1to5(ctx, repRes.Text, uid, false)
				if repR.valid {
					return MdxConvergenceResult{
						FinalContent:    repR.finalContent,
						CleanMdx:        repR.cleanMdx,
						Manifest:        &repR.manifest,
						WasRepaired:     true,
						WasFallbackUsed: false,
						OriginalLength:  len(rawDraft),
						FinalLength:     len(repR.finalContent),
						ValidationError: "",
					}
				}
				log.Printf("[convergence-pipeline] MDX full repair produced invalid syntax for %s: %s", p.DocPath, repR.verr)
			} else {
				log.Printf("[convergence-pipeline] MDX full repair invocation failed or truncated for %s: err=%v, finishReason=%s", p.DocPath, repErr, repRes.FinishReason)
			}
		}
	}

	// Stage 7 [确定性保底]: 严格受限保底（杜绝虚假模板骨架注水，红线 2 效果不劣化）
	if p.FallbackBuilder != nil {
		fallbackContent := strings.TrimSpace(p.FallbackBuilder())
		if fallbackContent != "" {
			log.Printf("[convergence-pipeline] Falling back to deterministic builder for %s", p.DocPath)
			fbManifest := ExtractConceptManifest(fallbackContent, p.DocPath)
			fbClean := fallbackContent
			if fbManifest.HasFrontmatter && fbManifest.CleanMdx != "" {
				fbClean = fbManifest.CleanMdx
			} else if fbManifest.CleanContent != "" {
				fbClean = fbManifest.CleanContent
			}
			return MdxConvergenceResult{
				FinalContent:    fallbackContent,
				CleanMdx:        fbClean,
				Manifest:        &fbManifest,
				WasRepaired:     false,
				WasFallbackUsed: true,
				OriginalLength:  len(rawDraft),
				FinalLength:     len(fallbackContent),
				ValidationError: firstError,
			}
		}
	}

	return MdxConvergenceResult{
		FinalContent:    r.finalContent,
		CleanMdx:        r.cleanMdx,
		Manifest:        &r.manifest,
		WasRepaired:     false,
		WasFallbackUsed: false,
		OriginalLength:  len(rawDraft),
		FinalLength:     len(r.finalContent),
		ValidationError: firstError,
	}
}

// ─────────────────────────────────────────────────────────────
// 结构化物理事实核验漏斗（原 internal/giant 收编:giant 包随巨型泳道
// 退役,本漏斗是转录收敛管线的活体组件）。
// ─────────────────────────────────────────────────────────────

// KeyDataStructure 关键数据结构与系统类型。
type KeyDataStructure struct {
	Name        string `json:"name"`
	Subsystem   string `json:"subsystem"`
	Description string `json:"description"`
	FilePath    string `json:"filePath"`
}

// GroundingAudit 结构化物理事实核验审计报告。
type GroundingAudit struct {
	TotalProposed     int  `json:"totalProposed"`
	KeptCount         int  `json:"keptCount"`
	DiscardedCount    int  `json:"discardedCount"`
	FallbackTriggered bool `json:"fallbackTriggered"`
}

// normalizeOverviewPath 归一化 LLM 输出的文件路径（反斜杠/前导 ./），供树成员核验。
func normalizeOverviewPath(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimPrefix(p, "./")
	return strings.TrimPrefix(p, "/")
}

// GroundKeyDataStructures 校验每个 FilePath 是否存在于真实归档树；
// 过滤幻觉条目；全空时触发 fallback()，输出审计报告。
func GroundKeyDataStructures(raw []KeyDataStructure, filePathInTree func(string) bool, fallback func() []KeyDataStructure) ([]KeyDataStructure, GroundingAudit) {
	audit := GroundingAudit{TotalProposed: len(raw)}
	if filePathInTree == nil {
		audit.KeptCount = len(raw)
		return raw, audit
	}

	verified := make([]KeyDataStructure, 0, len(raw))
	for _, ds := range raw {
		if strings.TrimSpace(ds.FilePath) == "" || filePathInTree(normalizeOverviewPath(ds.FilePath)) {
			verified = append(verified, ds)
		} else {
			audit.DiscardedCount++
		}
	}
	audit.KeptCount = len(verified)

	if len(verified) == 0 && len(raw) > 0 {
		audit.FallbackTriggered = true
		if fallback != nil {
			fb := fallback()
			return fb, audit
		}
	}
	return verified, audit
}

// ─────────────────────────────────────────────────────────────
// Mermaid 拓扑健全性检测与解耦自愈体系 (Stage 3.5)
// ─────────────────────────────────────────────────────────────

// HealMdxMermaidBlocks 对 MDX 文档内的所有 Mermaid 代码块执行第一性原理自愈与主题解耦修复：
// 1. Layer 1: 内存 0ms 纯状态机急救（标签双引号加固、自动补齐 flowchart LR、配平 subgraph 与围栏）；
// 2. Layer 2: 解耦微创 Mermaid Doctor（若 Layer 1 无法恢复且提供 LlmClient，仅传入这几行残破代码由极速微模型修复并就地缝合）；
// 3. Layer 3: 零注水原则（彻底废除死板假骨架替换；若无法自愈且无真实物理骨架，干净移除损坏代码块，保留整洁文本）。
func (p *MdxConvergencePipeline) HealMdxMermaidBlocks(ctx context.Context, content string, uid *string) string {
	if strings.TrimSpace(content) == "" {
		return content
	}

	lines := strings.Split(content, "\n")
	type blockPos struct {
		startLine int
		endLine   int
		rawCode   string
	}

	var blocks []blockPos
	inMermaid := false
	blockStart := -1
	var blockLines []string

	for i, line := range lines {
		if !inMermaid {
			if mdpat.MermaidFenceOpenRe.MatchString(line) {
				inMermaid = true
				blockStart = i
				blockLines = nil
			}
		} else {
			if mdpat.FenceCloseRe.MatchString(line) {
				blocks = append(blocks, blockPos{
					startLine: blockStart,
					endLine:   i,
					rawCode:   strings.Join(blockLines, "\n"),
				})
				inMermaid = false
			} else {
				blockLines = append(blockLines, line)
			}
		}
	}

	if inMermaid {
		blocks = append(blocks, blockPos{
			startLine: blockStart,
			endLine:   len(lines) - 1,
			rawCode:   strings.Join(blockLines, "\n"),
		})
	}

	if len(blocks) == 0 {
		// 若完全无图表，且提供了非 dummy 的真实 AST 骨架，注入导言后
		if strings.TrimSpace(p.ArchitectureSkeleton) != "" && !isDummySkeleton(p.ArchitectureSkeleton) {
			return injectMermaidSkeleton(lines, strings.TrimSpace(p.ArchitectureSkeleton))
		}
		return content
	}

	for bIdx := len(blocks) - 1; bIdx >= 0; bIdx-- {
		b := blocks[bIdx]
		// Layer 1: 内存 0ms 纯状态机急救
		healed, ok := HealMermaidSyntax(b.rawCode)
		if ok {
			var replacement []string
			replacement = append(replacement, "```mermaid")
			replacement = append(replacement, strings.Split(healed, "\n")...)
			replacement = append(replacement, "```")

			var newLines []string
			newLines = append(newLines, lines[:b.startLine]...)
			newLines = append(newLines, replacement...)
			newLines = append(newLines, lines[b.endLine+1:]...)
			lines = newLines
			continue
		}

		// Layer 2: 与主题解耦的极速 Mermaid Doctor (~100 Token / 300ms)
		if p.LlmClient != nil && ctx != nil {
			doctorRepaired, err := RepairMermaidWithLlm(ctx, p.LlmClient, b.rawCode, uid)
			if err == nil && doctorRepaired != "" {
				var replacement []string
				replacement = append(replacement, "```mermaid")
				replacement = append(replacement, strings.Split(doctorRepaired, "\n")...)
				replacement = append(replacement, "```")

				var newLines []string
				newLines = append(newLines, lines[:b.startLine]...)
				newLines = append(newLines, replacement...)
				newLines = append(newLines, lines[b.endLine+1:]...)
				lines = newLines
				continue
			}
		}

		// Layer 3: 失效封闭与零注水
		if strings.TrimSpace(p.ArchitectureSkeleton) != "" && !isDummySkeleton(p.ArchitectureSkeleton) {
			cleanSkel := strings.TrimSpace(p.ArchitectureSkeleton)
			var newLines []string
			newLines = append(newLines, lines[:b.startLine]...)
			newLines = append(newLines, cleanSkel)
			newLines = append(newLines, lines[b.endLine+1:]...)
			lines = newLines
			continue
		}

		// 彻底无法自愈且无真实物理骨架：干净丢弃破损图块，保留优质正文，绝不插入死板假方框
		var newLines []string
		newLines = append(newLines, lines[:b.startLine]...)
		newLines = append(newLines, lines[b.endLine+1:]...)
		lines = newLines
	}

	return strings.Join(lines, "\n")
}

// EnsureMermaidArchitecture 确保文档包含合法 Mermaid 架构图；若缺失或破损且提供了骨架，则自动注入/替换为确定性骨架。
func EnsureMermaidArchitecture(content string, skeleton string) string {
	return EnsureGroundedMermaidArchitecture(content, skeleton, nil)
}

// EnsureGroundedMermaidArchitecture 确保文档内的 Mermaid 图表语法健全并放行高价值业务/架构拓扑：
// 1. 先经 Layer 1 内存 0ms 状态机自愈（加固双引号、全角规整、配平 subgraph 与围栏）；
// 2. 具备连通拓扑（节点 >= 2 且有边）或自然语言概念图，100% 尊重并保留 AI 教学拓扑（认知 2: 语法 ≠ 意图）；
// 3. 仅当图表彻底无法解析或为空，且提供了非 dummy 的真实 AST 骨架时，才以骨架对齐；
// 4. 若无真实骨架且图表破损无法自愈，干净剥离残片（Layer 3: 零注水）。
func EnsureGroundedMermaidArchitecture(content string, skeleton string, verifiedSymbols []string) string {
	pipeline := MdxConvergencePipeline{
		ArchitectureSkeleton: skeleton,
	}
	return pipeline.HealMdxMermaidBlocks(context.Background(), content, nil)
}

// isDummySkeleton 判定骨架是否仅由占位容器或 Core 单节点构成（无真实函数 AST 实体）。
func isDummySkeleton(skeleton string) bool {
	clean := strings.TrimSpace(skeleton)
	if clean == "" {
		return true
	}
	symbols := extractSkeletonSymbols(clean)
	return len(symbols) == 0
}

var skeletonLabelRe = mdpat.SkeletonLabelRe

func extractSkeletonSymbols(skeleton string) []string {
	lines := strings.Split(skeleton, "\n")
	var symbols []string
	seen := make(map[string]bool)

	for _, line := range lines {
		trim := strings.TrimSpace(line)
		// 容器边界与兜底单节点不属于代码 AST 实体，坚决不计入 verifiedSymbols
		if strings.HasPrefix(trim, "subgraph ") {
			continue
		}
		if strings.HasSuffix(trim, ` Core"]`) || strings.HasSuffix(trim, ` Core"])`) {
			continue
		}

		matches := skeletonLabelRe.FindAllStringSubmatch(trim, -1)
		for _, m := range matches {
			raw := m[1]
			if raw == "" {
				raw = m[2]
			}
			raw = strings.TrimSpace(raw)
			if idx := strings.Index(raw, "<br/>"); idx >= 0 {
				raw = raw[:idx]
			}
			raw = strings.TrimSuffix(raw, "()")
			if idx := strings.Index(raw, " ("); idx >= 0 {
				raw = raw[:idx]
			}
			raw = strings.TrimPrefix(raw, "Prerequisite: ")
			raw = strings.TrimPrefix(raw, "Dependent: ")
			clean := strings.TrimSpace(raw)
			lower := strings.ToLower(clean)
			if len(clean) >= 2 && !seen[lower] && lower != "flowchart" && lower != "td" && lower != "lr" && lower != "subgraph" && lower != "end" && lower != "graph" && lower != "empty" && lower != "module architecture" {
				seen[lower] = true
				symbols = append(symbols, clean)
			}
		}
	}
	return symbols
}

func injectMermaidSkeleton(lines []string, skeleton string) string {
	// 策略 1: 寻找第一个 H2 标题（## 1. 架构总览 / ## 概述 等）
	firstH2Idx := -1
	for i, line := range lines {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "## ") {
			firstH2Idx = i
			break
		}
	}

	if firstH2Idx >= 0 {
		insertIdx := firstH2Idx + 1
		for insertIdx < len(lines) && strings.TrimSpace(lines[insertIdx]) == "" {
			insertIdx++
		}
		for insertIdx < len(lines) && strings.TrimSpace(lines[insertIdx]) != "" && !strings.HasPrefix(strings.TrimSpace(lines[insertIdx]), "#") {
			insertIdx++
		}
		var result []string
		result = append(result, lines[:insertIdx]...)
		result = append(result, "", skeleton)
		result = append(result, lines[insertIdx:]...)
		return strings.Join(result, "\n")
	}

	// 策略 2: 寻找首个 H1 标题（# 章节标题）
	firstH1Idx := -1
	for i, line := range lines {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "# ") {
			firstH1Idx = i
			break
		}
	}

	if firstH1Idx >= 0 {
		insertIdx := firstH1Idx + 1
		for insertIdx < len(lines) && (strings.TrimSpace(lines[insertIdx]) == "" || strings.HasPrefix(strings.TrimSpace(lines[insertIdx]), ">")) {
			insertIdx++
		}
		for insertIdx < len(lines) && strings.TrimSpace(lines[insertIdx]) != "" && !strings.HasPrefix(strings.TrimSpace(lines[insertIdx]), "#") {
			insertIdx++
		}
		var result []string
		result = append(result, lines[:insertIdx]...)
		result = append(result, "", skeleton)
		result = append(result, lines[insertIdx:]...)
		return strings.Join(result, "\n")
	}

	// 策略 3: 无任何标题，前置骨架
	return skeleton + "\n\n" + strings.Join(lines, "\n")
}
