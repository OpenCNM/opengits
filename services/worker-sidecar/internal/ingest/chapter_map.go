package ingest

// 作用域过滤 / 自定义大纲格式化 / 章节映射链 / 课程树渲染。
//
// 2026-09-17 Node 老管线（engine/ingest.ts）物理删除时自 TS 移植，语义逐字对齐：
// - filterNodesByScope / resolveTranslationScopeConflict ← ingest.ts:146-160/192-205
// - buildChaptersFromCustomOutline ← ingest.ts:287-331（text_only 口径）
// - runChapterMapChain ← chapter-map.ts runChapterMap（TOC 金标准 → 数字前缀 → BYOK LLM）
// - buildCurriculumTreeFromMap ← curriculum-builder.ts buildCurriculumTreeFromMap
// 确定性段全部复用 internal/chapter 冻结契约（chapter-map.golden.json 锁定）。

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/chapter"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// ---------- 画像增强辅助 ----------

// profileToMap SniffProfile → map（增强字段的挂载点：chapterMap/profileVersion/ingestPrefix）。
func profileToMap(profile SniffProfile) map[string]any {
	blob, err := json.Marshal(profile)
	if err != nil {
		return map[string]any{}
	}
	var m map[string]any
	if err := json.Unmarshal(blob, &m); err != nil {
		return map[string]any{}
	}
	if m == nil {
		return map[string]any{}
	}
	return m
}

// scopePrefixPtr 空串 → nil（快照 Prefix 可空语义）。
func scopePrefixPtr(prefix string) *string {
	if prefix == "" {
		return nil
	}
	return &prefix
}

// ---------- 作用域过滤（prefix 作用域，Scope-First 分流的数据面） ----------

// resolveScopePrefix 作用域前缀解析：prefixFilter 优先（向导归一后的有效作用域），缺席回退 prefix。
func resolveScopePrefix(prefixFilter, prefix string) string {
	if prefixFilter != "" {
		return prefixFilter
	}
	return prefix
}

var rootReadmeRe = regexp.MustCompile(`(?i)^readme\.(md|mdx|markdown)$`)

