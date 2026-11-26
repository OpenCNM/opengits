package update

import (
	"github.com/opengits/worker-sidecar/internal/cluster"
)

type CandidatePlanBuilder struct {
	diffResult  *UpdateArchiveDiff
	clusters    []ModuleSnapshot
	newClusters []ModuleSnapshot
	clusterDiff *cluster.ClusterDiffResult
	docs        []UpdateDocumentMeta
	ingestMode  string

	docByPath   map[string]UpdateDocumentMeta
	modifiedSet map[string]bool
	removedSet  map[string]bool
	addedSet    map[string]bool

	chapters          []UpdateCandidateChapter
	hitPaths          map[string]bool
	unmatchedFiles    []AffectedFile
	structuralAdds    []UpdateCandidateChapter
	structuralRemoves []UpdateCandidateChapter
	allRepoChapters   []repoChapterMeta
	repoChapterMap    map[string]repoChapterMeta
}

func NewCandidatePlanBuilder(
	diffResult *UpdateArchiveDiff,
	clusters []ModuleSnapshot,
	newClusters []ModuleSnapshot,
	clusterDiff *cluster.ClusterDiffResult,
	docs []UpdateDocumentMeta,
	ingestMode string,
) *CandidatePlanBuilder {
	docByPath := make(map[string]UpdateDocumentMeta, len(docs))
	for _, d := range docs {
		docByPath[d.Path] = d
	}

	modifiedSet := make(map[string]bool, len(diffResult.Modified))
	for _, f := range diffResult.Modified {
		modifiedSet[f] = true
	}
	removedSet := make(map[string]bool, len(diffResult.Removed))
	for _, f := range diffResult.Removed {
		removedSet[f] = true
	}
	addedSet := make(map[string]bool, len(diffResult.Added))
	for _, f := range diffResult.Added {
		addedSet[f] = true
	}

	return &CandidatePlanBuilder{
		diffResult:        diffResult,
		clusters:          clusters,
		newClusters:       newClusters,
		clusterDiff:       clusterDiff,
		docs:              docs,
		ingestMode:        ingestMode,
		docByPath:         docByPath,
		modifiedSet:       modifiedSet,
		removedSet:        removedSet,
		addedSet:          addedSet,
		chapters:          make([]UpdateCandidateChapter, 0),
		hitPaths:          make(map[string]bool),
		unmatchedFiles:    make([]AffectedFile, 0),
		structuralAdds:    make([]UpdateCandidateChapter, 0),
		structuralRemoves: make([]UpdateCandidateChapter, 0),
		allRepoChapters:   make([]repoChapterMeta, 0),
		repoChapterMap:    make(map[string]repoChapterMeta),
	}
}

func (b *CandidatePlanBuilder) pushChapter(p string, title *string, affectedFiles []AffectedFile) {
	if len(affectedFiles) == 0 {
		return
	}
	doc, hasDoc := b.docByPath[p]
	var finalTitle *string
	if title != nil && *title != "" {
		finalTitle = title
	} else if hasDoc && doc.Title != nil {
		finalTitle = doc.Title
	}
	var oldSummary *string
	if hasDoc && doc.Summary != nil {
		oldSummary = doc.Summary
	}
	structural := false
	for _, f := range affectedFiles {
		if f.Change == "added" || f.Change == "removed" {
			structural = true
			break
		}
	}
	chg := "content"
	if structural {
		chg = "structural"
	}
	b.chapters = append(b.chapters, UpdateCandidateChapter{
		Path:          p,
		Title:         finalTitle,
		OldSummary:    oldSummary,
		Change:        chg,
		AffectedFiles: affectedFiles,
	})
	for _, f := range affectedFiles {
		b.hitPaths[f.Path] = true
	}
}

func (b *CandidatePlanBuilder) CollectClusterMatches() {
	if b.clusterDiff != nil && b.newClusters != nil {
		for _, m := range b.clusterDiff.Matched {
			var affectedFiles []AffectedFile
			for _, f := range m.Neu.Files {
				if b.modifiedSet[f] {
					affectedFiles = append(affectedFiles, AffectedFile{Path: f, Change: "modified"})
				} else if b.removedSet[f] {
					affectedFiles = append(affectedFiles, AffectedFile{Path: f, Change: "removed"})
				} else if b.addedSet[f] {
					affectedFiles = append(affectedFiles, AffectedFile{Path: f, Change: "added"})
				}
			}
			t := m.Old.Title
			b.pushChapter(codeChapterPath(clusterChapterNo(m.Old.ChapterNo, m.Old.TeachingOrder)), &t, affectedFiles)
		}
	} else {
		for _, c := range b.clusters {
			var affectedFiles []AffectedFile
			for _, f := range c.Files {
				if b.modifiedSet[f] {
					affectedFiles = append(affectedFiles, AffectedFile{Path: f, Change: "modified"})
				} else if b.removedSet[f] {
					affectedFiles = append(affectedFiles, AffectedFile{Path: f, Change: "removed"})
				} else if b.addedSet[f] {
					affectedFiles = append(affectedFiles, AffectedFile{Path: f, Change: "added"})
				}
			}
			t := c.Title
			b.pushChapter(codeChapterPath(clusterChapterNo(c.ChapterNo, c.TeachingOrder)), &t, affectedFiles)
		}
	}
}

