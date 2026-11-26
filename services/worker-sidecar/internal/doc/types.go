package doc

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/webdoc"
)

type ReplaceChunksOpts = webdoc.ReplaceChunksOpts
type ExtractedManifestResult = concept.ExtractedManifestResult
type MarkdownChunk = chunker.MarkdownChunk

type Patterns interface {
	IsMarkdownDocPath(path string) bool
	IsVirtualChapterPath(path string) bool
}

type snifferPatterns struct {
	MarkdownExtensions []string `json:"markdownExtensions"`
}

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

const (
	GenerationLevelEnhanced   = "enhanced"
	GenerationLevelTranslated = "translated"
	GenerationLevelOriginal   = "original"
	GenerationLevelCodeLesson = "code_lesson"
)

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

type PrepareResult struct {
	Ok      bool   `json:"ok"`
	Outcome string `json:"outcome"`
	//nolint:revive
	Fingerprint string `json:"fingerprint"`
	Model       string `json:"model"`
	// Skip content-layer persistence when ContentDegraded is true so degraded fallback output never pins a reusable fingerprint.
	ContentDegraded bool   `json:"contentDegraded,omitempty"`
	ReuseContent    string `json:"reuseContent,omitempty"`
	GenerationLevel string `json:"generationLevel,omitempty"`
	Effective       struct {
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

type PrepareStore interface {
	LoadDocumentForPrepare(ctx context.Context, docId string) (*PrepareDoc, error)
	LoadActiveUserModelId(ctx context.Context, userId string) (string, error)
	FindReusableContentByFingerprint(ctx context.Context, fingerprint string) (contentId, content, donorDocId, donorLevel string, err error)
	CountContentChunks(ctx context.Context, contentId string) (int, error)
	AttachContentChunks(ctx context.Context, contentId, documentId string) error
	StampProcessed(ctx context.Context, documentId, content string, contentId *string, gitSha *string, model, generationLevel string, dualWrite bool) (bool, error)
	StoreDocumentMetadata(ctx context.Context, repositoryId, docId, docPath, content string, manifest ExtractedManifestResult, summary string) error
}

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

type LlmsTxtStore interface {
	GetLlmsTxtData(ctx context.Context, repoID string, userID *string) (*LlmsTxtRepoInfo, []LlmsTxtDoc, error)
}

type Store interface {
	PrepareStore
	FinalizeStore
	LlmsTxtStore
}

type DocStore = Store
