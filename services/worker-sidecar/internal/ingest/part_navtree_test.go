package ingest

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildCodeRepoPlan_PartTitle(t *testing.T) {
	tests := []struct {
		name          string
		snapshots     []ModuleSnapshot
		appendixNodes []GitNode
		wantParts     []string
		wantTopTypes  []string
		wantChapters  []struct {
			title     string
			partTitle string
		}
	}{
		{
			name: "snapshots with parts create directory nav nodes and draft parts",
			snapshots: []ModuleSnapshot{
				{
					TeachingOrder: 1,
					ChapterNo:     1,
					Title:         "Architecture Overview",
					PartTitle:     "Part 1: Overview",
					Files:         []string{"pkg/core/arch.go"},
				},
				{
					TeachingOrder: 2,
					ChapterNo:     2,
					Title:         "Bootstrapping",
					PartTitle:     "Part 1: Overview",
					Files:         []string{"pkg/core/boot.go"},
				},
				{
					TeachingOrder: 3,
					ChapterNo:     3,
					Title:         "Storage Engine",
					PartTitle:     "Part 2: Storage",
					Files:         []string{"pkg/store/engine.go"},
				},
			},
			appendixNodes: nil,
			wantParts:     []string{"Part 1: Overview", "Part 2: Storage"},
			wantTopTypes:  []string{"directory", "directory"},
			wantChapters: []struct {
				title     string
				partTitle string
			}{
				{title: "Architecture Overview", partTitle: "Part 1: Overview"},
				{title: "Bootstrapping", partTitle: "Part 1: Overview"},
				{title: "Storage Engine", partTitle: "Part 2: Storage"},
			},
		},
		{
			name: "snapshots without parts preserve flat file nav nodes",
			snapshots: []ModuleSnapshot{
				{
					TeachingOrder: 1,
					ChapterNo:     1,
					Title:         "Module A",
					Files:         []string{"src/a.ts"},
				},
				{
					TeachingOrder: 2,
					ChapterNo:     2,
					Title:         "Module B",
					Files:         []string{"src/b.ts"},
				},
			},
			appendixNodes: nil,
			wantParts:     nil,
			wantTopTypes:  []string{"file", "file"},
			wantChapters: []struct {
				title     string
				partTitle string
			}{
				{title: "Module A", partTitle: ""},
				{title: "Module B", partTitle: ""},
			},
		},
		{
			name: "mixed snapshots with part and standalone plus appendix docs",
			snapshots: []ModuleSnapshot{
				{
					TeachingOrder: 1,
					ChapterNo:     1,
					Title:         "Core Pipeline",
					PartTitle:     "Part 1: Core",
					Files:         []string{"src/core.go"},
				},
				{
					TeachingOrder: 2,
					ChapterNo:     2,
					Title:         "Standalone Tool",
					PartTitle:     "",
					Files:         []string{"cmd/tool.go"},
				},
			},
			appendixNodes: []GitNode{
				{Path: "docs/readme.md", Type: "blob"},
			},
			wantParts:    []string{"Part 1: Core"},
			wantTopTypes: []string{"directory", "file", "file"},
			wantChapters: []struct {
				title     string
				partTitle string
			}{
				{title: "Core Pipeline", partTitle: "Part 1: Core"},
				{title: "Standalone Tool", partTitle: ""},
				{title: "readme", partTitle: ""},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plan := buildCodeRepoPlan(tt.snapshots, tt.appendixNodes, nil, "owner", "repo", "zh-CN")
			require.NotNil(t, plan)

			require.Equal(t, len(tt.wantTopTypes), len(plan.NavTree))
			for i, wantType := range tt.wantTopTypes {
				assert.Equal(t, wantType, plan.NavTree[i].Type)
			}

			if len(tt.wantParts) == 0 {
				assert.Empty(t, plan.Draft.Parts)
			} else {
				require.Equal(t, len(tt.wantParts), len(plan.Draft.Parts))
				for i, wantPartTitle := range tt.wantParts {
					assert.Equal(t, wantPartTitle, plan.Draft.Parts[i].Title)
					assert.Equal(t, i+1, plan.Draft.Parts[i].TeachingOrder)
				}
			}

			require.Equal(t, len(tt.wantChapters), len(plan.Draft.Chapters))
			for i, wantCh := range tt.wantChapters {
				assert.Equal(t, wantCh.title, plan.Draft.Chapters[i].Title)
				assert.Equal(t, wantCh.partTitle, plan.Draft.Chapters[i].PartTitle)
				assert.Equal(t, i+1, plan.Draft.Chapters[i].TeachingOrder)
			}
		})
	}
}

