package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/chapter"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/cognitive/pipelineb"
	"github.com/opengits/worker-sidecar/internal/concept"
)

const learningPathHeader = "🧭 学习路径（Learning Path）"

const (
	maxLearningPathDepth = 4
	maxLearningPathNodes = 12
)

type exploreConceptArgs struct {
	Concept *string `json:"concept"`
	Action  *string `json:"action"`
}

func (s *readService) runExploreConcept(ctx context.Context, resolved *ResolvedRepo, userID, clientName string, args exploreConceptArgs) readResult {
	action := deref(args.Action)
	if action == "" {
		action = "details"
	}
	repo := resolved.Repository
	conceptRaw := strings.TrimSpace(deref(args.Concept))
	_, cleanConcept := concept.ParseScopedConcept(conceptRaw)
	conceptName := cleanConcept
	if conceptName == "" {
		conceptName = conceptRaw
	}

	switch action {
	case "course_map":
		return s.runCourseMap(ctx, repo, userID, clientName)
	case "architecture":
		return s.runConceptArchitecture(ctx, repo, userID, clientName, conceptName)
	case "coverage":

		return readResult{Text: "Skill coverage analysis is available on Hub mode."}
	case "recommend":
		if conceptName == "" {
			return readResult{Text: `Error: pass a short project description as "concept" for recommendation (e.g. "Next.js 15 + Drizzle + auth 全栈项目").`, IsError: true}
		}
		return readResult{Text: "Tutorial recommendation is available on Hub mode (omit \"repository\" to rank your whole bookshelf)."}
	}

	if conceptName == "" {
		return readResult{Text: `Error: "concept" parameter is required for details, neighbors, or learning path exploration.`, IsError: true}
	}
	switch action {
	case "neighbors":
		return s.runConceptNeighbors(ctx, repo, userID, clientName, conceptName)
	case "path":
		return s.runLearningPath(ctx, repo, userID, clientName, conceptName)
	case "quiz":
		return s.runConceptQuiz(ctx, repo, userID, clientName, conceptName)
	case "editions":
		return s.runConceptEditions(ctx, repo, userID, clientName, conceptName)
	default:
		return s.runConceptDetails(ctx, repo, userID, clientName, conceptName)
	}
}

func (s *readService) runConceptQuiz(ctx context.Context, repo RepoRow, userID, clientName, concept string) readResult {
	startTime := time.Now()
	node, _ := s.store.ResolveConceptNode(ctx, repo.ID, concept)
	if node == nil || node.DocumentPath == nil || *node.DocumentPath == "" {
		s.recordTelemetry(ctx, CallLogEntry{
			ToolName: "explore_concept", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
			Dimension: "documents", Status: "BLIND_SPOT", ResultCount: 0, ResponseTimeMs: time.Since(startTime).Milliseconds(),
		})
		return readResult{Text: fmt.Sprintf("Concept %q not found; pass a concept name from outline (Knowledge Graph Concepts section).", concept), IsError: true}
	}
	quizzes, err := s.store.GetDocumentQuizzesByPath(ctx, repo.ID, *node.DocumentPath)
	if err != nil {
		quizzes = nil
	}

	var b strings.Builder
	fmt.Fprintf(&b, "# 📝 Chapter Quizzes for concept %q\n\n", concept)
	if len(quizzes) == 0 {
		b.WriteString("No structured quizzes persisted for this chapter (older transcriptions keep quizzes folded inside concept reflections; re-transcription will persist them structurally).")
	} else {
		for _, q := range quizzes {
			fmt.Fprintf(&b, "### Q%d: %s\n", q.Order+1, q.Question)
			for i, opt := range q.Options {
				fmt.Fprintf(&b, "- %s. %s\n", string(rune('A'+i)), opt)
			}
			if q.Explanation != "" {
				fmt.Fprintf(&b, "\nExplanation: %s\n", q.Explanation)
			}
			fmt.Fprintf(&b, "\n(Answer: %s)\n\n", string(rune('A'+q.CorrectIndex)))
		}
		b.WriteString("(Answers are for self-check; see read with the chapter path for full context.)")
	}

	s.recordTelemetry(ctx, CallLogEntry{
		ToolName: "explore_concept", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
		Dimension: "documents", Status: "SUCCESS", ResultCount: len(quizzes), ResponseTimeMs: time.Since(startTime).Milliseconds(),
	})
	return readResult{Text: b.String()}
}