func (b *CandidatePlanBuilder) CollectDocDiffs() {
	for _, p := range b.diffResult.Modified {
		if doc, ok := b.docByPath[p]; ok && !isCodeChapterPath(p) {
			b.chapters = append(b.chapters, UpdateCandidateChapter{
				Path:          p,
				Title:         doc.Title,
				OldSummary:    doc.Summary,
				Change:        "content",
				AffectedFiles: []AffectedFile{{Path: p, Change: "modified"}},
			})
			b.hitPaths[p] = true
		}
	}

	for _, p := range b.diffResult.Removed {
		if doc, ok := b.docByPath[p]; ok && !isCodeChapterPath(p) {
			b.chapters = append(b.chapters, UpdateCandidateChapter{
				Path:          p,
				Title:         doc.Title,
				OldSummary:    doc.Summary,
				Change:        "structural",
				AffectedFiles: []AffectedFile{{Path: p, Change: "removed"}},
			})
			b.hitPaths[p] = true
		}
	}
}

func (b *CandidatePlanBuilder) CollectDeterministicRenames() {
	for _, r := range b.diffResult.Renamed {
		if isCodeChapterPath(r.From) {
			continue
		}
		if doc, ok := b.docByPath[r.From]; ok {
			pair := r
			b.chapters = append(b.chapters, UpdateCandidateChapter{
				Path:          r.From,
				Title:         doc.Title,
				OldSummary:    doc.Summary,
				Change:        "content",
				AffectedFiles: []AffectedFile{{Path: r.From, Change: "renamed"}},
				Rename:        &pair,
			})
			b.hitPaths[r.From] = true
			b.hitPaths[r.To] = true
		}
	}
}

func (b *CandidatePlanBuilder) CollectUnmatchedFiles() {
	pushUnmatched := func(p string, change string) {
		if !b.hitPaths[p] {
			b.unmatchedFiles = append(b.unmatchedFiles, AffectedFile{Path: p, Change: change})
		}
	}
	for _, p := range b.diffResult.Added {
		pushUnmatched(p, "added")
	}
	for _, p := range b.diffResult.Modified {
		pushUnmatched(p, "modified")
	}
	for _, p := range b.diffResult.Removed {
		pushUnmatched(p, "removed")
	}
	for _, r := range b.diffResult.Renamed {
		pushUnmatched(r.From, "renamed")
		pushUnmatched(r.To, "renamed")
	}
}

func (b *CandidatePlanBuilder) CollectStructuralDiffs() {
	if b.clusterDiff == nil {
		return
	}
	if len(b.clusterDiff.Added) > 0 {
		for _, c := range b.clusterDiff.Added {
			aff := make([]AffectedFile, 0, len(c.Files))
			for _, f := range c.Files {
				aff = append(aff, AffectedFile{Path: f, Change: "added"})
			}
			title := c.Title
			b.structuralAdds = append(b.structuralAdds, UpdateCandidateChapter{
				Path:          codeChapterPath(clusterChapterNo(c.ChapterNo, c.TeachingOrder)),
				Title:         &title,
				OldSummary:    nil,
				Change:        "structural",
				AffectedFiles: aff,
			})
		}
	}
	if len(b.clusterDiff.Removed) > 0 {
		for _, c := range b.clusterDiff.Removed {
			p := codeChapterPath(c.TeachingOrder)
			var summary *string
			if doc, ok := b.docByPath[p]; ok && doc.Summary != nil {
				summary = doc.Summary
			}
			title := c.Title
			remItem := UpdateCandidateChapter{
				Path:          p,
				Title:         &title,
				OldSummary:    summary,
				Change:        "structural",
				AffectedFiles: []AffectedFile{},
			}
			b.structuralRemoves = append(b.structuralRemoves, remItem)
		}
		b.chapters = append(b.chapters, b.structuralRemoves...)
	}
}

func (b *CandidatePlanBuilder) CollectRepoChapterMeta() {
	activeClusters := b.clusters
	if len(b.newClusters) > 0 {
		activeClusters = b.newClusters
	}
	for _, c := range activeClusters {
		p := codeChapterPath(clusterChapterNo(c.ChapterNo, c.TeachingOrder))
		doc, hasDoc := b.docByPath[p]
		var title *string
		if c.Title != "" {
			title = &c.Title
		} else if hasDoc && doc.Title != nil {
			title = doc.Title
		}
		var summary *string
		if hasDoc && doc.Summary != nil {
			summary = doc.Summary
		}
		meta := repoChapterMeta{
			Path:    p,
			Title:   title,
			Summary: summary,
			Files:   c.Files,
		}
		b.allRepoChapters = append(b.allRepoChapters, meta)
		b.repoChapterMap[p] = meta
	}
	for _, doc := range b.docs {
		if !isCodeChapterPath(doc.Path) {
			if _, exists := b.repoChapterMap[doc.Path]; !exists {
				meta := repoChapterMeta{
					Path:    doc.Path,
					Title:   doc.Title,
					Summary: doc.Summary,
					Files:   []string{doc.Path},
				}
				b.allRepoChapters = append(b.allRepoChapters, meta)
				b.repoChapterMap[doc.Path] = meta
			}
		}
	}
}

func (b *CandidatePlanBuilder) Build() (
	[]UpdateCandidateChapter,
	[]AffectedFile,
	[]UpdateCandidateChapter,
	[]UpdateCandidateChapter,
	[]repoChapterMeta,
	map[string]repoChapterMeta,
) {
	b.CollectClusterMatches()
	b.CollectDocDiffs()
	b.CollectDeterministicRenames()
	b.CollectUnmatchedFiles()
	b.CollectStructuralDiffs()
	b.CollectRepoChapterMeta()

	return b.chapters, b.unmatchedFiles, b.structuralAdds, b.structuralRemoves, b.allRepoChapters, b.repoChapterMap
}
