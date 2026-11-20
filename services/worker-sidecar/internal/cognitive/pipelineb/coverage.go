package pipelineb

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/cognitive"
)

// ─────────────────────────────────────────────────────────────
// WP4.1 后置架构覆盖率门禁（确定性，零 LLM 判定）。
//
// 职责：大纲装甲（SanitizeAndIntersectOutline）只拦截不存在路径，不检查
// 高体量核心子系统是否被整块遗漏。本文件在装甲之后做确定性覆盖率裁决：
//   - 纯函数 evaluateSubsystemCoverage：缺失核心子系统 + 推荐核心入口文件；
//   - 深度 1（Run）：反馈非空时追加至多 1 次 outline_map_v1 修订回流
//     （契约 C7：ModelRequest.CoverageFeedback → vars["coverageFeedback"]），
//     修订结果再过同一路径幻觉装甲收尾；仍缺失记录告警放行，绝不循环；
//   - 深度 2（RunDrill）：仅调用纯函数记录指标与告警日志（Gall's Law：
//     不触发重规划/子树重跑）。
// 覆盖率指标只进结构化日志，不进 UI（最小文案公理）。
// ─────────────────────────────────────────────────────────────

// coverageMissingRatio 核心子系统缺失判定阈值：Prefix 作用域内 EstLOC
// 占比 >= 12% 且非辅助且被 0 章节覆盖才视为缺失（WP4 规格值）。
const coverageMissingRatio = 0.12

// coverageRecommendationCap 反馈中推荐核心入口文件数（按 Hotness/LOC 排序取 2~3 个）。
const coverageRecommendationCap = 3

// coverageRevisionBudget / coverageRevisionFloor 深度 1 修订调用的预算钳制
// （与 Layer 2 断点续写同款哲学：留出装甲收尾预留，下限以下放弃修订）。
const (
	coverageRevisionBudget = 20 * time.Second
	coverageRevisionFloor  = 5 * time.Second
)

// CoverageFeedback 覆盖率门禁反馈（确定性产出，缺失时返回 nil 而非空壳）。
type CoverageFeedback struct {
	// MissingSubsystems 缺失核心子系统展示名（EstLOC 降序）。
	MissingSubsystems []string
	// RecommendedFiles 缺失子系统前缀 -> 推荐核心入口文件
	// （Hotness/LOC 降序取前 2~3；纯函数无文件事实时为空）。
	RecommendedFiles map[string][]string
	// Feedback 回流 outline_map_v1 的确定性修订指令（契约 C7 载荷）。
	Feedback string
}

// teachingContextAware 可选接口：模型实现可声明教学条件供确定性覆盖率
// 门禁做冲突裁决（Run 签名保持不变——条件经模型实例随路携带；
// GatewayModel 即实现方，测试桩可按需实现）。
type teachingContextAware interface {
	TeachingContext() (teachingDepth, customPrompt string)
}

// evaluateSubsystemCoverage 覆盖率门禁纯函数（契约签名，冻结）。
// 确定性冲突规则：customPrompt != ""（用户聚焦意图主权）或
// teachingDepth == "overview" 时返回 nil——跳过强制重规划，仅记录指标。
// 本签名无文件事实输入，推荐文件由 evaluateSubsystemCoverageFromFiles 补全。
func evaluateSubsystemCoverage(subsystems []SubsystemSpec, chapters []cognitive.OutlineChapter, prefix, teachingDepth, customPrompt string) *CoverageFeedback {
	return evaluateSubsystemCoverageFromFiles(subsystems, chapters, nil, prefix, teachingDepth, customPrompt)
}

