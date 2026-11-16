package ingest

import (
	"testing"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildCodeRepoPlan_MicroRepoWithAnchors(t *testing.T) {
	// 5-phase snapshots typical of micro repos (e.g. developit/mitt)
	snapshots := []ModuleSnapshot{
		{
			TeachingOrder: 1,
			ChapterNo:     1,
			Title:         "第 1 章：起步与使用指南",
			Summary:       "核心概念、安装配置与基础使用示例",
			Directories:   []string{},
			Files: []string{
				"README.md",
				"README.md#Usage",
				"README.md#Quick Start",
			},
		},
		{
			TeachingOrder: 2,
			ChapterNo:     2,
			Title:         "第 2 章：类型契约与状态定义",
			Summary:       "核心类型定义、泛型参数与接口契约",
			Directories:   []string{"src/"},
			Files: []string{
				"src/index.ts#EventType",
				"src/index.ts#Handler",
				"src/index.ts#Emitter",
			},
		},
		{
			TeachingOrder: 3,
			ChapterNo:     3,
			Title:         "第 3 章：核心分发器与业务实现",
			Summary:       "核心分发逻辑、闭包状态与方法流转",
			Directories:   []string{"src/"},
			Files: []string{
				"src/index.ts#mitt",
			},
		},
		{
			TeachingOrder: 4,
			ChapterNo:     4,
			Title:         "第 4 章：API 接口与进阶规范",
			Summary:       "公共 API 详解与方法边界",
			Directories:   []string{},
			Files: []string{
				"README.md#API",
			},
		},
		{
			TeachingOrder: 5,
			ChapterNo:     5,
			Title:         "第 5 章：行为规范与单元测试验证",
			Summary:       "测试用例设计与边界行为验证",
			Directories:   []string{"test/"},
			Files: []string{
				"test/index.test.ts#should default to empty all map",
				"test/index.test.ts#should register handler with on",
			},
		},
	}

	nodes := []GitNode{
		{Path: "README.md", Type: "blob"},
		{Path: "src/index.ts", Type: "blob"},
		{Path: "test/index.test.ts", Type: "blob"},
		{Path: "package.json", Type: "blob"},
	}

	patterns := DefaultPatterns()
	require.NotNil(t, patterns)

	plan := buildCodeRepoPlan(snapshots, nodes, patterns, "developit", "mitt", "zh-CN")
	require.NotNil(t, plan)

	// 1. Verify 5 chapters generated
	assert.Len(t, plan.Chapters, 5)
	assert.Equal(t, "第 1 章：起步与使用指南", plan.Chapters[0].Title)
	assert.Equal(t, "chapters/01.mdx", plan.Chapters[0].Files[0].Path)
	assert.Equal(t, "第 5 章：行为规范与单元测试验证", plan.Chapters[4].Title)
	assert.Equal(t, "chapters/05.mdx", plan.Chapters[4].Files[0].Path)

	// 2. Verify appendixDocs: README.md was included in Chapter 1 with anchors,
	// so it should NOT be duplicated into appendixDocs.
	assert.Empty(t, plan.AppendixDocs, "README.md should not be duplicated as appendixDocs because its base path was covered by snapshots")

	// 3. Verify NavTree contains the 5 chapters
	assert.Len(t, plan.NavTree, 5)
	assert.Equal(t, "chapters/01.mdx", plan.NavTree[0].Path)
	assert.Equal(t, "chapters/05.mdx", plan.NavTree[4].Path)
}

func TestSnapshotsFromOutlineChapters_PreservesAnchors(t *testing.T) {
	chapters := []cognitive.OutlineChapter{
		{
			Name:    "Chapter 1: Types",
			Summary: "Type definitions",
			Files: []cognitive.ChapterFile{
				{Path: "src/index.ts", Anchor: "Emitter", ShortTitle: "Emitter"},
				{Path: "src/index.ts", Anchor: "Handler", ShortTitle: "Handler"},
			},
		},
		{
			Name:    "Chapter 2: Implementation",
			Summary: "Main implementation",
			Files: []cognitive.ChapterFile{
				{Path: "src/index.ts", Anchor: "mitt", ShortTitle: "mitt"},
			},
		},
	}

	snapshots := snapshotsFromOutlineChapters(chapters)
	require.Len(t, snapshots, 2)

	assert.Equal(t, 1, snapshots[0].TeachingOrder)
	assert.Equal(t, "Chapter 1: Types", snapshots[0].Title)
	assert.Equal(t, []string{"src/index.ts#Emitter", "src/index.ts#Handler"}, snapshots[0].Files)
	assert.Equal(t, []string{"src/"}, snapshots[0].Directories)

	assert.Equal(t, 2, snapshots[1].TeachingOrder)
	assert.Equal(t, "Chapter 2: Implementation", snapshots[1].Title)
	assert.Equal(t, []string{"src/index.ts#mitt"}, snapshots[1].Files)
	assert.Equal(t, []string{"src/"}, snapshots[1].Directories)
}

// 摘要按章节身份（标题）继承回归：草稿含文件全空章时被压缩，
// 旧的同位下标配对会把后续章节的摘要全部错挂一格。
func TestAssembleTextPlanSummaryByTitle(t *testing.T) {
	draft := DraftOutlineContent{Outline: []DraftOutlineChapter{
		{Title: "空章（无有效文件）", Summary: "不应继承给任何章", Files: []DraftOutlineFile{{Path: ""}}},
		{Title: "第二章", Summary: "第二章的摘要", Files: []DraftOutlineFile{{Path: "docs/a.md"}}},
		{Title: "第三章", Summary: "第三章的摘要", Files: []DraftOutlineFile{{Path: "docs/b.md"}}},
	}}
	chapters := chaptersFromDraftOutline(draft.Outline)
	require.Len(t, chapters, 2, "空章必须被压缩")
	plan := assembleTextPlan(chapters, nil, draft)
	require.Len(t, plan.Draft.Chapters, 2)
	assert.Equal(t, "第二章的摘要", ptrStr(plan.Draft.Chapters[0].Summary), "压缩后首章摘要不得继承空章之后的错位摘要")
	assert.Equal(t, "第三章的摘要", ptrStr(plan.Draft.Chapters[1].Summary))
}

func ptrStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
