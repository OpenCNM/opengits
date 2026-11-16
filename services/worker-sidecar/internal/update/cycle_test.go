package update

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeAutoUpdateStore struct {
	repos     []StaleRepoRow
	docs      []DocIdPath
	busy      []string
	active    int
	profiles  map[string]*UpdateRepoProfile
	created   []DocIdPath
	pendingTo string
	advanced  string
	cleared   []string
}

func (f *fakeAutoUpdateStore) ReleaseExpiredClaims(context.Context) (int64, error) { return 0, nil }
func (f *fakeAutoUpdateStore) FailTrialsWithoutStaging(context.Context) (int64, error) {
	return 0, nil
}
func (f *fakeAutoUpdateStore) ListUpdatableRepos(_ context.Context, _ int) ([]StaleRepoRow, error) {
	return f.repos, nil
}
func (f *fakeAutoUpdateStore) GetRepoProfile(_ context.Context, id string) (*UpdateRepoProfile, error) {
	return f.profiles[id], nil
}
func (f *fakeAutoUpdateStore) GetDocuments(_ context.Context, _ string, _ *string) ([]UpdateDocumentMeta, error) {
	return nil, nil
}
func (f *fakeAutoUpdateStore) ListProcessedSharedDocs(_ context.Context, _ string, _ []string) ([]DocIdPath, error) {
	return f.docs, nil
}
func (f *fakeAutoUpdateStore) BusyUpdateJobDocIDs(_ context.Context, _ string) ([]string, error) {
	return f.busy, nil
}
func (f *fakeAutoUpdateStore) CountActiveUpdateJobs(_ context.Context, _ string) (int, error) {
	return f.active, nil
}
func (f *fakeAutoUpdateStore) CreateChapterUpdateJob(_ context.Context, _, documentId, path, _, _ string) error {
	f.created = append(f.created, DocIdPath{ID: documentId, Path: path})
	return nil
}
func (f *fakeAutoUpdateStore) SetPendingSyncSha(_ context.Context, _, sha string) error {
	f.pendingTo = sha
	return nil
}
func (f *fakeAutoUpdateStore) AdvanceSyncBaseline(_ context.Context, _, sha string) error {
	f.advanced = sha
	return nil
}
func (f *fakeAutoUpdateStore) ClearUpstreamUpdate(_ context.Context, id string) error {
	f.cleared = append(f.cleared, id)
	return nil
}

func TestCreateStaleJobsRules(t *testing.T) {
	candidateOf := func(chapters ...UpdateCandidateChapter) *UpdateCandidateResponse {
		return &UpdateCandidateResponse{Chapters: chapters}
	}

	tests := []struct {
		name        string
		candidate   *UpdateCandidateResponse
		docs        []DocIdPath
		busy        []string
		wantCreated int
		wantStruct  bool
		wantPending bool
	}{
		{
			name:       "structural 拦截建单",
			candidate:  candidateOf(UpdateCandidateChapter{Path: "a.md", Change: "structural"}),
			wantStruct: true,
		},
		{
			name: "keepExemption 物理拦截",
			candidate: candidateOf(
				UpdateCandidateChapter{Path: "a.md", Change: "content", KeepExemption: &KeepExemption{Reason: "infra"}}),
			wantCreated: 0,
		},
		{
			name:        "活跃任务去重",
			candidate:   candidateOf(UpdateCandidateChapter{Path: "a.md", Change: "content"}),
			docs:        []DocIdPath{{ID: "d1", Path: "a.md"}},
			busy:        []string{"d1"},
			wantCreated: 0,
		},
		{
			name: "正常建单并记 pendingSyncSha",
			candidate: candidateOf(
				UpdateCandidateChapter{Path: "a.md", Change: "content"},
				UpdateCandidateChapter{Path: "b.md", Change: "content"},
				UpdateCandidateChapter{Path: "c.md", Change: "content", KeepExemption: &KeepExemption{Reason: "ci"}}),
			docs:        []DocIdPath{{ID: "d1", Path: "a.md"}, {ID: "d2", Path: "b.md"}},
			wantCreated: 2,
			wantPending: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeAutoUpdateStore{docs: tt.docs, busy: tt.busy}
			created, structural, err := CreateStaleJobs(t.Context(), store, "repo-1", "from", tt.candidate, "to")
			require.NoError(t, err)
			assert.Equal(t, tt.wantStruct, structural)
			assert.Equal(t, tt.wantCreated, created)
			assert.Equal(t, tt.wantPending, store.pendingTo != "")
			if tt.wantCreated > 0 {
				assert.Equal(t, "to", store.pendingTo)
			}
		})
	}
}

