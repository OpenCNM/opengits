package doc

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"github.com/opengits/worker-sidecar/internal/concept"
)

// defaultAIModel 对齐 apps/client/src/lib/constants.ts DEFAULT_AI_MODEL。
const defaultAIModel = "qwen3.6-flash"

// transcriptionPresetIds 转录预设 id 白名单（对齐 transcription-presets.ts
// TRANSCRIPTION_PRESETS；未知 id 静默回落默认——repoProfile 脏数据容错）。
var transcriptionPresetIds = map[string]bool{
	"standard":   true,
	"deep":       true,
	"cheatsheet": true,
	"faithful":   true,
	"analogy":    true,
}

// presetTeachingDepth 预设默认教学深度（仅 standard/deep 携带 defaults.
// teachingDepth，其余预设无该默认）。
var presetTeachingDepth = map[string]string{
	"standard": "standard",
	"deep":     "deep",
}

// presetAiCondensation 预设默认凝练度（对齐 transcription-presets.ts defaults：
// standard→balanced / cheatsheet→tldr / faithful→faithful；deep 与 analogy 无默认）。
var presetAiCondensation = map[string]string{
	"standard":   "balanced",
	"cheatsheet": "tldr",
	"faithful":   "faithful",
}

var PresetTeachingDepth = presetTeachingDepth

// defaultTranscriptionPresetId 对齐 DEFAULT_TRANSCRIPTION_PRESET_ID。
const defaultTranscriptionPresetId = "standard"

// resolveTranscriptionPresetId 白名单外回落默认 preset。
func resolveTranscriptionPresetId(id string) string {
	if !transcriptionPresetIds[id] {
		return defaultTranscriptionPresetId
	}
	return id
}

// FingerprintInput 请求指纹输入（对齐 RequestFingerprintInput；值仅
// string，teachingDepth 历史类型 string|number 以 string 承载）。
type FingerprintInput struct {
	RepositoryId   string
	Path           string
	GitSha         string
	Lang           string
	Model          string
	Preset         string
	TeachingDepth  string
	AICondensation string
	CustomPrompt   string
}

// computeRequestFingerprint 生成请求指纹：非空字段按 key 排序后稳定序列化
// （JS JSON.stringify 语义），sha256 hex。逐字节对齐 content-addressing.ts
// computeRequestFingerprint（黄金夹具锁死——Node JIT 路径与 Go 必须同指纹）。
func computeRequestFingerprint(in FingerprintInput) string {
	type kv struct{ k, v string }
	entries := []kv{
		{"aiCondensation", strings.TrimSpace(in.AICondensation)},
		{"customPrompt", strings.TrimSpace(in.CustomPrompt)},
		{"gitSha", strings.TrimSpace(in.GitSha)},
		{"lang", strings.TrimSpace(in.Lang)},
		{"model", strings.TrimSpace(in.Model)},
		{"path", strings.TrimSpace(in.Path)},
		{"preset", strings.TrimSpace(in.Preset)},
		{"repositoryId", strings.TrimSpace(in.RepositoryId)},
		{"teachingDepth", strings.TrimSpace(in.TeachingDepth)},
	}
	var filtered []kv
	for _, e := range entries {
		if e.v != "" {
			filtered = append(filtered, e)
		}
	}
	// 既有字段集恒定且互异（小写驼峰 ASCII），key 字典序 = localeCompare 序
	var b strings.Builder
	b.WriteByte('[')
	for i, e := range filtered {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteByte('[')
		b.WriteString(jsJSONArrayItem(e.k))
		b.WriteByte(',')
		b.WriteString(jsJSONArrayItem(e.v))
		b.WriteByte(']')
	}
	b.WriteByte(']')
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:])
}