func (s *readService) runConceptArchitecture(ctx context.Context, repo RepoRow, userID, clientName, concept string) readResult {
	startTime := time.Now()
	cleanConcept := strings.TrimSpace(concept)
	conceptLower := strings.ToLower(cleanConcept)

	var text string
	if conceptLower == "" || conceptLower == "all" || conceptLower == "root" || conceptLower == "system" {
		text = renderMacroArchitecture(repo)
	} else {
		text = renderSubsystemArchitecture(repo, cleanConcept)
	}

	s.recordTelemetry(ctx, CallLogEntry{
		ToolName:       "explore_concept",
		UserID:         userID,
		ClientName:     clientName,
		RepositoryID:   repo.ID,
		Dimension:      "architecture",
		Status:         "SUCCESS",
		ResultCount:    1,
		ResponseTimeMs: time.Since(startTime).Milliseconds(),
	})
	return readResult{Text: text}
}

func renderMacroArchitecture(repo RepoRow) string {
	topoSection := extractMacroTopologySection(repo)
	if topoSection == "" {
		return fmt.Sprintf("No code architecture topology available for %s/%s (non-code documentation repository).", repo.Owner, repo.Repo)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# 🏛️ System Architecture Topology (C4 L1 System Context)\nRepository: %s/%s\n\n", repo.Owner, repo.Repo)
	b.WriteString(topoSection)
	b.WriteString("\n(Next steps: use explore_concept with concept=\"<subsystem_name>\", action=\"architecture\" to drill down into subsystem component collaboration maps and AST call flows.)")
	return b.String()
}

func renderSubsystemArchitecture(repo RepoRow, concept string) string {
	conceptTrimmed := strings.TrimSpace(concept)
	conceptLower := strings.ToLower(conceptTrimmed)

	var profile map[string]json.RawMessage
	if len(repo.RepoProfile) > 0 {
		_ = json.Unmarshal(repo.RepoProfile, &profile)
	}

	var clusters []codeClusterRow
	if raw, ok := profile["codeClusters"]; ok && len(raw) > 0 {
		_ = json.Unmarshal(raw, &clusters)
	}

	var matchedCluster *codeClusterRow
	for i := range clusters {
		c := &clusters[i]
		if strings.EqualFold(c.Title, conceptTrimmed) || strings.Contains(strings.ToLower(c.Title), conceptLower) {
			matchedCluster = c
			break
		}
		for _, dir := range c.Directories {
			cleanDir := strings.ToLower(strings.Trim(dir, "/"))
			if cleanDir == conceptLower || strings.ToLower(filepath.Base(cleanDir)) == conceptLower || strings.Contains(cleanDir, conceptLower) {
				matchedCluster = c
				break
			}
		}
		if matchedCluster != nil {
			break
		}
		for _, file := range c.Files {
			cleanFile := strings.ToLower(strings.Trim(file, "/"))
			if cleanFile == conceptLower || strings.ToLower(filepath.Base(cleanFile)) == conceptLower {
				matchedCluster = c
				break
			}
		}
		if matchedCluster != nil {
			break
		}
		if n, err := strconv.Atoi(conceptTrimmed); err == nil && (c.TeachingOrder == n || c.ChapterNo == n) {
			matchedCluster = c
			break
		}
		if strings.EqualFold(fmt.Sprintf("chapter %d", c.TeachingOrder), conceptTrimmed) ||
			strings.EqualFold(fmt.Sprintf("ch%d", c.TeachingOrder), conceptTrimmed) ||
			strings.EqualFold(fmt.Sprintf("ch%02d", c.TeachingOrder), conceptTrimmed) {
			matchedCluster = c
			break
		}
	}

	if matchedCluster != nil {
		var cog *cognitive.ModuleCognition
		var goldenSymbols []cognitive.ModuleGoldenSymbol
		if matchedCluster.Cognitive != nil {
			cog = &cognitive.ModuleCognition{
				Phase:             cognitive.CognitivePhase(matchedCluster.Cognitive.Phase),
				Rationale:         matchedCluster.Cognitive.Rationale,
				UpstreamModules:   matchedCluster.Cognitive.UpstreamModules,
				DownstreamModules: matchedCluster.Cognitive.DownstreamModules,
				GoldenSymbols:     matchedCluster.Cognitive.GoldenSymbols,
				CallFlow:          matchedCluster.Cognitive.CallFlow,
			}
			goldenSymbols = matchedCluster.Cognitive.GoldenSymbols
		}

		mermaid := chapter.BuildModuleArchitectureMermaidSkeleton(
			matchedCluster.Title,
			cog,
			goldenSymbols,
			chapter.SkeletonOptions{MaxCallSteps: 8, IncludeExternal: true},
		)

		var b strings.Builder
		fmt.Fprintf(&b, "# 🏛️ Subsystem Architecture (C4 L2 Component Map)\n")
		fmt.Fprintf(&b, "Subsystem: %s (Chapter %d)\n", matchedCluster.Title, matchedCluster.TeachingOrder)
		fmt.Fprintf(&b, "Repository: %s/%s\n", repo.Owner, repo.Repo)
		if matchedCluster.Summary != "" {
			fmt.Fprintf(&b, "Summary: %s\n", matchedCluster.Summary)
		}
		if len(matchedCluster.Directories) > 0 {
			fmt.Fprintf(&b, "Directories: %s\n", strings.Join(matchedCluster.Directories, ", "))
		}
		if len(matchedCluster.Files) > 0 {
			shownFiles := matchedCluster.Files
			more := ""
			if len(shownFiles) > 8 {
				shownFiles = shownFiles[:8]
				more = fmt.Sprintf(" ... [%d more files]", len(matchedCluster.Files)-8)
			}
			fmt.Fprintf(&b, "Files (%d): %s%s\n", len(matchedCluster.Files), strings.Join(shownFiles, ", "), more)
		}
		if cog != nil && cog.Phase != "" {
			fmt.Fprintf(&b, "Role / Phase: %s\n", cog.Phase)
		}
		b.WriteString("\n## Component Collaboration & AST Call Flow\n\n")
		b.WriteString(mermaid)
		b.WriteString("\n")

		if cog != nil && len(cog.GoldenSymbols) > 0 {
			b.WriteString("\n### Verified AST Golden Symbols:\n")
			limit := 6
			if len(cog.GoldenSymbols) < limit {
				limit = len(cog.GoldenSymbols)
			}
			for _, sym := range cog.GoldenSymbols[:limit] {
				filePart := ""
				if sym.File != "" {
					filePart = " in `" + sym.File + "`"
				}
				kindPart := ""
				if sym.Kind != "" {
					kindPart = " (" + sym.Kind + ")"
				}
				fmt.Fprintf(&b, "- `%s`%s%s\n", sym.Name, kindPart, filePart)
			}
		}

		if cog != nil && cog.Rationale != "" {
			fmt.Fprintf(&b, "\n### Architectural Rationale:\n%s\n", cog.Rationale)
		}

		if cog != nil && (len(cog.UpstreamModules) > 0 || len(cog.DownstreamModules) > 0) {
			b.WriteString("\n### Module Dependencies:\n")
			if len(cog.UpstreamModules) > 0 {
				fmt.Fprintf(&b, "- Upstream (Prerequisites): %s\n", strings.Join(cog.UpstreamModules, ", "))
			}
			if len(cog.DownstreamModules) > 0 {
				fmt.Fprintf(&b, "- Downstream (Dependents): %s\n", strings.Join(cog.DownstreamModules, ", "))
			}
		}

		return b.String()
	}

	if raw, ok := profile["macroTopology"]; ok && len(raw) > 0 {
		var topo pipelineb.MacroTopology
		if err := json.Unmarshal(raw, &topo); err == nil {
			for _, n := range topo.Nodes {
				if strings.EqualFold(n.Name, conceptTrimmed) ||
					strings.EqualFold(n.ID, conceptTrimmed) ||
					strings.Contains(strings.ToLower(n.Name), conceptLower) ||
					strings.Contains(strings.ToLower(n.Path), conceptLower) {
					var b strings.Builder
					fmt.Fprintf(&b, "# 🏛️ Subsystem Component (C4 L2 Component View)\n")
					fmt.Fprintf(&b, "Component: %s [%s]\n", n.Name, formatRoleLabel(n.Role))
					fmt.Fprintf(&b, "Path: %s\n", n.Path)
					fmt.Fprintf(&b, "Repository: %s/%s\n", repo.Owner, repo.Repo)
					if n.FileCount > 0 {
						fmt.Fprintf(&b, "File Count: %d\n", n.FileCount)
					}
					if n.LOC > 0 {
						fmt.Fprintf(&b, "LOC: %d\n", n.LOC)
					}
					if len(n.TopExports) > 0 {
						fmt.Fprintf(&b, "Top Exports: %s\n", strings.Join(n.TopExports, ", "))
					}
					var incoming []string
					var outgoing []string
					for _, e := range topo.Edges {
						if e.To == n.ID {
							incoming = append(incoming, fmt.Sprintf("%s (%s)", e.From, e.Label))
						}
						if e.From == n.ID {
							outgoing = append(outgoing, fmt.Sprintf("%s (%s)", e.To, e.Label))
						}
					}
					if len(incoming) > 0 || len(outgoing) > 0 {
						b.WriteString("\n### Component Dependencies:\n")
						if len(incoming) > 0 {
							fmt.Fprintf(&b, "- Inbound Calls / Dependencies: %s\n", strings.Join(incoming, ", "))
						}
						if len(outgoing) > 0 {
							fmt.Fprintf(&b, "- Outbound Calls / Dependencies: %s\n", strings.Join(outgoing, ", "))
						}
					}
					return b.String()
				}
			}
		}
	}

	var available []string
	for _, c := range clusters {
		if c.Title != "" {
			available = append(available, c.Title)
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Subsystem %q not found in architecture topology for %s/%s.\n\n", conceptTrimmed, repo.Owner, repo.Repo)
	if len(available) > 0 {
		b.WriteString("Available subsystems:\n")
		for _, name := range available {
			fmt.Fprintf(&b, "- %s\n", name)
		}
		b.WriteString("\n(Use explore_concept with concept=\"<name>\", action=\"architecture\" to inspect a subsystem, or concept=\"\" for the full C4 L1 system architecture.)")
	} else {
		b.WriteString("This repository does not have subsystem breakdowns. Use concept=\"\" for the full C4 L1 architecture.")
	}
	return b.String()
}

func (s *readService) runConceptDetails(ctx context.Context, repo RepoRow, userID, clientName, concept string) readResult {
	startTime := time.Now()
	if concept == "" {
		return readResult{Text: hintConceptRequiredMsg, IsError: true}
	}
	node, _ := s.store.ResolveConceptNode(ctx, repo.ID, concept)
	if node == nil {
		s.recordTelemetry(ctx, CallLogEntry{
			ToolName: "explore_concept", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
			Dimension: "all", Status: "BLIND_SPOT", ResultCount: 0,
			ResponseTimeMs: time.Since(startTime).Milliseconds(),
		})
		return readResult{Text: conceptNotFoundMsg(concept, repo.Owner, repo.Repo, true), IsError: true}
	}

	docPath := deref(node.DocumentPath)
	var b strings.Builder
	fmt.Fprintf(&b, "🧠 概念详情 (Concept Details): %s (%s)\n", node.ConceptName, node.Category)
	if docPath != "" {
		b.WriteString("- 来源: " + docPath)
		if hp := deref(node.HeadingPath); hp != "" {
			b.WriteString(" [Address: " + buildCleanSectionAddress(docPath, hp) + "]")
		}
		b.WriteString("\n")

		if isCodeChapterPath(docPath) {
			writeConceptCodeContext(&b, s.getConceptCodeContext(ctx, repo, docPath))
		}

		if isWebDocRepository(repo) {
			var profile map[string]any
			if len(repo.RepoProfile) > 0 {
				_ = json.Unmarshal(repo.RepoProfile, &profile)
			}
			originalURL, _ := profile["originalUrl"].(string)
			if liveURL := resolveDocLiveURL(repo.NavTree, docPath, originalURL); liveURL != "" {
				b.WriteString("- 原站链接 (Live URL): " + liveURL + "\n")
			}
		}
	}

	if grounding := s.getConceptGroundingForDetails(ctx, repo, node.ConceptName, docPath); grounding != nil {
		if len(grounding.goldenSymbols) > 0 {
			b.WriteString("- 核心代码符号 (AST Golden Symbols):\n")
			for _, sym := range grounding.goldenSymbols[:minInt(4, len(grounding.goldenSymbols))] {
				fmt.Fprintf(&b, "  - `%s` (%s) in `%s`\n", sym.Name, sym.Kind, sym.File)
			}
		}
		if len(grounding.backboneFiles) > 0 {
			b.WriteString("- 主干实现文件 (Backbone Files):\n")
			for _, f := range grounding.backboneFiles[:minInt(3, len(grounding.backboneFiles))] {
				fmt.Fprintf(&b, "  - `%s` (%s)\n", f.Path, f.Role)
			}
		}
	}
	if summary := deref(node.Summary); summary != "" {
		b.WriteString("- 设计摘要: " + summary + "\n")
	}
	if node.CanonicalKey != nil && *node.CanonicalKey != "" {
		memberCount := s.store.CountCanonicalMembers(ctx, repo.ID, *node.CanonicalKey)
		repName := deref(node.CanonicalName)
		if repName == "" {
			repName = node.ConceptName
		}
		if memberCount > 1 || repName != node.ConceptName {
			fmt.Fprintf(&b, "- 归并: %s · 同义 %d 处\n", repName, memberCount)
		}
	}
	if p := deref(node.PrinciplesText); p != "" {
		b.WriteString("- 核心原理 (Principles):\n  " + strings.ReplaceAll(p, "\n", "\n  ") + "\n")
	}
	if ar := deref(node.AuthorReflections); ar != "" {
		b.WriteString("- 作者思考与 Trade-off 权衡:\n  > " + strings.ReplaceAll(ar, "\n", "\n  > ") + "\n")
	}
	if len(node.SopSteps) > 0 {
		b.WriteString("- 核心 SOP 开发步骤:\n")
		for i, step := range node.SopSteps {
			fmt.Fprintf(&b, "  %d. %s\n", i+1, step)
		}
	}
	if len(node.SubTopics) > 0 {
		b.WriteString("- 关联主题 (Sub Topics): " + strings.Join(node.SubTopics, "、") + "\n")
	}
	if len(node.Tags) > 0 {
		b.WriteString("- 标签 (Tags): " + strings.Join(node.Tags, "、") + "\n")
	}
	if docPath != "" && deref(node.HeadingPath) != "" {
		b.WriteString(hintConceptReadSection)
	}

	if deps := s.conceptDependencies(ctx, repo.ID, node.ID); len(deps) > 0 {
		b.WriteString(formatDependencyHintText(node.ConceptName, deps))
	}
	if neighbors := s.getConceptNeighbors(ctx, repo.ID, node.ID); len(neighbors) > 0 {
		b.WriteString("\n\n🧭 直接邻居 (Neighbors): ")
		var tagged []string
		for i, n := range neighbors {
			if i >= 6 {
				break
			}
			tagged = append(tagged, neighborRelationTag(n.relationType, n.direction)+n.conceptName)
		}
		b.WriteString(strings.Join(tagged, "、"))
		b.WriteString("\n(用 explore_concept(action='neighbors') 查看全部邻居及 Address，explore_concept(action='path') 获取完整递进链)")
	}

	s.recordTelemetry(ctx, CallLogEntry{
		ToolName: "explore_concept", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
		Dimension: "all", Status: "SUCCESS", ResultCount: 1,
		ResponseTimeMs: time.Since(startTime).Milliseconds(),
	})
	return readResult{Text: b.String()}
}

func conceptNotFoundMsg(concept, owner, repo string, withSearchHint bool) string {
	msg := fmt.Sprintf("Error: Concept %q not found in %s/%s. Use outline (see Knowledge Graph Concepts section) to see available concepts", concept, owner, repo)
	if withSearchHint {
		msg += ", or search to locate related content"
	}
	return msg + "."
}

func (s *readService) runConceptNeighbors(ctx context.Context, repo RepoRow, userID, clientName, concept string) readResult {
	startTime := time.Now()
	if concept == "" {
		return readResult{Text: hintConceptRequiredMsg, IsError: true}
	}
	node, _ := s.store.ResolveConceptNode(ctx, repo.ID, concept)
	if node == nil {
		s.recordTelemetry(ctx, CallLogEntry{
			ToolName: "explore_concept", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
			Dimension: "all", Status: "BLIND_SPOT", ResultCount: 0,
			ResponseTimeMs: time.Since(startTime).Milliseconds(),
		})
		return readResult{Text: conceptNotFoundMsg(concept, repo.Owner, repo.Repo, true), IsError: true}
	}
	neighbors := s.getConceptNeighbors(ctx, repo.ID, node.ID)
	s.recordTelemetry(ctx, CallLogEntry{
		ToolName: "explore_concept", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
		Dimension: "all", Status: telemetryStatus(len(neighbors)), ResultCount: len(neighbors),
		ResponseTimeMs: time.Since(startTime).Milliseconds(),
	})
	return readResult{Text: formatNeighborsOutput(node.ConceptName, neighbors)}
}

func formatNeighborsOutput(conceptName string, neighbors []neighborItem) string {
	if len(neighbors) == 0 {
		return "🧭 「" + conceptName + "」暂无直接邻居概念（图谱边尚未构建）。可尝试 outline 查看概念拓扑清单。"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "🧭 概念邻居（Concept Neighbors）— %s\n\n", conceptName)
	for _, n := range neighbors {
		arrow := neighborRelationTag(n.relationType, n.direction)
		srcKey := n.source
		if srcKey == "" {
			srcKey = "cooccurrence"
		}
		meta, ok := edgeSourceLabels[srcKey]
		if !ok {
			meta = struct{ label, confidence string }{srcKey, "推断"}
		}
		fmt.Fprintf(&b, "- %s (%s) %s [%s · 来源:%s(%s) · w%s]", n.conceptName, n.category, arrow,
			n.relationType, meta.label, meta.confidence, formatWeight(n.weight))
		if n.canonicalName != "" && n.canonicalName != n.conceptName {
			b.WriteString(" (归并: " + n.canonicalName + ")")
		}
		if n.docPath != "" {
			b.WriteString(" — " + n.docPath)
		}
		if n.address != "" {
			b.WriteString("\n  [Address: " + n.address + "]")
		}
		b.WriteString("\n")
	}
	b.WriteString("\n(可对任一邻居调用 explore_concept / read 深入；学习顺序见 explore_concept(action=\"path\"))")
	b.WriteString("\n(证据来源：共现/教学顺序/代码依赖=确定；LLM推断=可能幻觉，权重越高关系越强)")
	return b.String()
}

type pathChainItem struct {
	conceptID     string
	depth         int
	conceptName   string
	category      string
	docPath       string
	address       string
	canonicalKey  string
	canonicalName string
}

func (s *readService) runLearningPath(ctx context.Context, repo RepoRow, userID, clientName, concept string) readResult {
	startTime := time.Now()
	if concept == "" {
		return readResult{Text: hintConceptRequiredMsg, IsError: true}
	}
	node, _ := s.store.ResolveConceptNode(ctx, repo.ID, concept)
	if node == nil {
		s.recordTelemetry(ctx, CallLogEntry{
			ToolName: "explore_concept", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
			Dimension: "all", Status: "BLIND_SPOT", ResultCount: 0,
			ResponseTimeMs: time.Since(startTime).Milliseconds(),
		})
		return readResult{Text: conceptNotFoundMsg(concept, repo.Owner, repo.Repo, false), IsError: true}
	}

	chain := s.learningPathChain(ctx, repo.ID, node.ID)

	if len(chain) == 0 {
		s.recordTelemetry(ctx, CallLogEntry{
			ToolName: "explore_concept", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
			Dimension: "all", Status: telemetryStatus(0), ResultCount: 0,
			ResponseTimeMs: time.Since(startTime).Milliseconds(),
		})
		return readResult{Text: "🧭 尚未发现「" + node.ConceptName + "」的前置知识链（图谱中暂无 prerequisite / successor 边）。学习路径将随图谱边构建后可用。"}
	}

	steps := make([]pathChainItem, len(chain))
	for i, c := range chain {
		steps[len(chain)-1-i] = c
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s — 目标: %s\n\n", learningPathHeader, node.ConceptName)
	for i, c := range steps {
		fmt.Fprintf(&b, "%d. %s (%s)", i+1, c.conceptName, c.category)
		if c.canonicalName != "" && c.canonicalName != c.conceptName {
			b.WriteString(" (归并: " + c.canonicalName + ")")
		}
		if c.docPath != "" {
			b.WriteString(" — " + c.docPath)
		}
		if c.address != "" {
			b.WriteString("\n   [Address: " + c.address + "]")
		}
		b.WriteString("\n")
	}
	fmt.Fprintf(&b, "%d. 🎯 %s（目标概念）\n", len(steps)+1, node.ConceptName)
	b.WriteString("\n(按顺序阅读即可递进掌握；每个概念可用 read 精读，explore_concept 深钻)")

	s.recordTelemetry(ctx, CallLogEntry{
		ToolName: "explore_concept", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
		Dimension: "all", Status: telemetryStatus(len(chain)), ResultCount: len(chain),
		ResponseTimeMs: time.Since(startTime).Milliseconds(),
	})
	return readResult{Text: b.String()}
}

func (s *readService) learningPathChain(ctx context.Context, repositoryID, targetID string) []pathChainItem {
	edges, _ := s.store.LearningPathEdges(ctx, repositoryID)
	memberIDs, _ := s.store.CanonicalMemberIDs(ctx, repositoryID, targetID)

	incoming := map[string][]EdgeRef{}
	for _, e := range edges {
		incoming[e.TargetID] = append(incoming[e.TargetID], e)
	}
	roots := map[string]bool{targetID: true}
	for _, id := range memberIDs {
		roots[id] = true
	}
	visited := map[string]bool{}
	for id := range roots {
		visited[id] = true
	}
	var chain []chainEntry
	frontier := mapKeys(roots)

	for depth := 1; depth <= maxLearningPathDepth && len(frontier) > 0; depth++ {
		var next []string
		type cand struct {
			conceptID string
			weight    float64
		}
		var candidates []cand
		for _, id := range frontier {
			for _, e := range incoming[id] {
				if e.Type != "prerequisite" && e.Type != "successor" {
					continue
				}
				if visited[e.SourceID] {
					continue
				}
				candidates = append(candidates, cand{e.SourceID, e.Weight})
			}
		}
		sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].weight > candidates[j].weight })
		for _, c := range candidates {
			if visited[c.conceptID] {
				continue
			}
			visited[c.conceptID] = true
			chain = append(chain, chainEntry{c.conceptID, depth})
			next = append(next, c.conceptID)
			if len(chain) >= maxLearningPathNodes {
				frontier = nil
				break
			}
		}
		frontier = next
	}

	if len(chain) == 0 {
		return nil
	}

	nodes, _ := s.store.NodesByIDs(ctx, repositoryID, chainIDs(chain))
	nodeByID := map[string]ConceptNodeLite{}
	for _, n := range nodes {
		nodeByID[n.ID] = n
	}

	seenKeys := map[string]bool{}
	var out []pathChainItem
	for _, c := range chain {
		n, ok := nodeByID[c.conceptID]
		if !ok {
			continue
		}
		key := deref(n.CanonicalKey)
		if key != "" {
			if seenKeys[key] {
				continue
			}
			seenKeys[key] = true
		}
		item := pathChainItem{
			conceptID: c.conceptID, depth: c.depth, conceptName: n.ConceptName, category: n.Category,
			docPath: deref(n.DocumentPath), canonicalKey: key, canonicalName: derefOr2(n.CanonicalName),
		}
		if item.docPath != "" && deref(n.HeadingPath) != "" {
			item.address = buildCleanSectionAddress(item.docPath, deref(n.HeadingPath))
		}
		out = append(out, item)
	}
	return out
}

type chainEntry struct {
	conceptID string
	depth     int
}

func chainIDs(chain []chainEntry) []string {
	ids := make([]string, 0, len(chain))
	for _, c := range chain {
		ids = append(ids, c.conceptID)
	}
	return ids
}

func mapKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func derefOr2(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

var chapterPathRE = regexp.MustCompile(`^chapters/`)

func isCodeChapterPath(p string) bool { return chapterPathRE.MatchString(p) }

var nonDigitsRE = regexp.MustCompile(`\D`)

func (s *readService) getConceptCodeContext(ctx context.Context, repo RepoRow, documentPath string) *codeClusterRow {
	if !isCodeChapterPath(documentPath) {
		return nil
	}
	last := documentPath
	if idx := strings.LastIndex(last, "/"); idx >= 0 {
		last = last[idx+1:]
	}
	order, err := strconv.Atoi(nonDigitsRE.ReplaceAllString(last, ""))
	if err != nil {
		return nil
	}
	var profile map[string]json.RawMessage
	if len(repo.RepoProfile) > 0 {
		_ = json.Unmarshal(repo.RepoProfile, &profile)
	}
	raw, ok := profile["codeClusters"]
	if !ok || raw == nil {
		return nil
	}
	var rows []codeClusterRow
	if json.Unmarshal(raw, &rows) != nil {
		return nil
	}
	for i := range rows {
		if rows[i].TeachingOrder == order {
			row := rows[i]
			if row.Title == "" {
				row.Title = fmt.Sprintf("Chapter %d", order)
			}
			return &row
		}
	}
	return nil
}

func (s *readService) getConceptGroundingForDetails(ctx context.Context, repo RepoRow, conceptName, docPath string) *groundingResult {
	owner, r, sha, ok := s.store.GetRepoGitSha(ctx, repo.ID)
	if !ok {
		return nil
	}
	artifact := loadRSGArtifact(owner, r, sha)
	if artifact == nil {
		return nil
	}
	var scopeFiles map[string]bool
	if docPath != "" && isCodeChapterPath(docPath) {
		if codeCtx := s.getConceptCodeContext(ctx, repo, docPath); codeCtx != nil && len(codeCtx.Files) > 0 {
			scopeFiles = map[string]bool{}
			for _, f := range codeCtx.Files {
				scopeFiles[f] = true
			}
		}
	}

	backbone := rsgBackboneFilesScoped(artifact, scopeFiles)
	backboneSet := map[string]bool{}
	for _, f := range backbone {
		backboneSet[f.Path] = true
	}

	type sym = struct {
		Name, Kind, File string
		Score            float64
	}
	var symbols []sym
	normConcept := strings.ToLower(conceptName)
	seen := map[string]bool{}
	for _, s := range artifact.GoldenSymbols {
		inScope := scopeFiles != nil && scopeFiles[s.File]
		if !inScope && scopeFiles == nil {
			inScope = backboneSet[s.File]
		}
		nameMatch := strings.Contains(normConcept, strings.ToLower(s.Name)) || strings.Contains(strings.ToLower(s.Name), normConcept)
		if !inScope && !nameMatch {
			continue
		}
		key := s.File + "::" + s.Name
		if seen[key] {
			continue
		}
		seen[key] = true
		symbols = append(symbols, sym{s.Name, s.Kind, s.File, s.Score})
		if len(symbols) >= 6 {
			break
		}
	}
	if len(symbols) == 0 && len(backbone) == 0 {
		return nil
	}
	return &groundingResult{goldenSymbols: symbols, backboneFiles: backbone}
}

type groundingResult struct {
	goldenSymbols []struct {
		Name, Kind, File string
		Score            float64
	}
	backboneFiles []struct{ Path, Role string }
}

func rsgBackboneFilesScoped(a *rsgArtifact, scopeFiles map[string]bool) []struct{ Path, Role string } {
	type bf = struct{ Path, Role string }
	var out []bf
	for _, n := range a.Nodes {
		if scopeFiles != nil {
			if scopeFiles[n.Path] {
				out = append(out, bf{n.Path, n.Role})
			}
		} else if n.IsBackbone || n.Role == "core_contract" || n.Role == "entry_point" {
			out = append(out, bf{n.Path, n.Role})
		}
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0; j-- {
			if a.nodePageRank(out[j].Path) > a.nodePageRank(out[j-1].Path) {
				out[j-1], out[j] = out[j], out[j-1]
			} else {
				break
			}
		}
	}
	if len(out) > 4 {
		out = out[:4]
	}
	return out
}

func (s *readService) conceptDependencies(ctx context.Context, repositoryID, conceptID string) []EdgeRef {
	memberIDs, _ := s.store.CanonicalMemberIDs(ctx, repositoryID, conceptID)
	edges, _ := s.store.ConceptDependencyEdges(ctx, repositoryID, memberIDs)
	seen := map[string]bool{}
	var out []EdgeRef
	for _, e := range edges {
		if seen[e.SourceID] {
			continue
		}
		seen[e.SourceID] = true
		out = append(out, e)
		if len(out) >= 5 {
			break
		}
	}
	return out
}

func formatDependencyHintText(targetName string, deps []EdgeRef) string {
	if len(deps) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n\n" + conceptDependencyHintHeader + "\n")
	fmt.Fprintf(&b, "- 理解「%s」建议先掌握:\n", targetName)
	for _, d := range deps {
		srcKey := d.Source
		if srcKey == "" {
			srcKey = "cooccurrence"
		}
		meta, ok := edgeSourceLabels[srcKey]
		if !ok {
			meta = struct{ label, confidence string }{srcKey, "推断"}
		}
		fmt.Fprintf(&b, "  • (概念 %s) [来源:%s(%s) · w%s]\n", d.SourceID, meta.label, meta.confidence, formatWeight(d.Weight))
	}
	b.WriteString("\n(可用 read 精读任一前置概念，或 explore_concept(action=\"path\") 获取完整递进链)")
	b.WriteString("\n(证据来源：共现/教学顺序/代码依赖=确定；LLM推断=可能幻觉)")
	return b.String()
}

func (s *readService) runConceptEditions(ctx context.Context, repo RepoRow, userID, clientName, concept string) readResult {
	startTime := time.Now()
	if concept == "" {
		return readResult{Text: `Error: "concept" is required for cross-edition comparison.`, IsError: true}
	}
	rows, err := s.store.ConceptEditionCompare(ctx, repo.Owner, repo.Repo, concept)
	if err != nil {
		rows = nil
	}

	var b strings.Builder
	fmt.Fprintf(&b, "# 🔄 Cross-Edition Comparison: %q in %s/%s\n\n", concept, repo.Owner, repo.Repo)
	if len(rows) <= 1 {
		if len(rows) == 1 {
			b.WriteString("This concept exists in only ONE edition row — no cross-edition divergence to compare.")
		} else {
			b.WriteString("This concept was not found in any edition row (check the concept name via explore_concept action=\"details\").")
		}
	} else {
		fmt.Fprintf(&b, "Editions found: %d\n\n", len(rows))
		base := rows[0]
		baseLabel := base.Edition
		if baseLabel == "" {
			baseLabel = "(base)"
		}
		for _, row := range rows {
			label := row.Edition
			if label == "" {
				label = "(base)"
			}
			fmt.Fprintf(&b, "## Edition: %s\n", label)
			if row.PrinciplesText != "" && row.PrinciplesText != base.PrinciplesText {
				trunc := row.PrinciplesText
				if len(trunc) > 400 {
					trunc = trunc[:400] + "…"
				}
				fmt.Fprintf(&b, "- **Principles (differs from %s)**: %s\n", baseLabel, trunc)
			} else {
				b.WriteString("- Principles: (same as base edition)\n")
			}
			if row.Summary != "" && row.Summary != base.Summary {
				trunc := row.Summary
				if len(trunc) > 300 {
					trunc = trunc[:300] + "…"
				}
				fmt.Fprintf(&b, "- **Summary (differs)**: %s\n", trunc)
			} else {
				b.WriteString("- Summary: (same as base edition)\n")
			}
			b.WriteString("\n")
		}
		b.WriteString("(Diff lines are truncated; use explore_concept action=\"details\" with \"owner/repo@edition\" for the full package of a specific edition.)")
	}

	s.recordTelemetry(ctx, CallLogEntry{
		ToolName: "explore_concept", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
		Dimension: "documents", Status: "SUCCESS", ResultCount: len(rows), ResponseTimeMs: time.Since(startTime).Milliseconds(),
	})
	return readResult{Text: b.String()}
}
