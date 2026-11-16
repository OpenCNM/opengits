package concept

import (
	"encoding/json"
	"regexp"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/opengits/worker-sidecar/internal/chunker"
)

// CompanionQuiz represents a self-assessment question accompanying a chapter.
type CompanionQuiz struct {
	Question     string   `json:"question"`
	Options      []string `json:"options"`
	CorrectIndex int      `json:"correctIndex"`
	Explanation  string   `json:"explanation,omitempty"`
}

// ExtractedConcept represents an extracted conceptual knowledge unit.
type ExtractedConcept struct {
	ConceptName       string   `json:"conceptName"`
	Slug              string   `json:"slug"`
	Category          string   `json:"category"`
	PrinciplesText    string   `json:"principlesText"`
	AuthorReflections string   `json:"authorReflections,omitempty"`
	SopSteps          []string `json:"sopSteps"`
	Summary           string   `json:"summary"`
	SubTopics         []string `json:"subTopics"`
	Tags              []string `json:"tags"`
	SourceHeading     string   `json:"sourceHeading,omitempty"`
	AnchorText        string   `json:"anchorText,omitempty"`
}

// ExtractedManifestResult contains cleaned document content along with extracted concepts and metadata.
type ExtractedManifestResult struct {
	HasFrontmatter bool               `json:"hasFrontmatter"`
	CleanMdx       string             `json:"cleanMdx"`
	CleanContent   string             `json:"cleanContent"`
	Concepts       []ExtractedConcept `json:"concepts"`
	Quizzes        []CompanionQuiz    `json:"quizzes,omitempty"`
	Takeaways      []string           `json:"takeaways,omitempty"`
	Summary        string             `json:"summary,omitempty"`
}

var (
	frontmatterRe               = regexp.MustCompile(`(?s)^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)`)
	manifestClosedConceptRe     = regexp.MustCompile(`(?is)<concept_manifest[^>]*>(.*?)</concept_manifest>`)
	manifestClosedPedagogyRe    = regexp.MustCompile(`(?is)<pedagogy_manifest[^>]*>(.*?)</pedagogy_manifest>`)
	manifestOpenTagRe           = regexp.MustCompile(`(?is)<(?:concept_manifest|pedagogy_manifest)[^>]*>`)
	nextHeadingRe               = regexp.MustCompile(`(?m)\n#{1,6}\s`)
	codeFenceRe                 = regexp.MustCompile(`(?is)^` + "```" + `(?:json|ya?ml)?\s*(.*?)\s*` + "```" + `$`)
	codeFencePrefixRe           = regexp.MustCompile(`(?is)^` + "```" + `(?:json|ya?ml)?\s*`)
	codeFenceSuffixRe           = regexp.MustCompile(`(?is)\s*` + "```" + `$`)
	trailingCommaRe             = regexp.MustCompile(`,\s*([\]}])`)
	manifestInlineDecorationsRe = regexp.MustCompile(`[*_~` + "`" + `]`)
)

func stripAndExtractManifestXml(content string) (string, []string) {
	var payloads []string

	// 1. Extract and strip closed concept_manifest tags
	clean := manifestClosedConceptRe.ReplaceAllStringFunc(content, func(m string) string {
		sub := manifestClosedConceptRe.FindStringSubmatch(m)
		if len(sub) > 1 {
			payloads = append(payloads, sub[1])
		}
		return ""
	})

	// Extract and strip closed pedagogy_manifest tags
	clean = manifestClosedPedagogyRe.ReplaceAllStringFunc(clean, func(m string) string {
		sub := manifestClosedPedagogyRe.FindStringSubmatch(m)
		if len(sub) > 1 {
			payloads = append(payloads, sub[1])
		}
		return ""
	})

	// 2. Extract and strip all unclosed tags up to the next heading or end of content
	for {
		loc := manifestOpenTagRe.FindStringIndex(clean)
		if loc == nil {
			break
		}
		rest := clean[loc[0]:]
		tagEnd := loc[1] - loc[0]
		headingLoc := nextHeadingRe.FindStringIndex(rest[tagEnd:])
		if headingLoc != nil {
			unclosedPayload := rest[tagEnd : tagEnd+headingLoc[0]]
			payloads = append(payloads, unclosedPayload)
			clean = clean[:loc[0]] + rest[tagEnd+headingLoc[0]:]
		} else {
			unclosedPayload := rest[tagEnd:]
			payloads = append(payloads, unclosedPayload)
			clean = clean[:loc[0]]
		}
	}

	return strings.TrimSpace(clean), payloads
}

