package pipelineb

import (
	"fmt"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive"
)

// ── 分卷收敛漏斗 (Part Convergence Funnel) ──────────────────────────────
// 三权分立：LLM 提炼分卷业务命名（不可信草稿），确定性代码负责剥除机械序数、
// 自愈缺漏、压制碎片化并按首现次序赋予连续自然序——序数主权归代码，命名主权归 LLM。

// partCeiling 依据章节物理体量推得分卷数上限（尺度护栏，反碎片化）：
// 微内核双核课 (2 章) 允许每核一卷；常规课程每卷至少承载约半数章节；
// 上限 5 与 deep 档 3~5 卷的尺度范式带同步。单章课程由调用方直接抹除分卷。
func partCeiling(n int) int {
	if n < 2 {
		return 0
	}
	ceil := (n + 1) / 2
	if ceil < 2 {
		ceil = 2
	}
	if ceil > 5 {
		ceil = 5
	}
	return ceil
}

var (
	// stripWords 词头式序数前缀（后接 ASCII 或中文数字）。
	stripWords = []string{"part", "dimension", "module", "维度", "模块", "分卷"}
	// stripUnits 「第 N X」形态必须命中 的量词，杜绝误剥「第三方库」等正文。
	stripUnits = []string{"卷", "部分", "分卷", "篇", "章"}
	// asciiOrdinalWords 词头匹配基于小写化文本。
	cjkDigits = "一二三四五六七八九十"
	// ordinalSeparators 序数与正文的分隔符（循环剥除）。
	ordinalSeparators = " \t:：.。、-－–—_"
)

// stripPartOrdinalPrefix 剥离分卷标题头部的机械序数前缀（维度 N / Part N /
// Dimension N / Module N / 模块 N / 第 N 卷(部分/分卷/篇/章) / 卷一等）。
// LLM 违规携带的静态断号（如「维度 3」）在此被物理抹除，序数由漏斗统一重编。
// 属一维纯文本定前缀扫描（宪章 Regex 安全区），采用确定性扫描器而非正则。
func stripPartOrdinalPrefix(s string) string {
	rest := strings.TrimSpace(s)
	// 至多两轮：防「Part 1: 维度 2: X」双层套壳
	for i := 0; i < 2 && rest != ""; i++ {
		next, stripped := stripOneOrdinalPrefix(rest)
		if !stripped {
			break
		}
		rest = next
	}
	return rest
}

func stripOneOrdinalPrefix(s string) (string, bool) {
	lower := strings.ToLower(s)
	for _, w := range stripWords {
		if !strings.HasPrefix(lower, w) {
			continue
		}
		rest := s[len(w):]
		if next, ok := takeOrdinalNumber(rest); ok {
			return trimOrdinalSeparators(next), true
		}
	}
	// 「第 N <量词>」：数字后必须紧跟量词，防误剥「第三方库」「第 3 方」等正文
	if strings.HasPrefix(s, "第") {
		if rest, ok := takeOrdinalNumber(s[len("第"):]); ok {
			trimmed := trimLeadingSpaces(rest)
			for _, u := range stripUnits {
				if strings.HasPrefix(trimmed, u) {
					return trimOrdinalSeparators(trimmed[len(u):]), true
				}
			}
		}
		return "", false
	}
	// 「卷一」裸式：卷 + 中文数字
	if strings.HasPrefix(s, "卷") {
		if rest, ok := takeCJKNumber(s[len("卷"):]); ok {
			return trimOrdinalSeparators(rest), true
		}
	}
	return "", false
}

// takeOrdinalNumber 消费可选空格 + 至少一位 ASCII 或中文数字（仅识别形状，不估值）。
func takeOrdinalNumber(s string) (string, bool) {
	rest := trimLeadingSpaces(s)
	if next, ok := takeASCIIDigits(rest); ok {
		return next, true
	}
	return takeCJKNumber(rest)
}

