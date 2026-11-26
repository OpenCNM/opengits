package ingest

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/chapter"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

type ExcludedCategoryDef struct {
	Label      string   `json:"label"`
	Extensions []string `json:"extensions"`
}

type HighPriorityMigrationPatterns struct {
	Keywords       []string `json:"keywords"`
	VersionPattern *regexp.Regexp
}

type SubsystemDutyDef struct {
	Pattern       *regexp.Regexp
	NamePrefix    string `json:"namePrefix"`
	NamePrefixEn  string `json:"namePrefixEn"`
	Description   string `json:"description"`
	DescriptionEn string `json:"descriptionEn"`
}

type Patterns struct {
	DocExtensions  map[string]bool `json:"docExtensions"`
	CodeExtensions map[string]bool `json:"codeExtensions"`
	nonContentDir  []*regexp.Regexp
	nonContentFile []*regexp.Regexp
	Sniffer        snifferPatterns

	TechAcronyms           map[string]string
	TextOnlyRatioThreshold float64 `json:"textOnlyRatioThreshold"`
	CodeOnlyRatioThreshold float64 `json:"codeOnlyRatioThreshold"`

	EntryPointFiles        map[string]bool `json:"entryPointFiles"`
	EntryPointPrefixes     []string        `json:"entryPointPrefixes"`
	ReadmePattern          *regexp.Regexp
	SubsystemDuties        []SubsystemDutyDef
	DominantSourceDirNames map[string]bool

	testPatterns               []*regexp.Regexp
	metaOrProtocolDocPattern   *regexp.Regexp
	coreDocEntryKeywordPattern *regexp.Regexp
	TopLevelDocDirs            map[string]bool
	TopLevelDocDirsList        []string
	BuildSystemFiles           map[string]bool
	configPatterns             []*regexp.Regexp
	dataModelPatterns          []*regexp.Regexp
	typeHubPatterns            []*regexp.Regexp
	utilityPatterns            []*regexp.Regexp
	BinaryOrArchiveExtensions  map[string]bool

	tocSidecar []*regexp.Regexp

	VirtualChapterPathPrefixes []string `json:"virtualChapterPathPrefixes"`

	HighPriorityMigrationPatterns HighPriorityMigrationPatterns
	ExcludedFileCategories        map[string]ExcludedCategoryDef
	NoisyPathPrefixes             []string
	IgnoredFilenames              map[string]bool
	allowedFileExtensions         *regexp.Regexp

	WebDoc WebDocPatterns
}

type WebDocPatterns struct {
	MainContentSelectors []string
	NoiseSelectors       []string
	LinkAssetPattern     *regexp.Regexp
}

type snifferPatterns struct {
	docRoot            []*regexp.Regexp
	docRootDir         []*regexp.Regexp
	course             []*regexp.Regexp
	courseRootDir      []*regexp.Regexp
	pdfLang            []*regexp.Regexp
	answer             []*regexp.Regexp
	buildScript        []*regexp.Regexp
	translationDir     []*regexp.Regexp
	numericPrefix      *regexp.Regexp
	MarkdownExtensions []string `json:"markdownExtensions"`
}

type IngestPatterns = Patterns

// Match entrypoint prefixes against basename only so full-path substrings like homepage.md do not trigger page.*.
func (p *IngestPatterns) IsEntryPoint(path string) bool {
	if path == "" {
		return false
	}
	base := path
	if idx := strings.LastIndex(path, "/"); idx >= 0 {
		base = path[idx+1:]
	}
	if p.EntryPointFiles[base] {
		return true
	}
	for _, pref := range p.EntryPointPrefixes {
		if strings.HasPrefix(base, pref) {
			return true
		}
	}
	return false
}

func (p *IngestPatterns) IsReadme(path string) bool {
	if path == "" {
		return false
	}
	parts := strings.Split(path, "/")
	filename := parts[len(parts)-1]
	if p.ReadmePattern != nil {
		return p.ReadmePattern.MatchString(filename)
	}
	lower := strings.ToLower(filename)
	return lower == "readme" || strings.HasPrefix(lower, "readme.")
}

func (p *IngestPatterns) IsTestFile(path string) bool {
	if path == "" {
		return false
	}
	for _, re := range p.testPatterns {
		if re.MatchString(path) {
			return true
		}
	}
	return false
}

func (p *IngestPatterns) IsMetaOrProtocolDoc(fileName string) bool {
	if fileName == "" {
		return false
	}
	if p.metaOrProtocolDocPattern != nil && p.metaOrProtocolDocPattern.MatchString(fileName) {
		return true
	}
	return false
}

