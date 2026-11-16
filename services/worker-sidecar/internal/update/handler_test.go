package update

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestHandler(t *testing.T, store Store) (*Handler, http.Handler) {
	t.Helper()
	cfg := Config{
		InternalToken: "test-internal-token",
		ArchiveRoot:   t.TempDir(),
	}
	h := NewHandler(cfg, store, nil)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/update/candidate-set", h.HandleUpdateCandidateSet)
	mux.HandleFunc("POST /v1/update/apply", h.HandleUpdateApply)
	return h, mux
}

func TestUpdateHandlerValidation(t *testing.T) {
	_, handler := newTestHandler(t, nil)

	tests := []struct {
		name         string
		body         string
		expectedCode int
	}{
		{
			name:         "invalid json returns 400",
			body:         "{invalid-json",
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "missing owner returns 400",
			body:         `{"repo":"r","fromSha":"s1","toSha":"s2","repositoryId":"id1"}`,
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "missing repo returns 400",
			body:         `{"owner":"o","fromSha":"s1","toSha":"s2","repositoryId":"id1"}`,
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "missing sha returns 400",
			body:         `{"owner":"o","repo":"r","repositoryId":"id1"}`,
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "unsafe owner with dot-dot returns 400",
			body:         `{"owner":"../bad","repo":"r","fromSha":"s1","toSha":"s2","repositoryId":"id1"}`,
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "unsafe repo with slash returns 400",
			body:         `{"owner":"o","repo":"r/bad","fromSha":"s1","toSha":"s2","repositoryId":"id1"}`,
			expectedCode: http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/update/candidate-set", bytes.NewBufferString(tt.body))
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			assert.Equal(t, tt.expectedCode, w.Code)
		})
	}
}

// 🧪 [5.2.1.2 · HIGH] 增量更新候选集与差异比对一站式下沉至 Go worker-sidecar (零跨进程 RPC 乒乓与 V8 集合抖动)
func TestUpdateCandidateDocsRepo(t *testing.T) {
	h, _ := newTestHandler(t, nil)

	introTitle := "起步介绍"
	introSummary := "这是旧的起步介绍摘要"
	depTitle := "废弃功能"
	depSummary := "这是已废弃的功能说明"
	unchangedTitle := "不变文档"
	unchangedSummary := "未改动的文档"

	req := UpdateCandidateRequest{
		Owner:        "test-owner",
		Repo:         "test-docs-repo",
		Branch:       "main",
		FromSha:      "1111111111111111111111111111111111111111",
		ToSha:        "2222222222222222222222222222222222222222",
		RepositoryID: "repo-1",
		Diff: &UpdateArchiveDiff{
			Modified: []string{"docs/intro.md"},
			Removed:  []string{"docs/deprecated.md"},
			Added:    []string{"docs/new-guide.md"},
			Renamed: []ChapterRename{
				{From: "docs/old-name.md", To: "docs/new-name.md"},
			},
		},
		Documents: []UpdateDocumentMeta{
			{Path: "docs/intro.md", Title: &introTitle, Summary: &introSummary},
			{Path: "docs/deprecated.md", Title: &depTitle, Summary: &depSummary},
			{Path: "docs/unchanged.md", Title: &unchangedTitle, Summary: &unchangedSummary},
		},
	}

	resp, err := BuildUpdateCandidateSet(h.cfg, req)
	require.NoError(t, err)
	require.NotNil(t, resp)

	// Chapters: intro.md (content) and deprecated.md (structural)
	require.Len(t, resp.Chapters, 2)

	var intro *UpdateCandidateChapter
	var dep *UpdateCandidateChapter
	for i := range resp.Chapters {
		if resp.Chapters[i].Path == "docs/intro.md" {
			intro = &resp.Chapters[i]
		}
		if resp.Chapters[i].Path == "docs/deprecated.md" {
			dep = &resp.Chapters[i]
		}
	}
	require.NotNil(t, intro)
	assert.Equal(t, "content", intro.Change)
	assert.Equal(t, "起步介绍", *intro.Title)
	assert.Contains(t, *intro.OldSummary, "起步介绍摘要")
	assert.Equal(t, []AffectedFile{{Path: "docs/intro.md", Change: "modified"}}, intro.AffectedFiles)

	require.NotNil(t, dep)
	assert.Equal(t, "structural", dep.Change)
	assert.Equal(t, []AffectedFile{{Path: "docs/deprecated.md", Change: "removed"}}, dep.AffectedFiles)

	// Unmatched files
	expectedUnmatched := []AffectedFile{
		{Path: "docs/new-guide.md", Change: "added"},
		{Path: "docs/old-name.md", Change: "renamed"},
		{Path: "docs/new-name.md", Change: "renamed"},
	}
	assert.Equal(t, expectedUnmatched, resp.UnmatchedFiles)

	// Diff stats
	assert.Equal(t, DiffStats{Added: 1, Modified: 1, Removed: 1, Renamed: 1}, resp.DiffStats)
}