func TestSettleIfAllResolved(t *testing.T) {
	t.Run("活跃清零才推进基线", func(t *testing.T) {
		store := &fakeAutoUpdateStore{active: 2}
		_ = SettleIfAllResolved(t.Context(), store, "repo-1", "to")
		assert.Empty(t, store.advanced, "活跃任务未清零不得推进")
		store.active = 0
		_ = SettleIfAllResolved(t.Context(), store, "repo-1", "to")
		assert.Equal(t, "to", store.advanced)
	})
}

func TestResolveLatestShaHTTP(t *testing.T) {
	t.Run("正常返回 sha", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]string{"sha": "abc123"})
		}))
		defer ts.Close()
		sha, err := resolveLatestShaHTTP(t.Context(), Config{GitHubAPIBase: ts.URL}, "o", "r", "main")
		require.NoError(t, err)
		assert.Equal(t, "abc123", sha)
	})
	t.Run("非 200 显式报错", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "nope", http.StatusNotFound)
		}))
		defer ts.Close()
		_, err := resolveLatestShaHTTP(t.Context(), Config{GitHubAPIBase: ts.URL}, "o", "r", "main")
		require.Error(t, err)
	})
}

func TestFetchCompareDiffHTTPGuards(t *testing.T) {
	compareBody := func(status string, total int, files []map[string]any) http.HandlerFunc {
		return func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": status, "total_commits": total, "files": files,
			})
		}
	}
	tests := []struct {
		name      string
		handler   http.HandlerFunc
		wantErr   bool
		wantAdded []string
	}{
		{
			name: "正常 diff 分类",
			handler: compareBody("ahead", 3, []map[string]any{
				{"filename": "a.md", "status": "added"},
				{"filename": "b.md", "status": "modified"},
				{"filename": "c.md", "status": "removed"},
				{"filename": "d.md", "status": "renamed", "previous_filename": "old.md"},
			}),
			wantAdded: []string{"a.md"},
		},
		{name: "diversed 拒用", handler: compareBody("diverged", 1, nil), wantErr: true},
		{
			name: "files 触截断上限拒用",
			handler: func() http.HandlerFunc {
				files := make([]map[string]any, CompareAPIFilesHardCap)
				for i := range files {
					files[i] = map[string]any{"filename": "f", "status": "added"}
				}
				return compareBody("ahead", 1, files)
			}(),
			wantErr: true,
		},
		{name: "commits 触截断上限拒用", handler: compareBody("ahead", CompareAPICommitsHardCap, nil), wantErr: true},
		{name: "同 sha 短路空 diff", handler: compareBody("ahead", 0, nil)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ts := httptest.NewServer(tt.handler)
			defer ts.Close()
			from, to := "from", "to"
			if tt.name == "同 sha 短路空 diff" {
				from, to = "same", "same"
			}
			d, err := fetchCompareDiffHTTP(t.Context(), Config{GitHubAPIBase: ts.URL}, "o", "r", from, to)
			if tt.name == "同 sha 短路空 diff" {
				require.NoError(t, err)
				assert.Nil(t, d)
				return
			}
			if tt.wantErr {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			require.NotNil(t, d)
			assert.Equal(t, tt.wantAdded, d.Added)
		})
	}
}

// 🧪 WP-H 快照推进（源锚点断言）：update 侧 ImportRecord upsert 推进 sha，
// 历史死字段 status 与 prefix 已全面物理拆除。
func TestImportRecordTristateSemantics(t *testing.T) {
	srcBytes, err := os.ReadFile("store_pg_apply.go")
	if err != nil {
		srcBytes, err = os.ReadFile("store_pg.go")
	}
	require.NoError(t, err)
	src := string(srcBytes)
	assert.Contains(t, src, `qtx.ApplyTxUpsertImportRecord`, "must advance ImportRecord sha via ApplyTxUpsertImportRecord")
	assert.NotContains(t, src, `'UPDATED'`, "dead status column has been eliminated")
	assert.NotContains(t, src, `'', 'UPDATED'`, "hardcoded UPDATED with empty prefix is eliminated")
}
