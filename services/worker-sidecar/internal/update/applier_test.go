package update

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeUpdateStore struct {
	repoProfile *UpdateRepoProfile
	documents   []UpdateDocumentMeta
	txParams    *ApplyUpdatePlanTxParams
	txResult    *ApplyUpdatePlanTxResult
	txErr       error
}

func (f *fakeUpdateStore) GetRepoProfile(ctx context.Context, repoID string) (*UpdateRepoProfile, error) {
	return f.repoProfile, nil
}

func (f *fakeUpdateStore) GetDocuments(ctx context.Context, repoID string, docOwnerID *string) ([]UpdateDocumentMeta, error) {
	return f.documents, nil
}

func (f *fakeUpdateStore) ApplyUpdatePlanTx(ctx context.Context, p ApplyUpdatePlanTxParams) (*ApplyUpdatePlanTxResult, error) {
	f.txParams = &p
	if f.txErr != nil {
		return nil, f.txErr
	}
	if f.txResult != nil {
		return f.txResult, nil
	}
	return &ApplyUpdatePlanTxResult{
		UpdatedDocs:    len(p.Plan.Chapters),
		NavTreePatched: p.NeedStructural,
		GitShaAdvanced: p.NeedStructural,
		CoercedActions: p.CoercedCount,
	}, nil
}

