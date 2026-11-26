package transcription

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeBookAuditStore struct {
	unsettled int
	scopeRows []ChapterScopeRow
	docs      []BookAuditDoc
	under     bool
	lockFree  bool
	lockErr   error
	claimOK   bool
	claimErr  error

	mu       sync.Mutex
	calls    []string
	statuses []string
	hashes   []string
}

func (f *fakeBookAuditStore) record(call string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
}

func (f *fakeBookAuditStore) callLog() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func (f *fakeBookAuditStore) CountUnsettledChapters(context.Context, BookAuditScope) (int, error) {
	f.record("count")
	return f.unsettled, nil
}

func (f *fakeBookAuditStore) ListChapterScope(context.Context, BookAuditScope) ([]ChapterScopeRow, error) {
	f.record("scope")
	return f.scopeRows, nil
}

func (f *fakeBookAuditStore) ListProcessedChapters(context.Context, BookAuditScope) ([]BookAuditDoc, error) {
	f.record("list")
	return f.docs, nil
}

func (f *fakeBookAuditStore) TryLockBookAudit(context.Context, BookAuditScope) (func(), bool, error) {
	f.record("lock")
	if f.lockErr != nil {
		return nil, false, f.lockErr
	}
	if !f.lockFree {
		return nil, false, nil
	}
	return func() { f.record("unlock") }, true, nil
}

func (f *fakeBookAuditStore) TryClaimBookAudit(_ context.Context, _ BookAuditScope, scopeHash string, _ time.Time, _ int) (bool, error) {
	f.record("claim")
	if f.claimErr != nil {
		return false, f.claimErr
	}
	f.mu.Lock()
	f.hashes = append(f.hashes, scopeHash)
	f.mu.Unlock()
	return f.claimOK, nil
}

func (f *fakeBookAuditStore) MarkBookAuditStatus(_ context.Context, _ BookAuditScope, status string) error {
	f.record("mark:" + status)
	f.mu.Lock()
	f.statuses = append(f.statuses, status)
	f.mu.Unlock()
	return nil
}

func (f *fakeBookAuditStore) RepositoryUnderReviewOrPublic(context.Context, string) (bool, error) {
	f.record("guard")
	return f.under, nil
}

func auditTestPrep(t *testing.T) (Config, *PrepareResult) {
	t.Helper()
	cfg, prep := groundingBodyFixture(t, false)
	prep.Doc.RepositoryID = "repo-1"
	return cfg, prep
}

func TestBookAuditScopeHash(t *testing.T) {
	t.Helper()
	shared := BookAuditScope{RepositoryID: "repo-1"}
	userB := "user-b"
	private := BookAuditScope{RepositoryID: "repo-1", OwnerUserID: &userB}
	c1, c2 := "content-a", "content-b"
	base := []ChapterScopeRow{{Path: "chapters/01.mdx", ContentID: &c1}, {Path: "chapters/02.mdx", ContentID: &c2}}
	baseHash := bookAuditScopeHash(shared, base)

	tests := []struct {
		name  string
		scope BookAuditScope
		rows  []ChapterScopeRow
		same  bool
	}{
		{name: "同一范围指纹稳定", scope: shared, rows: base, same: true},
		{
			name:  "内容层指针变化（重转录）即范围变化",
			scope: shared,
			rows:  []ChapterScopeRow{{Path: "chapters/01.mdx", ContentID: &c2}, {Path: "chapters/02.mdx", ContentID: &c2}},
			same:  false,
		},
		{
			name:  "补录章节即范围变化",
			scope: shared,
			rows:  append(append([]ChapterScopeRow(nil), base...), ChapterScopeRow{Path: "chapters/03.mdx", ContentID: &c1}),
			same:  false,
		},
		{name: "同仓不同归属是不同范围", scope: private, rows: base, same: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := bookAuditScopeHash(tt.scope, tt.rows)
			assert.Equal(t, tt.same, got == baseHash)
			assert.Len(t, got, 64, "sha256 十六进制")
		})
	}

	t.Run("降级成品（无内容层指针）指纹稳定", func(t *testing.T) {
		legacy := []ChapterScopeRow{{Path: "chapters/01.mdx"}}
		assert.Equal(t, bookAuditScopeHash(shared, legacy), bookAuditScopeHash(shared, []ChapterScopeRow{{Path: "chapters/01.mdx", ContentID: nil}}))
	})
}

