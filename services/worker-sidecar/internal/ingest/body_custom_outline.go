package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

type DraftOutlineFile struct {
	Path           string   `json:"path"`
	Anchor         string   `json:"anchor,omitempty"`
	Title          string   `json:"title,omitempty"`
	ShortTitle     string   `json:"shortTitle,omitempty"`
	CompanionFiles []string `json:"companionFiles,omitempty"`
}

func (f *DraftOutlineFile) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err == nil {
		if strings.Contains(s, "#") {
			parts := strings.SplitN(s, "#", 2)
			f.Path = parts[0]
			f.Anchor = parts[1]
			f.ShortTitle = parts[1]
		} else {
			f.Path = s
			f.ShortTitle = docFallbackTitle(s)
		}
		return nil
	}
	type alias DraftOutlineFile
	var a alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	*f = DraftOutlineFile(a)
	if f.Anchor == "" && strings.Contains(f.Path, "#") {
		parts := strings.SplitN(f.Path, "#", 2)
		f.Path = parts[0]
		f.Anchor = parts[1]
	}
	return nil
}

type DraftOutlineChapter struct {
	Name    string             `json:"name"`
	Title   string             `json:"title"`
	Summary string             `json:"summary"`
	Files   []DraftOutlineFile `json:"files"`
}

type DraftOutlineContent struct {
	Category    string                `json:"category"`
	Tags        []string              `json:"tags"`
	BestUsedFor []string              `json:"bestUsedFor"`
	Outline     []DraftOutlineChapter `json:"outline"`
	Modules     []ConfirmedModule     `json:"modules"`
}

func parseDraftOutline(raw []byte) (DraftOutlineContent, bool) {
	if len(raw) <= 2 {
		return DraftOutlineContent{}, false
	}
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, "\"") {
		var unquoted string
		if err := json.Unmarshal(raw, &unquoted); err == nil && len(unquoted) > 2 {
			return parseDraftOutline([]byte(unquoted))
		}
	}
	if strings.HasPrefix(trimmed, "[") {
		var chapters []DraftOutlineChapter
		if err := json.Unmarshal(raw, &chapters); err == nil && len(chapters) > 0 {
			return DraftOutlineContent{Outline: chapters}, true
		}
	}
	var content DraftOutlineContent
	if err := json.Unmarshal(raw, &content); err == nil {
		return content, true
	}
	return DraftOutlineContent{}, false
}

type CustomOutlineFile struct {
	Path           string   `json:"path"`
	Anchor         string   `json:"anchor,omitempty"`
	Title          string   `json:"title,omitempty"`
	ShortTitle     string   `json:"shortTitle,omitempty"`
	CompanionFiles []string `json:"companionFiles,omitempty"`
}

func (f *CustomOutlineFile) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err == nil {
		p, a := mdpat.SplitPathAnchor(s)
		f.Path = p
		f.Anchor = a
		f.ShortTitle = docFallbackTitle(p)
		if a != "" {
			f.ShortTitle = a
		}
		return nil
	}
	type alias CustomOutlineFile
	var a alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	p, anchor := mdpat.SplitPathAnchor(a.Path)
	if anchor != "" && a.Anchor == "" {
		a.Anchor = anchor
	}
	a.Path = p
	*f = CustomOutlineFile(a)
	return nil
}

type CustomOutlineCategory struct {
	Name      string              `json:"name"`
	Title     string              `json:"title,omitempty"`
	Summary   string              `json:"summary,omitempty"`
	PartTitle string              `json:"partTitle,omitempty"`
	Files     []CustomOutlineFile `json:"files,omitempty"`
}

func parseCustomOutline(raw []byte) ([]CustomOutlineCategory, bool) {
	if len(raw) <= 2 {
		return nil, false
	}
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, "\"") {
		var unquoted string
		if err := json.Unmarshal(raw, &unquoted); err == nil && len(unquoted) > 2 {
			return parseCustomOutline([]byte(unquoted))
		}
	}
	if strings.HasPrefix(trimmed, "[") {
		var list []CustomOutlineCategory
		if err := json.Unmarshal(raw, &list); err == nil && len(list) > 0 {
			return list, true
		}
	}
	var wrapper struct {
		Categories []CustomOutlineCategory `json:"categories"`
		Cats       []CustomOutlineCategory `json:"cats"`
		Outline    []CustomOutlineCategory `json:"outline"`
	}
	if err := json.Unmarshal(raw, &wrapper); err == nil {
		if len(wrapper.Categories) > 0 {
			return wrapper.Categories, true
		}
		if len(wrapper.Cats) > 0 {
			return wrapper.Cats, true
		}
		if len(wrapper.Outline) > 0 {
			return wrapper.Outline, true
		}
	}
	return nil, false
}