func TestCoercePlanDraft(t *testing.T) {
	tests := []struct {
		name             string
		plan             UpdatePlan
		candidateSet     UpdateCandidateSet
		expectedChapters []UpdatePlanChapter
		expectedCoerced  []CoercedAction
	}{
		{
			name: "rename chapter is dropped from plan and recorded in coerced",
			plan: UpdatePlan{
				Chapters: []UpdatePlanChapter{
					{Path: "docs/old.md", Action: "update"},
				},
				Summary: "update old",
			},
			candidateSet: UpdateCandidateSet{
				Chapters: []UpdateCandidateChapter{
					{
						Path:   "docs/old.md",
						Rename: &ChapterRename{From: "docs/old.md", To: "docs/new.md"},
					},
				},
			},
			expectedChapters: []UpdatePlanChapter{},
			expectedCoerced: []CoercedAction{
				{
					Path:       "docs/old.md",
					FromAction: "update",
					ToAction:   "DROP",
					Reason:     "rename 由代码迁移路径，LLM 裁决被忽略",
				},
			},
		},
		{
			name: "remove without all files removed is coerced to update",
			plan: UpdatePlan{
				Chapters: []UpdatePlanChapter{
					{Path: "docs/guide.md", Action: "remove"},
				},
				Summary: "remove guide",
			},
			candidateSet: UpdateCandidateSet{
				Chapters: []UpdateCandidateChapter{
					{
						Path: "docs/guide.md",
						AffectedFiles: []AffectedFile{
							{Path: "docs/guide.md", Change: "modified"},
						},
					},
				},
			},
			expectedChapters: []UpdatePlanChapter{
				{Path: "docs/guide.md", Action: "update"},
			},
			expectedCoerced: []CoercedAction{
				{
					Path:       "docs/guide.md",
					FromAction: "remove",
					ToAction:   "update",
					Reason:     "remove 无 Git 事实支撑（源文件未全部删除），矫正为 update",
				},
			},
		},
		{
			name: "true remove with all removed files remains remove",
			plan: UpdatePlan{
				Chapters: []UpdatePlanChapter{
					{Path: "docs/obsolete.md", Action: "remove"},
				},
				Summary: "remove obsolete",
			},
			candidateSet: UpdateCandidateSet{
				Chapters: []UpdateCandidateChapter{
					{
						Path: "docs/obsolete.md",
						AffectedFiles: []AffectedFile{
							{Path: "docs/obsolete.md", Change: "removed"},
						},
					},
				},
			},
			expectedChapters: []UpdatePlanChapter{
				{Path: "docs/obsolete.md", Action: "remove"},
			},
			expectedCoerced: []CoercedAction{},
		},
		{
			name: "structural remove remains remove",
			plan: UpdatePlan{
				Chapters: []UpdatePlanChapter{
					{Path: "chapters/03.mdx", Action: "remove"},
				},
				Summary: "remove chapter 3",
			},
			candidateSet: UpdateCandidateSet{
				StructuralRemoves: []UpdateCandidateChapter{
					{Path: "chapters/03.mdx"},
				},
			},
			expectedChapters: []UpdatePlanChapter{
				{Path: "chapters/03.mdx", Action: "remove"},
			},
			expectedCoerced: []CoercedAction{},
		},
		{
			name: "llm rename action is dropped from plan and recorded in coerced",
			plan: UpdatePlan{
				Chapters: []UpdatePlanChapter{
					{Path: "docs/moved.md", Action: "rename"},
				},
				Summary: "rename from llm",
			},
			candidateSet: UpdateCandidateSet{
				Chapters: []UpdateCandidateChapter{
					{Path: "docs/moved.md"},
				},
			},
			expectedChapters: []UpdatePlanChapter{},
			expectedCoerced: []CoercedAction{
				{
					Path:       "docs/moved.md",
					FromAction: "rename",
					ToAction:   "DROP",
					Reason:     "rename 由代码迁移路径，LLM 裁决被忽略",
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := CoercePlanDraft(tt.plan, tt.candidateSet)
			assert.Equal(t, tt.expectedChapters, res.Plan.Chapters)
			assert.Equal(t, tt.expectedCoerced, res.Coerced)
		})
	}
}

func TestValidatePlan(t *testing.T) {
	tests := []struct {
		name         string
		plan         UpdatePlan
		candidateSet UpdateCandidateSet
		expectError  bool
		errContains  string
	}{
		{
			name: "valid plan passes",
			plan: UpdatePlan{
				Chapters: []UpdatePlanChapter{
					{Path: "docs/a.md", Action: "update"},
					{Path: "docs/b.md", Action: "keep"},
					{Path: "docs/new.md", Action: "add"},
				},
			},
			candidateSet: UpdateCandidateSet{
				Chapters: []UpdateCandidateChapter{
					{Path: "docs/a.md"},
					{Path: "docs/b.md"},
				},
				UnmatchedFiles: []AffectedFile{
					{Path: "docs/new.md", Change: "added"},
				},
			},
			expectError: false,
		},
		{
			name: "too many chapters returns error",
			plan: UpdatePlan{
				Chapters: func() []UpdatePlanChapter {
					ch := make([]UpdatePlanChapter, 51)
					for i := range ch {
						ch[i] = UpdatePlanChapter{Path: fmt.Sprintf("docs/%d.md", i), Action: "update"}
					}
					return ch
				}(),
			},
			candidateSet: UpdateCandidateSet{},
			expectError:  true,
			errContains:  "超过上限",
		},
		{
			name: "unknown action returns error",
			plan: UpdatePlan{
				Chapters: []UpdatePlanChapter{
					{Path: "docs/a.md", Action: "destroy"},
				},
			},
			candidateSet: UpdateCandidateSet{
				Chapters: []UpdateCandidateChapter{{Path: "docs/a.md"}},
			},
			expectError: true,
			errContains: "非法章节动作",
		},
		{
			name: "unauthorized update target returns error",
			plan: UpdatePlan{
				Chapters: []UpdatePlanChapter{
					{Path: "docs/unauthorized.md", Action: "update"},
				},
			},
			candidateSet: UpdateCandidateSet{
				Chapters: []UpdateCandidateChapter{{Path: "docs/a.md"}},
			},
			expectError: true,
			errContains: "不在候选集内",
		},
		{
			name: "add target in structural adds passes",
			plan: UpdatePlan{
				Chapters: []UpdatePlanChapter{
					{Path: "chapters/04.mdx", Action: "add"},
				},
			},
			candidateSet: UpdateCandidateSet{
				StructuralAdds: []UpdateCandidateChapter{{Path: "chapters/04.mdx"}},
			},
			expectError: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidatePlan(tt.plan, tt.candidateSet)
			if tt.expectError {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.errContains)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestPatchNavTree(t *testing.T) {
	initialTree := []*NavNode{
		{
			Name:  "guide",
			Title: "Guide",
			Type:  "file",
			Path:  "docs/guide.md",
			Url:   "/docs/o/r/guide",
		},
		{
			Name:  "advanced",
			Title: "Advanced",
			Type:  "directory",
			Children: []*NavNode{
				{
					Name:  "old-name",
					Title: "Old Name",
					Type:  "file",
					Path:  "docs/advanced/old.md",
					Url:   "/docs/o/r/advanced/old",
				},
				{
					Name:  "remove-me",
					Title: "Remove Me",
					Type:  "file",
					Path:  "docs/advanced/remove.md",
					Url:   "/docs/o/r/advanced/remove",
				},
			},
		},
	}

	posPath := "docs/guide.md"
	patch := NavTreePatch{
		Remove: []string{"docs/advanced/remove.md"},
		Rename: []NavTreeRename{
			{
				From:  "docs/advanced/old.md",
				To:    "docs/advanced/new.md",
				ToUrl: "/docs/o/r/advanced/new",
			},
		},
		Add: []NavTreeAdd{
			{
				Node: &NavNode{
					Name:  "intro",
					Title: "Intro",
					Type:  "file",
					Path:  "docs/intro.md",
					Url:   "/docs/o/r/intro",
				},
				PositionPath: &posPath,
			},
		},
	}

	newTree := PatchNavTree(initialTree, patch)

	require.Len(t, newTree, 3)
	assert.Equal(t, "docs/guide.md", newTree[0].Path)
	assert.Equal(t, "docs/intro.md", newTree[1].Path) // inserted after guide
	assert.Equal(t, "Advanced", newTree[2].Title)

	advChildren := newTree[2].Children
	require.Len(t, advChildren, 1)
	assert.Equal(t, "docs/advanced/new.md", advChildren[0].Path)
	assert.Equal(t, "/docs/o/r/advanced/new", advChildren[0].Url)
	assert.Equal(t, "new", advChildren[0].Name)
}

func TestApplyUpdatePlan_Success(t *testing.T) {
	store := &fakeUpdateStore{}
	cfg := Config{}

	req := UpdateApplyRequest{
		RepositoryID: "repo-123",
		UserID:       "user-456",
		FromSha:      "sha-1",
		ToSha:        "sha-2",
		Plan: UpdatePlan{
			Chapters: []UpdatePlanChapter{
				{Path: "docs/a.md", Action: "update"},
				{Path: "docs/rename-target.md", Action: "update"},
			},
			Summary: "test plan",
		},
		CandidateSet: UpdateCandidateSet{
			Chapters: []UpdateCandidateChapter{
				{Path: "docs/a.md"},
				{
					Path:   "docs/rename-target.md",
					Rename: &ChapterRename{From: "docs/rename-target.md", To: "docs/new-name.md"},
				},
			},
		},
	}

	res, err := ApplyUpdatePlan(context.Background(), cfg, store, req)
	require.NoError(t, err)
	require.NotNil(t, res)

	require.NotNil(t, store.txParams)
	assert.Equal(t, "repo-123", store.txParams.RepositoryID)
	assert.Equal(t, 1, store.txParams.CoercedCount) // 1 rename dropped
	require.Len(t, store.txParams.Plan.Chapters, 1)
	assert.Equal(t, "docs/a.md", store.txParams.Plan.Chapters[0].Path)
}

func TestApplyUpdatePlan_CoerceDropsRenamesBeforeValidationLimit(t *testing.T) {
	store := &fakeUpdateStore{}
	cfg := Config{}

	// Construct 51 chapters: 49 normal updates + 2 rename chapters
	chapters := make([]UpdatePlanChapter, 51)
	candChapters := make([]UpdateCandidateChapter, 51)
	for i := 0; i < 49; i++ {
		p := fmt.Sprintf("docs/%02d.md", i)
		chapters[i] = UpdatePlanChapter{Path: p, Action: "update"}
		candChapters[i] = UpdateCandidateChapter{Path: p}
	}
	// 2 rename chapters
	chapters[49] = UpdatePlanChapter{Path: "docs/old1.md", Action: "update"}
	candChapters[49] = UpdateCandidateChapter{
		Path:   "docs/old1.md",
		Rename: &ChapterRename{From: "docs/old1.md", To: "docs/new1.md"},
	}
	chapters[50] = UpdatePlanChapter{Path: "docs/old2.md", Action: "update"}
	candChapters[50] = UpdateCandidateChapter{
		Path:   "docs/old2.md",
		Rename: &ChapterRename{From: "docs/old2.md", To: "docs/new2.md"},
	}

	req := UpdateApplyRequest{
		RepositoryID: "repo-limit",
		UserID:       "user-1",
		FromSha:      "sha-1",
		ToSha:        "sha-2",
		Plan: UpdatePlan{
			Chapters: chapters,
			Summary:  "test plan with 51 items including 2 renames",
		},
		CandidateSet: UpdateCandidateSet{
			Chapters: candChapters,
		},
	}

	res, err := ApplyUpdatePlan(context.Background(), cfg, store, req)
	require.NoError(t, err)
	require.NotNil(t, res)
	require.NotNil(t, store.txParams)
	assert.Equal(t, 2, store.txParams.CoercedCount)
	assert.Len(t, store.txParams.Plan.Chapters, 49)
}

func TestNavTreeChainedRenames(t *testing.T) {
	tree := []*NavNode{
		{Name: "a", Title: "A", Path: "a.md", Url: "/docs/a"},
		{Name: "b", Title: "B", Path: "b.md", Url: "/docs/b"},
	}

	patch := NavTreePatch{
		Rename: []NavTreeRename{
			{From: "a.md", To: "b.md", ToUrl: "/docs/b"},
			{From: "b.md", To: "c.md", ToUrl: "/docs/c"},
		},
	}

	patched := PatchNavTree(tree, patch)
	require.Len(t, patched, 2)
	assert.Equal(t, "c.md", patched[0].Path)
	assert.Equal(t, "c.md", patched[1].Path)
}

func TestBuildDocUrl_CodeChapterParity(t *testing.T) {
	tests := []struct {
		name          string
		order         int
		owner         string
		repo          string
		expectedPath  string
		expectedDocUrl string
	}{
		{
			name:          "single-digit chapter with zero padding",
			order:         1,
			owner:         "acme",
			repo:          "widget",
			expectedPath:  "chapters/01.mdx",
			expectedDocUrl: "/docs/acme/widget/chapters/01",
		},
		{
			name:          "boundary chapter 9 with zero padding",
			order:         9,
			owner:         "org",
			repo:          "lib",
			expectedPath:  "chapters/09.mdx",
			expectedDocUrl: "/docs/org/lib/chapters/09",
		},
		{
			name:          "double-digit chapter 15",
			order:         15,
			owner:         "team",
			repo:          "core",
			expectedPath:  "chapters/15.mdx",
			expectedDocUrl: "/docs/team/core/chapters/15",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := codeChapterPath(tt.order)
			assert.Equal(t, tt.expectedPath, path)

			url := buildDocUrl(path, tt.owner, tt.repo)
			assert.Equal(t, tt.expectedDocUrl, url, "incremental chapter URL must match full ingest /docs/:owner/:repo/chapters/%02d (BUG-10)")
		})
	}
}
