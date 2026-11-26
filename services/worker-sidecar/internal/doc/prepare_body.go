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

const defaultAIModel = "qwen3.6-flash"

var transcriptionPresetIds = map[string]bool{
	"standard":   true,
	"deep":       true,
	"cheatsheet": true,
	"faithful":   true,
	"analogy":    true,
}

var presetTeachingDepth = map[string]string{
	"standard": "standard",
	"deep":     "deep",
}

var presetAiCondensation = map[string]string{
	"standard":   "balanced",
	"cheatsheet": "tldr",
	"faithful":   "faithful",
}

var PresetTeachingDepth = presetTeachingDepth

const defaultTranscriptionPresetId = "standard"

func resolveTranscriptionPresetId(id string) string {
	if !transcriptionPresetIds[id] {
		return defaultTranscriptionPresetId
	}
	return id
}

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

// Serialize sorted non-empty fields with JS JSON.stringify escaping so Go and Node JIT yield identical sha256 fingerprints.
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

// Escape control chars without escaping HTML entities to match JS JSON.stringify output.
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

type navTreeItem struct {
	Path     string        `json:"path"`
	Title    string        `json:"title"`
	Children []navTreeItem `json:"children"`
}

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

func PrepareDocumentBody(ctx context.Context, cfg Config, patterns Patterns, store PrepareStore, docId string, opts PrepareOptions) (*PrepareResult, error) {
	doc, err := store.LoadDocumentForPrepare(ctx, docId)
	if err != nil {
		return nil, fmt.Errorf("prepare load document: %w", err)
	}

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

	if doc.Status == "PROCESSED" && doc.Content != nil && strings.TrimSpace(*doc.Content) != "" && !opts.ForceEnhance {
		return &PrepareResult{Ok: true, Outcome: "noop", Model: model}, nil
	}

	fp := computeRequestFingerprint(fingerprintInputsFor(doc, model, &opts))

	if !opts.ForceEnhance {
		contentId, content, donor, donorLevel, err := store.FindReusableContentByFingerprint(ctx, fp)
		if err == nil && contentId != "" && strings.TrimSpace(content) != "" {
			if n, cerr := store.CountContentChunks(ctx, contentId); cerr == nil && n == 0 && donor != "" {
				_ = store.AttachContentChunks(ctx, contentId, donor)
			}
			stamped, serr := store.StampProcessed(ctx, doc.ID, content, &contentId, doc.GitSha, model, donorLevel, cfg.ContentDualWrite)
			if serr != nil {
				return nil, fmt.Errorf("prepare reuse stamp: %w", serr)
			}
			if !stamped {
				// Converge to noop on StampProcessed CAS miss so concurrent processing never falsely reports fingerprint-hit.
				log.Printf("[prepare] reuse stamp CAS miss, converging to noop for %s", doc.Path)
				return &PrepareResult{Ok: true, Outcome: "noop", Model: model}, nil
			}
			manifest := concept.ExtractConceptManifest(content, doc.Path)
			if merr := store.StoreDocumentMetadata(ctx, doc.RepositoryID, doc.ID, doc.Path, content, manifest, ""); merr != nil {
				log.Printf("[prepare] reuse concept sync failed for %s: %v", doc.Path, merr)
			}
			res := &PrepareResult{Ok: true, Outcome: "fingerprint-hit", Fingerprint: fp, Model: model, ReuseContent: content}
			res.Doc.ID = doc.ID
			res.Doc.RepositoryID = doc.RepositoryID
			return res, nil
		}
		if err != nil {
			log.Printf("[prepare] fingerprint hit-check failed for %s: %v", doc.Path, err)
		}
	}

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

func runPrepare(ctx context.Context, cfg Config, patterns Patterns, store PrepareStore, docId string, opts PrepareOptions) (*PrepareResult, error) {
	return PrepareDocumentBody(ctx, cfg, patterns, store, docId, opts)
}

func isMarkdownDocPath(patterns Patterns, path string) bool {
	if patterns == nil {
		return false
	}
	return patterns.IsMarkdownDocPath(path)
}

func isVirtualChapterPath(patterns Patterns, path string) bool {
	if patterns == nil {
		return false
	}
	return patterns.IsVirtualChapterPath(path)
}

// Treat only explicit false as disabled to match JavaScript enableAiEnhance !== false semantics.
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
