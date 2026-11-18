package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/cognitive"
)

// ── course_map ──

type codeClusterCognitive struct {
	Phase             string                         `json:"phase"`
	Rationale         string                         `json:"rationale,omitempty"`
	UpstreamModules   []string                       `json:"upstreamModules,omitempty"`
	DownstreamModules []string                       `json:"downstreamModules,omitempty"`
	GoldenSymbols     []cognitive.ModuleGoldenSymbol `json:"goldenSymbols,omitempty"`
	CallFlow          []cognitive.ModuleCallStep     `json:"callFlow,omitempty"`
}

type codeClusterRow struct {
	TeachingOrder int                   `json:"teachingOrder"`
	ChapterNo     int                   `json:"chapterNo,omitempty"`
	Title         string                `json:"title"`
	Summary       string                `json:"summary,omitempty"`
	Directories   []string              `json:"directories"`
	Files         []string              `json:"files"`
	Cognitive     *codeClusterCognitive `json:"cognitive,omitempty"`
}

type superTopicRow struct {
	Title      string   `json:"title"`
	Summary    string   `json:"summary"`
	Rationale  string   `json:"rationale"`
	MemberKeys []string `json:"memberKeys"`
}

type superTopicsBlock struct {
	Topics      []superTopicRow `json:"topics"`
	GeneratedAt string          `json:"generatedAt"`
	Model       string          `json:"model"`
}

func (s *readService) runCourseMap(ctx context.Context, repo RepoRow, userID, clientName string) readResult {
	startTime := time.Now()
	text := formatCourseMap(repo.RepoProfile, repo.NavTree)
	s.recordTelemetry(ctx, CallLogEntry{
		ToolName: "explore_concept", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
		Dimension: "all", Status: "SUCCESS", ResultCount: 1,
		ResponseTimeMs: time.Since(startTime).Milliseconds(),
	})
	return readResult{Text: text}
}

func writeConceptCodeContext(b *strings.Builder, codeCtx *codeClusterRow) {
	if codeCtx == nil {
		return
	}
	b.WriteString("- 所属模块: " + codeCtx.Title)
	if len(codeCtx.Directories) > 0 {
		b.WriteString(" (" + strings.Join(codeCtx.Directories, ", ") + ")")
	}
	b.WriteString("\n")
	if len(codeCtx.Files) > 0 {
		shown := codeCtx.Files
		ellipsis := ""
		if len(shown) > 8 {
			shown = shown[:8]
			ellipsis = " …"
		}
		fmt.Fprintf(b, "- 关联源码 (Code Files, %d): %s%s\n", len(codeCtx.Files), strings.Join(shown, ", "), ellipsis)
	}
}