// jsJSONArrayItem JS JSON.stringify 风格字符串序列化（\b\t\n\f\r 快捷
// 转义 + <0x20 控制字符 \u00XX + 不转义 HTML 实体字符）。
func jsJSONArrayItem(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\t':
			b.WriteString(`\t`)
		case '\n':
			b.WriteString(`\n`)
		case '\f':
			b.WriteString(`\f`)
		case '\r':
			b.WriteString(`\r`)
		default:
			if c < 0x20 {
				b.WriteString(fmt.Sprintf(`\u%04x`, c))
			} else {
				b.WriteByte(c)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// profileStr 画像字符串键（非字符串或空白 → ""）。
func profileStr(profile map[string]any, key string) string {
	if profile == nil {
		return ""
	}
	v, ok := profile[key]
	if !ok {
		return ""
	}
	s, ok := v.(string)
	if !ok || strings.TrimSpace(s) == "" {
		return ""
	}
	return s
}

// fingerprintInputsFor 指纹输入归一（对齐 transcription/fingerprint.ts）：
// 显式 options 优先、缺省画像兜底、teachingDepth 缺省取 preset 默认。
func fingerprintInputsFor(doc *PrepareDoc, model string, opts *PrepareOptions) FingerprintInput {
	profile := doc.RepoProfile
	preset := opts.TranscriptionPreset
	if preset == "" {
		preset = profileStr(profile, "transcriptionPreset")
	}
	resolved := resolveTranscriptionPresetId(preset)
	teachingDepth := opts.TeachingDepth
	if teachingDepth == "" {
		teachingDepth = presetTeachingDepth[resolved]
	}
	lang := opts.TargetLanguage
	if lang == "" {
		lang = profileStr(profile, "targetLanguage")
	}
	customPrompt := opts.CustomPrompt
	if customPrompt == "" {
		customPrompt = profileStr(profile, "transcriptionPrompt")
	}
	aiCondensation := opts.AICondensation
	if aiCondensation == "" {
		aiCondensation = presetAiCondensation[resolved]
	}
	return FingerprintInput{
		RepositoryId:   doc.RepositoryID,
		Path:           doc.Path,
		GitSha:         derefStrPtr(doc.GitSha),
		Lang:           lang,
		Model:          model,
		Preset:         preset,
		TeachingDepth:  teachingDepth,
		AICondensation: aiCondensation,
		CustomPrompt:   customPrompt,
	}
}

// navTreeItem navTree 节点最小投影（parentTitle 提取只需 path/title/children）。
type navTreeItem struct {
	Path     string        `json:"path"`
	Title    string        `json:"title"`
	Children []navTreeItem `json:"children"`
}

// extractParentTitleFromNavTree 目标路径的父分组标题（对齐 chunker.ts：
// path / path.md / path.mdx 三态匹配，children 递归下钻）。
func ExtractParentTitleFromNavTree(raw json.RawMessage, targetPath string) string {
	return extractParentTitleFromNavTree(raw, targetPath)
}

func extractParentTitleFromNavTree(raw json.RawMessage, targetPath string) string {
	if len(raw) == 0 || targetPath == "" {
		return ""
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "null" || trimmed == "" {
		return ""
	}
	if strings.HasPrefix(trimmed, "{") {
		var obj struct {
			ParentTitle string `json:"parentTitle"`
		}
		if json.Unmarshal(raw, &obj) == nil {
			return obj.ParentTitle
		}
		return ""
	}
	var nodes []navTreeItem
	if json.Unmarshal(raw, &nodes) != nil {
		return ""
	}
	var search func(items []navTreeItem, parentTitle string) string
	search = func(items []navTreeItem, parentTitle string) string {
		for _, n := range items {
			if n.Path == targetPath || n.Path+".md" == targetPath || n.Path+".mdx" == targetPath {
				return parentTitle
			}
			if len(n.Children) > 0 {
				next := n.Title
				if next == "" {
					next = parentTitle
				}
				if found := search(n.Children, next); found != "" {
					return found
				}
			}
		}
		return ""
	}
	return search(nodes, "")
}

// PrepareDocumentBody S1-S4 收口（对齐 prepare route 主流程）。文档不存在/读失败
// 显式 error（Fail-Closed，由调用方 bodyFallback/ERROR 处置）。
func PrepareDocumentBody(ctx context.Context, cfg Config, patterns Patterns, store PrepareStore, docId string, opts PrepareOptions) (*PrepareResult, error) {
	doc, err := store.LoadDocumentForPrepare(ctx, docId)
	if err != nil {
		return nil, fmt.Errorf("prepare load document: %w", err)
	}

	// 配置兜底链（S1b）：options > repoProfile
	effective := struct{ tl, cp, tp, ac, td string }{
		tl: firstNonEmpty(opts.TargetLanguage, profileStr(doc.RepoProfile, "targetLanguage")),
		cp: firstNonEmpty(opts.CustomPrompt, profileStr(doc.RepoProfile, "transcriptionPrompt")),
		tp: firstNonEmpty(opts.TranscriptionPreset, profileStr(doc.RepoProfile, "transcriptionPreset")),
		ac: func() string {
			if opts.AICondensation != "" {
				return opts.AICondensation
			}
			preset := opts.TranscriptionPreset
			if preset == "" {
				preset = profileStr(doc.RepoProfile, "transcriptionPreset")
			}
			return presetAiCondensation[resolveTranscriptionPresetId(preset)]
		}(),
		td: opts.TeachingDepth,
	}

	// 模型解析链（S2b）：options > BYOK 激活 selectedModel > 画像 > 默认
	userId := opts.UserID
	if userId == "" {
		userId = derefStrPtr(doc.OwnerUserID)
	}
	userModel := ""
	if userId != "" {
		if m, err := store.LoadActiveUserModelId(ctx, userId); err == nil {
			userModel = m
		} else {
			log.Printf("[prepare] user model resolve failed for %s: %v", userId, err)
		}
	}
	model := firstNonEmpty(opts.Model, userModel, profileStr(doc.RepoProfile, "transcriptionModel"), defaultAIModel)

	// noop（S4a）：已 PROCESSED 且内容非空
	if doc.Status == "PROCESSED" && doc.Content != nil && strings.TrimSpace(*doc.Content) != "" && !opts.ForceEnhance {
		return &PrepareResult{Ok: true, Outcome: "noop", Model: model}, nil
	}

	fp := computeRequestFingerprint(fingerprintInputsFor(doc, model, &opts))

	// 指纹命中零 LLM 复用（S4b）
	if !opts.ForceEnhance {
		contentId, content, donor, donorLevel, err := store.FindReusableContentByFingerprint(ctx, fp)
		if err == nil && contentId != "" && strings.TrimSpace(content) != "" {
			if n, cerr := store.CountContentChunks(ctx, contentId); cerr == nil && n == 0 && donor != "" {
				_ = store.AttachContentChunks(ctx, contentId, donor)
			}
			// 内容等级继承 donor 行（复用搬成品，等级随成品走——不因搬运丢失标注）
			stamped, serr := store.StampProcessed(ctx, doc.ID, content, &contentId, doc.GitSha, model, donorLevel, cfg.ContentDualWrite)
			if serr != nil {
				return nil, fmt.Errorf("prepare reuse stamp: %w", serr)
			}
			if !stamped {
				// CAS miss：指纹复用装配期间成品已被并发换入——doc 已有他人成品，
				// 按 noop 收敛（与 297 行「已 PROCESSED 且有内容」同语义），绝不谎报 fingerprint-hit
				log.Printf("[prepare] reuse stamp CAS miss, converging to noop for %s", doc.Path)
				return &PrepareResult{Ok: true, Outcome: "noop", Model: model}, nil
			}
			manifest := concept.ExtractConceptManifest(content, doc.Path)
			if merr := store.StoreDocumentMetadata(ctx, doc.RepositoryID, doc.ID, doc.Path, content, manifest, ""); merr != nil {
				log.Printf("[prepare] reuse concept sync failed for %s: %v", doc.Path, merr)
			}
			// 命中结果载有 ReuseContent/RepositoryID：供执行体命中分支做 LLM 边
			// 补同步（零 LLM 复用不得留下图谱空洞）
			res := &PrepareResult{Ok: true, Outcome: "fingerprint-hit", Fingerprint: fp, Model: model, ReuseContent: content}
			res.Doc.ID = doc.ID
			res.Doc.RepositoryID = doc.RepositoryID
			return res, nil
		}
		if err != nil {
			log.Printf("[prepare] fingerprint hit-check failed for %s: %v", doc.Path, err)
		}
	}

	// ready：chunker 单一配置源（navTree parentTitle + 同 env 同默认的
	// CHUNK_MAX_TOKENS/CHUNK_OVERLOAD，防两侧参数漂移）
	res := &PrepareResult{
		Ok:          true,
		Outcome:     "ready",
		Fingerprint: fp,
		Model:       model,
	}
	res.Effective.TargetLanguage = strPtrOrNil(effective.tl)
	res.Effective.CustomPrompt = strPtrOrNil(effective.cp)
	res.Effective.TranscriptionPreset = strPtrOrNil(effective.tp)
	res.Effective.AICondensation = strPtrOrNil(effective.ac)
	res.Effective.TeachingDepth = strPtrOrNil(effective.td)
	res.Effective.ForceEnhance = opts.ForceEnhance
	res.TokensUsed = opts.TokensUsed
	res.Doc.ID = doc.ID
	res.Doc.RepositoryID = doc.RepositoryID
	res.Doc.Path = doc.Path
	res.Doc.Title = doc.Title
	res.Doc.Content = doc.Content
	res.Doc.Status = doc.Status
	res.Doc.OwnerUserID = doc.OwnerUserID
	res.Doc.EnableAIEnhance = !profileBoolFalse(doc.RepoProfile, "enableAiEnhance")
	res.Doc.IsMarkdown = isMarkdownDocPath(patterns, doc.Path)
	res.Doc.VirtualChapter = isVirtualChapterPath(patterns, doc.Path)
	res.Doc.RepoProfile = doc.RepoProfile
	res.Doc.Repository.Owner = doc.RepoOwner
	res.Doc.Repository.Repo = doc.RepoName
	res.Doc.Repository.Branch = doc.Branch
	res.Doc.Repository.GitSha = doc.GitSha
	res.Chunker.ParentTitle = extractParentTitleFromNavTree(doc.NavTree, doc.Path)
	res.Chunker.MaxTokens = cfg.ChunkerMaxTokens
	res.Chunker.Overlap = cfg.ChunkerOverlap
	return res, nil
}

// runPrepare 兼容性别名，保留平滑过渡。
func runPrepare(ctx context.Context, cfg Config, patterns Patterns, store PrepareStore, docId string, opts PrepareOptions) (*PrepareResult, error) {
	return PrepareDocumentBody(ctx, cfg, patterns, store, docId, opts)
}

// isMarkdownDocPath markdown 扩展判定（注册表单一事实源 MODULE_ROLE_PATTERNS）。
func isMarkdownDocPath(patterns Patterns, path string) bool {
	if patterns == nil {
		return false
	}
	return patterns.IsMarkdownDocPath(path)
}

// isVirtualChapterPath 虚拟章节前缀判定（code-chapter 管线分流）。
func isVirtualChapterPath(patterns Patterns, path string) bool {
	if patterns == nil {
		return false
	}
	return patterns.IsVirtualChapterPath(path)
}

// profileBoolFalse 画像布尔键仅显式 false 才为假（enableAiEnhance !== false 语义）。
func profileBoolFalse(profile map[string]any, key string) bool {
	if profile == nil {
		return false
	}
	v, ok := profile[key]
	if !ok {
		return false
	}
	b, ok := v.(bool)
	return ok && !b
}

func strPtrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func derefStrPtr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
