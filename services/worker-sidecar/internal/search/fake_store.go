package search

import (
	"context"
	"os"
	"sync"
)

// FakeIndexStore 内存假库（互斥保护，模拟 OR-JOIN 去重后的行集）。
type FakeIndexStore struct {
	mu         sync.Mutex
	repos      map[string]*OGISRepoMeta // by id
	chunkCalls int
}

func NewFakeIndexStore() *FakeIndexStore {
	return &FakeIndexStore{repos: map[string]*OGISRepoMeta{}}
}

type fakeSearchIndexStore = FakeIndexStore

func newFakeSearchIndexStore() *fakeSearchIndexStore {
	return NewFakeIndexStore()
}

func (f *FakeIndexStore) AddRepo(m OGISRepoMeta) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.repos[m.ID] = &m
}

func (f *FakeIndexStore) addRepo(m OGISRepoMeta) {
	f.AddRepo(m)
}

func (f *FakeIndexStore) ChunkCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.chunkCalls
}

func (f *FakeIndexStore) chunkRows(repoId string) []OGISChunkRow {
	heading := "H"
	path := "docs/a.md"
	title := "Title"
	return []OGISChunkRow{{
		ChunkID: repoId + "-c1", Heading: &heading, HeadingPath: &heading,
		Content: "server components 服务器组件", Title: &title, Path: &path,
	}}
}

func (f *FakeIndexStore) RepoMetaForIndex(ctx context.Context, repoId string) (*OGISRepoMeta, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if m, ok := f.repos[repoId]; ok {
		cp := *m
		return &cp, nil
	}
	return nil, errNotExist
}

func (f *FakeIndexStore) OGISChunkRowsForRepo(ctx context.Context, repoId string) ([]OGISChunkRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.chunkCalls++
	return f.chunkRows(repoId), nil
}

func (f *FakeIndexStore) ReposWithProcessedDocs(ctx context.Context) ([]OGISRepoMeta, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]OGISRepoMeta, 0, len(f.repos))
	for _, m := range f.repos {
		out = append(out, *m)
	}
	return out, nil
}

// FakeAssetStore 内存对象存储（记录 put 次数与键）。
type FakeAssetStore struct {
	mu          sync.Mutex
	objects     map[string][]byte
	putKeys     []string
	putCalls    int
	ensureCalls int
	block       chan struct{} // 非 nil 时 Put 阻塞（singleflight 用例）
}

func NewFakeAssetStore() *FakeAssetStore {
	return &FakeAssetStore{objects: map[string][]byte{}}
}

type fakeAssetStore = FakeAssetStore

func newFakeAssetStore() *fakeAssetStore {
	return NewFakeAssetStore()
}

func (f *FakeAssetStore) EnsureBucket(ctx context.Context) error {
	f.mu.Lock()
	f.ensureCalls++
	f.mu.Unlock()
	return nil
}

func (f *FakeAssetStore) Put(ctx context.Context, key string, data []byte) error {
	if f.block != nil {
		<-f.block
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.putCalls++
	f.putKeys = append(f.putKeys, key)
	f.objects[key] = append([]byte(nil), data...)
	return nil
}

func (f *FakeAssetStore) Exists(ctx context.Context, key string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.objects[key]
	return ok, nil
}

func (f *FakeAssetStore) Get(ctx context.Context, key string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, ok := f.objects[key]
	if !ok {
		return nil, os.ErrNotExist
	}
	return append([]byte(nil), data...), nil
}

func (f *FakeAssetStore) PutCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.putCalls
}

func (f *FakeAssetStore) PutKeys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.putKeys...)
}
