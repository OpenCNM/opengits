package search

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/ogis"
	cachestore "github.com/opengits/worker-sidecar/internal/platform/cache"
	"github.com/opengits/worker-sidecar/internal/platform/httpx"
	"github.com/opengits/worker-sidecar/internal/rsg"
)

const (
	DefaultIndexCacheCap = 100
	defaultIndexCacheCap = DefaultIndexCacheCap
)

type ogisCacheItem struct {
	index    *ogis.Index
	lastUsed time.Time
}

type IndexCache struct {
	mu      sync.RWMutex
	items   map[string]*ogisCacheItem
	maxSize int
}

type OgisIndexCache = IndexCache

func NewIndexCache(maxSize int) *IndexCache {
	if maxSize <= 0 {
		maxSize = DefaultIndexCacheCap
	}
	return &IndexCache{
		items:   make(map[string]*ogisCacheItem),
		maxSize: maxSize,
	}
}

func NewOGISIndexCache(maxSize int) *IndexCache {
	return NewIndexCache(maxSize)
}

func newOGISIndexCache(maxSize int) *IndexCache {
	return NewIndexCache(maxSize)
}

func (c *IndexCache) Get(key string) (*ogis.Index, bool) {
	if c == nil {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	item, ok := c.items[key]
	if !ok {
		return nil, false
	}
	item.lastUsed = time.Now()
	return item.index, true
}

func (c *IndexCache) Set(key string, idx *ogis.Index) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	if item, ok := c.items[key]; ok {
		item.index = idx
		item.lastUsed = time.Now()
		return
	}

	if len(c.items) >= c.maxSize {
		var oldestKey string
		var oldestTime time.Time
		first := true
		for k, v := range c.items {
			if first || v.lastUsed.Before(oldestTime) {
				oldestKey = k
				oldestTime = v.lastUsed
				first = false
			}
		}
		if oldestKey != "" {
			delete(c.items, oldestKey)
		}
	}

	c.items[key] = &ogisCacheItem{
		index:    idx,
		lastUsed: time.Now(),
	}
}

func (c *IndexCache) InvalidateRepo(owner, repo string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	prefix := strings.ToLower(strings.TrimSpace(owner)) + "/" + strings.ToLower(strings.TrimSpace(repo)) + "/"
	for k := range c.items {
		if strings.HasPrefix(k, prefix) {
			delete(c.items, k)
		}
	}
}

type Handler struct {
	store    Store
	builder  *IndexBuilder
	cache    *IndexCache
	assets   archive.AssetStore
	graphDir string

	// Singleflight LRU avoids cache-clear storms and duplicate disk reads on concurrent topology misses.
	topoCache *cachestore.Store[*ogis.TopologicalScorer]
}

func NewHandler(store Store, builder *IndexBuilder, cache *IndexCache, assets archive.AssetStore, graphDir ...string) *Handler {
	if cache == nil {
		cache = NewIndexCache(DefaultIndexCacheCap)
	}
	if assets == nil && builder != nil {
		assets = builder.Assets()
	}
	gd := ""
	if len(graphDir) > 0 {
		gd = strings.TrimSpace(graphDir[0])
	}
	h := &Handler{
		store:    store,
		builder:  builder,
		cache:    cache,
		assets:   assets,
		graphDir: gd,
	}
	h.topoCache = cachestore.New[*ogis.TopologicalScorer](DefaultIndexCacheCap, 0, nil)
	if builder != nil {
		builder.SetOnBuilt(h.InvalidateRepoCache)
	}
	return h
}

func (h *Handler) IndexCache() *IndexCache {
	if h == nil {
		return nil
	}
	return h.cache
}

func (h *Handler) InvalidateRepoCache(owner, repo string) {
	if h == nil {
		return
	}
	if h.cache != nil {
		h.cache.InvalidateRepo(owner, repo)
	}
	prefix := strings.ToLower(strings.TrimSpace(owner)) + "/" + strings.ToLower(strings.TrimSpace(repo)) + "/"
	h.topoCache.InvalidatePrefix(prefix)
}

func (h *Handler) GetOrLoadTopology(ctx context.Context, owner, repo, gitSha string) *ogis.TopologicalScorer {
	if h == nil || h.graphDir == "" {
		return ogis.DefaultTopologicalScorer
	}
	normOwner := strings.ToLower(strings.TrimSpace(owner))
	normRepo := strings.ToLower(strings.TrimSpace(repo))
	normSha := strings.TrimSpace(gitSha)
	if normSha == "" {
		normSha = "head"
	}
	cacheKey := normOwner + "/" + normRepo + "/" + normSha
	if scorer, err := h.topoCache.GetOrLoad(cacheKey, func(key string) (*ogis.TopologicalScorer, error) {
		return h.buildTopologyScorer(normOwner, normRepo, normSha)
	}); err == nil && scorer != nil {
		return scorer
	}
	return ogis.DefaultTopologicalScorer
}

