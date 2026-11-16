package ingest

import (
	"encoding/json"
	"strings"

	"github.com/opengits/worker-sidecar/internal/chapter"
	"github.com/opengits/worker-sidecar/internal/concept"
)

// ─────────────────────────────────────────────────────────────
// 信封 repoProfile 权威消费 + 文本路径画像过滤（逐条对齐 Node
// efc69e6c^:engine/ingest.ts:171-215/275 与 engine/fetcher.ts:342-402）。
// ─────────────────────────────────────────────────────────────

// codebaseProfileEnvelope 信封画像的技术栈区块（向导 AI sniffer 产出，随
// options.repoProfile 透传；SniffProfile 规则嗅探不产生此区块）。
type codebaseProfileEnvelope struct {
	Framework        string   `json:"framework,omitempty"`
	PrimaryLanguages []string `json:"primaryLanguages,omitempty"`
}

// envelopeRepoProfile 信封画像形态：SniffProfile 全字段 + 章节映射增强字段。
type envelopeRepoProfile struct {
	SniffProfile
	ChapterMap      []chapter.ChapterMapEntry `json:"chapterMap,omitempty"`
	ProfileVersion  int                       `json:"profileVersion,omitempty"`
	CodebaseProfile *codebaseProfileEnvelope  `json:"codebaseProfile,omitempty"`
}

// parseProvidedProfile 解析信封 repoProfile；空载荷返回 nil（保持纯规则嗅探路径）。
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

// mergeProvidedProfile 信封画像权威消费（零额外 LLM）：
// rule 侧 translationRoots 并集合并（确定性多语言目录不因画像陈旧而漏滤）、
// isTreeTruncated 恒以物理扫描为准；关键字段缺席时回退规则嗅探值。
func mergeProvidedProfile(provided *envelopeRepoProfile, rule SniffProfile) SniffProfile {
	merged := provided.SniffProfile
	if merged.IngestMode == "" {
		merged.IngestMode = rule.IngestMode
	}
	// 物理反证闸门：信封裁定 hybrid/code_only 但物理扫描显示零代码文件——
	// 陈旧/异常信封不得把无码仓推入代码管线（阶梯 RSG 格会硬失败）。
	// 反向（text_only 但有代码）不拦：灰区意图裁决权在 scout 侧 LLM 仲裁。
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

// providedChapterMapOf 信封画像携带的章节映射（profileVersion=2 产物）；
// 非空即同仓同 sha 复用（零 LLM）。
func providedChapterMapOf(p *envelopeRepoProfile) []ChapterMapEntry {
	if p == nil || len(p.ChapterMap) == 0 {
		return nil
	}
	return p.ChapterMap
}

// filterNodesByProfile 文本路径建树前过滤（Node fetcher.filterNodesByProfile 逐序移植）：
// 1. translationRoots 前缀命中 → 拒绝（翻译目录不入正典）
// 2. semanticTags：meta/config → 拒绝（migration 标记仅影响排序，Go 导航树无此消费面）
// 3. 高优迁移白名单（markdown 门 + 词干/路径段精确匹配）→ 保留
// 4. excludeFromNav 精确路径 → 拒绝（答案/剧透类文档）
// 5. 内容扩展白名单 → 保留
// 6. customExtensions 追加白名单 → 保留
// 非 blob 节点（tree）恒通过。代码路径不调用本过滤（Node 分派序：code 先行）。
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
		// 测试文件拒绝入正典树（cognitive 侧 IsTestFile 同款口径——
		// 规则树兜底章不得收编内部测试文档）
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
		// 默认拒绝（Node filter 尾部 default: reject）
	}
	return out
}

// normalizeTranslationRoots 统一携带尾部斜杠（Node 根目录约定 "zh-cn/" 形态）。
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

// semanticTagFor 语义标签查找：精确路径 → 去首斜杠路径 → 键大小写不敏感扫描
// （Node getSemanticTag 三级查找）。
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

// normalizeCustomExtensions trim → 小写 → 补 "." 前缀，空段丢弃。
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

// presetDisplayName 镜像 Node transcription-presets.ts 各 preset 的 name。
var presetDisplayName = map[string]string{
	"standard":   "教学解读",
	"deep":       "深度剖析",
	"cheatsheet": "速查手册",
	"faithful":   "忠实原文",
	"analogy":    "类比桥接",
}

// applyEnvelopeProfileExtras 信封转录选项落画像（原对齐 TS ingest.ts:209-252 持久化面；TS 原体已退役）：
// enableAiEnhance 决定转录层是否跑 LLM 增强管线；edition 三件套仅在指定讲法时写入。
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
			// Node 派生序：非 standard 讲法取 preset 名 + "讲法"，否则 "讲法 {edition}"
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
