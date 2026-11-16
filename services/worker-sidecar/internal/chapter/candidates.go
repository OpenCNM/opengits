package chapter

import (
	"github.com/opengits/worker-sidecar/internal/mdpat"

	"regexp"
	"strings"
)

// ─────────────────────────────────────────────────────────────
// 章节候选集构建与教材信号识别
// ─────────────────────────────────────────────────────────────

var chapterMapDashRun = regexp.MustCompile(`[-_]+`)

func replaceConsecutive(s string) string {
	return chapterMapDashRun.ReplaceAllString(s, " ")
}

// DeriveChapterTitle 标题兜底派生（纯格式化）。
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

// BuildChapterCandidates 与 TS buildChapterCandidates 对齐：文档优先占额。
func BuildChapterCandidates(nodes []ChapterMapNode, textRoot string) ChapterCandidates {
	return getDefaultPatterns().BuildChapterCandidates(nodes, textRoot)
}

// BuildChapterCandidates 在 ingestPatterns 实例上构建候选。
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

// ChapterMapFromSidecar 与 TS chapterMapFromSidecar 对齐（零 LLM 金标准）。
func ChapterMapFromSidecar(sidecarContent string, nodes []ChapterMapNode, textRoot string) []ChapterMapEntry {
	return getDefaultPatterns().ChapterMapFromSidecar(sidecarContent, nodes, textRoot)
}

// ChapterMapFromSidecar 在 ingestPatterns 实例上转换侧车为章节映射。
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

// IsTextbookRepoSignal：教材信号（确定性，供 ingest 分流）
// 与 TS isTextbookRepoSignal 对齐：TOC 在场（画像无关）→ 已带章节映射 →
// chapterCount > 0。
func IsTextbookRepoSignal(profile *TextbookRepoProfile, nodes []ChapterMapNode) bool {
	return getDefaultPatterns().IsTextbookRepoSignal(profile, nodes)
}

// IsTextbookRepoSignal 在 ingestPatterns 实例上检查教材信号。
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