func (h *Handler) buildTopologyScorer(normOwner, normRepo, normSha string) (*ogis.TopologicalScorer, error) {
	artifact, err := rsg.LoadSemanticGraphArtifact(h.graphDir, normOwner, normRepo, normSha)
	if (err != nil || artifact == nil) && normSha != "head" {
		artifact, _ = rsg.LoadSemanticGraphArtifact(h.graphDir, normOwner, normRepo, "head")
	}

	if artifact == nil || len(artifact.Nodes) == 0 {
		return ogis.DefaultTopologicalScorer, nil
	}
	nodes := make([]ogis.TopologicalNodeMeta, 0, len(artifact.Nodes))
	for _, n := range artifact.Nodes {
		nodes = append(nodes, ogis.TopologicalNodeMeta{
			Path:         n.Path,
			InDegree:     n.InDegree,
			OutDegree:    n.OutDegree,
			PageRank:     n.PageRank,
			Role:         string(n.Role),
			IsBackbone:   n.IsBackbone,
			IsEntryPoint: n.IsEntryPoint,
		})
	}
	return ogis.NewTopologicalScorer(nodes), nil
}

func (h *Handler) HandleChunks(w http.ResponseWriter, r *http.Request) {
	var req SearchChunksRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	if strings.TrimSpace(req.Query) == "" && strings.TrimSpace(req.RawQuery) == "" {
		httpx.WriteJSON(w, http.StatusOK, SearchChunksResponse{Hits: []SearchChunkHit{}})
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "search store unavailable")
		return
	}

	var hits []SearchChunkHit
	var err error

	if req.IsGlobal || req.RepositoryID == "" {
		hits, err = h.store.SearchGlobalChunks(r.Context(), req)
	} else {
		hits, err = h.store.SearchRepositoryChunks(r.Context(), req)
	}

	if err != nil {
		log.Printf("[worker-sidecar] search chunks failed: %v", err)
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	if hits == nil {
		hits = []SearchChunkHit{}
	}

	httpx.WriteJSON(w, http.StatusOK, SearchChunksResponse{Hits: hits})
}

func (h *Handler) HandleUnified(w http.ResponseWriter, r *http.Request) {
	var req UnifiedSearchRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	if strings.TrimSpace(req.Query) == "" && strings.TrimSpace(req.RawQuery) == "" {
		httpx.WriteJSON(w, http.StatusOK, UnifiedSearchResponse{OK: true, Hits: []UnifiedSearchHit{}})
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "search store unavailable")
		return
	}

	hits, err := h.store.SearchUnified(r.Context(), req)
	if err != nil {
		log.Printf("[worker-sidecar] search unified failed: %v", err)
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	if hits == nil {
		hits = []UnifiedSearchHit{}
	}

	httpx.WriteJSON(w, http.StatusOK, UnifiedSearchResponse{OK: true, Hits: hits})
}

type SearchIndexBuildRequest struct {
	RepositoryID string `json:"repositoryId"`
}

type SearchIndexBuildResponse struct {
	OK    bool `json:"ok"`
	Built bool `json:"built"`
}

func (h *Handler) HandleIndexBuild(w http.ResponseWriter, r *http.Request) {
	var req SearchIndexBuildRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	repoID := strings.TrimSpace(req.RepositoryID)
	if repoID == "" {
		httpx.Error(w, http.StatusBadRequest, "repositoryId is required")
		return
	}

	if h.builder == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "search index builder unavailable")
		return
	}

	built, err := h.builder.BuildRepo(r.Context(), repoID)
	if err != nil {
		log.Printf("[worker-sidecar] search index build failed for repo %s: %v", repoID, err)
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	if h.builder.Store() != nil {
		if meta, err := h.builder.Store().RepoMetaForIndex(r.Context(), repoID); err == nil && meta != nil {
			h.InvalidateRepoCache(meta.Owner, meta.Repo)
		}
	}

	httpx.WriteJSON(w, http.StatusOK, SearchIndexBuildResponse{
		OK:    true,
		Built: built,
	})
}

func (h *Handler) GetOrLoadOGISIndex(ctx context.Context, owner, repo, gitSha string) (*ogis.Index, error) {
	normOwner := strings.ToLower(strings.TrimSpace(owner))
	normRepo := strings.ToLower(strings.TrimSpace(repo))
	normSha := strings.TrimSpace(gitSha)
	if normSha == "" {
		normSha = "head"
	}
	cacheKey := normOwner + "/" + normRepo + "/" + normSha
	if h.cache != nil {
		if idx, ok := h.cache.Get(cacheKey); ok {
			return idx, nil
		}
	}

	assets := h.assets
	if assets == nil && h.builder != nil {
		assets = h.builder.Assets()
	}
	if assets == nil {
		return nil, errors.New("asset store unavailable")
	}

	key := AssetKeyForIndex(normOwner, normRepo, normSha)
	data, err := assets.Get(ctx, key)
	if err != nil {
		return nil, err
	}

	idx, err := ogis.ReadIndex(data)
	if err != nil {
		return nil, fmt.Errorf("unpack ogis index: %w", err)
	}

	if h.cache != nil {
		h.cache.Set(cacheKey, idx)
	}
	return idx, nil
}