// evaluateSubsystemCoverageFromFiles 覆盖率门禁完整实现：files 提供
// FileMap 事实时为缺失子系统补充推荐核心入口文件（按 Hotness/LOC 排序）。
func evaluateSubsystemCoverageFromFiles(subsystems []SubsystemSpec, chapters []cognitive.OutlineChapter, files []FileMap, prefix, teachingDepth, customPrompt string) *CoverageFeedback {
	if customPrompt != "" || teachingDepth == TeachingDepthOverview {
		return nil
	}
	if len(subsystems) == 0 || len(chapters) == 0 {
		return nil
	}

	// Prefix 作用域过滤（prefix 为空 = 全仓）；确定性：保持子系统原序
	scoped := make([]SubsystemSpec, 0, len(subsystems))
	totalLOC := 0
	for _, s := range subsystems {
		if prefix != "" && s.Prefix != prefix && !strings.HasPrefix(s.Prefix, prefix+"/") {
			continue
		}
		scoped = append(scoped, s)
		totalLOC += s.EstLOC
	}
	if len(scoped) == 0 || totalLOC <= 0 {
		return nil
	}

	// 章节覆盖判定：章节文件路径对子系统前缀做最长匹配（0 章节覆盖 = 缺失候选）
	covered := make(map[int]bool, len(scoped))
	for _, ch := range chapters {
		for _, f := range ch.Files {
			if f.Path == "" {
				continue
			}
			best, bestLen := -1, -1
			for i := range scoped {
				sp := scoped[i].Prefix
				if (f.Path == sp || strings.HasPrefix(f.Path, sp+"/")) && len(sp) > bestLen {
					bestLen = len(sp)
					best = i
				}
			}
			if best >= 0 {
				covered[best] = true
			}
		}
	}

	var missing []SubsystemSpec
	for i, s := range scoped {
		if covered[i] || s.IsAuxiliary {
			continue
		}
		// 门禁：EstLOC 占比 >= 12% 且非辅助的核心子系统被 0 章节覆盖
		if float64(s.EstLOC)/float64(totalLOC) >= coverageMissingRatio {
			missing = append(missing, s)
		}
	}
	if len(missing) == 0 {
		return nil
	}

	// 确定性排序：EstLOC 降序（specs 源序仅作稳定兜底，不依赖 map 迭代序）
	sort.SliceStable(missing, func(i, j int) bool { return missing[i].EstLOC > missing[j].EstLOC })

	fb := &CoverageFeedback{
		MissingSubsystems: make([]string, 0, len(missing)),
		RecommendedFiles:  make(map[string][]string, len(missing)),
	}
	var sb strings.Builder
	sb.WriteString("上次大纲遗漏了高体量核心子系统（物理事实：EstLOC 占比 >= 12% 且 0 章节覆盖）：")
	for i, s := range missing {
		fb.MissingSubsystems = append(fb.MissingSubsystems, s.Name)
		if i > 0 {
			sb.WriteString("、")
		}
		fmt.Fprintf(&sb, "%s（%s，预估 %d 行）", s.Name, s.Prefix, s.EstLOC)
		if recs := recommendSubsystemEntryFiles(files, s.Prefix, coverageRecommendationCap); len(recs) > 0 {
			fb.RecommendedFiles[s.Prefix] = recs
			fmt.Fprintf(&sb, "，优先覆盖核心入口文件 %s", strings.Join(recs, ", "))
		}
	}
	sb.WriteString("。请修订大纲：为每个遗漏子系统补充章节，文件路径严格从真实文件清单原样复制，已覆盖章节保持不变。")
	fb.Feedback = sb.String()
	return fb
}

// recommendSubsystemEntryFiles 为缺失子系统推荐核心入口文件：
// 非测试优先，Hotness 降序 → LOC 降序 → 路径升序（确定性字典序），取前 cap 个。
func recommendSubsystemEntryFiles(files []FileMap, prefix string, cap int) []string {
	if cap <= 0 {
		return nil
	}
	var candidates []FileMap
	for _, f := range files {
		if f.Path == prefix || strings.HasPrefix(f.Path, prefix+"/") {
			candidates = append(candidates, f)
		}
	}
	if len(candidates) == 0 {
		return nil
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		// 非测试优先（测试只在无源码可选时兜底）
		if candidates[i].IsTest != candidates[j].IsTest {
			return !candidates[i].IsTest
		}
		if candidates[i].Hotness != candidates[j].Hotness {
			return candidates[i].Hotness > candidates[j].Hotness
		}
		if candidates[i].LOC != candidates[j].LOC {
			return candidates[i].LOC > candidates[j].LOC
		}
		return candidates[i].Path < candidates[j].Path
	})
	out := make([]string, 0, cap)
	for _, f := range candidates {
		out = append(out, f.Path)
		if len(out) >= cap {
			break
		}
	}
	return out
}

// subsystemCoverageSummary 结构化覆盖率指标行（只进日志）：子系统数/覆盖数。
func subsystemCoverageSummary(subsystems []SubsystemSpec, chapters []cognitive.OutlineChapter, prefix string) string {
	scopedTotal, covered := 0, 0
	for _, s := range subsystems {
		if prefix != "" && s.Prefix != prefix && !strings.HasPrefix(s.Prefix, prefix+"/") {
			continue
		}
		scopedTotal++
		for _, ch := range chapters {
			hit := false
			for _, f := range ch.Files {
				if f.Path == s.Prefix || strings.HasPrefix(f.Path, s.Prefix+"/") {
					covered++
					hit = true
					break
				}
			}
			if hit {
				break
			}
		}
	}
	return fmt.Sprintf("subsystems=%d covered=%d", scopedTotal, covered)
}

