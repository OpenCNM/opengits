package cognitive

import (
	"fmt"
	"strings"
)

// Empty ja falls back to en when micro-repo copy has no Japanese variant.
type outlineL10n struct{ zh, ja, en string }

func (l outlineL10n) pick(isZh, isJa bool) string {
	if isZh {
		return l.zh
	}
	if isJa && l.ja != "" {
		return l.ja
	}
	return l.en
}

func outlineL10nFmt(l outlineL10n, isZh, isJa bool, args ...any) string {
	return fmt.Sprintf(l.pick(isZh, isJa), args...)
}

type outlineCtx struct {
	nodes       []GitNode
	patterns    Patterns
	opts        []OutlineSignalOptions
	isZh, isJa  bool
	cleanPrefix string
	candidates  []CandidateOutlineFile
	docFiles    []CandidateOutlineFile
	codeFiles   []CandidateOutlineFile
}

type outlineLadderRule struct {
	name  string
	build func(*outlineCtx) *OutlineChapter
}

var outlineFallbackLadder = []outlineLadderRule{
	{"readme-overview", fallbackReadmeChapter},
	{"any-blob-core", fallbackAnyBlobChapter},
	{"empty-repo", fallbackEmptyChapter},
}

type outlineEmitter struct {
	name string
	emit func(*outlineCtx, []OutlineChapter) []OutlineChapter
}

var outlineEmitters = []outlineEmitter{
	{"doc-guides", emitDocGuideChapters},
	{"code-impl", emitCodeImplChapters},
}

func fallbackReadmeChapter(ctx *outlineCtx) *OutlineChapter {
	readme := FindReadmePath(ctx.nodes, ctx.cleanPrefix, ctx.patterns)
	if readme == "" {
		return nil
	}
	return &OutlineChapter{
		Name: outlineL10n{
			zh: "第 1 章：项目概览", ja: "第 1 章：プロジェクト概要", en: "Chapter 1: Overview",
		}.pick(ctx.isZh, ctx.isJa),
		Summary: outlineL10n{
			zh: "项目核心文档与起步指南",
			ja: "プロジェクトの主要ドキュメントとクイックスタート",
			en: "Core documentation and quickstart",
		}.pick(ctx.isZh, ctx.isJa),
		Files: []ChapterFile{{Path: readme, ShortTitle: outlineL10n{
			zh: "起步概览", ja: "クイックスタート概要", en: "Quickstart",
		}.pick(ctx.isZh, ctx.isJa)}},
	}
}

func fallbackAnyBlobChapter(ctx *outlineCtx) *OutlineChapter {
	var anyBlob *GitNode
	for _, n := range ctx.nodes {
		if n.Type == "blob" &&
			!ctx.patterns.IsNonContentDir(n.Path) &&
			!ctx.patterns.IsBinaryOrArchiveFile(n.Path) &&
			!ctx.patterns.IsNonContentFile(n.Path) &&
			(ctx.patterns.IsCodeFile(n.Path) || ctx.patterns.IsDocFile(n.Path)) {
			anyBlob = &n
			break
		}
	}
	if anyBlob == nil {
		return nil
	}
	return &OutlineChapter{
		Name: outlineL10n{
			zh: "第 1 章：项目核心", ja: "第 1 章：プロジェクトコア", en: "Chapter 1: Core Project",
		}.pick(ctx.isZh, ctx.isJa),
		Summary: outlineL10n{
			zh: "项目文件与快速入门",
			ja: "プロジェクトファイルとクイックスタート",
			en: "Project file and quickstart",
		}.pick(ctx.isZh, ctx.isJa),
		Files: []ChapterFile{{Path: anyBlob.Path, ShortTitle: cleanShortTitle(anyBlob.Path)}},
	}
}

func fallbackEmptyChapter(ctx *outlineCtx) *OutlineChapter {
	return &OutlineChapter{
		Name: outlineL10n{
			zh: "第 1 章：项目核心", ja: "第 1 章：プロジェクトコア", en: "Chapter 1: Core Project",
		}.pick(ctx.isZh, ctx.isJa),
		Summary: outlineL10n{
			zh: "空项目或未检测到可用文件",
			ja: "空のプロジェクトまたは有効なファイルが見つかりません",
			en: "Empty repository or no valid files detected",
		}.pick(ctx.isZh, ctx.isJa),
		Files: []ChapterFile{},
	}
}

