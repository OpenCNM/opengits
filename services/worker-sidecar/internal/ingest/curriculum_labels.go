package ingest

import (
	"fmt"
	"strings"
)

// Closed 13-locale table synced with constants.ts SUPPORTED_LANGUAGES for idempotent nav trees without LLM drift.

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
	return curriculumLabelsTable["zh-cn"]
}
