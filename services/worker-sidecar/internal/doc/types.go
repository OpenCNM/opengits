package doc

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/webdoc"
)

// Re-export external types used by doc service.
type ReplaceChunksOpts = webdoc.ReplaceChunksOpts
type ExtractedManifestResult = concept.ExtractedManifestResult
type MarkdownChunk = chunker.MarkdownChunk

// Patterns abstracts path classification rules.
type Patterns interface {
	IsMarkdownDocPath(path string) bool
	IsVirtualChapterPath(path string) bool
}

type snifferPatterns struct {
	MarkdownExtensions []string `json:"markdownExtensions"`
}

// IngestPatterns implements Patterns for pattern matching.
type IngestPatterns struct {
	Sniffer                    snifferPatterns `json:"sniffer"`
	VirtualChapterPathPrefixes []string        `json:"virtualChapterPathPrefixes"`
}

func (p *IngestPatterns) IsMarkdownDocPath(path string) bool {
	if p == nil {
		return false
	}
	lower := strings.ToLower(path)
	for _, ext := range p.Sniffer.MarkdownExtensions {
		if strings.HasSuffix(lower, strings.ToLower(ext)) {
			return true
		}
	}
	return false
}

func (p *IngestPatterns) IsVirtualChapterPath(path string) bool {
	if p == nil {
		return false
	}
	for _, prefix := range p.VirtualChapterPathPrefixes {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

// 内容等级（生成时写入的确定性事实，读者知情分级；与 Node 侧
// lib/constants.ts GENERATION_LEVEL 注册表同值域同步）。
const (
	GenerationLevelEnhanced    = "enhanced"    // 增强+翻译一体化 / 纯增强
	GenerationLevelTranslated  = "translated"  // 纯翻译（JIT/直连/降级保译）
	GenerationLevelOriginal    = "original"    // 原文收编 / 原文保底
	GenerationLevelCodeLesson  = "code_lesson" // 代码章 LLM 写课
)

// PrepareDoc represents document + repo projection for prepare phase.
type PrepareDoc struct {
	ID           string
	RepositoryID string
	Path         string
	Title        string
	Status       string
	Content      *string
	OwnerUserID  *string
	RepoOwner    string
	RepoName     string
	Branch       string
	GitSha       *string
	RepoProfile  map[string]any
	NavTree      json.RawMessage
}

// PrepareOptions represents options passed to PrepareDocumentBody.
type PrepareOptions struct {
	Model               string
	TargetLanguage      string
	CustomPrompt        string
	TranscriptionPreset string
	AICondensation      string
	TeachingDepth       string
	UserID              string
	ForceEnhance        bool
	TokensUsed          int
}

// PrepareResult represents the outcome of PrepareDocumentBody.
type PrepareResult struct {
	Ok      bool   `json:"ok"`
	Outcome string `json:"outcome"` // noop | fingerprint-hit | ready
	//nolint:revive // 契约字段名对齐 web 端点
	Fingerprint string `json:"fingerprint"`
	Model       string `json:"model"`
	// ContentDegraded 成品降级标记（确定性事实传播）：收敛漏斗原文保底等降级
	// 路径置 true——finalize 段据此跳过内容层写入，防指纹钉死放大降级成品。
	ContentDegraded bool `json:"contentDegraded,omitempty"`
	// ReuseContent 指纹命中零 LLM 复用搬入的成品（仅 fingerprint-hit 填充，
	// 供命中后的图谱边同步消费，避免二次读库）。
	ReuseContent string `json:"reuseContent,omitempty"`
	// GenerationLevel 内容等级（策略层生成时写入的确定性事实；stamp 时落
	// Document.generationLevel 供读者知情分级；空 = 不更新既有值）。
	GenerationLevel string `json:"generationLevel,omitempty"`
	Effective    struct {
		TargetLanguage      *string `json:"targetLanguage"`
		CustomPrompt        *string `json:"customPrompt"`
		TranscriptionPreset *string `json:"transcriptionPreset"`
		AICondensation      *string `json:"aiCondensation"`
		TeachingDepth       *string `json:"teachingDepth,omitempty"`
		ForceEnhance        bool    `json:"forceEnhance"`
	} `json:"effective"`
	Doc struct {
		ID              string         `json:"id"`
		RepositoryID    string         `json:"repositoryId"`
		Path            string         `json:"path"`
		Title           string         `json:"title,omitempty"`
		Content         *string        `json:"content"`
		Status          string         `json:"status"`
		OwnerUserID     *string        `json:"ownerUserId"`
		EnableAIEnhance bool           `json:"enableAiEnhance"`
		IsMarkdown      bool           `json:"isMarkdown"`
		VirtualChapter  bool           `json:"virtualChapter"`
		RepoProfile     map[string]any `json:"repoProfile,omitempty"`
		SourceFiles     []string       `json:"sourceFiles,omitempty"`
		Repository      struct {
			Owner  string  `json:"owner"`
			Repo   string  `json:"repo"`
			Branch string  `json:"branch"`
			GitSha *string `json:"gitSha"`
		} `json:"repository"`
	} `json:"doc"`
	Chunker struct {
		ParentTitle string `json:"parentTitle"`
		MaxTokens   int    `json:"maxTokens"`
		Overlap     int    `json:"overlap"`
	} `json:"chunker"`
	TokensUsed int `json:"tokensUsed,omitempty"`
	Usage      struct {
		TotalTokens int `json:"totalTokens,omitempty"`
	} `json:"usage,omitempty"`
	Message string `json:"message"`
}

// PrepareStore abstracts storage operations required by PrepareDocumentBody.
type PrepareStore interface {
	LoadDocumentForPrepare(ctx context.Context, docId string) (*PrepareDoc, error)
	LoadActiveUserModelId(ctx context.Context, userId string) (string, error)
	FindReusableContentByFingerprint(ctx context.Context, fingerprint string) (contentId, content, donorDocId, donorLevel string, err error)
	CountContentChunks(ctx context.Context, contentId string) (int, error)
	AttachContentChunks(ctx context.Context, contentId, documentId string) error
	StampProcessed(ctx context.Context, documentId, content string, contentId *string, gitSha *string, model, generationLevel string, dualWrite bool) (bool, error)
	StoreDocumentMetadata(ctx context.Context, repositoryId, docId, docPath, content string, manifest ExtractedManifestResult, summary string) error
}

// FinalizeStore abstracts storage operations for chunks and finalization.
type FinalizeStore interface {
	GetDocumentRepositoryInfo(ctx context.Context, docId string) (repoId, docPath, branch string, err error)
	ReplaceDocumentChunks(ctx context.Context, docId string, chunks []chunker.MarkdownChunk, opts ReplaceChunksOpts) (int, error)
	StoreDocumentMetadata(ctx context.Context, repoID, docID, docPath, cleanContent string, manifest ExtractedManifestResult, summary string) error
	UpsertContentLayer(ctx context.Context, contentHash, fingerprint, content, lang, model string) (string, error)
	AttachContentChunks(ctx context.Context, contentId, documentId string) error
	DeleteLegacyChunks(ctx context.Context, docId string) error
	StampProcessed(ctx context.Context, docId, cleanContent string, contentId *string, gitSha *string, model, generationLevel string, dualWrite bool) (bool, error)
	RecordTranscriptionModel(ctx context.Context, repoID, model string) error
	RecordTranscriptionTokens(ctx context.Context, repoID string, tokens int) error
}

// LlmsTxtStore abstracts database operations for llms.txt generation.
type LlmsTxtStore interface {
	GetLlmsTxtData(ctx context.Context, repoID string, userID *string) (*LlmsTxtRepoInfo, []LlmsTxtDoc, error)
}

// Store combines all persistence operations for the doc package.
type Store interface {
	PrepareStore
	FinalizeStore
	LlmsTxtStore
}

// DocStore is a compatibility alias for Store.
type DocStore = Store
