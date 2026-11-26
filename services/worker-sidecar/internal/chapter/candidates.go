package chapter

import (
	"github.com/opengits/worker-sidecar/internal/mdpat"

	"regexp"
	"strings"
)

var chapterMapDashRun = regexp.MustCompile(`[-_]+`)

func replaceConsecutive(s string) string {
	return chapterMapDashRun.ReplaceAllString(s, " ")
}

func DeriveChapterTitle(path string) string {
	return deriveChapterTitle(path)
}

func deriveChapterTitle(path string) string {
	base := path
	if idx := strings.LastIndex(path, "/"); idx >= 0 {
		base = path[idx+1:]
	}
	if base == "" {
		base = path
	}
	ext := mdpat.ExtractExtensionLower(base)
	stem := base
	if ext != "" && len(base) > len(ext) {
		stem = base[:len(base)-len(ext)]
	}
	stem = replaceConsecutive(stem)
	if trimmed := strings.TrimSpace(stem); trimmed != "" {
		return trimmed
	}
	return base
}

func BuildChapterCandidates(nodes []ChapterMapNode, textRoot string) ChapterCandidates {
	return getDefaultPatterns().BuildChapterCandidates(nodes, textRoot)
}

func (p *ingestPatterns) BuildChapterCandidates(nodes []ChapterMapNode, textRoot string) ChapterCandidates {
	root := normalizeRootPrefix(textRoot)
	docFiles := []string{}
	codeFiles := []string{}
	for _, node := range nodes {
		if node.Type != "blob" {
			continue
		}
		if root != "" && !strings.HasPrefix(node.Path, root) {
			continue
		}
		if p.isDocFilePath(node.Path) {
			docFiles = append(docFiles, node.Path)
		} else if p.isCodeFilePath(node.Path) {
			codeFiles = append(codeFiles, node.Path)
		}
	}
	SortNaturalStable(docFiles)
	SortNaturalStable(codeFiles)

	docCapped := docFiles
	if len(docCapped) > ChapterMapCandidateCap {
		docCapped = docCapped[:ChapterMapCandidateCap]
	}
	codeBudget := ChapterMapCandidateCap - len(docCapped)
	if codeBudget < 0 {
		codeBudget = 0
	}
	codeCapped := codeFiles
	if len(codeCapped) > codeBudget {
		codeCapped = codeCapped[:codeBudget]
	}
	return ChapterCandidates{DocFiles: docCapped, CodeFiles: codeCapped}
}

func ChapterMapFromSidecar(sidecarContent string, nodes []ChapterMapNode, textRoot string) []ChapterMapEntry {
	return getDefaultPatterns().ChapterMapFromSidecar(sidecarContent, nodes, textRoot)
}

func (p *ingestPatterns) ChapterMapFromSidecar(sidecarContent string, nodes []ChapterMapNode, textRoot string) []ChapterMapEntry {
	signal := p.DetectOrderSignal(nodes, sidecarContent, "", textRoot)
	if signal.Type != "toc" {
		return nil
	}
	mainPaths := []string{}
	for _, path := range signal.Sequence {
		if p.isDocFilePath(path) {
			mainPaths = append(mainPaths, path)
		}
	}
	if len(mainPaths) < ChapterMapMinChapters {
		return nil
	}
	entries := make([]ChapterMapEntry, len(mainPaths))
	for i, path := range mainPaths {
		entries[i] = ChapterMapEntry{
			Order:      i + 1,
			Title:      deriveChapterTitle(path),
			MainPath:   path,
			AssetPaths: []ChapterMapAsset{},
		}
	}
	return entries
}

func IsTextbookRepoSignal(profile *TextbookRepoProfile, nodes []ChapterMapNode) bool {
	return getDefaultPatterns().IsTextbookRepoSignal(profile, nodes)
}

func (p *ingestPatterns) IsTextbookRepoSignal(profile *TextbookRepoProfile, nodes []ChapterMapNode) bool {
	if p.FindTocSidecarPath(nodes, "") != nil {
		return true
	}
	if profile == nil {
		return false
	}
	if len(profile.ChapterMap) > 0 {
		return true
	}
	return profile.ChapterCount != nil && *profile.ChapterCount > 0
}
