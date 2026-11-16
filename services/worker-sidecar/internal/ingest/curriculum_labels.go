package ingest

import (
	"fmt"
	"strings"
)

// ─────────────────────────────────────────────────────────────
// 课程导航标签语言表（SSOT：与 apps/client/src/lib/constants.ts
// SUPPORTED_LANGUAGES 的 13 语种一一对齐；新增语言 = 两侧各加一行）。
//
// 为什么是确定性语言表而不是 LLM：
// - 语言选择器是封闭集合（13 选 1），表可 100% 覆盖用户全部可选值；
// - 标签进落库导航树，必须幂等（LLM 每次拼写漂移会制造幽灵 nav diff）；
// - 宪章不对称计算公理：物理事实（封闭码表）已定结果，禁唤 LLM 慢路径。
// LLM 的语言工作在它该在的地方：章节标题/摘要本就以目标语言生成。
//
// 回落：'none'（不翻译，生成型内容无原文可保）与未知码 → 产品默认
// zh-CN（对齐 TRANSLATION_LANGUAGES.DEFAULT_CODE 与向导兜底文案）。
// ─────────────────────────────────────────────────────────────

// curriculumLabels 目标语言文案。
type curriculumLabels struct {
	MainText     string
	LabPrefix    string
	ChapterTitle func(order int) string
}

var curriculumLabelsTable = map[string]curriculumLabels{}

func registerCurriculumLabels(code, mainText, labPrefix, chapterFmt string) {
	curriculumLabelsTable[code] = curriculumLabels{
		MainText:     mainText,
		LabPrefix:    labPrefix,
		ChapterTitle: func(order int) string { return fmt.Sprintf(chapterFmt, order) },
	}
}

func init() {
	registerCurriculumLabels("zh-cn", "正文", "实验", "第 %d 章")
	registerCurriculumLabels("zh-tw", "正文", "實驗", "第 %d 章")
	registerCurriculumLabels("en", "Main Text", "Lab", "Chapter %d")
	registerCurriculumLabels("ja", "本文", "ラボ", "第 %d 章")
	registerCurriculumLabels("ko", "본문", "랩", "제 %d 장")
	registerCurriculumLabels("fr", "Texte principal", "TP", "Chapitre %d")
	registerCurriculumLabels("de", "Haupttext", "Übung", "Kapitel %d")
	registerCurriculumLabels("es", "Texto principal", "Laboratorio", "Capítulo %d")
	registerCurriculumLabels("it", "Testo principale", "Laboratorio", "Capitolo %d")
	registerCurriculumLabels("ru", "Основной текст", "Практикум", "Глава %d")
	registerCurriculumLabels("ar", "النص الرئيسي", "مختبر", "الفصل %d")
	registerCurriculumLabels("da", "Hovedtekst", "Øvelse", "Kapitel %d")
}

// curriculumLabelsFor 目标语言 → 导航标签（用户导入时选定，封闭 13 语种表；
// 'none'/未知码回落产品默认 zh-CN；zh 变体归并 zh-TW/zh-CN，en* 归并 en）。
func curriculumLabelsFor(targetLang string) curriculumLabels {
	code := strings.ToLower(strings.TrimSpace(targetLang))
	if l, ok := curriculumLabelsTable[code]; ok {
		return l
	}
	switch {
	case strings.HasPrefix(code, "zh"):
		if strings.Contains(code, "tw") || strings.Contains(code, "hk") {
			return curriculumLabelsTable["zh-tw"]
		}
		return curriculumLabelsTable["zh-cn"]
	case strings.HasPrefix(code, "en"):
		return curriculumLabelsTable["en"]
	}
	// 'none'（不翻译）与未知码：生成型内容无原文，按产品默认语言
	return curriculumLabelsTable["zh-cn"]
}
