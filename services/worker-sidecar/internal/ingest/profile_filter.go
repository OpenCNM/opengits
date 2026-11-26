package ingest

import (
	"encoding/json"
	"strings"

	"github.com/opengits/worker-sidecar/internal/chapter"
	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

type codebaseProfileEnvelope struct {
	Framework        string   `json:"framework,omitempty"`
	PrimaryLanguages []string `json:"primaryLanguages,omitempty"`
}

type envelopeRepoProfile struct {
	SniffProfile
	ChapterMap      []chapter.ChapterMapEntry `json:"chapterMap,omitempty"`
	ProfileVersion  int                       `json:"profileVersion,omitempty"`
	CodebaseProfile *codebaseProfileEnvelope  `json:"codebaseProfile,omitempty"`
}

func parseProvidedProfile(raw json.RawMessage) *envelopeRepoProfile {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var p envelopeRepoProfile
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil
	}
	return &p
}

func mergeProvidedProfile(provided *envelopeRepoProfile, rule SniffProfile) SniffProfile {
	merged := provided.SniffProfile
	if merged.IngestMode == "" {
		merged.IngestMode = rule.IngestMode
	}
	// Reject hybrid/code_only envelope modes when physical scan finds zero code files.
	if (merged.IngestMode == "hybrid" || merged.IngestMode == "code_only") && rule.DocCodeRatio.CodeFiles == 0 {
		merged.IngestMode = rule.IngestMode
	}
	if merged.Tier == "" {
		merged.Tier = rule.Tier
	}
	seen := make(map[string]bool, len(provided.TranslationRoots)+len(rule.TranslationRoots))
	roots := make([]string, 0, len(provided.TranslationRoots)+len(rule.TranslationRoots))
	for _, r := range provided.TranslationRoots {
		if !seen[r] {
			roots = append(roots, r)
			seen[r] = true
		}
	}
	for _, r := range rule.TranslationRoots {
		if !seen[r] {
			roots = append(roots, r)
			seen[r] = true
		}
	}
	merged.TranslationRoots = roots
	merged.HasTranslations = len(roots) > 0
	merged.IsTreeTruncated = rule.IsTreeTruncated
	return merged
}

// Detect code-centric customOutlines to correct false text_only profiles into virtual code chapters.
func customOutlineHasCodeChapters(categories []CustomOutlineCategory, patterns *IngestPatterns) bool {
	if len(categories) == 0 || patterns == nil {
		return false
	}
	for _, cat := range categories {
		codeCount := 0
		docCount := 0
		for _, f := range cat.Files {
			if len(f.CompanionFiles) > 0 {
				return true
			}
			basePath, _ := mdpat.SplitPathAnchor(strings.TrimSpace(f.Path))
			if basePath == "" {
				continue
			}
			if patterns.IsDocFile(basePath) || mdpat.MdMarkdownExtRe.MatchString(basePath) {
				docCount++
			} else if patterns.IsCodeFile(basePath) {
				codeCount++
			}
		}
		if codeCount > 0 && docCount == 0 {
			return true
		}
	}
	return false
}

func providedChapterMapOf(p *envelopeRepoProfile) []ChapterMapEntry {
	if p == nil || len(p.ChapterMap) == 0 {
		return nil
	}
	return p.ChapterMap
}

func filterNodesByProfile(nodes []GitNode, profile SniffProfile, customExtensions []string, patterns *IngestPatterns) []GitNode {
	if len(nodes) == 0 {
		return nodes
	}
	translationRoots := normalizeTranslationRoots(profile.TranslationRoots)
	excludeFromNav := make(map[string]bool, len(profile.ExcludeFromNav))
	for _, p := range profile.ExcludeFromNav {
		excludeFromNav[strings.TrimPrefix(p, "/")] = true
	}
	customExts := normalizeCustomExtensions(customExtensions)

	out := make([]GitNode, 0, len(nodes))
	for _, node := range nodes {
		if node.Type != "blob" {
			out = append(out, node)
			continue
		}
		path := strings.TrimPrefix(node.Path, "/")
		if patterns.IsTestFile(node.Path) {
			continue
		}
		if rejectedByTranslationRoot(path, translationRoots) {
			continue
		}
		if tag, ok := semanticTagFor(path, profile.SemanticTags); ok {
			if tag == "meta" || tag == "config" {
				continue
			}
			if tag == "migration" {
				out = append(out, node)
				continue
			}
		} else if patterns.IsHighPriorityMigrationFile(node.Path) {
			out = append(out, node)
			continue
		}
		if excludeFromNav[path] {
			continue
		}
		if patterns.MatchesAllowedFileExtension(node.Path) {
			out = append(out, node)
			continue
		}
		if matchesCustomExtension(node.Path, customExts) {
			out = append(out, node)
			continue
		}
	}
	return out
}