// splitScopePrefixes 逗号分隔多前缀：逐段 trim、去首尾斜杠、空段丢弃（对齐 TS ingest.ts:147-148）。
func splitScopePrefixes(prefixFilter string) []string {
	raw := strings.Split(prefixFilter, ",")
	out := make([]string, 0, len(raw))
	for _, p := range raw {
		p = strings.Trim(p, " ")
		p = strings.Trim(p, "/")
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// isRootReadme 根 README 豁免：无斜杠且 readme 扩展名（大小写不敏感），避免跨作用域 README 蒸发。
func isRootReadme(p string) bool {
	return !strings.Contains(p, "/") && rootReadmeRe.MatchString(p)
}

// filterNodesByScope 按前缀过滤节点：前缀内（精确等值或 p+"/" 子路径）或根 README。
func filterNodesByScope(nodes []GitNode, prefixFilter string) []GitNode {
	prefixes := splitScopePrefixes(prefixFilter)
	if len(prefixes) == 0 {
		return nodes
	}
	out := make([]GitNode, 0, len(nodes))
	for _, n := range nodes {
		under := false
		for _, p := range prefixes {
			if n.Path == p || strings.HasPrefix(n.Path, p+"/") {
				under = true
				break
			}
		}
		if under || isRootReadme(n.Path) {
			out = append(out, n)
		}
	}
	return out
}

// resolveTranslationScopeConflict 翻译目录与所选作用域冲突消解：
// 所选前缀与某 translationRoot 互为祖先/子孙时，该目录就是用户要的正文，从过滤清单剔除
// （否则所选作用域会被翻译过滤全部滤空）。对齐 TS ingest.ts:192-205。
func resolveTranslationScopeConflict(roots []string, prefixFilter string) []string {
	if prefixFilter == "" || len(roots) == 0 {
		return roots
	}
	normPrefix := prefixFilter
	if !strings.HasSuffix(normPrefix, "/") {
		normPrefix += "/"
	}
	kept := make([]string, 0, len(roots))
	for _, root := range roots {
		if root == normPrefix || strings.HasPrefix(root, normPrefix) || strings.HasPrefix(normPrefix, root) {
			continue
		}
		kept = append(kept, root)
	}
	return kept
}

// customOutlineFileUnderScope customOutline 路径级过滤：与作用域过滤不同口径——
// 不按逗号拆分，整体去首尾斜杠后单前缀匹配 + 根 README 豁免（对齐 TS ingest.ts:303-310）。
func customOutlineFileUnderScope(filePath, prefixFilter string) bool {
	if prefixFilter == "" {
		return true
	}
	cleanPrefix := strings.Trim(prefixFilter, "/")
	if cleanPrefix == "" {
		return true
	}
	return filePath == cleanPrefix || strings.HasPrefix(filePath, cleanPrefix+"/") || isRootReadme(filePath)
}

// ---------- text_only + customOutline 格式化（用户工作台自定义大纲 → 章节） ----------

var (
	mdExtRe        = mdpat.MdExtRe
	dashUnderscore = regexp.MustCompile(`[-_]`)
	wordStartRe    = regexp.MustCompile(`\b\w`)
)

// titleFromFileName 文件名 → 展示标题：去 md 扩展、[-_]→空格、词首大写（对齐 TS ingest.ts:311-316）。
func titleFromFileName(filePath string) string {
	base := path.Base(filePath)
	clean := mdExtRe.ReplaceAllString(base, "")
	clean = dashUnderscore.ReplaceAllString(clean, " ")
	clean = wordStartRe.ReplaceAllStringFunc(clean, strings.ToUpper)
	return clean
}

// buildChaptersFromCustomOutline 每个非空类目一章；文件按作用域过滤，
// 标题链 shortTitle → title → 文件名格式化（对齐 TS ingest.ts:287-331）。
func buildChaptersFromCustomOutline(categories []CustomOutlineCategory, prefixFilter string) []ChapterInput {
	chapters := make([]ChapterInput, 0, len(categories))
	for _, cat := range categories {
		files := make([]ChapterFile, 0, len(cat.Files))
		for _, f := range cat.Files {
			basePath, anchor := mdpat.SplitPathAnchor(f.Path)
			if anchor == "" && f.Anchor != "" {
				anchor = f.Anchor
			}
			if basePath == "" || !customOutlineFileUnderScope(basePath, prefixFilter) {
				continue
			}
			title := f.ShortTitle
			if title == "" {
				title = f.Title
			}
			if title == "" {
				title = titleFromFileName(basePath)
				if anchor != "" {
					title = anchor
				}
			}
			files = append(files, ChapterFile{Path: basePath, Anchor: anchor, ShortTitle: title})
		}
		if len(files) == 0 {
			continue
		}
		title := cat.Name
		if title == "" {
			title = cat.Title
		}
		if title == "" {
			title = fmt.Sprintf("Chapter %d", len(chapters)+1)
		}
		chapters = append(chapters, ChapterInput{Title: title, PartTitle: cat.PartTitle, Files: files})
	}
	return chapters
}

// ---------- 章节映射链（TOC 金标准 → 数字前缀 → BYOK LLM 小任务） ----------

// chapterMapChainDeps 链执行依赖（LLM 网关 + 归档读取）。
type chapterMapChainDeps struct {
	LLM         LLMGenerator
	ArchiveRoot string
	Owner       string
	Repo        string
	Sha         string
	UserId      *string
}

// toChapterNodes GitNode → chapter 冻结契约节点（零转换成本，字段同名）。
func toChapterNodes(nodes []GitNode) []ChapterMapNode {
	out := make([]ChapterMapNode, len(nodes))
	for i, n := range nodes {
		out[i] = ChapterMapNode{Path: n.Path, Type: n.Type}
	}
	return out
}

// chapterMapLLMTimeout 对齐 TS chapter-map.ts LLM_TIMEOUT_MS=90s（结构化模型实测 23~60s+ 波动）。
const chapterMapLLMTimeout = 90 * time.Second

// runChapterMapChain 章节映射降级阶梯（确定性段全部走 internal/chapter 冻结实现）：
//  1. TOC 侧车（SUMMARY.md/_sidebar.md）：作者亲写目录，顺序金标准，零 LLM
//  2. 数字前缀强命名（01-/02-/ch1）：确定性自然排序，零 LLM
//  3. BYOK LLM 小任务（llm 网关 purpose=chapter_map）+ 路径白名单防幻觉校验门
//
// 全部失败 → nil，调用方回退通用文件树，导入永不因此中断。
func runChapterMapChain(
	ctx context.Context,
	deps IngestBodyDeps,
	patterns *IngestPatterns,
	nodes []GitNode,
	textRoot string,
	chain chapterMapChainDeps,
) []ChapterMapEntry {
	cmNodes := toChapterNodes(nodes)

	// 1) TOC 侧车：本地归档直读原文（零网络），解析失败容忍走下一阶梯
	if sidecarPath := patterns.FindTocSidecarPath(cmNodes, textRoot); sidecarPath != nil {
		content, readErr := readLocalArchiveFile(chain.ArchiveRoot, chain.Owner, chain.Repo, chain.Sha, *sidecarPath)
		if readErr != nil {
			log.Printf("[chapter-map] toc sidecar archive read failed %s: %v (fall through to next ladder step)", *sidecarPath, readErr)
		} else if strings.TrimSpace(content) != "" {
			if entries := patterns.ChapterMapFromSidecar(content, cmNodes, textRoot); len(entries) > 0 {
				return entries
			}
		}
	}

	// 2) 数字前缀强命名：doc 文件过滤 + MIN_CHAPTERS=2 采信门槛
	if signal := patterns.DetectOrderSignal(cmNodes, "", "", textRoot); signal.Type == "numeric" {
		mainPaths := make([]string, 0, len(signal.Sequence))
		for _, p := range signal.Sequence {
			if patterns.IsDocFile(p) {
				mainPaths = append(mainPaths, p)
			}
		}
		if len(mainPaths) >= 2 {
			entries := make([]ChapterMapEntry, len(mainPaths))
			for i, p := range mainPaths {
				entries[i] = ChapterMapEntry{
					Order:      i + 1,
					Title:      chapter.DeriveChapterTitle(p),
					MainPath:   p,
					AssetPaths: []ChapterMapAsset{},
				}
			}
			return entries
		}
	}

	// 3) BYOK LLM 小任务：网关按 userId 解析用户模型（MISSING_API_KEY=未配置 → 静默跳过）
	if deps.LLM == nil {
		return nil
	}
	candidates := patterns.BuildChapterCandidates(cmNodes, textRoot)
	if len(candidates.DocFiles) < 2 {
		return nil
	}
	displayRoot := textRoot
	if displayRoot == "" {
		displayRoot = "(repository root)"
	}
	variables := map[string]any{
		"owner":     chain.Owner,
		"repo":      chain.Repo,
		"textRoot":  displayRoot,
		"docFiles":  candidates.DocFiles,
		"codeFiles": candidates.CodeFiles,
	}
	llmCtx, cancel := context.WithTimeout(ctx, chapterMapLLMTimeout)
	defer cancel()
	var raw json.RawMessage
	if err := deps.LLM.Generate(llmCtx, "chapter_map", variables, chain.UserId, &raw); err != nil {
		if isMissingApiKeyErr(err) {
			return nil
		}
		log.Printf("[chapter-map] LLM chapter mapping failed for %s/%s: %v", chain.Owner, chain.Repo, err)
		return nil
	}
	return patterns.ValidateChapterMap(raw, cmNodes)
}

// isMissingApiKeyErr BYOK 未配置模型：非错误，静默走降级阶梯。
func isMissingApiKeyErr(err error) bool {
	type missingKey interface{ IsMissingApiKey() bool }
	mk, ok := err.(missingKey)
	return ok && mk.IsMissingApiKey()
}

// ---------- 课程树渲染（照校验过的 ChapterMap JSON 机械渲染，零命名假设） ----------

var (
	docUrlExtRe   = mdpat.MdMarkdownExtRe
	trailingReadm = regexp.MustCompile(`(?i)/readme$`)
)

// toDocUrlPath 文档 URL 规约（对齐 structurizer / curriculum-builder）：去 md 扩展；
// README 折叠为目录路径（根 README → ”）。
func toDocUrlPath(p string) string {
	urlPath := docUrlExtRe.ReplaceAllString(p, "")
	urlPath = trailingReadm.ReplaceAllString(urlPath, "")
	if strings.EqualFold(urlPath, "readme") {
		return ""
	}
	return urlPath
}

// buildCurriculumTreeFromMap 章节映射 → 导航树：每章 directory 节点，
// 正文第一位（pageType=text），资产跟随（kind≠answer 防剧透，pageType=readme）。
func buildCurriculumTreeFromMap(entries []ChapterMapEntry, owner, repo, targetLang string) []*NavNode {
	labels := curriculumLabelsFor(targetLang)
	ordered := make([]ChapterMapEntry, len(entries))
	copy(ordered, entries)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Order < ordered[j].Order })

	chapters := make([]*NavNode, 0, len(ordered))
	for _, entry := range ordered {
		children := []*NavNode{{
			Name:       labels.MainText,
			Title:      labels.MainText,
			ShortTitle: labels.MainText,
			Type:       "file",
			Path:       entry.MainPath,
			PageType:   "text",
			Url:        fmt.Sprintf("/docs/%s/%s/%s", owner, repo, toDocUrlPath(entry.MainPath)),
		}}
		for _, asset := range entry.AssetPaths {
			if asset.Kind == "answer" {
				continue
			}
			filename := path.Base(asset.Path)
			label := fmt.Sprintf("%s · %s", labels.LabPrefix, filename)
			children = append(children, &NavNode{
				Name:       filename,
				Title:      label,
				ShortTitle: label,
				Type:       "file",
				Path:       asset.Path,
				PageType:   "readme",
				Url:        fmt.Sprintf("/docs/%s/%s/%s", owner, repo, toDocUrlPath(asset.Path)),
			})
		}
		title := entry.Title
		if title == "" {
			title = labels.ChapterTitle(entry.Order)
		}
		chapters = append(chapters, &NavNode{
			Title:    title,
			Type:     "directory",
			Children: children,
		})
	}
	return chapters
}

// chaptersFromChapterMap 章节映射 → 章节落库输入：每章正文 + 非答案资产（answer 不进导航也不落章）。
func chaptersFromChapterMap(entries []ChapterMapEntry) []ChapterInput {
	ordered := make([]ChapterMapEntry, len(entries))
	copy(ordered, entries)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Order < ordered[j].Order })

	chapters := make([]ChapterInput, 0, len(ordered))
	for _, entry := range ordered {
		if entry.MainPath == "" {
			continue
		}
		files := []ChapterFile{{Path: entry.MainPath, ShortTitle: entry.Title}}
		for _, asset := range entry.AssetPaths {
			if asset.Path == "" || asset.Kind == "answer" {
				continue
			}
			files = append(files, ChapterFile{Path: asset.Path, ShortTitle: path.Base(asset.Path)})
		}
		title := entry.Title
		if title == "" {
			title = fmt.Sprintf("Chapter %d", entry.Order)
		}
		chapters = append(chapters, ChapterInput{Title: title, Files: files})
	}
	return chapters
}