func TestRunBookAuditOnce(t *testing.T) {
	t.Helper()
	tests := []struct {
		name      string
		store     *fakeBookAuditStore
		docs      []BookAuditDoc
		withLLM   bool
		wantClaim bool
		wantCalls []string
	}{
		{
			name:      "仍有未终态章：不是执行者，零副作用",
			store:     &fakeBookAuditStore{unsettled: 1},
			wantCalls: []string{"count"},
		},
		{
			name:      "咨询锁被占：另一执行者负责收尾，不占坑",
			store:     &fakeBookAuditStore{lockFree: false},
			wantCalls: []string{"count", "scope", "lock"},
		},
		{
			name:      "范围已审过（占坑失败）：不读章节正文",
			store:     &fakeBookAuditStore{lockFree: true, claimOK: false},
			wantCalls: []string{"count", "scope", "lock", "claim", "unlock"},
		},
		{
			name:      "无 LLM：claimed 但落 skipped_no_llm（可重试态），不盖 done",
			store:     &fakeBookAuditStore{lockFree: true, claimOK: true},
			docs:      []BookAuditDoc{{ID: "d1", Path: "chapters/01.mdx"}, {ID: "d2", Path: "chapters/02.mdx"}},
			wantClaim: true,
			wantCalls: []string{"count", "scope", "lock", "claim", "mark:skipped_no_llm", "unlock"},
		},
		{
			name:      "成为执行者：单章书无跨章一致性可审，落 done",
			store:     &fakeBookAuditStore{lockFree: true, claimOK: true},
			docs:      []BookAuditDoc{{ID: "d1", Path: "chapters/01.mdx"}},
			withLLM:   true,
			wantClaim: true,
			wantCalls: []string{"count", "scope", "lock", "claim", "list", "mark:done", "unlock"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.store.docs = tt.docs
			deps := TranscriptionBodyDeps{}
			if tt.withLLM {
				deps.Llm = &codeChapterMockLlm{fn: func(purpose string, _ map[string]any) (LlmTextResult, error) {
					t.Fatalf("unexpected llm purpose %s", purpose)
					return LlmTextResult{}, nil
				}}
			}
			_, prep := auditTestPrep(t)

			claimed, err := runBookAuditOnce(context.Background(), Config{}, deps, tt.store, prep, "user-1")

			require.NoError(t, err)
			assert.Equal(t, tt.wantClaim, claimed)
			assert.Equal(t, tt.wantCalls, tt.store.callLog(), "调用序之外不得有任何额外读写")
		})
	}
}

func TestRunBookAuditOncePropagatesStoreErrors(t *testing.T) {
	t.Helper()
	tests := []struct {
		name  string
		store *fakeBookAuditStore
	}{
		{name: "咨询锁不可用：显式上抛，不得降级为无锁执行", store: &fakeBookAuditStore{lockErr: assert.AnError}},
		{name: "占坑失败：显式上抛", store: &fakeBookAuditStore{lockFree: true, claimErr: assert.AnError}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, prep := auditTestPrep(t)
			_, err := runBookAuditOnce(context.Background(), Config{}, TranscriptionBodyDeps{}, tt.store, prep, "user-1")
			assert.ErrorIs(t, err, assert.AnError)
			assert.NotContains(t, tt.store.callLog(), "list", "出错后不得继续审计")
		})
	}
}

func TestNewBookAuditPrepSnapshotsRepoProfile(t *testing.T) {
	t.Helper()
	_, prep := auditTestPrep(t)
	snapshot := newBookAuditPrep(prep)

	prep.Doc.RepoProfile["codeClusters"] = "mutated-after-snapshot"
	prep.Doc.Title = "mutated"

	assert.NotEqual(t, "mutated-after-snapshot", snapshot.Doc.RepoProfile["codeClusters"], "快照不随原 map 的后续写入变化")
	assert.NotEqual(t, "mutated", snapshot.Doc.Title)
	assert.Equal(t, BookAuditScope{RepositoryID: "repo-1"}, bookAuditScopeOf(snapshot), "共享行作用域")
}

func TestMaybeRunBookAuditRequiresStoreCapability(t *testing.T) {
	t.Helper()
	_, prep := auditTestPrep(t)
	c := NewTranscriptionCoordinator(Config{}, BodyDeps{Store: &fakeBodyStore{}})
	assert.NotPanics(t, func() { c.maybeRunBookAudit(prep, "user-1") })
}
