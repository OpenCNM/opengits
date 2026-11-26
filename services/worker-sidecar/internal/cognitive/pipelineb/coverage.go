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

// Missing threshold: non-auxiliary subsystem >=12% EstLOC within scope with zero chapter coverage.
const coverageMissingRatio = 0.12

const coverageRecommendationCap = 3

const (
	coverageRevisionBudget = 20 * time.Second
	coverageRevisionFloor  = 5 * time.Second
)

type CoverageFeedback struct {
	MissingSubsystems []string
	RecommendedFiles  map[string][]string
	Feedback          string
}

type teachingContextAware interface {
	TeachingContext() (teachingDepth, customPrompt string)
}

// Skip mandatory revision on customPrompt (user focus sovereignty) or overview teachingDepth.
func evaluateSubsystemCoverage(subsystems []SubsystemSpec, chapters []cognitive.OutlineChapter, prefix, teachingDepth, customPrompt string) *CoverageFeedback {
	return evaluateSubsystemCoverageFromFiles(subsystems, chapters, nil, prefix, teachingDepth, customPrompt)
}

func evaluateSubsystemCoverageFromFiles(subsystems []SubsystemSpec, chapters []cognitive.OutlineChapter, files []FileMap, prefix, teachingDepth, customPrompt string) *CoverageFeedback {
	if customPrompt != "" || teachingDepth == TeachingDepthOverview {
		return nil
	}
	if len(subsystems) == 0 || len(chapters) == 0 {
		return nil
	}

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
		if float64(s.EstLOC)/float64(totalLOC) >= coverageMissingRatio {
			missing = append(missing, s)
		}
	}
	if len(missing) == 0 {
		return nil
	}

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

// Single bounded revision (no loop); adopt revised chapters only when missing count strictly decreases.
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

	san := cognitive.SanitizeAndIntersectOutline(draft, nodes, "", targetLanguage, candidates, patterns)
	if len(san.Sanitized) == 0 {
		log.Printf("[pipelineb] CoverageGate revision rejected by hallucination armor, keep original outline\n")
		return nil, fb.MissingSubsystems
	}
	decorateChapterDimensions(san.Sanitized, arch)

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
