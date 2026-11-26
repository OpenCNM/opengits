package pipelineb

import (
	"fmt"
	"path"
	"regexp"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

type Course struct {
	Name        string                     `json:"name"`
	Summary     string                     `json:"summary"`
	Phase       string                     `json:"phase,omitempty"`
	SourcePaths []string                   `json:"sourcePaths"`
	Chapters    []cognitive.OutlineChapter `json:"chapters"`
	Topology    *MacroTopology             `json:"topology,omitempty"`
}

type CourseTree struct {
	Repo           string         `json:"repo"`
	OverviewCourse *Course        `json:"overviewCourse,omitempty"`
	SubCourses     []Course       `json:"subCourses"`
	SkippedTrees   []string       `json:"skippedTrees,omitempty"`
	DroppedPlan    []string       `json:"droppedPlan,omitempty"`
	Replanned      bool           `json:"replanned"`
	MacroTopology  *MacroTopology `json:"macroTopology,omitempty"`
}

func BuildCourseTree(repoName string, res *DrillResult, root *RepoTreeNode) *CourseTree {
	tree := &CourseTree{
		Repo:         repoName,
		SkippedTrees: res.SkippedTrees,
		DroppedPlan:  res.DroppedPlan,
		Replanned:    res.Replanned,
	}
	if len(res.Chapters) == 0 {
		return tree
	}

	rootName := ""
	if root != nil {
		rootName = root.Name
	}

	planByName := make(map[string]*PlanChapter, len(res.Plan)*3)
	for i := range res.Plan {
		name := strings.TrimSpace(res.Plan[i].Name)
		planByName[name] = &res.Plan[i]
		clean := StripPhaseSuffix(name)
		planByName[clean] = &res.Plan[i]
		if body := stripChapterPrefix(clean); body != "" {
			planByName[body] = &res.Plan[i]
		}
	}

	type moduleGroup struct {
		title       string
		summary     string
		phase       string
		sourcePaths []string
		chapters    []cognitive.OutlineChapter
	}

	var groups []*moduleGroup
	titleSet := make(map[string]bool)
	currentModTitle := ""
	currentPhase := ""
	currentPrimary := ""
	modIndex := 1

	for i := range res.Chapters {
		ch := res.Chapters[i]
		trimmedName := strings.TrimSpace(ch.Name)
		var pch *PlanChapter
		if i < len(res.Plan) && strings.TrimSpace(res.Plan[i].Name) == trimmedName {
			pch = &res.Plan[i]
		} else if p, ok := planByName[trimmedName]; ok {
			pch = p
		} else if p, ok := planByName[StripPhaseSuffix(trimmedName)]; ok {
			pch = p
		} else if p, ok := planByName[stripChapterPrefix(StripPhaseSuffix(trimmedName))]; ok {
			pch = p
		}

		ch.Name = StripPhaseSuffix(trimmedName)
		res.Chapters[i].Name = ch.Name

		rawTitle := strings.TrimSpace(ch.PartTitle)
		phase := ""
		summary := ch.Summary
		var targetPaths []string
		if pch != nil {
			if rawTitle == "" {
				rawTitle = strings.TrimSpace(pch.ModuleTitle)
			}
			phase = strings.TrimSpace(pch.Phase)
			if pch.Summary != "" {
				summary = pch.Summary
			}
			targetPaths = pch.TargetPaths
		}

		modTitle := rawTitle
		if modTitle == "" {
			primary := ""
			if len(targetPaths) > 0 {
				primary = targetPaths[0]
			} else {
				anchor := []cognitive.OutlineChapter{ch}
				if len(groups) > 0 {
					anchor = groups[len(groups)-1].chapters
				}
				primary = firstFileDir(anchor)
			}
			isRootPrimary := primary == "" || primary == "." || primary == "README.md" || (rootName != "" && primary == rootName)
			currentIsRoot := currentPrimary == "" || currentPrimary == "." || currentPrimary == "README.md" || (rootName != "" && currentPrimary == rootName)

			if isRootPrimary {
				if currentModTitle != "" && currentIsRoot && (phase == "" || phase == currentPhase) {
					modTitle = currentModTitle
				} else {
					modTitle = deriveFallbackModuleTitle(phase, modIndex)
					modIndex++
				}
			} else {
				if currentModTitle != "" && currentPrimary == primary {
					modTitle = currentModTitle
				} else {
					if strings.TrimSpace(phase) == "intro" || strings.TrimSpace(phase) == "advanced" || strings.TrimSpace(phase) == "practice" {
						modTitle = fmt.Sprintf("Module %d: %s Implementation", modIndex, primary)
					} else {
						modTitle = fmt.Sprintf("模块 %d: %s 核心实现", modIndex, primary)
					}
					modIndex++
				}
			}
			currentPrimary = primary
		}

		currentModTitle = modTitle
		if phase != "" {
			currentPhase = phase
		}
		ch.PartTitle = modTitle
		res.Chapters[i].PartTitle = modTitle

		// Strictly contiguous grouping preserves 1..N chapter order without pulling later chapters into closed modules.
		var g *moduleGroup
		if len(groups) > 0 && groups[len(groups)-1].title == modTitle {
			g = groups[len(groups)-1]
		} else {
			actualTitle := modTitle
			if titleSet[actualTitle] {
				actualTitle = fmt.Sprintf("%s (续)", modTitle)
			}
			titleSet[actualTitle] = true
			ch.PartTitle = actualTitle
			res.Chapters[i].PartTitle = actualTitle

			g = &moduleGroup{
				title:   actualTitle,
				summary: summary,
				phase:   phase,
			}
			groups = append(groups, g)
		}

		g.chapters = append(g.chapters, ch)
		for _, tp := range targetPaths {
			if tp != "" && !sliceContains(g.sourcePaths, tp) {
				g.sourcePaths = append(g.sourcePaths, tp)
			}
		}
	}

	// Backfill sourcePaths from chapter files before root fallback so thematic slices still render Scale 2 topologies.
	for _, g := range groups {
		if len(g.sourcePaths) == 0 && len(g.chapters) > 0 {
			if dir := deriveGroupSourceDir(g.chapters); dir != "" {
				g.sourcePaths = []string{dir}
			}
		}
	}

	if len(groups) > 0 {
		firstGroup := groups[0]
		firstSources := firstGroup.sourcePaths
		if len(firstSources) == 0 && rootName != "" {
			firstSources = []string{rootName}
		}
		tree.OverviewCourse = &Course{
			Name:        firstGroup.title,
			Summary:     firstGroup.summary,
			Phase:       firstGroup.phase,
			SourcePaths: firstSources,
			Chapters:    firstGroup.chapters,
		}
		for _, g := range groups[1:] {
			tree.SubCourses = append(tree.SubCourses, Course{
				Name:        g.title,
				Summary:     g.summary,
				Phase:       g.phase,
				SourcePaths: g.sourcePaths,
				Chapters:    g.chapters,
			})
		}
	}

	return tree
}

var phaseSuffixPattern = regexp.MustCompile(`\s*[(（](?:入门|进阶|实战|intro|advanced|practice)[)）]\s*$`)

func StripPhaseSuffix(title string) string {
	return phaseSuffixPattern.ReplaceAllString(title, "")
}

func stripChapterPrefix(title string) string {
	m := mdpat.ChapterPrefixRe.FindStringSubmatch(strings.TrimSpace(title))
	if len(m) > 0 && m[3] != "" {
		return strings.TrimLeft(strings.TrimSpace(m[3]), ":：-—–、. ")
	}
	return strings.TrimSpace(title)
}

func deriveFallbackModuleTitle(phase string, modIndex int) string {
	switch strings.TrimSpace(phase) {
	case "intro":
		return fmt.Sprintf("Module %d: Overview & Fundamentals", modIndex)
	case "advanced":
		return fmt.Sprintf("Module %d: Core Mechanisms & Architecture", modIndex)
	case "practice":
		return fmt.Sprintf("Module %d: Extensions & Real-world Practice", modIndex)
	case "入门", "基础":
		return fmt.Sprintf("模块 %d: 架构全景与基础上手", modIndex)
	case "进阶", "核心":
		return fmt.Sprintf("模块 %d: 核心机制与架构深入", modIndex)
	case "实战", "扩展":
		return fmt.Sprintf("模块 %d: 扩展功能与综合实战", modIndex)
	default:
		return fmt.Sprintf("模块 %d: 基础总览", modIndex)
	}
}

func sliceContains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}

