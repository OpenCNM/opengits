package webdoc

import (
	"context"

	"github.com/opengits/worker-sidecar/internal/chunker"
)

type WebSyncRepoInfo struct {
	ID                string
	IsPublic          bool
	Branch            string
	UpstreamEtag      *string
	OriginalURL       string
	SiteTitle         string
	SourceType        string
	SitemapLastModMap map[string]string
	DocOwnerID        *string
	// Empty scope fields allow all URLs during sync to preserve compatibility with un-scoped repos.
	AllowedPrefixes []string
	ExcludePrefixes []string
}

type WebSyncTxParams struct {
	RepositoryID      string
	DocOwnerID        *string
	UpdatedDocs       []FirecrawlDoc
	RemovedPaths      []string
	ETag              string
	SitemapLastModMap map[string]string
	AggregateSha      string
	UserID            string
	Owner             string
	Repo              string
	Branch            string
}

type WebSyncSavedDoc struct {
	ID      string
	Path    string
	Content string
}

type ReplaceChunksOpts struct {
	DocPath       string
	BlueprintRole string
	DefaultBranch string
}

type SyncOutcome int

const (
	SyncDone SyncOutcome = iota
	SyncFailed
	SyncFallback = SyncFailed
)

type SyncJob struct {
	ID     string
	Owner  string
	Repo   string
	Branch string
	UserID string
}

type SettleResult struct {
	RepositoryID         string
	QueuedDocumentsCount int
	GitSha               string
}

type SyncStore interface {
	GetRepositoryForWebSync(ctx context.Context, owner, repo string) (*WebSyncRepoInfo, error)
	TouchWebSyncNoChanges(ctx context.Context, repoID, etag string, lastModMap map[string]string) error
	ExecuteWebSyncTx(ctx context.Context, p WebSyncTxParams) ([]WebSyncSavedDoc, error)
	ReplaceDocumentChunks(ctx context.Context, docID string, chunks []chunker.MarkdownChunk, opts ReplaceChunksOpts) (int, error)
}

type SyncDeps struct {
	Store     SyncStore
	Firecrawl FirecrawlAPI
	Emit      func(eventType string, payload map[string]any)
	Settle    func(ctx context.Context, jobID string, result SettleResult) error
}

type IngestRepoParams struct {
	Owner        string
	Repo         string
	Branch       string
	Edition      string
	Skeleton     string
	SkeletonHash string
	NavTreeJSON  []byte
	ProfileJSON  []byte
	IsPublic     bool
	Category     string
	Tags         []string
	GitSha       *string
	BestUsedFor  []string
	StarCount    int
}

type IngestDocParams struct {
	RepositoryId string
	Path         string
	OwnerUserId  *string
	Title        string
	Content      string
	Lang         string
	Status       string
	HasUpdate    bool
	UpdateTitle  string
}

type IngestSnapshotParams struct {
	UserId       string
	RepositoryId string
	Owner        string
	Repo         string
	Branch       string
	Sha          string
	Prefix       *string
	DocOwnerId   *string
	Changed      []string
	Removed      []string
	SkipReset    bool
}

type IngestStore interface {
	UpsertRepositoryRow(ctx context.Context, p IngestRepoParams) (string, error)
	UpsertOwnedDocument(ctx context.Context, args IngestDocParams) (string, error)
	RegisterImportSnapshot(ctx context.Context, p IngestSnapshotParams) (bool, error)
	UpdateImportJobProgress(ctx context.Context, jobID, step string, progress int) error
	StoreOutlineDraft(ctx context.Context, repositoryId string, draft OutlineDraft, isActive bool) (string, error)
}

type IngestJob struct {
	ID     string
	Owner  string
	Repo   string
	Branch string
	UserID string
}

type LLMGenerator interface {
	Generate(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error
}

type IngestOptions struct {
	URL              string
	MaxPages         int
	Category         string
	Tags             []string
	IsPublic         bool
	TargetLanguage   string
	Branch           string
	Edition          string
	Name             string
	ScopeMode        string
	PrimaryDocPrefix string
	AllowedPrefixes  []string
	ModuleTabs       []ModuleTab
}

type GitNode struct {
	Path string
	Type string
}

type IngestOutcome int

const (
	IngestDone IngestOutcome = iota
	IngestFailed
	IngestFallback = IngestFailed
)

type IngestDeps struct {
	Store        IngestStore
	Firecrawl    FirecrawlAPI
	BuildNavTree func(nodes []GitNode, owner, repo string, maxPages int) []byte
	Emit         func(eventType string, payload map[string]any)
	Settle       func(ctx context.Context, jobID string, result SettleResult) error
	LLM          LLMGenerator
}