func takeASCIIDigits(s string) (string, bool) {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == 0 {
		return "", false
	}
	return s[i:], true
}

// takeCJKNumber 消费 1~99 形状的中文数字（[一-九]?十[一-九]? 或 [一-九]）。
func takeCJKNumber(s string) (string, bool) {
	rest := s
	consumed := false
	if r, size := firstRune(rest); r != 0 && strings.ContainsRune(cjkDigits, r) && r != '十' {
		rest = rest[size:]
		consumed = true
	}
	if r, size := firstRune(rest); r == '十' {
		rest = rest[size:]
		consumed = true
	}
	if r, size := firstRune(rest); r != 0 && strings.ContainsRune(cjkDigits, r) && r != '十' {
		rest = rest[size:]
		consumed = true
	}
	if !consumed {
		return "", false
	}
	return rest, true
}

func firstRune(s string) (rune, int) {
	for _, r := range s {
		return r, len(string(r))
	}
	return 0, 0
}

func trimLeadingSpaces(s string) string {
	return strings.TrimLeft(s, " \t")
}

func trimOrdinalSeparators(s string) string {
	return strings.TrimLeft(strings.TrimSpace(s), ordinalSeparators)
}

// canonicalizeLLMPartTitles 收敛漏斗主体：剥壳 → 缺漏自愈 → 尺度护栏 → 自然序重编。
// 返回 false 表示 LLM 未提供任何有效分卷业务命名（含全被剥成序数空壳），
// 调用方回落确定性维度标题保底。
func canonicalizeLLMPartTitles(chapters []cognitive.OutlineChapter) bool {
	if len(chapters) == 0 {
		return false
	}
	// 0. 单章自成一体：不设分卷（single_masterclass 尺度范式，UI 不渲染分卷分割线）
	if len(chapters) == 1 {
		chapters[0].PartTitle = ""
		return true
	}

	// 1. 剥离机械序数前缀；纯序数空壳（如标题即「维度 1」）置空待自愈
	for i := range chapters {
		chapters[i].PartTitle = stripPartOrdinalPrefix(chapters[i].PartTitle)
	}
	firstNamed := ""
	for i := range chapters {
		if chapters[i].PartTitle != "" {
			firstNamed = chapters[i].PartTitle
			break
		}
	}
	if firstNamed == "" {
		return false
	}

	// 2. 上下文自愈：前向继承 + 前导空章批量回填（根治 [空,空,X] 三明治断卷）
	last := ""
	for i := range chapters {
		if chapters[i].PartTitle != "" {
			last = chapters[i].PartTitle
		} else if last != "" {
			chapters[i].PartTitle = last
		}
	}
	for i := range chapters {
		if chapters[i].PartTitle != "" {
			break
		}
		chapters[i].PartTitle = firstNamed
	}

	// 3. 尺度护栏：distinct 分卷数超上限时，溢出分卷整体并入最后一卷
	//（分组收口归代码，业务命名仍归 LLM，绝不机械改名）
	idxOf := make(map[string]int, 4)
	order := make([]string, 0, 4)
	for _, ch := range chapters {
		if _, ok := idxOf[ch.PartTitle]; !ok {
			idxOf[ch.PartTitle] = len(order)
			order = append(order, ch.PartTitle)
		}
	}
	if ceil := partCeiling(len(chapters)); len(order) > ceil {
		lastKept := order[ceil-1]
		for i := range chapters {
			if idxOf[chapters[i].PartTitle] >= ceil-1 {
				chapters[i].PartTitle = lastKept
			}
		}
	}

	// 4. 首现次序连续自然序重编：Part N: <LLM 业务命名>
	for i := range chapters {
		if n, ok := idxOf[chapters[i].PartTitle]; ok {
			chapters[i].PartTitle = fmt.Sprintf("Part %d: %s", n+1, chapters[i].PartTitle)
		}
	}
	return true
}
