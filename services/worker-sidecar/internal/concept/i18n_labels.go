package concept

import (
	"os"
	"strings"
)

// ─────────────────────────────────────────────────────────────
// 概念 i18n 标签（镜像 apps/client/src/lib/i18n.ts:15-17/74-76 与
// t(locale = DEFAULT_LOCALE) 语义——en 部署不再落中文标签）。
// ─────────────────────────────────────────────────────────────

// ConceptLabels 概念提取所用 i18n 标签。
type ConceptLabels struct {
	UntitledConceptName string
	MentorGuidanceTag   string
	ExperienceTag       string
}

var conceptLabelsZh = ConceptLabels{
	UntitledConceptName: "概述设计",
	MentorGuidanceTag:   "导师指引",
	ExperienceTag:       "实战经验",
}

var conceptLabelsEn = ConceptLabels{
	UntitledConceptName: "Overview Notes",
	MentorGuidanceTag:   "Mentor Guide",
	ExperienceTag:       "Field Experience",
}

// LabelsForLocale locale 解析：空 → DEFAULT_LOCALE env → zh 默认；
// en* 前缀 → 英文字典。
func LabelsForLocale(locale string) ConceptLabels {
	if locale == "" {
		locale = os.Getenv("DEFAULT_LOCALE")
	}
	if strings.HasPrefix(strings.ToLower(locale), "en") {
		return conceptLabelsEn
	}
	return conceptLabelsZh
}