func TestUpdateCandidateCodeRepoRecompute(t *testing.T) {
	h, _ := newTestHandler(t, nil)

	ch1Title := "运行时核心架构"
	ch1Summary := "旧代码章节摘要"
	ch2Title := "编译器实现"
	ch2Summary := "编译器摘要"

	req := UpdateCandidateRequest{
		Owner:        "test-owner",
		Repo:         "test-code-repo",
		Branch:       "main",
		FromSha:      "1111111111111111111111111111111111111111",
		ToSha:        "2222222222222222222222222222222222222222",
		RepositoryID: "repo-2",
		RepoProfile: &UpdateRepoProfile{
			CodeClusters: []ModuleSnapshot{
				{
					TeachingOrder: 1,
					ChapterNo:     1,
					Title:         ch1Title,
					Summary:       "核心架构",
					Directories:   []string{"src/runtime"},
					Files:         []string{"src/runtime/core.ts", "src/runtime/index.ts"},
				},
				{
					TeachingOrder: 2,
					ChapterNo:     2,
					Title:         ch2Title,
					Summary:       "编译器",
					Directories:   []string{"src/compiler"},
					Files:         []string{"src/compiler/parser.ts"},
				},
			},
		},
		Diff: &UpdateArchiveDiff{
			Modified: []string{"src/runtime/core.ts"},
			Added:    []string{"src/runtime/helper.ts"},
			Removed:  []string{},
			Renamed:  []ChapterRename{},
		},
		NewTree: []GitNode{
			{Path: "src", Type: "tree"},
			{Path: "src/runtime", Type: "tree"},
			{Path: "src/compiler", Type: "tree"},
			{Path: "src/runtime/core.ts", Type: "blob", Size: 100},
			{Path: "src/runtime/index.ts", Type: "blob", Size: 100},
			{Path: "src/runtime/helper.ts", Type: "blob", Size: 100},
			{Path: "src/compiler/parser.ts", Type: "blob", Size: 100},
		},
		Documents: []UpdateDocumentMeta{
			{Path: "chapters/01.mdx", Title: &ch1Title, Summary: &ch1Summary},
			{Path: "chapters/02.mdx", Title: &ch2Title, Summary: &ch2Summary},
		},
	}

	resp, err := BuildUpdateCandidateSet(h.cfg, req)
	require.NoError(t, err)
	require.NotNil(t, resp)

	// Chapters: chapters/01.mdx affected
	require.Len(t, resp.Chapters, 1)
	ch1 := resp.Chapters[0]
	assert.Equal(t, "chapters/01.mdx", ch1.Path)
	assert.Equal(t, ch1Title, *ch1.Title)
	assert.Equal(t, "structural", ch1.Change)
	assert.Equal(t, []AffectedFile{
		{Path: "src/runtime/core.ts", Change: "modified"},
		{Path: "src/runtime/helper.ts", Change: "added"},
	}, ch1.AffectedFiles)
}

