package search

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestBuilder(store IndexStore, assets *FakeAssetStore, debounceMs int) *IndexBuilder {
	return &IndexBuilder{
		store: store, assets: assets, gzipLevel: 1,
		debounce: time.Duration(debounceMs) * time.Millisecond,
		pending:  map[string]*time.Timer{},
	}
}

func TestSearchIndexBuilderBuildRepo(t *testing.T) {
	sha := "3f8a2c1d9b04e5678901234abcdef0123456789a"
	tests := []struct {
		name    string
		gitSha  *string
		wantKey string
	}{
		{name: "有 gitSha：对象键含 sha", gitSha: &sha, wantKey: "assets/vercel/next.js/search-index-" + sha + ".bin"},
		{name: "无 gitSha：回退 head", gitSha: nil, wantKey: "assets/vercel/next.js/search-index-head.bin"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newFakeSearchIndexStore()
			store.addRepo(OGISRepoMeta{ID: "r1", Owner: "vercel", Repo: "next.js", GitSha: tt.gitSha})
			assets := newFakeAssetStore()
			b := newTestBuilder(store, assets, 10_000)

			built, err := b.BuildRepo(context.Background(), "r1")
			require.NoError(t, err)
			assert.True(t, built)

			require.Len(t, assets.putKeys, 1)
			assert.Equal(t, tt.wantKey, assets.putKeys[0])
			// 写入的是 gzip 包装的 OGIS v1 二进制
			data := assets.objects[tt.wantKey]
			require.GreaterOrEqual(t, len(data), 2)
			assert.Equal(t, byte(0x1f), data[0])
			assert.Equal(t, byte(0x8b), data[1])
		})
	}
}

func TestSearchIndexBuilderDebounce(t *testing.T) {
	store := newFakeSearchIndexStore()
	store.addRepo(OGISRepoMeta{ID: "r1", Owner: "o", Repo: "r"})
	assets := newFakeAssetStore()
	b := newTestBuilder(store, assets, 30) // 30ms 去抖窗口

	b.ScheduleRefresh("r1")
	b.ScheduleRefresh("r1")
	b.ScheduleRefresh("r1")
	assert.Len(t, b.PendingRebuilds(), 1, "同仓连续触发合并为一个挂起定时器")
	assert.Zero(t, assets.PutCalls(), "窗口内不触发")

	time.Sleep(80 * time.Millisecond)
	assert.Empty(t, b.PendingRebuilds())
	assert.Equal(t, 1, store.ChunkCalls(), "末次后只重建一次")
	assert.Equal(t, 1, assets.PutCalls())
}

func TestSearchIndexBuilderSingleFlight(t *testing.T) {
	store := newFakeSearchIndexStore()
	store.addRepo(OGISRepoMeta{ID: "r1", Owner: "o", Repo: "r"})
	assets := newFakeAssetStore()
	assets.block = make(chan struct{}) // Put 阻塞至放行
	b := newTestBuilder(store, assets, 10_000)

	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = b.BuildRepo(context.Background(), "r1")
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(assets.block)
	wg.Wait()

	assert.Equal(t, 1, store.ChunkCalls(), "并发 BuildRepo 共享一次重建")
	assert.Equal(t, 1, assets.PutCalls())
}

func TestSearchIndexBuilderSweepMissing(t *testing.T) {
	sha := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	store := newFakeSearchIndexStore()
	store.addRepo(OGISRepoMeta{ID: "r1", Owner: "o", Repo: "r", GitSha: &sha})
	store.addRepo(OGISRepoMeta{ID: "r2", Owner: "o2", Repo: "r2", GitSha: &sha})
	assets := newFakeAssetStore()
	// r1 已有索引（模拟历史构建）
	assets.objects[assetKeyForIndex("o", "r", sha)] = []byte{0x1f, 0x8b}

	b := newTestBuilder(store, assets, 10_000)
	require.NoError(t, b.SweepMissingOnce(context.Background()))

	assert.Equal(t, 1, assets.putCalls, "仅缺失的 r2 被重建")
	assert.Equal(t, assetKeyForIndex("o2", "r2", sha), assets.putKeys[0])
}
