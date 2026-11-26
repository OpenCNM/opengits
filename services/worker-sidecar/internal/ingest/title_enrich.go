package ingest

import (
	"fmt"
	"path"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

func enrichPlanFileTitles(plan *ChapterPlan, readFile func(p string) (string, bool)) {
	if plan == nil || readFile == nil {
		return
	}
	changed := make(map[string]string)
	for i := range plan.Chapters {
		before := chapterFileTitles(plan.Chapters[i])
		enrichChapterFileTitles(&plan.Chapters[i], readFile)
		disambiguateChapterFileTitles(&plan.Chapters[i])
		recordTitleChanges(changed, before, plan.Chapters[i])
	}
	if len(changed) == 0 {
		return
	}
	resyncDraftNodeTitles(&plan.Draft, changed)
	resyncNavTreeTitles(plan.NavTree, changed)
}

func enrichChapterFileTitles(ch *ChapterInput, readFile func(p string) (string, bool)) {
	for i := range ch.Files {
		f := &ch.Files[i]
		if !mdpat.MdMarkdownExtRe.MatchString(f.Path) {
			continue
		}
		if !isDerivedFileTitle(f.ShortTitle, f.Path) {
			continue
		}
		raw, ok := readFile(f.Path)
		if !ok {
			continue
		}
		if h1 := mdpat.FirstAtxHeading(headOf(raw)); h1 != "" {
			f.ShortTitle = h1
		}
	}
}

func disambiguateChapterFileTitles(ch *ChapterInput) {
	grouped := make(map[string][]int)
	for i, f := range ch.Files {
		key := strings.ToLower(strings.TrimSpace(f.ShortTitle))
		grouped[key] = append(grouped[key], i)
	}
	for _, idxs := range grouped {
		if len(idxs) < 2 {
			continue
		}
		for _, i := range idxs {
			if dir := parentDirLabel(ch.Files[i].Path); dir != "" {
				ch.Files[i].ShortTitle = fmt.Sprintf("%s · %s", ch.Files[i].ShortTitle, dir)
			}
		}
	}
}

func chapterFileTitles(ch ChapterInput) map[string]string {
	titles := make(map[string]string, len(ch.Files))
	for _, f := range ch.Files {
		titles[f.Path] = f.ShortTitle
	}
	return titles
}

func recordTitleChanges(changed, before map[string]string, after ChapterInput) {
	for _, f := range after.Files {
		if old, ok := before[f.Path]; ok && old != f.ShortTitle {
			changed[f.Path] = f.ShortTitle
		}
	}
}

func resyncDraftNodeTitles(draft *OutlineDraft, changed map[string]string) {
	if draft == nil {
		return
	}
	for i := range draft.Chapters {
		nodes := draft.Chapters[i].Nodes
		for j := range nodes {
			if title, ok := changed[nodes[j].SourcePath]; ok && title != "" {
				nodes[j].Title = title
			}
		}
	}
}

func resyncNavTreeTitles(navTree []*NavNode, changed map[string]string) {
	for _, n := range navTree {
		if n == nil {
			continue
		}
		if n.Type == "file" {
			if title, ok := changed[n.Path]; ok && title != "" {
				n.Title = title
			}
		}
		resyncNavTreeTitles(n.Children, changed)
	}
}

func isDerivedFileTitle(title, filePath string) bool {
	t := strings.TrimSpace(title)
	if t == "" {
		return true
	}
	base := path.Base(filePath)
	base = mdpat.MdMarkdownExtRe.ReplaceAllString(base, "")
	base = strings.ReplaceAll(strings.ReplaceAll(base, "-", " "), "_", " ")
	return strings.EqualFold(t, strings.TrimSpace(base))
}

func parentDirLabel(filePath string) string {
	dir := path.Dir(filePath)
	if dir == "." || dir == "/" {
		return ""
	}
	return path.Base(dir)
}

const titleEnrichHeadBytes = 8192

// Truncate at line boundary within 8KB head budget so partial lines never parse as false H1 headings.
func headOf(raw string) string {
	if len(raw) <= titleEnrichHeadBytes {
		return raw
	}
	head := raw[:titleEnrichHeadBytes]
	if idx := strings.LastIndexByte(head, '\n'); idx >= 0 {
		return head[:idx]
	}
	return ""
}