func normalizeTranslationRoots(roots []string) []string {
	out := make([]string, 0, len(roots))
	for _, r := range roots {
		r = strings.Trim(strings.TrimSpace(r), "/")
		if r == "" {
			continue
		}
		out = append(out, r+"/")
	}
	return out
}

func rejectedByTranslationRoot(path string, roots []string) bool {
	for _, r := range roots {
		if strings.HasPrefix(path, r) {
			return true
		}
	}
	return false
}

func semanticTagFor(path string, tags map[string]string) (string, bool) {
	if len(tags) == 0 {
		return "", false
	}
	if v, ok := tags[path]; ok {
		return v, true
	}
	lower := strings.ToLower(path)
	for k, v := range tags {
		if strings.ToLower(strings.TrimPrefix(k, "/")) == lower {
			return v, true
		}
	}
	return "", false
}

func normalizeCustomExtensions(exts []string) []string {
	out := make([]string, 0, len(exts))
	for _, e := range exts {
		e = strings.ToLower(strings.TrimSpace(e))
		if e == "" {
			continue
		}
		if !strings.HasPrefix(e, ".") {
			e = "." + e
		}
		out = append(out, e)
	}
	return out
}

func matchesCustomExtension(path string, exts []string) bool {
	if len(exts) == 0 {
		return false
	}
	lower := strings.ToLower(path)
	for _, e := range exts {
		if strings.HasSuffix(lower, e) {
			return true
		}
	}
	return false
}

var presetDisplayName = map[string]string{
	"standard":   "教学解读",
	"deep":       "深度剖析",
	"cheatsheet": "速查手册",
	"faithful":   "忠实原文",
	"analogy":    "类比桥接",
}

func applyEnvelopeProfileExtras(m map[string]any, o EnvelopeOptions, scopePrefix, edition string) {
	if m == nil {
		return
	}
	m["ingestPrefix"] = scopePrefix
	m["enableAiEnhance"] = o.UseAi
	if o.TargetLanguage != "" {
		m["targetLanguage"] = o.TargetLanguage
	}
	if o.CustomPrompt != "" {
		m["transcriptionPrompt"] = o.CustomPrompt
	}
	if o.TranscriptionPreset != "" {
		m["transcriptionPreset"] = o.TranscriptionPreset
	}
	if o.TeachingDepth != "" {
		m["teachingDepth"] = o.TeachingDepth
	}
	if o.AiCondensation != "" {
		m["aiCondensation"] = o.AiCondensation
	}
	if o.AiGranularity != "" {
		m["aiGranularity"] = o.AiGranularity
	}
	model := strings.TrimSpace(o.TranscriptionModel)
	if model == "" {
		model = strings.TrimSpace(o.Model)
	}
	if model != "" {
		m["transcriptionModel"] = model
	}
	if edition != "" {
		label := strings.TrimSpace(o.EditionLabel)
		if label == "" {
			if name, ok := presetDisplayName[o.TranscriptionPreset]; ok && o.TranscriptionPreset != "standard" {
				label = name + "讲法"
			} else {
				label = "讲法 " + edition
			}
		}
		m["editionLabel"] = label
		m["editionPreset"] = o.TranscriptionPreset
		m["editionFingerprint"] = concept.BuildEditionFingerprint(o.TranscriptionPreset, o.CustomPrompt, o.TargetLanguage, o.TeachingDepth)
	}
}
