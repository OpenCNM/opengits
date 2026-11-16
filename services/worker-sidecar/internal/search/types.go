package search

import "context"

// SearchChunksRequest 统一分块检索请求入参。
type SearchChunksRequest struct {
	RepositoryID   string   `json:"repositoryId,omitempty"`
	Query          string   `json:"query"`
	RawQuery       string   `json:"rawQuery,omitempty"`
	Limit          int      `json:"limit,omitempty"`
	UserID         *string  `json:"userId,omitempty"`
	Locale         string   `json:"locale,omitempty"`
	Version        string   `json:"version,omitempty"`
	ContentTypes   []string `json:"contentTypes,omitempty"`
	IsGlobal       bool     `json:"isGlobal,omitempty"`
	SnippetMaxLen  int      `json:"snippetMaxLen,omitempty"`
	IncludeContent bool     `json:"includeContent,omitempty"`
	TokenBudget    int      `json:"tokenBudget,omitempty"`
}

// SearchChunkHit 检索命中的分块数据模型。
type SearchChunkHit struct {
	ChunkID      string   `json:"chunkId"`
	DocID        string   `json:"docId"`
	Title        string   `json:"title"`
	Path         string   `json:"path"`
	Heading      *string  `json:"heading,omitempty"`
	HeadingPath  *string  `json:"headingPath,omitempty"`
	Snippet      string   `json:"snippet"`
	Similarity   float64  `json:"similarity"`
	Owner        string   `json:"owner,omitempty"`
	Repo         string   `json:"repo,omitempty"`
	Content      string   `json:"content,omitempty"`
	EditionLabel *string  `json:"editionLabel,omitempty"`
	MatchCount   *int     `json:"matchCount,omitempty"`
	FtsRank      *float64 `json:"ftsRank,omitempty"`
}

// SearchChunksResponse 检索结果集合包装。
type SearchChunksResponse struct {
	Hits []SearchChunkHit `json:"hits"`
}

// Engine 检索引擎统一接口（支持 Worker-Sidecar 进程内零 IPC 直调）。
type Engine interface {
	SearchChunks(ctx context.Context, req SearchChunksRequest) ([]SearchChunkHit, error)
}

// SearchEngine 兼容别名。
type SearchEngine = Engine

// UnifiedSearchRequest 统一混合检索请求入参。
type UnifiedSearchRequest struct {
	Query      string  `json:"query"`
	RawQuery   string  `json:"rawQuery,omitempty"`
	Owner      string  `json:"owner,omitempty"`
	Repo       string  `json:"repo,omitempty"`
	UserID     *string `json:"userId,omitempty"`
	ExactOwner string  `json:"exactOwner,omitempty"`
	ExactRepo  string  `json:"exactRepo,omitempty"`
	Limit      int     `json:"limit,omitempty"`
}

// UnifiedSearchHit 统一混合检索命中的实体项（对齐 TS SearchResultItem）。
type UnifiedSearchHit struct {
	ID          string `json:"id"`
	Type        string `json:"type"` // "repository_exists" | "repository_import_cta" | "document" | "bundle" | "featured_tutorial"
	IsIngested  *bool  `json:"isIngested,omitempty"`
	Title       string `json:"title"`
	Description string `json:"description"`
	URL         string `json:"url"`
	Owner       string `json:"owner,omitempty"`
	Repo        string `json:"repo,omitempty"`
	Category    string `json:"category,omitempty"`
	Score       int    `json:"score"`
}

// UnifiedSearchResponse 统一检索响应包装。
type UnifiedSearchResponse struct {
	OK   bool               `json:"ok"`
	Hits []UnifiedSearchHit `json:"hits"`
}