func TestBuildSnapshotsFromCustomOutline_PartTitle(t *testing.T) {
	tests := []struct {
		name       string
		rawJSON    string
		wantParts  []string
		wantTitles []string
	}{
		{
			name: "custom outline with partTitle propagates to snapshots and chapters",
			rawJSON: `[
				{
					"name": "Chapter 1",
					"partTitle": "Part I: Overview",
					"files": [{"path": "src/index.ts"}]
				},
				{
					"name": "Chapter 2",
					"partTitle": "Part II: Advanced",
					"files": [{"path": "src/advanced.ts"}]
				}
			]`,
			wantParts:  []string{"Part I: Overview", "Part II: Advanced"},
			wantTitles: []string{"Chapter 1", "Chapter 2"},
		},
		{
			name: "custom outline without partTitle leaves PartTitle empty",
			rawJSON: `[
				{
					"name": "Chapter 1",
					"files": [{"path": "src/index.ts"}]
				}
			]`,
			wantParts:  []string{""},
			wantTitles: []string{"Chapter 1"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var categories []CustomOutlineCategory
			err := json.Unmarshal([]byte(tt.rawJSON), &categories)
			require.NoError(t, err)

			snapshots := buildSnapshotsFromCustomOutline(categories, nil, nil)
			require.Equal(t, len(tt.wantTitles), len(snapshots))

			for i := range snapshots {
				assert.Equal(t, tt.wantTitles[i], snapshots[i].Title)
				assert.Equal(t, tt.wantParts[i], snapshots[i].PartTitle)
			}

			chapters := chaptersFromSnapshots(snapshots)
			require.Equal(t, len(snapshots), len(chapters))
			for i := range chapters {
				assert.Equal(t, tt.wantTitles[i], chapters[i].Title)
				assert.Equal(t, tt.wantParts[i], chapters[i].PartTitle)
			}
		})
	}
}

func TestAssembleTextPlan_PartTitle(t *testing.T) {
	categories := []CustomOutlineCategory{
		{
			Name:      "Getting Started",
			PartTitle: "Part 1: Intro",
			Files:     []CustomOutlineFile{{Path: "docs/intro.md"}},
		},
		{
			Name:      "Deep Dive",
			PartTitle: "Part 2: Advanced",
			Files:     []CustomOutlineFile{{Path: "docs/deep.md"}},
		},
	}

	chapters := buildChaptersFromCustomOutline(categories, "")
	require.Len(t, chapters, 2)
	assert.Equal(t, "Part 1: Intro", chapters[0].PartTitle)
	assert.Equal(t, "Part 2: Advanced", chapters[1].PartTitle)

	plan := assembleTextPlan(chapters, nil, DraftOutlineContent{})
	require.NotNil(t, plan)
	require.Len(t, plan.Draft.Parts, 2)
	assert.Equal(t, "Part 1: Intro", plan.Draft.Parts[0].Title)
	assert.Equal(t, "Part 2: Advanced", plan.Draft.Parts[1].Title)

	require.Len(t, plan.Draft.Chapters, 2)
	assert.Equal(t, "Part 1: Intro", plan.Draft.Chapters[0].PartTitle)
	assert.Equal(t, "Part 2: Advanced", plan.Draft.Chapters[1].PartTitle)
}