// NormalizeCategory normalizes raw category input to one of the canonical categories.
func NormalizeCategory(cat any) string {
	s := ""
	if str, ok := cat.(string); ok {
		s = strings.ToLower(strings.TrimSpace(str))
	}
	if s == "workflow" || strings.Contains(s, "process") || strings.Contains(s, "step") ||
		strings.Contains(s, "pipeline") || strings.Contains(s, "procedure") || strings.Contains(s, "guide") {
		return "workflow"
	}
	if s == "reflection" || strings.Contains(s, "insight") || strings.Contains(s, "tip") ||
		strings.Contains(s, "tradeoff") || strings.Contains(s, "trade-off") || strings.Contains(s, "lesson") {
		return "reflection"
	}
	if s == "architecture" || strings.Contains(s, "structure") || strings.Contains(s, "layout") ||
		strings.Contains(s, "overview") || strings.Contains(s, "module") {
		return "architecture"
	}
	return "principle"
}

// ExtractConceptManifest extracts companion concept manifests (YAML frontmatter or XML tags),
// parses structured concepts/quizzes/takeaways, truncates names to 60 chars (4.1.1.1),
// and strips manifest tags safely from document content to prevent MDX compilation conflicts.
func ExtractConceptManifest(rawContent string, docPath string) ExtractedManifestResult {
	rawContent = strings.TrimPrefix(rawContent, "\ufeff")
	trimmed := strings.TrimSpace(rawContent)
	if trimmed == "" {
		return ExtractedManifestResult{
			HasFrontmatter: false,
			CleanMdx:       "",
			CleanContent:   "",
			Concepts:       []ExtractedConcept{},
		}
	}

	// 1. Frontmatter check (--- ... ---)
	if strings.HasPrefix(trimmed, "---") {
		if fmMatch := frontmatterRe.FindStringSubmatchIndex(trimmed); fmMatch != nil {
			rawFm := trimmed[fmMatch[2]:fmMatch[3]]
			cleanMdx := strings.TrimSpace(trimmed[fmMatch[1]:])
			cleanMdx, _ = stripAndExtractManifestXml(cleanMdx)

			trimmedFm := strings.TrimSpace(rawFm)
			fmObj := parseFrontmatterYAML(trimmedFm)

			if fmObj != nil {
				// 真 frontmatter（YAML 可解析）：剥壳返回
				summary := ""
				if s, ok := fmObj["summary"].(string); ok {
					summary = strings.TrimSpace(s)
				}

				concepts := parseConceptsFromList(fmObj["concepts"], docPath)
				if concepts == nil {
					concepts = []ExtractedConcept{}
				}
				quizzes := parseQuizzesFromList(fmObj["quizzes"])
				takeaways := parseTakeawaysFromList(fmObj["takeaways"])

				return ExtractedManifestResult{
					HasFrontmatter: true,
					CleanMdx:       cleanMdx,
					CleanContent:   cleanMdx,
					Concepts:       concepts,
					Quizzes:        quizzes,
					Takeaways:      takeaways,
					Summary:        summary,
				}
			} else if looksLikeYamlAttempt(trimmedFm) {
				// 损坏 frontmatter（既有围栏行为，golden 锁定）：块内容是
				// 失败的 YAML 尝试——剥离防垃圾污染正文，但概念为空
				return ExtractedManifestResult{
					HasFrontmatter: true,
					CleanMdx:       cleanMdx,
					CleanContent:   cleanMdx,
					Concepts:       []ExtractedConcept{},
				}
			}
			// fmObj == nil 且非 YAML 形态：开头的 --- 是水平分割线而非
			// frontmatter——两个 --- 之间是正文。旧实现一律剥离，把这段
			// 正文静默吞掉。不剥离，整体落入下方 XML/标题提取主流程。
		}
	}

	// 2. XML block extraction (<concept_manifest> / <pedagogy_manifest>)
	cleanContent, payloads := stripAndExtractManifestXml(rawContent)

	var rawItems []any
	var rawQuizzes []any
	var rawTakeaways []any
	summary := ""

	for _, payload := range payloads {
		payload = strings.TrimSpace(payload)
		if payload == "" {
			continue
		}

		if fenceMatch := codeFenceRe.FindStringSubmatch(payload); fenceMatch != nil {
			payload = strings.TrimSpace(fenceMatch[1])
		}
		payload = trailingCommaRe.ReplaceAllString(payload, "$1")

		// XML 载荷 JSON-only（对齐 Node concept-manifest JSON.parse：YAML 回退
		// 会接受 Node 拒绝的载荷）
		var parsed any
		if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
			continue
		}

		switch val := parsed.(type) {
		case []any:
			rawItems = append(rawItems, val...)
		case map[string]any:
			if s, ok := val["summary"].(string); ok && summary == "" {
				summary = strings.TrimSpace(s)
			}
			if cList, ok := val["concepts"].([]any); ok {
				rawItems = append(rawItems, cList...)
			}
			if qList, ok := val["quizzes"].([]any); ok {
				rawQuizzes = append(rawQuizzes, qList...)
			}
			if tList, ok := val["takeaways"].([]any); ok {
				rawTakeaways = append(rawTakeaways, tList...)
			}
			if _, hasName := val["name"]; hasName {
				if _, hasConcepts := val["concepts"]; !hasConcepts {
					rawItems = append(rawItems, val)
				}
			}
		}
	}

	concepts := parseConceptsFromList(rawItems, docPath)
	if concepts == nil {
		concepts = []ExtractedConcept{}
	}
	quizzes := parseQuizzesFromList(rawQuizzes)
	takeaways := parseTakeawaysFromList(rawTakeaways)

	return ExtractedManifestResult{
		HasFrontmatter: false,
		CleanMdx:       cleanContent,
		CleanContent:   cleanContent,
		Concepts:       concepts,
		Quizzes:        quizzes,
		Takeaways:      takeaways,
		Summary:        summary,
	}
}

