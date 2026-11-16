package daemon

import (
	"github.com/opengits/worker-sidecar/internal/search"
)

type fakeSearchIndexStore struct {
	*search.FakeIndexStore
}

func newFakeSearchIndexStore() *fakeSearchIndexStore {
	return &fakeSearchIndexStore{FakeIndexStore: search.NewFakeIndexStore()}
}

func (f *fakeSearchIndexStore) addRepo(m search.OGISRepoMeta) {
	f.AddRepo(m)
}
