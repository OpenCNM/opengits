package ingest

import (
	"strings"
	"testing"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/stretchr/testify/assert"
)

// fixtureReader 构建内存归档读取闭包（缺失路径返回 false）。
func fixtureReader(files map[string]string) func(string) (string, bool) {
	return func(p string) (string, bool) {
		raw, ok := files[p]
		return raw, ok
	}
}

// enrichFixturePlan 构建带 Draft/NavTree 三面的章节计划夹具
// （镜像 assembleTextPlan 的 1:1 构建形态：章目录节点 + 文件子节点）。
func enrichFixturePlan(chapters []ChapterInput) *ChapterPlan {
	plan := &ChapterPlan{Chapters: chapters}
	for i, ch := range chapters {
		childNodes := make([]*NavNode, 0, len(ch.Files))
		outNodes := make([]OutlineNode, 0, len(ch.Files))
		for _, f := range ch.Files {
			childNodes = append(childNodes, &NavNode{Title: f.ShortTitle, Type: "file", Path: f.Path})
			outNodes = append(outNodes, OutlineNode{Title: f.ShortTitle, NodeType: "file", SourcePath: f.Path})
		}
		plan.NavTree = append(plan.NavTree, &NavNode{Title: ch.Title, Type: "directory", Path: ch.Title, Children: childNodes})
		plan.Draft.Chapters = append(plan.Draft.Chapters, StoredOutlineChapter{
			Title:         ch.Title,
			TeachingOrder: i + 1,
			Nodes:         outNodes,
		})
	}
	return plan
}

// collectPlanTitles 收集计划三面标题（chapters / draft nodes / navtree file nodes）。
func collectPlanTitles(t *testing.T, plan *ChapterPlan) (chapterTitles, draftTitles, navTitles []string) {
	t.Helper()
	for _, ch := range plan.Chapters {
		for _, f := range ch.Files {
			chapterTitles = append(chapterTitles, f.ShortTitle)
		}
	}
	for _, ch := range plan.Draft.Chapters {
		for _, n := range ch.Nodes {
			draftTitles = append(draftTitles, n.Title)
		}
	}
	var walk func(nodes []*NavNode)
	walk = func(nodes []*NavNode) {
		for _, n := range nodes {
			if n.Type == "file" {
				navTitles = append(navTitles, n.Title)
			}
			walk(n.Children)
		}
	}
	walk(plan.NavTree)
	return chapterTitles, draftTitles, navTitles
}

// TestEnrichPlanFileTitles_H1Lift 表驱动验证 H1 摩热：仅「文件名派生标题」的
// markdown 文件被提升为首个 ATX H1；真实标题/非 markdown/读取失败零侵扰。
func TestEnrichPlanFileTitles_H1Lift(t *testing.T) {
	t.Helper()
	tests := []struct {
		name       string
		chapters   []ChapterInput
		files      map[string]string
		wantTitles []string
	}{
		{
			name: "裸文件名 README 摩热为 H1（records 转录场景）",
			chapters: []ChapterInput{{
				Title: "第 6 章：短赛道实验记录解读",
				Files: []cognitive.ChapterFile{
					{Path: "records/2025-01-16_Sub3Min/README.md", ShortTitle: "README"},
					{Path: "records/2025-01-26_BatchSize/README.md", ShortTitle: "README"},
				},
			}},
			files: map[string]string{
				"records/2025-01-16_Sub3Min/README.md":   "# Sub-3 minute record\n\n正文",
				"records/2025-01-26_BatchSize/README.md": "# Batch Size Ablation\n\n正文",
			},
			wantTitles: []string{"Sub-3 minute record", "Batch Size Ablation"},
		},
		{
			name: "LLM 已给真实标题零侵扰",
			chapters: []ChapterInput{{
				Title: "第 1 章：起步",
				Files: []cognitive.ChapterFile{
					{Path: "docs/guide.md", ShortTitle: "配置手册与进阶路径"},
				},
			}},
			files:      map[string]string{"docs/guide.md": "# Installation\n"},
			wantTitles: []string{"配置手册与进阶路径"},
		},
		{
			name: "非 markdown（.py）不摩热",
			chapters: []ChapterInput{{
				Title: "第 3 章：模型结构",
				Files: []cognitive.ChapterFile{
					{Path: "model/attention.py", ShortTitle: "attention"},
				},
			}},
			files:      map[string]string{},
			wantTitles: []string{"attention"},
		},
		{
			name: "归档读取失败保持原状（失效封闭不阻塞）",
			chapters: []ChapterInput{{
				Title: "第 2 章：数据",
				Files: []cognitive.ChapterFile{
					{Path: "data/fineweb.md", ShortTitle: "fineweb"},
				},
			}},
			files:      map[string]string{}, // 归档缺失该文件
			wantTitles: []string{"fineweb"},
		},
		{
			name: "code 口径虚拟章（标题=章标题）天然跳过",
			chapters: []ChapterInput{{
				Title: "第 1 章：仓库全景与认知地图",
				Files: []cognitive.ChapterFile{
					{Path: "chapters/01.mdx", ShortTitle: "第 1 章：仓库全景与认知地图"},
				},
			}},
			files:      map[string]string{"chapters/01.mdx": "# Whatever\n"},
			wantTitles: []string{"第 1 章：仓库全景与认知地图"},
		},
		{
			name: "无 H1 文档保持文件名派生标题",
			chapters: []ChapterInput{{
				Title: "第 4 章：杂项",
				Files: []cognitive.ChapterFile{
					{Path: "notes/plain.md", ShortTitle: "plain"},
				},
			}},
			files:      map[string]string{"notes/plain.md": "没有一级标题的正文\n## 只有 H2"},
			wantTitles: []string{"plain"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plan := enrichFixturePlan(tt.chapters)
			enrichPlanFileTitles(plan, fixtureReader(tt.files))
			chapterTitles, draftTitles, navTitles := collectPlanTitles(t, plan)
			assert.Equal(t, tt.wantTitles, chapterTitles)
			assert.Equal(t, tt.wantTitles, draftTitles, "Draft 节点（侧边栏源）必须同步摩热标题")
			assert.Equal(t, tt.wantTitles, navTitles, "NavTree 文件节点必须同步摩热标题")
		})
	}
}

