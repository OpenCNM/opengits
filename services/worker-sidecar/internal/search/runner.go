package search

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/ogis"
)

type Config struct {
	SearchIndexGzipLevel  int
	SearchIndexDebounceMs int
	SearchEngine          string
}

type IndexBuilder struct {
	store     IndexStore
	assets    archive.AssetStore
	gzipLevel int

	debounce time.Duration
	mu       sync.Mutex
	pending  map[string]*time.Timer
	sf       singleflight.Group
	onBuilt  func(owner, repo string)
}

type SearchIndexBuilder = IndexBuilder

// Return nil when assets store is absent (local storage mode disables background S3 index writes).
func NewIndexBuilder(cfg Config, store IndexStore, assets archive.AssetStore) *IndexBuilder {
	if assets == nil {
		return nil
	}
	return &IndexBuilder{
		store:     store,
		assets:    assets,
		gzipLevel: cfg.SearchIndexGzipLevel,
		debounce:  time.Duration(cfg.SearchIndexDebounceMs) * time.Millisecond,
		pending:   make(map[string]*time.Timer),
	}
}

func NewSearchIndexBuilder(cfg Config, store IndexStore, assets archive.AssetStore) *IndexBuilder {
	return NewIndexBuilder(cfg, store, assets)
}

func (b *IndexBuilder) Store() IndexStore {
	if b == nil {
		return nil
	}
	return b.store
}

func (b *IndexBuilder) Assets() archive.AssetStore {
	if b == nil {
		return nil
	}
	return b.assets
}

func (b *IndexBuilder) SetOnBuilt(fn func(owner, repo string)) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onBuilt = fn
}

func (b *IndexBuilder) ScheduleRefresh(repoId string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if t, ok := b.pending[repoId]; ok {
		t.Stop()
	}
	b.pending[repoId] = time.AfterFunc(b.debounce, func() {
		b.mu.Lock()
		delete(b.pending, repoId)
		b.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if _, err := b.BuildRepo(ctx, repoId); err != nil {
			log.Printf("[search-index] debounced rebuild failed for repo %s: %v", repoId, err)
		}
	})
}

func (b *IndexBuilder) PendingRebuilds() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]string, 0, len(b.pending))
	for id := range b.pending {
		out = append(out, id)
	}
	return out
}

func (b *IndexBuilder) CancelAll() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for id, t := range b.pending {
		t.Stop()
		delete(b.pending, id)
	}
}

func (b *IndexBuilder) BuildRepo(ctx context.Context, repoId string) (built bool, err error) {
	v, err, _ := b.sf.Do(repoId, func() (any, error) {
		meta, err := b.store.RepoMetaForIndex(ctx, repoId)
		if err != nil {
			return false, fmt.Errorf("repo meta: %w", err)
		}
		gitSha := derefStrPtr(meta.GitSha)
		key := AssetKeyForIndex(meta.Owner, meta.Repo, gitSha)

		chunks, err := b.store.OGISChunkRowsForRepo(ctx, repoId)
		if err != nil {
			return false, fmt.Errorf("chunk rows: %w", err)
		}

		records := make([]ogis.ChunkRecord, 0, len(chunks))
		for _, c := range chunks {
			searchable := derefStrPtr(c.Title) + " " + derefStrPtr(c.Heading) + " " + c.Content
			records = append(records, ogis.ChunkRecord{
				ID:          c.ChunkID,
				DocPath:     derefStrPtr(c.Path),
				Title:       derefStrPtr(c.Title),
				Heading:     derefStrPtr(c.Heading),
				HeadingPath: derefStrPtr(c.HeadingPath),
				Content:     c.Content,
				Tokens:      ogis.TokenizeSearchText(searchable),
			})
		}

		packed := ogis.PackIndex(ogis.PackInput{
			Owner:  meta.Owner,
			Repo:   meta.Repo,
			GitSha: gitSha,
			Chunks: records,
		}, true, b.gzipLevel)

		if err := b.assets.EnsureBucket(ctx); err != nil {
			return false, fmt.Errorf("ensure bucket: %w", err)
		}
		if err := b.assets.Put(ctx, key, packed); err != nil {
			return false, fmt.Errorf("put %s: %w", key, err)
		}
		b.mu.Lock()
		onBuilt := b.onBuilt
		b.mu.Unlock()
		if onBuilt != nil {
			onBuilt(meta.Owner, meta.Repo)
		}
		return true, nil
	})
	built, _ = v.(bool)
	return built, err
}

func (b *IndexBuilder) SweepMissingOnce(ctx context.Context) error {
	repos, err := b.store.ReposWithProcessedDocs(ctx)
	if err != nil {
		return fmt.Errorf("list repos: %w", err)
	}
	if err := b.assets.EnsureBucket(ctx); err != nil {
		return fmt.Errorf("ensure bucket: %w", err)
	}
	for _, meta := range repos {
		key := AssetKeyForIndex(meta.Owner, meta.Repo, derefStrPtr(meta.GitSha))
		exists, err := b.assets.Exists(ctx, key)
		if err != nil {
			log.Printf("[search-index] sweep exists check failed for %s/%s: %v", meta.Owner, meta.Repo, err)
			continue
		}
		if exists {
			continue
		}
		if _, err := b.BuildRepo(ctx, meta.ID); err != nil {
			log.Printf("[search-index] sweep rebuild failed for %s/%s: %v", meta.Owner, meta.Repo, err)
		}
	}
	return nil
}

func derefStrPtr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