func parseConceptsFromList(raw any, docPath string) []ExtractedConcept {
	concepts := []ExtractedConcept{}
	list, ok := raw.([]any)
	if !ok {
		return concepts
	}

	seenSlugs := make(map[string]bool)
	for _, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		rawName, _ := m["name"].(string)
		rawName = strings.TrimSpace(rawName)
		if rawName == "" {
			continue
		}

		// 校验上限（对齐 Node concept-manifest zod：name 1-100 越界拒绝整条——
		// 此前截断 60 会把前 60 字符同名的两个概念坍缩成一个 slug）
		if r := []rune(rawName); len(r) > 100 {
			continue
		}

		sourceHeadingRaw, _ := m["sourceHeading"].(string)
		reflectionRaw, _ := m["reflection"].(string)
		summaryRaw, _ := m["summary"].(string)
		if r := []rune(strings.TrimSpace(sourceHeadingRaw)); len(r) > 100 {
			continue
		}
		if r := []rune(strings.TrimSpace(reflectionRaw)); len(r) > 1500 {
			continue
		}
		if r := []rune(strings.TrimSpace(summaryRaw)); len(r) > 500 {
			continue
		}

		slugPrefix := ""
		if docPath != "" {
			slugPrefix = docPath + "-"
		}
		slug := SlugifyConcept(slugPrefix + rawName)
		if seenSlugs[slug] {
			continue
		}
		seenSlugs[slug] = true

		cat := NormalizeCategory(m["category"])
		sourceHeading, _ := m["sourceHeading"].(string)
		if sourceHeading != "" {
			sourceHeading = strings.TrimSpace(manifestInlineDecorationsRe.ReplaceAllString(chunker.CleanMarkdownHeading(sourceHeading), ""))
		}

		reflection, _ := m["reflection"].(string)
		reflection = strings.TrimSpace(reflection)

		summary, _ := m["summary"].(string)
		summary = strings.TrimSpace(summary)
		if summary == "" {
			summary = rawName
		}

		anchor := sourceHeading
		if anchor == "" {
			anchor = rawName
		}

		labels := LabelsForLocale("")
		concepts = append(concepts, ExtractedConcept{
			ConceptName:       rawName,
			Slug:              slug,
			Category:          cat,
			PrinciplesText:    summary,
			AuthorReflections: reflection,
			SopSteps:          []string{},
			Summary:           summary,
			SubTopics:         []string{cat, labels.MentorGuidanceTag},
			Tags:              []string{labels.ExperienceTag, cat},
			SourceHeading:     sourceHeading,
			AnchorText:        anchor,
		})

		if len(concepts) >= 15 {
			break
		}
	}

	if concepts == nil {
		concepts = []ExtractedConcept{}
	}
	return concepts
}

