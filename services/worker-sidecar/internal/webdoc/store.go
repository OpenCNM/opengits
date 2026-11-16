package webdoc

import (
	"context"

	"github.com/opengits/worker-sidecar/internal/chunker"
)

// WebSyncRepoInfo 网页同步所需的仓库及基线信息。
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
	// 导入期收敛落盘的生效作用域（EffectiveAllowedPrefixes 并集 + 排除项）：
	// 增量同步按此过滤，防止源站后续新增的越界页面（如 changelog）逆向渗透。
	// 存量库两字段为空 ⇒ isURLAllowed 放行一切（通配全集语义，行为与历史一致）。
	AllowedPrefixes  []string
	ExcludePrefixes  []string
}

// WebSyncTxParams 网页增量同步事务入参。
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

// WebSyncSavedDoc 事务落库的文档信息（用于事务外刷新切片与图谱）。
type WebSyncSavedDoc struct {
	ID      string
	Path    string
	Content string
}

// ReplaceChunksOpts 与 chunker 元数据解析对齐的入参。
type ReplaceChunksOpts struct {
	DocPath       string
	BlueprintRole string
	DefaultBranch string
}

// SyncOutcome 同步执行结果（Zero-Node 纯 Go 闭环）。
type SyncOutcome int

const (
	SyncDone SyncOutcome = iota
	SyncFailed
	SyncFallback = SyncFailed // 兼容别名
)

// SyncJob 增量同步目标作业元数据。
type SyncJob struct {
	ID     string
	Owner  string
	Repo   string
	Branch string
	UserID string
}

// SettleResult 对应导入/同步完成时的结算参数。
type SettleResult struct {
	RepositoryID         string
	QueuedDocumentsCount int
	GitSha               string
}

// SyncStore 定义 WebDoc 增量同步所需的数据访问契约。
type SyncStore interface {
	GetRepositoryForWebSync(ctx context.Context, owner, repo string) (*WebSyncRepoInfo, error)
	TouchWebSyncNoChanges(ctx context.Context, repoID, etag string, lastModMap map[string]string) error
	ExecuteWebSyncTx(ctx context.Context, p WebSyncTxParams) ([]WebSyncSavedDoc, error)
	ReplaceDocumentChunks(ctx context.Context, docID string, chunks []chunker.MarkdownChunk, opts ReplaceChunksOpts) (int, error)
}

// SyncDeps 增量同步依赖注入集合。
type SyncDeps struct {
	Store     SyncStore
	Firecrawl FirecrawlAPI
	Emit      func(eventType string, payload map[string]any)
	Settle    func(ctx context.Context, jobID string, result SettleResult) error
}

// ─────────────────────────────────────────────────────────────
// WebDoc 初始导入数据访问面与任务契约
// ─────────────────────────────────────────────────────────────

// IngestRepoParams 四元唯一键 upsert 入参。
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

// IngestDocParams 文档写入参数。
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

// IngestSnapshotParams 导入快照入参。
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

// IngestStore 网页文档初始导入所需的数据访问契约。
type IngestStore interface {
	UpsertRepositoryRow(ctx context.Context, p IngestRepoParams) (string, error)
	UpsertOwnedDocument(ctx context.Context, args IngestDocParams) (string, error)
	RegisterImportSnapshot(ctx context.Context, p IngestSnapshotParams) (bool, error)
	UpdateImportJobProgress(ctx context.Context, jobID, step string, progress int) error
	StoreOutlineDraft(ctx context.Context, repositoryId string, draft OutlineDraft, isActive bool) (string, error)
}

// IngestJob 初始导入任务元数据。
type IngestJob struct {
	ID     string
	Owner  string
	Repo   string
	Branch string
	UserID string
}

// LLMGenerator LLM 生成契约（对齐 internal/platform/client/llm.go）。
type LLMGenerator interface {
	Generate(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error
}

// IngestOptions 网页文档导入配置项。
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
	ScopeMode        string // ''(未探测自动裁决) | 'recommended' | 'all' | 'custom'；非空 ⇒ 物理跳过 crawl-time LLM 拓扑裁决
	PrimaryDocPrefix string
	AllowedPrefixes  []string
	ModuleTabs       []ModuleTab
}

// GitNode 抽象文件树节点。
type GitNode struct {
	Path string
	Type string
}

// IngestOutcome 导入执行结果。
type IngestOutcome int

const (
	IngestDone IngestOutcome = iota
	IngestFailed
	IngestFallback = IngestFailed // 兼容别名
)

// IngestDeps 初始导入依赖注入集合。
type IngestDeps struct {
	Store        IngestStore
	Firecrawl    FirecrawlAPI
	BuildNavTree func(nodes []GitNode, owner, repo string, maxPages int) []byte
	Emit         func(eventType string, payload map[string]any)
	Settle       func(ctx context.Context, jobID string, result SettleResult) error
	LLM          LLMGenerator
}