// Normalize root "." directory to "" to align with empty TargetPaths and avoid bogus Scale 2 triggers.
func normalizedFileDir(p string) string {
	dir := path.Dir(p)
	if dir == "." {
		return ""
	}
	return dir
}

func firstFileDir(chapters []cognitive.OutlineChapter) string {
	for _, ch := range chapters {
		for _, f := range ch.Files {
			if strings.TrimSpace(f.Path) != "" {
				return normalizedFileDir(f.Path)
			}
		}
	}
	return ""
}

// Compare path segments rather than string prefixes so "core" never matches "cored".
func commonDirPrefix(a, b string) string {
	if a == "" || b == "" {
		return ""
	}
	aSegs := strings.Split(a, "/")
	bSegs := strings.Split(b, "/")
	n := len(aSegs)
	if len(bSegs) < n {
		n = len(bSegs)
	}
	var segs []string
	for i := 0; i < n; i++ {
		if aSegs[i] != bSegs[i] {
			break
		}
		segs = append(segs, aSegs[i])
	}
	if len(segs) == 0 {
		return ""
	}
	return strings.Join(segs, "/")
}

func deriveGroupSourceDir(chapters []cognitive.OutlineChapter) string {
	var dirs []string
	for _, ch := range chapters {
		for _, f := range ch.Files {
			if strings.TrimSpace(f.Path) != "" {
				dirs = append(dirs, normalizedFileDir(f.Path))
			}
		}
	}
	if len(dirs) == 0 {
		return ""
	}
	common := dirs[0]
	for _, d := range dirs[1:] {
		common = commonDirPrefix(common, d)
		if common == "" {
			break
		}
	}
	if common != "" {
		return common
	}
	return firstFileDir(chapters)
}

func (tree *CourseTree) AttachTopologies(m *RepoMap, patterns cognitive.Patterns) {
	if tree == nil || m == nil {
		return
	}
	tree.MacroTopology = BuildMacroTopology(m, "", 1, patterns)
	if tree.OverviewCourse != nil {
		tree.OverviewCourse.Topology = tree.MacroTopology
	}
	for i := range tree.SubCourses {
		sc := &tree.SubCourses[i]
		scope := ""
		if len(sc.SourcePaths) > 0 {
			scope = sc.SourcePaths[0]
		}
		if scope != "" {
			sc.Topology = BuildMacroTopology(m, scope, 2, patterns)
		}
	}
}