func TestUpdateCandidateDeterministicRename(t *testing.T) {
	h, _ := newTestHandler(t, nil)

	docTitle := "指南"
	docSummary := "改名前的指南文档"

	req := UpdateCandidateRequest{
		Owner:        "test-owner",
		Repo:         "test-docs-repo",
		Branch:       "main",
		FromSha:      "1111111111111111111111111111111111111111",
		ToSha:        "2222222222222222222222222222222222222222",
		RepositoryID: "repo-4",
		Diff: &UpdateArchiveDiff{
			Modified: []string{},
			Removed:  []string{},
			Added:    []string{},
			Renamed: []ChapterRename{
				{From: "docs/old-guide.md", To: "docs/new-guide.md"},
			},
		},
		Documents: []UpdateDocumentMeta{
			{Path: "docs/old-guide.md", Title: &docTitle, Summary: &docSummary},
		},
	}

	resp, err := BuildUpdateCandidateSet(h.cfg, req)
	require.NoError(t, err)
	require.NotNil(t, resp)

	require.Len(t, resp.Chapters, 1)
	renamed := resp.Chapters[0]
	assert.Equal(t, "docs/old-guide.md", renamed.Path)
	require.NotNil(t, renamed.Rename)
	assert.Equal(t, &ChapterRename{From: "docs/old-guide.md", To: "docs/new-guide.md"}, renamed.Rename)
	assert.Equal(t, []AffectedFile{{Path: "docs/old-guide.md", Change: "renamed"}}, renamed.AffectedFiles)

	// Both from and to are absorbed, not in unmatchedFiles
	assert.Empty(t, resp.UnmatchedFiles)
}

// 🧪 [5.2.2.2 · HIGH] 规则豁免误吞教学变更：章节的教学源文件被当作基础设施角色豁免 keep
func TestUpdateCandidateKeepExemption(t *testing.T) {
	h, _ := newTestHandler(t, nil)

	infraTitle := "工程基建"
	infraSummary := "旧基建"
	coreTitle := "核心模块"
	coreSummary := "旧核心"

	req := UpdateCandidateRequest{
		Owner:        "test-owner",
		Repo:         "test-repo",
		Branch:       "main",
		FromSha:      "1111111111111111111111111111111111111111",
		ToSha:        "2222222222222222222222222222222222222222",
		RepositoryID: "repo-decisions",
		RepoProfile: &UpdateRepoProfile{
			CodeClusters: []ModuleSnapshot{
				{TeachingOrder: 1, Title: infraTitle, Files: []string{"pnpm-lock.yaml"}},
				{TeachingOrder: 2, Title: coreTitle, Files: []string{"src/parser.ts"}},
			},
		},
		Diff: &UpdateArchiveDiff{
			Modified: []string{"pnpm-lock.yaml", "src/parser.ts"},
			Added:    []string{},
			Removed:  []string{},
			Renamed:  []ChapterRename{},
		},
		Documents: []UpdateDocumentMeta{
			{Path: "chapters/01.mdx", Title: &infraTitle, Summary: &infraSummary},
			{Path: "chapters/02.mdx", Title: &coreTitle, Summary: &coreSummary},
		},
		GraphDiff: &GraphDiffResponse{
			ChapterDecisions: []ChapterSemanticDecision{
				{
					Path:   "chapters/01.mdx",
					Action: ActionKeep,
					KeepExemption: &KeepExemption{
						Reason:   "基础设施角色变更，豁免重新生成",
						Evidence: "pnpm-lock.yaml",
					},
				},
				{
					Path:   "chapters/02.mdx",
					Action: ActionUpdate,
				},
			},
		},
	}

	resp, err := BuildUpdateCandidateSet(h.cfg, req)
	require.NoError(t, err)
	require.NotNil(t, resp)

	require.Len(t, resp.Chapters, 2)
	var ch1 *UpdateCandidateChapter
	var ch2 *UpdateCandidateChapter
	for i := range resp.Chapters {
		if resp.Chapters[i].Path == "chapters/01.mdx" {
			ch1 = &resp.Chapters[i]
		}
		if resp.Chapters[i].Path == "chapters/02.mdx" {
			ch2 = &resp.Chapters[i]
		}
	}
	require.NotNil(t, ch1)
	require.NotNil(t, ch2)

	// ch1 is pnpm-lock.yaml only -> non-teaching infra -> keepExemption
	require.NotNil(t, ch1.KeepExemption)
	assert.Contains(t, ch1.KeepExemption.Reason, "基础设施角色")
	assert.Equal(t, "pnpm-lock.yaml", ch1.KeepExemption.Evidence)

	// ch2 is src/parser.ts -> code change -> update without exemption
	assert.Nil(t, ch2.KeepExemption)
}

