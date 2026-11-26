package ingest

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestChapterPlanLadder_TableDriven(t *testing.T) {
	patterns := DefaultPatterns()
	require.NotNil(t, patterns)

	tests := []struct {
		name     string
		env      *IngestContext
		wantPlan bool
		wantErr  bool
	}{
		{
			name: "custom_outline_text_priority",
			env: &IngestContext{
				CodeRepo: false,
				CustomCats: []CustomOutlineCategory{
					{
						Title: "Introduction",
						Files: []CustomOutlineFile{{Path: "intro.md", ShortTitle: "Intro"}},
					},
				},
				ScopePrefix: "",
				DraftContent: DraftOutlineContent{
					Outline: []DraftOutlineChapter{
						{Title: "Draft Ch1", Files: []DraftOutlineFile{{Path: "draft.md"}}},
					},
				},
				Patterns:  patterns,
				TextNodes: []GitNode{{Path: "intro.md", Type: "blob"}},
			},
			wantPlan: true,
			wantErr:  false,
		},
		{
			name: "draft_outline_when_no_custom_outline",
			env: &IngestContext{
				CodeRepo:   false,
				CustomCats: nil,
				DraftContent: DraftOutlineContent{
					Outline: []DraftOutlineChapter{
						{Title: "Draft Ch1", Files: []DraftOutlineFile{{Path: "draft.md"}}},
					},
				},
				Patterns:  patterns,
				TextNodes: []GitNode{{Path: "draft.md", Type: "blob"}},
			},
			wantPlan: true,
			wantErr:  false,
		},
		{
			name: "ruletree_fallback_when_no_outlines_or_signals",
			env: &IngestContext{
				CodeRepo:     false,
				CustomCats:   nil,
				DraftContent: DraftOutlineContent{},
				Patterns:     patterns,
				TextNodes: []GitNode{
					{Path: "README.md", Type: "blob"},
					{Path: "guide.md", Type: "blob"},
				},
				Job: JobRow{Owner: "testowner", Repo: "testrepo"},
			},
			wantPlan: true,
			wantErr:  false,
		},
		{
			name: "empty_ruletree_fails_closed",
			env: &IngestContext{
				CodeRepo:     false,
				CustomCats:   nil,
				DraftContent: DraftOutlineContent{},
				Patterns:     patterns,
				TextNodes:    []GitNode{},
				Job:          JobRow{Owner: "testowner", Repo: "testrepo"},
			},
			wantPlan: false,
			wantErr:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ladder := DefaultChapterPlanLadder()
			plan, err := ladder.Evaluate(context.Background(), tt.env)
			if tt.wantErr {
				require.Error(t, err)
				assert.Nil(t, plan)
			} else {
				require.NoError(t, err)
				require.NotNil(t, plan)
				if tt.name == "custom_outline_text_priority" {
					assert.Equal(t, "Introduction", plan.Chapters[0].Title)
				} else if tt.name == "draft_outline_when_no_custom_outline" {
					assert.Equal(t, "Draft Ch1", plan.Chapters[0].Title)
				}
			}
		})
	}
}

func TestProjectSnapshotsInPhaseOrder_RenumberChapterTitles(t *testing.T) {
	snapshots := []ModuleSnapshot{
		{
			Title:         "第 4 章：网络通信与分发",
			Summary:       "网络分发核心",
			TeachingOrder: 4,
			ChapterNo:     4,
		},
		{
			Title:         "第 10 章：核心架构实现",
			Summary:       "核心架构",
			TeachingOrder: 10,
			ChapterNo:     10,
		},
	}

	sorted := projectSnapshotsInPhaseOrder(nil, snapshots)
	require.Len(t, sorted, 2)

	assert.Equal(t, 1, sorted[0].ChapterNo)
	assert.Equal(t, 1, sorted[0].TeachingOrder)
	assert.Equal(t, "第 1 章：网络通信与分发", sorted[0].Title)

	assert.Equal(t, 2, sorted[1].ChapterNo)
	assert.Equal(t, 2, sorted[1].TeachingOrder)
	assert.Equal(t, "第 2 章：核心架构实现", sorted[1].Title)
}