func microRepoChapters(ctx *outlineCtx) []OutlineChapter {
	if !(len(ctx.codeFiles) > 0 && len(ctx.codeFiles) <= 3 && len(ctx.opts) > 0 && ctx.opts[0].FileReader != nil) {
		return nil
	}
	anchors := ExtractSubFileAnchors(ctx.codeFiles, ctx.docFiles, ctx.nodes, ctx.opts[0].FileReader, ctx.opts[0].SymbolExtractor, ctx.patterns)
	if len(anchors) == 0 {
		return nil
	}
	var chapters []OutlineChapter

	introHeading := func(a CandidateOutlineFile) bool {
		return a.Kind == "heading" && (strings.EqualFold(a.Anchor, "Usage") || strings.EqualFold(a.Anchor, "Quick Start") || strings.EqualFold(a.Anchor, "Install"))
	}

	var introFiles []ChapterFile
	for _, d := range ctx.docFiles {
		introFiles = append(introFiles, ChapterFile{Path: d.Path, ShortTitle: cleanShortTitle(d.Path)})
	}
	for _, a := range anchors {
		if introHeading(a) {
			introFiles = append(introFiles, ChapterFile{Path: a.Path, Anchor: a.Anchor, ShortTitle: a.Anchor})
		}
	}
	if len(introFiles) > 0 {
		chapters = append(chapters, OutlineChapter{
			Name:    outlineL10n{zh: "第 1 章：起步与使用指南", en: "Chapter 1: Quickstart & Usage"}.pick(ctx.isZh, ctx.isJa),
			Summary: outlineL10n{zh: "核心概念、安装配置与基础使用示例", en: "Core concepts, installation, and basic usage"}.pick(ctx.isZh, ctx.isJa),
			Files:   introFiles,
		})
	}

	var typeFiles []ChapterFile
	for _, a := range anchors {
		if a.Kind == "type" {
			title := a.Anchor
			if a.Detail != "" {
				title = a.Anchor + " (" + a.Detail + ")"
			}
			typeFiles = append(typeFiles, ChapterFile{Path: a.Path, Anchor: a.Anchor, ShortTitle: title})
		}
	}
	if len(typeFiles) > 0 {
		n := len(chapters) + 1
		chapters = append(chapters, OutlineChapter{
			Name:    outlineL10nFmt(outlineL10n{zh: "第 %d 章：类型契约与状态定义", en: "Chapter %d: Type Contracts & Definitions"}, ctx.isZh, ctx.isJa, n),
			Summary: outlineL10n{zh: "核心类型定义、泛型参数与接口契约", en: "Core types, generics, and interface contracts"}.pick(ctx.isZh, ctx.isJa),
			Files:   typeFiles,
		})
	}

	var fnFiles []ChapterFile
	for _, a := range anchors {
		if a.Kind == "function" {
			fnFiles = append(fnFiles, ChapterFile{Path: a.Path, Anchor: a.Anchor, ShortTitle: a.Anchor})
		}
	}
	if len(fnFiles) == 0 {
		for _, c := range ctx.codeFiles {
			fnFiles = append(fnFiles, ChapterFile{Path: c.Path, ShortTitle: cleanShortTitle(c.Path)})
		}
	}
	if len(fnFiles) > 0 {
		n := len(chapters) + 1
		chapters = append(chapters, OutlineChapter{
			Name:    outlineL10nFmt(outlineL10n{zh: "第 %d 章：核心分发器与业务实现", en: "Chapter %d: Core Implementation"}, ctx.isZh, ctx.isJa, n),
			Summary: outlineL10n{zh: "核心分发逻辑、闭包状态与方法流转", en: "Core dispatcher logic, state, and methods"}.pick(ctx.isZh, ctx.isJa),
			Files:   fnFiles,
		})
	}

	var apiFiles []ChapterFile
	for _, a := range anchors {
		if a.Kind == "heading" && !introHeading(a) {
			apiFiles = append(apiFiles, ChapterFile{Path: a.Path, Anchor: a.Anchor, ShortTitle: a.Anchor})
		}
	}
	if len(apiFiles) > 0 {
		n := len(chapters) + 1
		chapters = append(chapters, OutlineChapter{
			Name:    outlineL10nFmt(outlineL10n{zh: "第 %d 章：API 接口与进阶规范", en: "Chapter %d: API Reference & Specifications"}, ctx.isZh, ctx.isJa, n),
			Summary: outlineL10n{zh: "公共 API 详解与方法边界", en: "Public API details and method boundaries"}.pick(ctx.isZh, ctx.isJa),
			Files:   apiFiles,
		})
	}

	var specFiles []ChapterFile
	for _, a := range anchors {
		if a.Kind == "spec" {
			specFiles = append(specFiles, ChapterFile{Path: a.Path, Anchor: a.Anchor, ShortTitle: a.Anchor})
		}
	}
	if len(specFiles) > 0 {
		n := len(chapters) + 1
		chapters = append(chapters, OutlineChapter{
			Name:    outlineL10nFmt(outlineL10n{zh: "第 %d 章：行为规范与单元测试验证", en: "Chapter %d: Behavioral Specs & Tests"}, ctx.isZh, ctx.isJa, n),
			Summary: outlineL10n{zh: "测试用例设计与边界行为验证", en: "Test suites and behavioral specifications"}.pick(ctx.isZh, ctx.isJa),
			Files:   specFiles,
		})
	}
	if len(chapters) == 0 {
		return nil
	}
	return chapters
}