func (p *IngestPatterns) IsCoreDocEntryKeyword(fileName string) bool {
	if fileName == "" {
		return false
	}
	if p.coreDocEntryKeywordPattern != nil && p.coreDocEntryKeywordPattern.MatchString(fileName) {
		return true
	}
	return false
}

func (p *IngestPatterns) IsTopLevelDocDir(firstSegmentOrPath string) bool {
	if firstSegmentOrPath == "" {
		return false
	}
	lower := strings.ToLower(firstSegmentOrPath)
	parts := strings.Split(lower, "/")
	first := parts[0]
	if p.TopLevelDocDirs[first] {
		return true
	}
	for _, dir := range p.TopLevelDocDirsList {
		if strings.HasPrefix(lower, strings.ToLower(dir)) {
			return true
		}
	}
	return false
}

func (p *IngestPatterns) IsBinaryOrArchiveFile(fp string) bool {
	if fp == "" {
		return false
	}
	ext := strings.ToLower(mdpat.ExtractExtension(fp))
	return p.BinaryOrArchiveExtensions[ext]
}

func (p *IngestPatterns) IsHighPriorityMigrationFile(filePath string) bool {
	if filePath == "" {
		return false
	}
	normalized := strings.TrimLeft(filePath, "/")
	lower := strings.ToLower(normalized)
	segments := strings.Split(lower, "/")
	filename := segments[len(segments)-1]

	isMd := false
	for _, ext := range p.Sniffer.MarkdownExtensions {
		if strings.HasSuffix(filename, ext) {
			isMd = true
			break
		}
	}
	if !isMd {
		return false
	}

	stem := filename
	for _, ext := range p.Sniffer.MarkdownExtensions {
		if strings.HasSuffix(stem, ext) {
			stem = strings.TrimSuffix(stem, ext)
			break
		}
	}

	for _, kw := range p.HighPriorityMigrationPatterns.Keywords {
		if stem == kw {
			return true
		}
		for _, seg := range segments {
			if seg == kw {
				return true
			}
		}
	}

	if p.HighPriorityMigrationPatterns.VersionPattern != nil && p.HighPriorityMigrationPatterns.VersionPattern.MatchString(stem) {
		return true
	}

	return false
}

type FileExclusionVerdict = archive.FileExclusionVerdict

func (p *IngestPatterns) ClassifyExcludedFile(filePath string, size int64) FileExclusionVerdict {
	lowerPath := strings.ToLower(filePath)

	categoryOrder := []string{"archive", "executable", "office_media", "build_db"}
	for _, catKey := range categoryOrder {
		meta, ok := p.ExcludedFileCategories[catKey]
		if !ok {
			continue
		}
		for _, ext := range meta.Extensions {
			if strings.HasSuffix(lowerPath, ext) {
				return FileExclusionVerdict{
					IsExcluded:    true,
					Category:      catKey,
					CategoryLabel: meta.Label,
					Reason:        fmt.Sprintf("文件格式属于【%s】", meta.Label),
				}
			}
		}
	}
	for catKey, meta := range p.ExcludedFileCategories {
		if catKey == "archive" || catKey == "executable" || catKey == "office_media" || catKey == "build_db" {
			continue
		}
		for _, ext := range meta.Extensions {
			if strings.HasSuffix(lowerPath, ext) {
				return FileExclusionVerdict{
					IsExcluded:    true,
					Category:      catKey,
					CategoryLabel: meta.Label,
					Reason:        fmt.Sprintf("文件格式属于【%s】", meta.Label),
				}
			}
		}
	}

	isKnown := false
	if p.allowedFileExtensions != nil {
		isKnown = p.allowedFileExtensions.MatchString(filePath)
	} else {
		isKnown = p.IsDocFile(filePath) || p.IsCodeFile(filePath)
	}

	effectiveCap := int64(2 * 1024 * 1024)
	if isKnown {
		effectiveCap = 5 * 1024 * 1024
	}

	if size > effectiveCap {
		capMb := effectiveCap / (1024 * 1024)
		sizeMb := float64(size) / (1024.0 * 1024.0)
		return FileExclusionVerdict{
			IsExcluded:    true,
			Category:      "oversized",
			CategoryLabel: fmt.Sprintf("超大文件 (>%dMB)", capMb),
			Reason:        fmt.Sprintf("单文件体积 %.1fMB 超过 %dMB 限制", sizeMb, capMb),
		}
	}

	return FileExclusionVerdict{IsExcluded: false}
}

