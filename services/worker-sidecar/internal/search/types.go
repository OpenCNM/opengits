package search

import "context"

type SearchChunksRequest struct {
	RepositoryID   string   `json:"repositoryId,omitempty"`
	RepositoryIDs  []string `json:"repositoryIds,omitempty"`
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

type SearchChunkHit struct {
	ChunkID      string   `json:"chunkId"`
	DocID        string   `json:"docId"`
	Title        string   `json:"title"`
	Path         string   `json:"path"`
	Heading      *string  `json:"heading,omitempty"`
	HeadingPath  *string  `json:"headingPath,omitempty"`
	Snippet      string   `json:"snippet"`
	Similarity   float64  `json:"similarity"`
	RepositoryID string   `json:"repositoryId,omitempty"`
	Owner        string   `json:"owner,omitempty"`
	Repo         string   `json:"repo,omitempty"`
	Content      string   `json:"content,omitempty"`
	EditionLabel *string  `json:"editionLabel,omitempty"`
	MatchCount   *int     `json:"matchCount,omitempty"`
	FtsRank      *float64 `json:"ftsRank,omitempty"`
}

type SearchChunksResponse struct {
	Hits []SearchChunkHit `json:"hits"`
}

type Engine interface {
	SearchChunks(ctx context.Context, req SearchChunksRequest) ([]SearchChunkHit, error)
}

type SearchEngine = Engine

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

type UnifiedSearchHit struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	IsIngested  *bool  `json:"isIngested,omitempty"`
	Title       string `json:"title"`
	Description string `json:"description"`
	URL         string `json:"url"`
	Owner       string `json:"owner,omitempty"`
	Repo        string `json:"repo,omitempty"`
	Category    string `json:"category,omitempty"`
	Score       int    `json:"score"`
}

type UnifiedSearchResponse struct {
	OK   bool               `json:"ok"`
	Hits []UnifiedSearchHit `json:"hits"`
}