// applyCoverageGate 深度 1 门禁编排（Run 中 Sanitize 之后调用）：
// 反馈非空则追加至多 1 次 outline_map_v1 修订调用（携 CoverageFeedback），
// 修订结果过同一装甲收尾；仅当缺失核心子系统严格减少才采信修订——
// 仍缺失记录告警放行，绝不循环。
func applyCoverageGate(ctx context.Context, m *RepoMap, arch *ArchitecturalModel, model OutlineModel, patterns cognitive.Patterns, nodes []cluster.GitNode, candidates []cognitive.CandidateOutlineFile, targetLanguage string, chapters []cognitive.OutlineChapter) []cognitive.OutlineChapter {
	teachingDepth, customPrompt := "", ""
	if ca, ok := model.(teachingContextAware); ok {
		teachingDepth, customPrompt = ca.TeachingContext()
	}
	subsystems := DiscoverSubsystems(SubsystemSourcesFromRepoMap(m), patterns)
	fb := evaluateSubsystemCoverageFromFiles(subsystems, chapters, m.Files, "", teachingDepth, customPrompt)
	if fb == nil {
		return chapters
	}
	log.Printf("[pipelineb] CoverageGate depth1 missing core subsystems %v (%s) -> one outline_map_v1 revision\n",
		fb.MissingSubsystems, subsystemCoverageSummary(subsystems, chapters, ""))

	revised, stillMissing := reviseOutlineForCoverage(ctx, m, arch, model, patterns, nodes, candidates, targetLanguage, subsystems, fb, teachingDepth)
	if revised != nil {
		chapters = revised
	}
	if len(stillMissing) > 0 {
		log.Printf("[pipelineb] CoverageGate still missing after bounded revision, allow with warning: %v\n", stillMissing)
	}
	return chapters
}

// reviseOutlineForCoverage 单次修订回流（封顶一次，不迭代）：
// 返回 (采纳的修订章节, 仍缺失的子系统名)。修订失败/预算不足/覆盖率未
// 严格改善时返回 (nil, 原缺失清单)——确定性裁决，绝不静默采信更差结果。
func reviseOutlineForCoverage(
	ctx context.Context,
	m *RepoMap,
	arch *ArchitecturalModel,
	model OutlineModel,
	patterns cognitive.Patterns,
	nodes []cluster.GitNode,
	candidates []cognitive.CandidateOutlineFile,
	targetLanguage string,
	subsystems []SubsystemSpec,
	fb *CoverageFeedback,
	teachingDepth string,
) (revised []cognitive.OutlineChapter, stillMissing []string) {
	budget := coverageRevisionBudget
	if d, ok := ctx.Deadline(); ok {
		rem := time.Until(d) - outlineArmorReserve
		if rem < budget {
			budget = rem
		}
	}
	if budget < coverageRevisionFloor {
		log.Printf("[pipelineb] CoverageGate insufficient budget (%s) for revision, allow with warning: %v\n", budget, fb.MissingSubsystems)
		return nil, fb.MissingSubsystems
	}

	revCtx, cancel := context.WithTimeout(ctx, budget)
	raw, err := model.Complete(revCtx, ModelRequest{
		RepoMap:          m,
		ArchModel:        arch,
		TargetLanguage:   targetLanguage,
		CoverageFeedback: fb.Feedback,
	})
	cancel()
	// 截止抢救与主调用同契约：流被切断时残文仍可确定性回收
	if raw == "" {
		if err != nil {
			log.Printf("[pipelineb] CoverageGate revision call failed (%v), keep original outline\n", err)
		}
		return nil, fb.MissingSubsystems
	}

	draft, _ := ParseOutlineJSON(raw)
	if len(draft) == 0 {
		draft = SalvageOutlineChapters(raw)
	}
	if len(draft) == 0 {
		log.Printf("[pipelineb] CoverageGate revision produced zero parsable chapters, keep original outline\n")
		return nil, fb.MissingSubsystems
	}

	// 修订结果过同一路径幻觉装甲收尾（SSOT：cognitive.SanitizeAndIntersectOutline）
	san := cognitive.SanitizeAndIntersectOutline(draft, nodes, "", targetLanguage, candidates, patterns)
	if len(san.Sanitized) == 0 {
		log.Printf("[pipelineb] CoverageGate revision rejected by hallucination armor, keep original outline\n")
		return nil, fb.MissingSubsystems
	}
	decorateChapterDimensions(san.Sanitized, arch)

	// 确定性裁决：仅当缺失核心子系统严格减少才采信修订
	// （teachingDepth 与首发冲突裁决同源；customPrompt 已在门禁入口裁决过非空）
	fb2 := evaluateSubsystemCoverageFromFiles(subsystems, san.Sanitized, m.Files, "", teachingDepth, "")
	if fb2 == nil {
		log.Printf("[pipelineb] CoverageGate revision resolved all missing core subsystems -> adopt\n")
		return san.Sanitized, nil
	}
	if len(fb2.MissingSubsystems) < len(fb.MissingSubsystems) {
		log.Printf("[pipelineb] CoverageGate revision reduced missing %d -> %d, adopt; still missing allowed with warning: %v\n",
			len(fb.MissingSubsystems), len(fb2.MissingSubsystems), fb2.MissingSubsystems)
		return san.Sanitized, fb2.MissingSubsystems
	}
	log.Printf("[pipelineb] CoverageGate revision not better (missing %d >= %d), keep original; allow with warning: %v\n",
		len(fb2.MissingSubsystems), len(fb.MissingSubsystems), fb.MissingSubsystems)
	return nil, fb.MissingSubsystems
}