func parseQuizzesFromList(raw any) []CompanionQuiz {
	var quizzes []CompanionQuiz
	list, ok := raw.([]any)
	if !ok {
		return nil
	}

	for _, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		qText, _ := m["question"].(string)
		qText = strings.TrimSpace(qText)
		if qText == "" {
			continue
		}

		var options []string
		if rawOpts, ok := m["options"].([]any); ok {
			for _, o := range rawOpts {
				if s, ok := o.(string); ok && strings.TrimSpace(s) != "" {
					options = append(options, strings.TrimSpace(s))
				}
			}
		}
		if len(options) < 2 || len(options) > 5 {
			continue // 2-5 个选项（>5 弃整个 quiz，对齐 Node zod；此前截断保留）
		}
		invalidQuiz := false
		for _, o := range options {
			if r := []rune(o); len(r) > 200 {
				invalidQuiz = true
				break
			}
		}
		if invalidQuiz || func() bool { r := []rune(qText); return len(r) > 300 }() {
			continue
		}

		correctIdx := 0
		switch v := m["correctIndex"].(type) {
		case int:
			correctIdx = v
		case float64:
			correctIdx = int(v)
		}
		if correctIdx < 0 || correctIdx >= len(options) {
			correctIdx = 0
		}

		explanation, _ := m["explanation"].(string)
		quizzes = append(quizzes, CompanionQuiz{
			Question:     qText,
			Options:      options,
			CorrectIndex: correctIdx,
			Explanation:  strings.TrimSpace(explanation),
		})
	}
	return quizzes
}

func parseTakeawaysFromList(raw any) []string {
	var takeaways []string
	list, ok := raw.([]any)
	if !ok {
		return nil
	}

	for _, item := range list {
		if s, ok := item.(string); ok {
			t := strings.TrimSpace(s)
			if t != "" {
				takeaways = append(takeaways, t)
			}
		}
		if len(takeaways) >= 5 {
			break
		}
	}
	return takeaways
}

// knownFrontmatterKeys 是合法的 concept manifest frontmatter 键白名单。
// 扩展此列表时同步更新 Node parseFrontmatter 的期望 schema。
var knownFrontmatterKeys = map[string]bool{
	"summary":   true,
	"concepts":  true,
	"quizzes":   true,
	"takeaways": true,
	"title":     true,
	"tags":      true,
	"level":     true,
	"category":  true,
	"lang":      true,
	"version":   true,
}

func looksLikeYamlAttempt(block string) bool {
	trimmed := strings.TrimSpace(block)
	if strings.HasPrefix(trimmed, "[") || strings.HasPrefix(trimmed, "{") {
		return true
	}
	// 按行扫描：若任一行以已知 frontmatter key + ":" 开头，判定为 YAML 尝试
	for _, line := range strings.Split(trimmed, "\n") {
		line = strings.TrimSpace(line)
		line = strings.TrimPrefix(line, "- ")
		if idx := strings.Index(line, ":"); idx > 0 {
			key := strings.Trim(strings.TrimSpace(line[:idx]), `"'`)
			if knownFrontmatterKeys[key] {
				return true
			}
		}
	}
	return false
}

func parseFrontmatterYAML(trimmedFm string) map[string]any {
	var fmObj map[string]any
	err := yaml.Unmarshal([]byte(trimmedFm), &fmObj)
	if err == nil && fmObj != nil {
		return fmObj
	}

	stripped := trimmedFm
	if fenceMatch := codeFenceRe.FindStringSubmatch(trimmedFm); fenceMatch != nil {
		stripped = strings.TrimSpace(fenceMatch[1])
	} else {
		stripped = codeFencePrefixRe.ReplaceAllString(stripped, "")
		stripped = codeFenceSuffixRe.ReplaceAllString(stripped, "")
		stripped = strings.TrimSpace(stripped)
	}
	stripped = trailingCommaRe.ReplaceAllString(stripped, "$1")
	var retryObj map[string]any
	if errRetry := yaml.Unmarshal([]byte(stripped), &retryObj); errRetry == nil && retryObj != nil {
		return retryObj
	}
	return nil
}