func emitChunked(ctx *outlineCtx, chapters []OutlineChapter, items []CandidateOutlineFile, chunkSize int, nameTpl, summaryTpl outlineL10n) []OutlineChapter {
	totalParts := (len(items) + chunkSize - 1) / chunkSize
	for i := 0; i < len(items); i += chunkSize {
		end := i + chunkSize
		if end > len(items) {
			end = len(items)
		}
		chNum := len(chapters) + 1
		partSuffix := ""
		if totalParts > 1 {
			partIdx := (i / chunkSize) + 1
			switch {
			case ctx.isZh:
				partSuffix = fmt.Sprintf(" (第 %d 节)", partIdx)
			case ctx.isJa:
				partSuffix = fmt.Sprintf(" (第 %d 節)", partIdx)
			default:
				partSuffix = fmt.Sprintf(" (Part %d)", partIdx)
			}
		}
		var chunkFiles []ChapterFile
		for _, c := range items[i:end] {
			chunkFiles = append(chunkFiles, ChapterFile{Path: c.Path, ShortTitle: cleanShortTitle(c.Path)})
		}
		chapters = append(chapters, OutlineChapter{
			Name:    outlineL10nFmt(nameTpl, ctx.isZh, ctx.isJa, chNum, partSuffix),
			Summary: summaryTpl.pick(ctx.isZh, ctx.isJa),
			Files:   chunkFiles,
		})
	}
	return chapters
}

func emitDocGuideChapters(ctx *outlineCtx, chapters []OutlineChapter) []OutlineChapter {
	if len(ctx.docFiles) == 0 {
		return chapters
	}
	limit := 4
	if len(ctx.docFiles) < limit {
		limit = len(ctx.docFiles)
	}
	var introFiles []ChapterFile
	for _, d := range ctx.docFiles[:limit] {
		introFiles = append(introFiles, ChapterFile{Path: d.Path, ShortTitle: cleanShortTitle(d.Path)})
	}
	chapters = append(chapters, OutlineChapter{
		Name: outlineL10n{
			zh: "第 1 章：快速上手与核心概念",
			ja: "第 1 章：クイックスタートと基本概念",
			en: "Chapter 1: Quickstart & Core Concepts",
		}.pick(ctx.isZh, ctx.isJa),
		Summary: outlineL10n{
			zh: "系统起步与核心基础介绍",
			ja: "システムの導入と主要な基礎知識",
			en: "Getting started and core concepts",
		}.pick(ctx.isZh, ctx.isJa),
		Files: introFiles,
	})
	return emitChunked(ctx, chapters, ctx.docFiles[limit:], 8,
		outlineL10n{
			zh: "第 %d 章：深入指南与实践%s", ja: "第 %d 章：詳細ガイドと実践%s", en: "Chapter %d: In-Depth Guides%s",
		},
		outlineL10n{
			zh: "详细操作指南与进阶功能", ja: "詳細な操作ガイドと高度な機能", en: "Detailed guides and advanced features",
		})
}