func TestUpdateCandidateEmptyDiff(t *testing.T) {
	h, _ := newTestHandler(t, nil)

	req := UpdateCandidateRequest{
		Owner:        "test-owner",
		Repo:         "test-empty-repo",
		Branch:       "main",
		FromSha:      "1111111111111111111111111111111111111111",
		ToSha:        "2222222222222222222222222222222222222222",
		RepositoryID: "repo-empty",
		Diff: &UpdateArchiveDiff{
			Modified: []string{},
			Added:    []string{},
			Removed:  []string{},
			Renamed:  []ChapterRename{},
		},
		Documents: []UpdateDocumentMeta{},
	}

	resp, err := BuildUpdateCandidateSet(h.cfg, req)
	require.NoError(t, err)
	require.NotNil(t, resp)

	assert.Empty(t, resp.Chapters)
	assert.Empty(t, resp.UnmatchedFiles)
	assert.Equal(t, DiffStats{Added: 0, Modified: 0, Removed: 0, Renamed: 0}, resp.DiffStats)
}

func TestUpdateCandidateRippleBeforeExistingChapter(t *testing.T) {
	h, _ := newTestHandler(t, nil)

	ch1Title := "章节一"
	ch1Summary := "摘要一"
	ch2Title := "章节二（被波及）"
	ch2Summary := "摘要二"

	req := UpdateCandidateRequest{
		Owner:        "test-owner",
		Repo:         "test-ripple-repo",
		Branch:       "main",
		FromSha:      "1111111111111111111111111111111111111111",
		ToSha:        "2222222222222222222222222222222222222222",
		RepositoryID: "repo-ripple",
		Diff: &UpdateArchiveDiff{
			Modified: []string{"docs/ch1.md"},
			Added:    []string{},
			Removed:  []string{},
			Renamed:  []ChapterRename{},
		},
		Documents: []UpdateDocumentMeta{
			{Path: "docs/ch1.md", Title: &ch1Title, Summary: &ch1Summary},
			{Path: "docs/ch2.md", Title: &ch2Title, Summary: &ch2Summary},
		},
		GraphDiff: &GraphDiffResponse{
			FromSha: "1111111111111111111111111111111111111111",
			ToSha:   "2222222222222222222222222222222222222222",
			ChapterDecisions: []ChapterSemanticDecision{
				{
					Path:   "docs/ch2.md",
					Action: ActionUpdate,
					SurgicalAnchors: []SurgicalAnchor{
						{SymbolName: "rippleFn", File: "docs/ch2.md", Change: "ripple"},
					},
					IsBreaking: false,
				},
				{
					Path:   "docs/ch1.md",
					Action: ActionKeep,
					KeepExemption: &KeepExemption{
						Reason:   "规则级豁免验证",
						Evidence: "docs/ch1.md",
					},
					IsBreaking: false,
				},
			},
		},
	}

	resp, err := BuildUpdateCandidateSet(h.cfg, req)
	require.NoError(t, err)
	require.NotNil(t, resp)

	require.Len(t, resp.Chapters, 2)
	var ch1 *UpdateCandidateChapter
	var ch2 *UpdateCandidateChapter
	for i := range resp.Chapters {
		if resp.Chapters[i].Path == "docs/ch1.md" {
			ch1 = &resp.Chapters[i]
		}
		if resp.Chapters[i].Path == "docs/ch2.md" {
			ch2 = &resp.Chapters[i]
		}
	}

	require.NotNil(t, ch1)
	require.NotNil(t, ch2)

	require.NotNil(t, ch1.KeepExemption, "existing chapter KeepExemption must not be lost after slice reallocation")
	assert.Equal(t, "规则级豁免验证", ch1.KeepExemption.Reason)
	assert.Equal(t, "docs/ch1.md", ch1.KeepExemption.Evidence)

	require.Len(t, ch2.SurgicalAnchors, 1)
	assert.Equal(t, "rippleFn", ch2.SurgicalAnchors[0].SymbolName)
}

