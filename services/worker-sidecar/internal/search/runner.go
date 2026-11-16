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

// ─────────────────────────────────────────────────────────────
// OGIS 索引构建器：把"查 chunk → 分词 → 打包 → gzip → 写 MinIO"
// 从 Node 事件循环整体承接（读路径仍在 Node web，JIT 现场生成保留自愈）。
// 触发源：
//   1. 直触发：转录收尾（finalizeTranscription 成功后）→ trailing debounce
//      合并同仓批量导入（与 Node scheduleRepoBinaryIndexRefresh 同窗口语义）
//   2. 兜底扫描：search-index-sweep 任务（租约单端生效）补建缺失索引
// 并发安全：singleflight 按 repoId 合并同时重建；
// 与 Node 混跑期双写同 key 幂等无害（ETag 基于 gitSha，非内容哈希）。
// ─────────────────────────────────────────────────────────────

// Config 检索与索引模块配置。
type Config struct {
	SearchIndexGzipLevel  int
	SearchIndexDebounceMs int
	SearchEngine          string
}

// IndexBuilder 索引构建器（进程内单例）。
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

// SearchIndexBuilder 兼容别名。
type SearchIndexBuilder = IndexBuilder

// NewIndexBuilder assets 为 nil（local 存储模式）时返回 nil——
// Go 打包仅 STORAGE_DRIVER=s3 时启用，local 开发由 Node 覆盖。
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

// NewSearchIndexBuilder 兼容旧版命名构造函数。
func NewSearchIndexBuilder(cfg Config, store IndexStore, assets archive.AssetStore) *IndexBuilder {
	return NewIndexBuilder(cfg, store, assets)
}

// Store 返回关联的索引存储接口。
func (b *IndexBuilder) Store() IndexStore {
	if b == nil {
		return nil
	}
	return b.store
}

// Assets 返回关联的资产存储接口。
func (b *IndexBuilder) Assets() archive.AssetStore {
	if b == nil {
		return nil
	}
	return b.assets
}

// SetOnBuilt 设置构建完成回调。
func (b *IndexBuilder) SetOnBuilt(fn func(owner, repo string)) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onBuilt = fn
}

// ScheduleRefresh trailing debounce：同仓连续触发合并为末次后一次重建。
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

// PendingRebuilds 观测/测试：挂起去抖重建的仓集合。
func (b *IndexBuilder) PendingRebuilds() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]string, 0, len(b.pending))
	for id := range b.pending {
		out = append(out, id)
	}
	return out
}

// CancelAll 取消所有挂起的去抖重建定时器（供测试清理与停机排空）。
func (b *IndexBuilder) CancelAll() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for id, t := range b.pending {
		t.Stop()
		delete(b.pending, id)
	}
}

// BuildRepo 构建并写入单仓索引（singleflight 合并并发；skipExisting 用于
// sweep 兜底——已存在的对象不重建，直触发路径恒 false）。
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

// SweepMissingOnce 兜底扫描：对有 PROCESSED 文档的仓库检查索引对象，
// 缺失则重建（覆盖直触发丢失/历史回填）。
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