// Collect both main paths and companionFiles (stripping #anchor) so scoped/giant truncation keeps companion code.
func collectCustomOutlineKeepPaths(categories []CustomOutlineCategory) map[string]bool {
	keep := make(map[string]bool, 64)
	addPath := func(raw string) {
		p, _ := mdpat.SplitPathAnchor(strings.TrimSpace(raw))
		if p != "" {
			keep[p] = true
		}
	}
	for _, c := range categories {
		for _, f := range c.Files {
			addPath(f.Path)
			for _, comp := range f.CompanionFiles {
				addPath(comp)
			}
		}
	}
	return keep
}

func buildSnapshotsFromCustomOutline(
	categories []CustomOutlineCategory,
	activeModuleNames []string,
	scopeBlobSet map[string]bool,
) []ModuleSnapshot {
	activeCategories := categories
	if len(activeModuleNames) > 0 {
		activeSet := make(map[string]bool, len(activeModuleNames))
		for _, name := range activeModuleNames {
			activeSet[name] = true
		}
		var filtered []CustomOutlineCategory
		for _, cat := range categories {
			if activeSet[cat.Name] || (cat.Title != "" && activeSet[cat.Title]) {
				filtered = append(filtered, cat)
			}
		}
		if len(filtered) > 0 {
			activeCategories = filtered
		}
	}

	var snapshots []ModuleSnapshot
	order := 1
	for _, cat := range activeCategories {
		seenFiles := make(map[string]bool)
		var candidateFiles []string
		for _, f := range cat.Files {
			fullPath := mdpat.JoinPathAnchor(f.Path, f.Anchor)
			if fullPath != "" && !seenFiles[fullPath] {
				seenFiles[fullPath] = true
				candidateFiles = append(candidateFiles, fullPath)
			}
			for _, comp := range f.CompanionFiles {
				if comp != "" && !seenFiles[comp] {
					seenFiles[comp] = true
					candidateFiles = append(candidateFiles, comp)
				}
			}
		}

		var validFiles []string
		if len(scopeBlobSet) > 0 {
			for _, p := range candidateFiles {
				basePath, _ := mdpat.SplitPathAnchor(p)
				if scopeBlobSet[basePath] {
					validFiles = append(validFiles, p)
				}
			}
		} else {
			validFiles = candidateFiles
		}

		if len(validFiles) == 0 {
			continue
		}

		seenDirs := make(map[string]bool)
		var directories []string
		for _, f := range validFiles {
			basePath, _ := mdpat.SplitPathAnchor(f)
			if idx := strings.LastIndex(basePath, "/"); idx >= 0 {
				dir := basePath[:idx+1]
				if !seenDirs[dir] {
					seenDirs[dir] = true
					directories = append(directories, dir)
				}
			}
		}
		sort.Strings(directories)
		if directories == nil {
			directories = make([]string, 0)
		}

		title := cat.Name
		if title == "" {
			title = cat.Title
		}
		if title == "" {
			title = fmt.Sprintf("Chapter %d", order)
		} else {
			title = cognitive.RenumberChapterTitle(title, order)
		}

		snapshots = append(snapshots, ModuleSnapshot{
			TeachingOrder: order,
			ChapterNo:     order,
			Title:         title,
			Summary:       cat.Summary,
			Directories:   directories,
			Granularity:   "standard",
			Files:         validFiles,
			PartTitle:     cat.PartTitle,
		})
		order++
	}

	if snapshots == nil {
		snapshots = make([]ModuleSnapshot, 0)
	}
	return snapshots
}

func chaptersFromSnapshots(snapshots []ModuleSnapshot) []ChapterInput {
	chapters := make([]ChapterInput, len(snapshots))
	for i, s := range snapshots {
		chapters[i] = ChapterInput{
			Title:     s.Title,
			PartTitle: s.PartTitle,
			Files: []ChapterFile{
				{
					Path:       fmt.Sprintf("chapters/%02d.mdx", s.ChapterNo),
					ShortTitle: s.Title,
				},
			},
		}
	}
	return chapters
}

func buildCodePlanFromSnapshots(ctx context.Context, cfg Config, deps IngestBodyDeps, job JobRow, sha string, nodes []GitNode, patterns *Patterns, targetLang string, snapshots []ModuleSnapshot) (*ChapterPlan, error) {
	artifact, gerr := buildGraphArtifact(ctx, cfg, deps, job, sha, nodes)
	if gerr != nil {
		return nil, gerr
	}
	attachCognitiveMetadata(artifact, snapshots)
	return buildCodeRepoPlan(snapshots, nodes, patterns, job.Owner, job.Repo, targetLang), nil
}
