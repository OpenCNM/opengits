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

// ─────────────────────────────────────────────────────────────
// ingest 判定模式清单：单一事实源为 Go 原生注册表 DefaultPatterns()
// （patterns_native.go，与 TS MODULE_ROLE_PATTERNS 语义对齐）。
// 历史 TS 导出 JSON 管道（export-ingest-patterns.ts → ingest-patterns.json）
// 已随 TS 抓取引擎退役一并拆除；testdata/ingest-patterns.golden.json 仅作
// 冻结夹具供 patterns_parity_test.go 反漂移对拍。
// ─────────────────────────────────────────────────────────────

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

	// giant-repo / explorer patterns (Milestone 3)
	EntryPointFiles        map[string]bool `json:"entryPointFiles"`
	EntryPointPrefixes     []string        `json:"entryPointPrefixes"`
	ReadmePattern          *regexp.Regexp
	SubsystemDuties        []SubsystemDutyDef
	DominantSourceDirNames map[string]bool

	// outline heuristic / rule engine / flat probe patterns (Unit 1.3)
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

	// chapter-map 教材分流（TOC 侧车文件名模式：SUMMARY.md / _sidebar.md）
	tocSidecar []*regexp.Regexp

	// prepare 下沉（D组端点3）：虚拟章节前缀（code-chapter 分流判定）
	VirtualChapterPathPrefixes []string `json:"virtualChapterPathPrefixes"`

	// scout 探测阶段下沉规则（单一事实源导出）
	HighPriorityMigrationPatterns HighPriorityMigrationPatterns
	ExcludedFileCategories        map[string]ExcludedCategoryDef
	NoisyPathPrefixes             []string
	IgnoredFilenames              map[string]bool
	allowedFileExtensions         *regexp.Regexp

	// web-doc 抓取选择器（web-doc/selectors.ts 单一事实源导出；cascadia 消费）
	WebDoc WebDocPatterns
}

// WebDocPatterns web-doc 正文定位 / 噪声移除 / 资产过滤模式。
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

// IngestPatterns 是 Patterns 的向后兼容别名。
type IngestPatterns = Patterns

// IsEntryPoint 判定文件是否是子系统核心入口文件（从导出 patterns 判定，零硬编码）。
// 前缀只对 basename 生效（对齐 cluster/patterns.go 同语义实现）：
// 全路径 Contains 会让 homepage.md 命中 "page."、myapp.ts 命中 "app."。
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

// IsReadme 判定文件是否是 README 文档（从导出 patterns 判定，零硬编码）。
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

// IsTestFile 判定是否为测试文件（从导出 patterns 判定，零硬编码）。
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

// IsMetaOrProtocolDoc 判定是否为协议/许可/贡献指南等非教学元文档。
func (p *IngestPatterns) IsMetaOrProtocolDoc(fileName string) bool {
	if fileName == "" {
		return false
	}
	if p.metaOrProtocolDocPattern != nil && p.metaOrProtocolDocPattern.MatchString(fileName) {
		return true
	}
	return false
}

// IsCoreDocEntryKeyword 判定是否命中教程核心入口关键词。
func (p *IngestPatterns) IsCoreDocEntryKeyword(fileName string) bool {
	if fileName == "" {
		return false
	}
	if p.coreDocEntryKeywordPattern != nil && p.coreDocEntryKeywordPattern.MatchString(fileName) {
		return true
	}
	return false
}

// IsTopLevelDocDir 判定是否为顶级教学文档目录（支持首段或完整路径）。
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

// IsBinaryOrArchiveFile 判定是否为二进制、压缩包或媒体非文本资产。
func (p *IngestPatterns) IsBinaryOrArchiveFile(fp string) bool {
	if fp == "" {
		return false
	}
	ext := strings.ToLower(mdpat.ExtractExtension(fp))
	return p.BinaryOrArchiveExtensions[ext]
}

// IsHighPriorityMigrationFile 判定是否为高优先级迁移/版本过渡文档（单一事实源导出，零硬编码）。
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

// FileExclusionVerdict represents file exclusion classification result.
type FileExclusionVerdict = archive.FileExclusionVerdict

// ClassifyExcludedFile 对齐 TS classifyExcludedFile（4 大显式维度黑名单 + 差异化单文件体积上限）。
func (p *IngestPatterns) ClassifyExcludedFile(filePath string, size int64) FileExclusionVerdict {
	lowerPath := strings.ToLower(filePath)

	// 1. 优先判定 4 大维度显式黑名单（压缩包、二进制、办公文档、构建/缓存数据库）
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

	// 2. 差异化体积兜底：
	// - 已知合法源代码/Markdown文档：放宽至 5MB
	// - 未知/通用数据文件：维持 2MB
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

// IsNoisyPath 检查路径是否命中嘈杂前缀。
func (p *IngestPatterns) IsNoisyPath(path string) bool {
	for _, prefix := range p.NoisyPathPrefixes {
		dir := strings.TrimSuffix(prefix, "/")
		if path == dir || strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

// IsIgnoredFilename 检查文件名是否命中忽略清单。
func (p *IngestPatterns) IsIgnoredFilename(filename string) bool {
	return p.IgnoredFilenames[strings.ToLower(filename)]
}

// IsHiddenFileOrDir 检查路径是否包含隐藏文件或目录（.开头）。
func (p *IngestPatterns) IsHiddenFileOrDir(path string) bool {
	segments := strings.Split(path, "/")
	for _, seg := range segments {
		if strings.HasPrefix(seg, ".") && seg != "." && seg != ".." {
			return true
		}
	}
	return false
}

// IsMarkdownDocPath checks whether a path matches registered markdown doc extensions.
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

// IsVirtualChapterPath checks whether a path begins with a virtual chapter prefix.
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

// IsMarkdown 检查路径是否命中 markdown 文档扩展名（满足 transform.Patterns 契约）。
func (p *IngestPatterns) IsMarkdown(path string) bool {
	return p.IsMarkdownDocPath(path)
}

// IsEntryPointFile 判定文件名是否属于子系统核心入口文件集合。
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

// ─────────────────────────────────────────────────────────────
// Chapter compatibility methods delegating to internal/chapter
// ─────────────────────────────────────────────────────────────

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

// MatchesAllowedFileExtension 内容扩展白名单（ingest-patterns.json
// allowedFileExtensions，镜像 Node ALLOWED_FILE_EXTENSIONS；大小写不敏感）。
func (p *IngestPatterns) MatchesAllowedFileExtension(filePath string) bool {
	if p == nil || p.allowedFileExtensions == nil {
		return false
	}
	return p.allowedFileExtensions.MatchString(strings.ToLower(filePath))
}