func emitCodeImplChapters(ctx *outlineCtx, chapters []OutlineChapter) []OutlineChapter {
	if len(ctx.codeFiles) == 0 {
		return chapters
	}
	var entryCode, coreCode []CandidateOutlineFile
	for _, c := range ctx.codeFiles {
		if c.Role == "entry_point" || c.Role == "configuration" {
			entryCode = append(entryCode, c)
		} else {
			coreCode = append(coreCode, c)
		}
	}
	if len(entryCode) > 0 {
		limit := 8
		if len(entryCode) < limit {
			limit = len(entryCode)
		}
		var entryFiles []ChapterFile
		for _, c := range entryCode[:limit] {
			entryFiles = append(entryFiles, ChapterFile{Path: c.Path, ShortTitle: cleanShortTitle(c.Path)})
		}
		chNum := len(chapters) + 1
		chapters = append(chapters, OutlineChapter{
			Name: outlineL10nFmt(outlineL10n{
				zh: "第 %d 章：核心架构与启动入口",
				ja: "第 %d 章：コアアーキテクチャとエントリ",
				en: "Chapter %d: Architecture & Entry",
			}, ctx.isZh, ctx.isJa, chNum),
			Summary: outlineL10n{
				zh: "程序启动入口与全局配置实现",
				ja: "プログラムのエントリポイントとグローバル設定の実装",
				en: "Entry points and configuration",
			}.pick(ctx.isZh, ctx.isJa),
			Files: entryFiles,
		})
	}
	var remaining []CandidateOutlineFile
	if len(entryCode) > 8 {
		remaining = append(remaining, entryCode[8:]...)
	}
	remaining = append(remaining, coreCode...)
	if len(remaining) == 0 {
		remaining = ctx.codeFiles
	}
	return emitChunked(ctx, chapters, remaining, 8,
		outlineL10n{
			zh: "第 %d 章：核心业务逻辑与实现%s", ja: "第 %d 章：コアビジネスロジックと実装%s", en: "Chapter %d: Core Implementation%s",
		},
		outlineL10n{
			zh: "核心业务模块流转与数据处理",
			ja: "コアビジネスモジュールのフローとデータ処理",
			en: "Core business logic and modules",
		})
}

func buildRuleFallbackOutline(ctx *outlineCtx) []OutlineChapter {
	if len(ctx.candidates) == 0 {
		for _, rule := range outlineFallbackLadder {
			if ch := rule.build(ctx); ch != nil {
				return []OutlineChapter{*ch}
			}
		}
		return nil // Unreachable: empty-repo rule always matches as terminal fallback.
	}
	if micro := microRepoChapters(ctx); len(micro) > 0 {
		return micro
	}
	chapters := []OutlineChapter{}
	for _, em := range outlineEmitters {
		chapters = em.emit(ctx, chapters)
	}
	return chapters
}

func newOutlineCtx(nodes []GitNode, prefix, targetLanguage string, patterns Patterns, opts []OutlineSignalOptions) *outlineCtx {
	ctx := &outlineCtx{
		nodes:       nodes,
		patterns:    patterns,
		opts:        opts,
		isZh:        targetLanguage == "" || targetLanguage == "zh-CN" || targetLanguage == "zh",
		isJa:        targetLanguage == "ja",
		cleanPrefix: strings.Trim(strings.Trim(prefix, " "), "/"),
		candidates:  SelectCandidateFilesForOutline(nodes, 40, patterns),
	}
	for _, c := range ctx.candidates {
		if c.IsDoc {
			ctx.docFiles = append(ctx.docFiles, c)
		} else {
			ctx.codeFiles = append(ctx.codeFiles, c)
		}
	}
	return ctx
}