func formatSuperTopicsCourseMap(raw json.RawMessage) (string, bool) {
	var block superTopicsBlock
	if err := json.Unmarshal(raw, &block); err != nil || len(block.Topics) == 0 || block.GeneratedAt == "" || block.Model == "" {
		return "", false
	}
	coveredKeys := map[string]bool{}
	for _, t := range block.Topics {
		for _, k := range t.MemberKeys {
			coveredKeys[k] = true
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "🗺️ Course Map（知识超主题骨架，%d 个主题域）\n\n", len(block.Topics))
	b.WriteString("```mermaid\nflowchart TD\n")
	for i, t := range block.Topics {
		id := fmt.Sprintf("T%02d", i+1)
		label := strings.ReplaceAll(fmt.Sprintf("%s（%d 概念组）", t.Title, len(t.MemberKeys)), `"`, "''")
		fmt.Fprintf(&b, "  %s[\"%s\"]\n", id, label)
		if i+1 < len(block.Topics) {
			fmt.Fprintf(&b, "  %s --> T%02d\n", id, i+2)
		}
	}
	b.WriteString("```\n\n")
	b.WriteString("主题域清单（用 explore_concept(action=\"details\") 深入任一概念，或 explore_concept(action=\"neighbors\") 查邻居）：\n")
	for _, t := range block.Topics {
		b.WriteString("- " + t.Title)
		if t.Summary != "" {
			b.WriteString(" — " + t.Summary)
		}
		b.WriteString("\n")
	}
	if len(coveredKeys) > 0 {
		generatedOn := "近期"
		if len(block.GeneratedAt) >= 10 {
			generatedOn = block.GeneratedAt[:10]
		}
		fmt.Fprintf(&b, "\n(超主题由图谱凝聚生成于 %s；覆盖 %d 个概念组)\n", generatedOn, len(coveredKeys))
	}
	return b.String(), true
}

func classifyCoursePhase(phaseStr string) int {
	p := strings.ToLower(strings.TrimSpace(phaseStr))
	switch {
	case strings.Contains(p, "perception") || strings.Contains(p, "phase1") || strings.Contains(p, "foundation"):
		return 0
	case strings.Contains(p, "entity") || strings.Contains(p, "phase2") || strings.Contains(p, "core"):
		return 1
	case strings.Contains(p, "pipeline") || strings.Contains(p, "phase3") || strings.Contains(p, "interface"):
		return 2
	case strings.Contains(p, "adapter") || strings.Contains(p, "phase4") || strings.Contains(p, "extension"):
		return 3
	default:
		return 0
	}
}

func formatCodeClustersCourseMap(raw json.RawMessage) (string, bool) {
	var rows []codeClusterRow
	if err := json.Unmarshal(raw, &rows); err != nil {
		return "", false
	}
	var clusters []codeClusterRow
	for _, r := range rows {
		if r.Title != "" && len(r.Files) >= 0 {
			clusters = append(clusters, r)
		}
	}
	sort.SliceStable(clusters, func(i, j int) bool { return clusters[i].TeachingOrder < clusters[j].TeachingOrder })
	if len(clusters) == 0 {
		return "", false
	}
	totalFiles := 0
	for _, c := range clusters {
		totalFiles += len(c.Files)
	}

	hasCognitive := false
	for _, c := range clusters {
		if c.Cognitive != nil && (c.Cognitive.Phase != "" || len(c.Cognitive.UpstreamModules) > 0) {
			hasCognitive = true
			break
		}
	}

	var b strings.Builder
	fmt.Fprintf(&b, "🗺️ Course Map — %d 章 / %d 文件（按教学顺序）\n\n", len(clusters), totalFiles)
	b.WriteString("```mermaid\nflowchart TD\n")

	if !hasCognitive {
		for i, c := range clusters {
			id := fmt.Sprintf("Ch%02d", c.TeachingOrder)
			label := strings.ReplaceAll(fmt.Sprintf("%d. %s（%d 文件）", c.TeachingOrder, c.Title, len(c.Files)), `"`, "''")
			fmt.Fprintf(&b, "  %s[\"%s\"]\n", id, label)
			if i+1 < len(clusters) {
				fmt.Fprintf(&b, "  %s --> Ch%02d\n", id, clusters[i+1].TeachingOrder)
			}
		}
	} else {
		type phaseGroup struct {
			title    string
			clusters []codeClusterRow
		}
		groups := []phaseGroup{
			{title: `subgraph Phase_Foundation["🌱 基础层 (Foundation)"]`},
			{title: `subgraph Phase_Core["⚡️ 核心层 (Core Logic)"]`},
			{title: `subgraph Phase_Interface["🔌 接口层 (Interface & Delivery)"]`},
			{title: `subgraph Phase_Extension["🚀 扩展层 (Advanced Extension)"]`},
		}

		for _, c := range clusters {
			phaseIdx := 0
			if c.Cognitive != nil {
				phaseIdx = classifyCoursePhase(c.Cognitive.Phase)
			}
			groups[phaseIdx].clusters = append(groups[phaseIdx].clusters, c)
		}

		for _, g := range groups {
			if len(g.clusters) == 0 {
				continue
			}
			b.WriteString("  " + g.title + "\n")
			for _, c := range g.clusters {
				id := fmt.Sprintf("Ch%02d", c.TeachingOrder)
				label := strings.ReplaceAll(fmt.Sprintf("%d. %s（%d 文件）", c.TeachingOrder, c.Title, len(c.Files)), `"`, "''")
				fmt.Fprintf(&b, "    %s[\"%s\"]\n", id, label)
			}
			b.WriteString("  end\n")
		}

		lookup := make(map[string]string)
		for _, c := range clusters {
			id := fmt.Sprintf("Ch%02d", c.TeachingOrder)
			lookup[strings.ToLower(c.Title)] = id
			lookup[fmt.Sprintf("ch%02d", c.TeachingOrder)] = id
			lookup[fmt.Sprintf("ch%d", c.TeachingOrder)] = id
			for _, dir := range c.Directories {
				cleanDir := strings.ToLower(strings.Trim(dir, "/"))
				lookup[cleanDir] = id
				lookup[strings.ToLower(filepath.Base(cleanDir))] = id
			}
		}

		type edgePair struct {
			from string
			to   string
		}
		var edges []edgePair
		seenEdges := make(map[string]bool)

		for _, c := range clusters {
			currId := fmt.Sprintf("Ch%02d", c.TeachingOrder)
			if c.Cognitive == nil {
				continue
			}
			for _, up := range c.Cognitive.UpstreamModules {
				cleanUp := strings.ToLower(strings.Trim(strings.TrimSpace(up), "/"))
				fromId, exists := lookup[cleanUp]
				if !exists {
					fromId, exists = lookup[strings.ToLower(filepath.Base(cleanUp))]
				}
				if exists && fromId != currId {
					key := fromId + "-->" + currId
					if !seenEdges[key] {
						seenEdges[key] = true
						edges = append(edges, edgePair{from: fromId, to: currId})
					}
				}
			}
		}

		if len(edges) == 0 {
			for i := 0; i+1 < len(clusters); i++ {
				fromId := fmt.Sprintf("Ch%02d", clusters[i].TeachingOrder)
				toId := fmt.Sprintf("Ch%02d", clusters[i+1].TeachingOrder)
				edges = append(edges, edgePair{from: fromId, to: toId})
			}
		}

		for _, e := range edges {
			fmt.Fprintf(&b, "  %s --> %s\n", e.from, e.to)
		}
	}

	b.WriteString("```\n\n")
	b.WriteString("章节清单（可对任一章用 read / explore_concept 深入）：\n")
	for _, c := range clusters {
		fmt.Fprintf(&b, "- %d. %s — %d 文件\n", c.TeachingOrder, c.Title, len(c.Files))
	}
	return b.String(), true
}

// formatCourseMap 三级优先：conceptSuperTopics → codeClusters → navTree 兜底。
func formatCourseMap(repoProfile json.RawMessage, navTree json.RawMessage) string {
	var profile map[string]json.RawMessage
	if len(repoProfile) > 0 {
		_ = json.Unmarshal(repoProfile, &profile)
	}

	// ① 超主题骨架（形状校验：topics 数组 + generatedAt + model 均在才生效）
	if raw, ok := profile["conceptSuperTopics"]; ok && raw != nil {
		if text, ok := formatSuperTopicsCourseMap(raw); ok {
			return text
		}
	}

	// ② 代码章节教学顺序（行形状校验）
	if raw, ok := profile["codeClusters"]; ok && raw != nil {
		if text, ok := formatCodeClustersCourseMap(raw); ok {
			return text
		}
	}

	// ③ navTree 文件兜底（shortTitle || title || path）
	entries := flattenNavTreeFileEntries(navTree)
	if len(entries) == 0 {
		return "🗺️ Course Map：该仓库无 codeClusters（非代码教学仓），且 navTree 为空，无法生成课程图。可用 outline 查看文档清单。"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "🗺️ Course Map（文档大纲兜底，%d 篇）\n\n", len(entries))
	for i, f := range entries {
		if i >= 50 {
			fmt.Fprintf(&b, "...（其余 %d 篇见 outline 大纲）\n", len(entries)-50)
			break
		}
		fmt.Fprintf(&b, "%d. %s [Path: %s]\n", i+1, f.title, f.path)
	}
	return b.String()
}

type navFileEntry struct{ path, title string }

func flattenNavTreeFileEntries(navTree json.RawMessage) []navFileEntry {
	if len(navTree) == 0 || !strings.HasPrefix(strings.TrimSpace(string(navTree)), "[") {
		return nil
	}
	type rawNavNode struct {
		Type       string       `json:"type"`
		Title      string       `json:"title"`
		ShortTitle string       `json:"shortTitle"`
		Path       string       `json:"path"`
		Children   []rawNavNode `json:"children"`
	}
	var nodes []rawNavNode
	if err := json.Unmarshal(navTree, &nodes); err != nil {
		return nil
	}
	var out []navFileEntry
	var walk func([]rawNavNode)
	walk = func(ns []rawNavNode) {
		for _, n := range ns {
			if n.Type == "file" {
				title := n.ShortTitle
				if title == "" {
					title = n.Title
				}
				if title == "" {
					title = n.Path
				}
				out = append(out, navFileEntry{n.Path, title})
			} else if len(n.Children) > 0 {
				walk(n.Children)
			}
		}
	}
	walk(nodes)
	return out
}