func (p *IngestPatterns) IsNoisyPath(path string) bool {
	for _, prefix := range p.NoisyPathPrefixes {
		dir := strings.TrimSuffix(prefix, "/")
		if path == dir || strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

func (p *IngestPatterns) IsIgnoredFilename(filename string) bool {
	return p.IgnoredFilenames[strings.ToLower(filename)]
}

func (p *IngestPatterns) IsHiddenFileOrDir(path string) bool {
	segments := strings.Split(path, "/")
	for _, seg := range segments {
		if strings.HasPrefix(seg, ".") && seg != "." && seg != ".." {
			return true
		}
	}
	return false
}

func (p *IngestPatterns) IsMarkdownDocPath(path string) bool {
	if p == nil {
		return false
	}
	lower := strings.ToLower(path)
	for _, ext := range p.Sniffer.MarkdownExtensions {
		if strings.HasSuffix(lower, strings.ToLower(ext)) {
			return true
		}
	}
	return false
}

func (p *IngestPatterns) IsVirtualChapterPath(path string) bool {
	if p == nil {
		return false
	}
	for _, prefix := range p.VirtualChapterPathPrefixes {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

func isMarkdownDocPath(p *IngestPatterns, path string) bool {
	return p.IsMarkdownDocPath(path)
}

func isVirtualChapterPath(p *IngestPatterns, path string) bool {
	return p.IsVirtualChapterPath(path)
}

func (p *IngestPatterns) IsMarkdown(path string) bool {
	return p.IsMarkdownDocPath(path)
}

func (p *IngestPatterns) IsEntryPointFile(filename string) bool {
	if p == nil || p.EntryPointFiles == nil {
		return false
	}
	return p.EntryPointFiles[filename]
}

func (p *IngestPatterns) IsBuildSystemFile(filename string) bool {
	if p == nil || p.BuildSystemFiles == nil {
		return false
	}
	return p.BuildSystemFiles[strings.ToLower(filename)]
}

func (p *IngestPatterns) MarkdownExtensions() []string {
	if p == nil || len(p.Sniffer.MarkdownExtensions) == 0 {
		return []string{".md", ".markdown", ".mdx"}
	}
	return p.Sniffer.MarkdownExtensions
}

func (p *IngestPatterns) IsConfigFile(filename string) bool {
	if p == nil {
		return false
	}
	for _, re := range p.configPatterns {
		if re.MatchString(filename) {
			return true
		}
	}
	return false
}

func (p *IngestPatterns) IsDataModelFile(filename string) bool {
	if p == nil {
		return false
	}
	for _, re := range p.dataModelPatterns {
		if re.MatchString(filename) {
			return true
		}
	}
	return false
}

func (p *IngestPatterns) IsTypeHubFile(filename string) bool {
	if p == nil {
		return false
	}
	for _, re := range p.typeHubPatterns {
		if re.MatchString(filename) {
			return true
		}
	}
	return false
}

func (p *IngestPatterns) IsUtilityFile(filename string) bool {
	if p == nil {
		return false
	}
	for _, re := range p.utilityPatterns {
		if re.MatchString(filename) {
			return true
		}
	}
	return false
}

type (
	ChapterMapNode      = chapter.ChapterMapNode
	ChapterMapAsset     = chapter.ChapterMapAsset
	ChapterMapEntry     = chapter.ChapterMapEntry
	ChapterCandidates   = chapter.ChapterCandidates
	OrderSignal         = chapter.OrderSignal
	TextbookRepoProfile = chapter.TextbookRepoProfile
)

func (p *IngestPatterns) BuildChapterCandidates(nodes []ChapterMapNode, textRoot string) ChapterCandidates {
	return chapter.BuildChapterCandidates(nodes, textRoot)
}

func (p *IngestPatterns) DetectOrderSignal(scopedTree []ChapterMapNode, tocContent string, readmeHead string, prefix string) OrderSignal {
	return chapter.DetectOrderSignal(scopedTree, tocContent, readmeHead, prefix)
}

func (p *IngestPatterns) FindTocSidecarPath(nodes []ChapterMapNode, textRoot string) *string {
	return chapter.FindTocSidecarPath(nodes, textRoot)
}

func (p *IngestPatterns) ChapterMapFromSidecar(sidecarContent string, nodes []ChapterMapNode, textRoot string) []ChapterMapEntry {
	return chapter.ChapterMapFromSidecar(sidecarContent, nodes, textRoot)
}

func (p *IngestPatterns) ValidateChapterMap(raw json.RawMessage, nodes []ChapterMapNode) []ChapterMapEntry {
	return chapter.ValidateChapterMap(raw, nodes)
}

func (p *IngestPatterns) IsTextbookRepoSignal(profile *TextbookRepoProfile, nodes []ChapterMapNode) bool {
	return chapter.IsTextbookRepoSignal(profile, nodes)
}

func (p *IngestPatterns) MatchesAllowedFileExtension(filePath string) bool {
	if p == nil || p.allowedFileExtensions == nil {
		return false
	}
	return p.allowedFileExtensions.MatchString(strings.ToLower(filePath))
}