func TestDiffArchiveTrees(t *testing.T) {
	tests := []struct {
		name        string
		oldTree     map[string]string
		newTree     map[string]string
		wantAdded   []string
		wantMod     []string
		wantRemoved []string
		wantRenamed [][2]string
	}{
		{
			name:        "identical trees produce empty diff",
			wantAdded:   []string{},
			wantMod:     []string{},
			wantRemoved: []string{},
			wantRenamed: [][2]string{},
			oldTree:     map[string]string{"a.md": "h1", "b.md": "h2"},
			newTree:     map[string]string{"a.md": "h1", "b.md": "h2"},
		},
		{
			name:        "added modified removed classified",
			oldTree:     map[string]string{"a.md": "h1", "gone.md": "h2"},
			newTree:     map[string]string{"a.md": "h1x", "new.md": "h3"},
			wantAdded:   []string{"new.md"},
			wantMod:     []string{"a.md"},
			wantRemoved: []string{"gone.md"},
			wantRenamed: [][2]string{},
		},
		{
			name:        "same-hash rename pair absorbed",
			oldTree:     map[string]string{"docs/old.md": "same"},
			newTree:     map[string]string{"docs/new.md": "same"},
			wantAdded:   []string{},
			wantMod:     []string{},
			wantRemoved: []string{},
			wantRenamed: [][2]string{{"docs/old.md", "docs/new.md"}},
		},
		{
			name:        "changed-content move is not a rename",
			oldTree:     map[string]string{"docs/old.md": "v1"},
			newTree:     map[string]string{"docs/new.md": "v2"},
			wantAdded:   []string{"docs/new.md"},
			wantMod:     []string{},
			wantRemoved: []string{"docs/old.md"},
			wantRenamed: [][2]string{},
		},
		{
			name:        "multiple same-hash targets pair deterministically",
			oldTree:     map[string]string{"a/old.md": "dup", "b/old.md": "dup"},
			newTree:     map[string]string{"x/1.md": "dup", "y/2.md": "dup", "z/3.md": "other"},
			wantRenamed: [][2]string{{"a/old.md", "y/2.md"}, {"b/old.md", "x/1.md"}},
			wantAdded:   []string{"z/3.md"},
			wantMod:     []string{},
			wantRemoved: []string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := diffArchiveTrees(tt.oldTree, tt.newTree)
			assert.Equal(t, tt.wantAdded, d.Added)
			assert.Equal(t, tt.wantMod, d.Modified)
			assert.Equal(t, tt.wantRemoved, d.Removed)
			got := make([][2]string, 0, len(d.Renamed))
			for _, r := range d.Renamed {
				got = append(got, [2]string{r.From, r.To})
			}
			assert.Equal(t, tt.wantRenamed, got)
		})
	}
}

// 🧪 [1.22.5.1] TestDiffArchiveTreesDeterministicAcrossRuns diffArchiveTrees 同哈希多目标确定性排序配对
func TestDiffArchiveTreesDeterministicAcrossRuns(t *testing.T) {
	oldTree := map[string]string{"old1.md": "dup", "old2.md": "dup", "old3.md": "dup"}
	newTree := map[string]string{"a.md": "dup", "b.md": "dup", "c.md": "dup"}

	first := diffArchiveTrees(oldTree, newTree)
	for i := 0; i < 20; i++ {
		got := diffArchiveTrees(oldTree, newTree)
		require.Equal(t, first.Renamed, got.Renamed, "rename pairing must be deterministic")
	}
}

func TestUpdateApplyHandler_HTTP(t *testing.T) {
	store := &fakeRunnerStore{}
	h, handler := newTestHandler(t, store)
	_ = h

	applyReq := UpdateApplyRequest{
		RepositoryID: "repo-apply",
		UserID:       "user-1",
		FromSha:      "1111111111111111111111111111111111111111",
		ToSha:        "2222222222222222222222222222222222222222",
		Plan: UpdatePlan{
			Chapters: []UpdatePlanChapter{
				{Path: "docs/a.md", Action: "update"},
			},
			Summary: "test plan",
		},
		CandidateSet: UpdateCandidateSet{
			Chapters: []UpdateCandidateChapter{
				{Path: "docs/a.md"},
			},
		},
	}
	body, _ := json.Marshal(applyReq)

	req := httptest.NewRequest(http.MethodPost, "/v1/update/apply", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}