// TestEnrichPlanFileTitles_CollisionDisambiguation 章内标题碰撞以父目录消歧，
// 跨章同题互不干扰；根目录文件无目录标签时保持原状。
func TestEnrichPlanFileTitles_CollisionDisambiguation(t *testing.T) {
	t.Helper()
	chapters := []ChapterInput{
		{
			Title: "第 6 章：记录",
			Files: []cognitive.ChapterFile{
				{Path: "records/2024-10-29_Optimizers/README.md", ShortTitle: "New Record"},
				{Path: "records/2024-11-04_50Bruns/README.md", ShortTitle: "New Record"},
				{Path: "records/2024-10-29_Optimizers/details.md", ShortTitle: "细节补充"},
			},
		},
		{
			Title: "第 7 章：另一章",
			Files: []cognitive.ChapterFile{
				// 与第 6 章同名但本章唯一，不参与消歧
				{Path: "bench/2024-10-29_Optimizers/README.md", ShortTitle: "New Record"},
			},
		},
		{
			Title: "第 8 章：根部",
			Files: []cognitive.ChapterFile{
				// 根目录文件本章无碰撞，保持原状
				{Path: "README.md", ShortTitle: "New Record"},
				{Path: "intro.md", ShortTitle: "导读"},
			},
		},
	}

	plan := enrichFixturePlan(chapters)
	enrichPlanFileTitles(plan, fixtureReader(nil))

	assert.Equal(t, "New Record · 2024-10-29_Optimizers", plan.Chapters[0].Files[0].ShortTitle)
	assert.Equal(t, "New Record · 2024-11-04_50Bruns", plan.Chapters[0].Files[1].ShortTitle)
	assert.Equal(t, "细节补充", plan.Chapters[0].Files[2].ShortTitle, "无碰撞文件不追加目录标签")
	assert.Equal(t, "New Record", plan.Chapters[1].Files[0].ShortTitle, "跨章同题不消歧")
	assert.Equal(t, "New Record", plan.Chapters[2].Files[0].ShortTitle, "根目录文件本章无碰撞保持原状")

	_, draftTitles, navTitles := collectPlanTitles(t, plan)
	assert.Contains(t, draftTitles, "New Record · 2024-10-29_Optimizers", "消歧结果同步 Draft")
	assert.Contains(t, navTitles, "New Record · 2024-11-04_50Bruns", "消歧结果同步 NavTree")
}

// TestEnrichPlanFileTitles_NilSafety 空计划与空读取闭包零 panic 零副作用。
func TestEnrichPlanFileTitles_NilSafety(t *testing.T) {
	t.Helper()
	enrichPlanFileTitles(nil, fixtureReader(nil))
	plan := &ChapterPlan{}
	enrichPlanFileTitles(plan, nil)
	assert.Empty(t, plan.Chapters)
}

// TestIsDerivedFileTitle 文件名派生标题指纹判定（cleanShortTitle 与
// titleFromFileName 两种兜底输出、大小写与空白归一）。
func TestIsDerivedFileTitle(t *testing.T) {
	t.Helper()
	tests := []struct {
		name     string
		title    string
		path     string
		expected bool
	}{
		{name: "空标题", title: "", path: "a/README.md", expected: true},
		{name: "cleanShortTitle 小写形态", title: "cached fineweb10B", path: "data/cached_fineweb10B.md", expected: true},
		{name: "titleFromFileName 词首大写形态", title: "Cached Fineweb10B", path: "data/cached_fineweb10B.md", expected: true},
		{name: "连字符归一", title: "quick start", path: "docs/quick-start.md", expected: true},
		{name: "教学标题非派生", title: "数据下载与分词流水线", path: "data/fineweb.py.md", expected: false},
		{name: "部分匹配不算派生", title: "fineweb 数据", path: "data/fineweb.md", expected: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, isDerivedFileTitle(tt.title, tt.path))
		})
	}
}

// TestHeadOf_TruncatesAtLineBoundary 头部预算截断必须落在行边界，防止半行伪标题。
func TestHeadOf_TruncatesAtLineBoundary(t *testing.T) {
	t.Helper()
	longLine := "# " + strings.Repeat("x", titleEnrichHeadBytes)
	head := headOf(longLine)
	assert.NotContains(t, head, "x", "唯一超长行应被整体丢弃而非截成伪标题")

	twoLines := "# Title\n" + strings.Repeat("y", titleEnrichHeadBytes)
	assert.Equal(t, "# Title", headOf(twoLines), "保留完整首行")
}
