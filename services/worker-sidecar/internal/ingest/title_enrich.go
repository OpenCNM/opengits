// title_enrich.go 大纲节点标题认知摩热（File ≠ Cognitive Unit）。
//
// 背景：统一树管线的 LLM 大纲 schema 只携带文件路径（files: string[]），
// shortTitle 由 cleanShortTitle 确定性兜底为裸文件名；文档型仓库（text 口径）
// 逐文件落 Document 后，侧边栏会出现 "README"×N、UUID 串等无认知语义的细分。
// 本模块在持久化尾段之前做确定性增强（零 LLM，微秒级）：
//  1. H1 摩热：markdown 文件的裸文件名 shortTitle → 文件首个 ATX 一级标题；
//  2. 章内消歧：同章标题碰撞时以父目录名消歧（如 "README · 2025-01-16_Sub3Min"）；
//  3. 三面重对齐：Chapters（Document.title 源）、Draft（OutlineNode 侧边栏源）、
//     NavTree（Repository 物化树）以 path 为键同步摩热后标题——draft/navTree 在
//     阶梯内先于摩热构建，不同步会让侧边栏残留裸文件名。
//
// 边界（失效封闭）：物理读取失败/无 H1/非 markdown/标题非文件名派生 → 原状保持；
// 增强是提升不是硬门，绝不因摩热失败阻塞导入主链路。
package ingest

import (
	"fmt"
	"path"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// enrichPlanFileTitles 对章节计划执行标题摩热、章内消歧与三面重对齐（原地修改）。
// readFile 为归档物理读取闭包（返回 false 表示读取失败，静默保持原状）。
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

// enrichChapterFileTitles 单章 H1 摩热：仅处理「标题为空或等于文件名派生形态」
// 的 markdown 文件（LLM/人工/TOC 已给出的真实标题零侵扰；code 口径虚拟章
// chapters/NN.mdx 因标题=章标题天然跳过）。
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

// disambiguateChapterFileTitles 章内标题碰撞消歧：同章 ≥2 个文件共享同一
// （大小写不敏感）标题时，追加父目录名消歧（"README · 2025-01-16_Sub3Min"）。
// 父目录为空（根目录文件）或消歧后仍碰撞时保持原状——确定性、幂等、零排序假设。
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

// chapterFileTitles 快照单章 path→title（摩热前基线）。
func chapterFileTitles(ch ChapterInput) map[string]string {
	titles := make(map[string]string, len(ch.Files))
	for _, f := range ch.Files {
		titles[f.Path] = f.ShortTitle
	}
	return titles
}

// recordTitleChanges 记录发生变化的 path→新标题（path 为键，天然免疫
// draft/navTree 与 chapters 之间的顺序漂移）。
func recordTitleChanges(changed, before map[string]string, after ChapterInput) {
	for _, f := range after.Files {
		if old, ok := before[f.Path]; ok && old != f.ShortTitle {
			changed[f.Path] = f.ShortTitle
		}
	}
}

// resyncDraftNodeTitles Draft（OutlineNode 持久化源，侧边栏标题）按 SourcePath
// 重对齐摩热后标题。
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

// resyncNavTreeTitles NavTree（Repository 物化导航树）按文件节点 Path 重对齐。
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

// isDerivedFileTitle 判定标题是否为文件名派生形态（空串、或与去扩展名基名
// 在 [-_]→空格 归一后大小写不敏感相等——覆盖 cleanShortTitle 与
// titleFromFileName 两种确定性兜底的输出指纹）。
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

// parentDirLabel 父目录标签（末段目录名；根目录文件返回 ""）。
func parentDirLabel(filePath string) string {
	dir := path.Dir(filePath)
	if dir == "." || dir == "/" {
		return ""
	}
	return path.Base(dir)
}

// titleEnrichHeadBytes H1 扫描读取的头部预算（H1 通常位于文首；预算保护巨文内存）。
const titleEnrichHeadBytes = 8192

// headOf 截取头部文本（按字节预算，规避整篇巨文扫描；丢弃预算边界处的
// 半行，防止截断出伪标题）。
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
