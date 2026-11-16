package update

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/cluster"
)

func TestCandidatePlanBuilder_TableDriven(t *testing.T) {
	title := "Auth Module"
	docs := []UpdateDocumentMeta{
		{Path: "docs/intro.md", Title: strPtr("Introduction"), Summary: strPtr("Old intro")},
		{Path: "docs/config.md", Title: strPtr("Config"), Summary: strPtr("Old config")},
	}
	clusters := []ModuleSnapshot{
		{Title: title, ChapterNo: 1, TeachingOrder: 1, Files: []string{"src/auth/a.go", "src/auth/b.go"}},
	}

	tests := []struct {
		name                 string
		diff                 *UpdateArchiveDiff
		clusterDiff          *cluster.ClusterDiffResult
		newClusters          []ModuleSnapshot
		wantChapterCount     int
		wantUnmatchedCount   int
		wantStructuralAdds   int
		wantStructuralRemCount int
		checkFirstChapter    func(t *testing.T, ch UpdateCandidateChapter)
	}{
		{
			name: "cluster_file_modified",
			diff: &UpdateArchiveDiff{Modified: []string{"src/auth/a.go"}},
			wantChapterCount:   1,
			wantUnmatchedCount: 0,
			checkFirstChapter: func(t *testing.T, ch UpdateCandidateChapter) {
				t.Helper()
				assert.Equal(t, "chapters/01.mdx", ch.Path)
				assert.Equal(t, "content", ch.Change)
				assert.Equal(t, "Auth Module", *ch.Title)
			},
		},
		{
			name: "doc_file_modified_and_removed",
			diff: &UpdateArchiveDiff{
				Modified: []string{"docs/intro.md"},
				Removed:  []string{"docs/config.md"},
			},
			wantChapterCount:   2,
			wantUnmatchedCount: 0,
			checkFirstChapter: func(t *testing.T, ch UpdateCandidateChapter) {
				t.Helper()
				assert.Equal(t, "docs/intro.md", ch.Path)
				assert.Equal(t, "content", ch.Change)
			},
		},
		{
			name: "deterministic_rename",
			diff: &UpdateArchiveDiff{
				Renamed: []ChapterRename{{From: "docs/intro.md", To: "docs/intro-new.md"}},
			},
			wantChapterCount:   1,
			wantUnmatchedCount: 0,
			checkFirstChapter: func(t *testing.T, ch UpdateCandidateChapter) {
				t.Helper()
				assert.Equal(t, "docs/intro.md", ch.Path)
				require.NotNil(t, ch.Rename)
				assert.Equal(t, "docs/intro-new.md", ch.Rename.To)
			},
		},
		{
			name: "structural_added_and_unmatched",
			diff: &UpdateArchiveDiff{
				Added: []string{"orphan/test.go"},
			},
			clusterDiff: &cluster.ClusterDiffResult{
				Added: []ModuleSnapshot{{Title: "Billing", ChapterNo: 2, TeachingOrder: 2, Files: []string{"src/pay/pay.go"}}},
			},
			newClusters: []ModuleSnapshot{
				{Title: "Billing", ChapterNo: 2, TeachingOrder: 2, Files: []string{"src/pay/pay.go"}},
			},
			wantChapterCount:   0,
			wantUnmatchedCount: 1,
			wantStructuralAdds: 1,
		},
		{
			name: "structural_removed_chapter_appended",
			diff: &UpdateArchiveDiff{},
			clusterDiff: &cluster.ClusterDiffResult{
				Removed: []cluster.ClusterRemovedItem{{Title: "Deprecated", TeachingOrder: 3}},
			},
			wantChapterCount:       1,
			wantUnmatchedCount:     0,
			wantStructuralRemCount: 1,
			checkFirstChapter: func(t *testing.T, ch UpdateCandidateChapter) {
				t.Helper()
				assert.Equal(t, "chapters/03.mdx", ch.Path)
				assert.Equal(t, "structural", ch.Change)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			builder := NewCandidatePlanBuilder(tt.diff, clusters, tt.newClusters, tt.clusterDiff, docs, "")
			chapters, unmatched, structuralAdds, structuralRemoves, allMetas, metaMap := builder.Build()

			assert.Len(t, chapters, tt.wantChapterCount)
			assert.Len(t, unmatched, tt.wantUnmatchedCount)
			assert.Len(t, structuralAdds, tt.wantStructuralAdds)
			assert.Len(t, structuralRemoves, tt.wantStructuralRemCount)
			assert.NotEmpty(t, allMetas)
			assert.NotEmpty(t, metaMap)

			if tt.checkFirstChapter != nil && len(chapters) > 0 {
				tt.checkFirstChapter(t, chapters[0])
			}
		})
	}
}

func TestCoercePlanDraft_Specifications(t *testing.T) {
	candidateSet := UpdateCandidateSet{
		Chapters: []UpdateCandidateChapter{
			{
				Path:   "docs/renamed.md",
				Rename: &ChapterRename{From: "docs/renamed.md", To: "docs/new.md"},
			},
			{
				Path: "docs/partial.md",
				AffectedFiles: []AffectedFile{
					{Path: "src/a.ts", Change: "modified"},
				},
			},
			{
				Path: "docs/deleted.md",
				AffectedFiles: []AffectedFile{
					{Path: "src/b.ts", Change: "removed"},
				},
			},
		},
	}

	tests := []struct {
		name            string
		plan            UpdatePlan
		wantChapterLen  int
		wantCoercedLen  int
		checkCoerced    func(t *testing.T, res CoercePlanResult)
	}{
		{
			name: "rename_fact_is_dropped",
			plan: UpdatePlan{
				Chapters: []UpdatePlanChapter{
					{Path: "docs/renamed.md", Action: "update"},
				},
			},
			wantChapterLen: 0,
			wantCoercedLen: 1,
			checkCoerced: func(t *testing.T, res CoercePlanResult) {
				t.Helper()
				assert.Equal(t, "DROP", res.Coerced[0].ToAction)
				assert.Equal(t, "docs/renamed.md", res.Coerced[0].Path)
			},
		},
		{
			name: "remove_without_git_delete_coerced_to_update",
			plan: UpdatePlan{
				Chapters: []UpdatePlanChapter{
					{Path: "docs/partial.md", Action: "remove"},
				},
			},
			wantChapterLen: 1,
			wantCoercedLen: 1,
			checkCoerced: func(t *testing.T, res CoercePlanResult) {
				t.Helper()
				assert.Equal(t, "update", res.Coerced[0].ToAction)
				assert.Equal(t, "update", res.Plan.Chapters[0].Action)
			},
		},
		{
			name: "remove_with_git_delete_kept_as_remove",
			plan: UpdatePlan{
				Chapters: []UpdatePlanChapter{
					{Path: "docs/deleted.md", Action: "remove"},
				},
			},
			wantChapterLen: 1,
			wantCoercedLen: 0,
			checkCoerced: func(t *testing.T, res CoercePlanResult) {
				t.Helper()
				assert.Equal(t, "remove", res.Plan.Chapters[0].Action)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := CoercePlanDraft(tt.plan, candidateSet)
			assert.Len(t, res.Plan.Chapters, tt.wantChapterLen)
			assert.Len(t, res.Coerced, tt.wantCoercedLen)
			if tt.checkCoerced != nil {
				tt.checkCoerced(t, res)
			}
		})
	}
}
