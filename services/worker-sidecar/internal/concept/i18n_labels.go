package concept

import (
	"os"
	"strings"
)

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

func LabelsForLocale(locale string) ConceptLabels {
	if locale == "" {
		locale = os.Getenv("DEFAULT_LOCALE")
	}
	if strings.HasPrefix(strings.ToLower(locale), "en") {
		return conceptLabelsEn
	}
	return conceptLabelsZh
}
