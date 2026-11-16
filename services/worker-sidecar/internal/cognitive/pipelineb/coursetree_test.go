package pipelineb

import (
	"testing"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildCourseTree(t *testing.T) {
	tests := []struct {
		name     string
		repoName string
		plan     []PlanChapter
		chapters []cognitive.OutlineChapter
		checkFn  func(t *testing.T, tree *CourseTree)
	}{
		{
			name:     "标准 3 模块保序：模块 1 归入 OverviewCourse，第 8 章归入模块 3",
			repoName: "test-repo",
			plan: []PlanChapter{
				{ModuleTitle: "模块 1: 架构全景与环境准备", Name: "第 1 章: 项目总览与环境搭建", Summary: "S1", TargetPaths: []string{"README.md"}, Phase: "入门"},
				{ModuleTitle: "模块 1: 架构全景与环境准备", Name: "第 2 章: 核心抽象与基础能力", Summary: "S2", TargetPaths: []string{"core"}, Phase: "入门"},
				{ModuleTitle: "模块 2: 核心协议与传输架构", Name: "第 3 章: 通用工具与基础设施", Summary: "S3", TargetPaths: []string{"common"}, Phase: "进阶"},
				{ModuleTitle: "模块 2: 核心协议与传输架构", Name: "第 4 章: 入口程序与生命周期管理", Summary: "S4", TargetPaths: []string{"main"}, Phase: "进阶"},
				{ModuleTitle: "模块 2: 核心协议与传输架构", Name: "第 5 章: 传输层架构与协议栈", Summary: "S5", TargetPaths: []string{"transport"}, Phase: "进阶"},
				{ModuleTitle: "模块 2: 核心协议与传输架构", Name: "第 6 章: 代理协议与出站入站实现", Summary: "S6", TargetPaths: []string{"proxy"}, Phase: "进阶"},
				{ModuleTitle: "模块 3: 应用扩展与综合实战", Name: "第 7 章: 应用层功能与扩展模块", Summary: "S7", TargetPaths: []string{"app"}, Phase: "实战"},
				{ModuleTitle: "模块 3: 应用扩展与综合实战", Name: "第 8 章: 综合实战与二次开发指南", Summary: "S8", TargetPaths: []string{"main"}, Phase: "实战", DrillDown: false},
			},
			chapters: []cognitive.OutlineChapter{
				{Name: "第 1 章: 项目总览与环境搭建", Summary: "S1", Files: []cognitive.ChapterFile{{Path: "README.md"}}},
				{Name: "第 2 章: 核心抽象与基础能力", Summary: "S2", Files: []cognitive.ChapterFile{{Path: "core/core.go"}}},
				{Name: "第 3 章: 通用工具与基础设施", Summary: "S3", Files: []cognitive.ChapterFile{{Path: "common/util.go"}}},
				{Name: "第 4 章: 入口程序与生命周期管理", Summary: "S4", Files: []cognitive.ChapterFile{{Path: "main/main.go"}}},
				{Name: "第 5 章: 传输层架构与协议栈", Summary: "S5", Files: []cognitive.ChapterFile{{Path: "transport/pipe.go"}}},
				{Name: "第 6 章: 代理协议与出站入站实现", Summary: "S6", Files: []cognitive.ChapterFile{{Path: "proxy/inbound.go"}}},
				{Name: "第 7 章: 应用层功能与扩展模块", Summary: "S7", Files: []cognitive.ChapterFile{{Path: "app/log.go"}}},
				{Name: "第 8 章: 综合实战与二次开发指南", Summary: "S8", Files: []cognitive.ChapterFile{{Path: "main/app.go"}}},
			},
			checkFn: func(t *testing.T, tree *CourseTree) {
				t.Helper()
				require.NotNil(t, tree.OverviewCourse, "OverviewCourse 不能为空")
				assert.Equal(t, "模块 1: 架构全景与环境准备", tree.OverviewCourse.Name)
				require.Len(t, tree.OverviewCourse.Chapters, 2)
				assert.Equal(t, "第 1 章: 项目总览与环境搭建", tree.OverviewCourse.Chapters[0].Name)
				assert.Equal(t, "模块 1: 架构全景与环境准备", tree.OverviewCourse.Chapters[0].PartTitle)
				assert.Equal(t, "第 2 章: 核心抽象与基础能力", tree.OverviewCourse.Chapters[1].Name)
				assert.Equal(t, "模块 1: 架构全景与环境准备", tree.OverviewCourse.Chapters[1].PartTitle)

				require.Len(t, tree.SubCourses, 2, "应包含模块 2 与模块 3 两个子课")

				// 模块 2
				assert.Equal(t, "模块 2: 核心协议与传输架构", tree.SubCourses[0].Name)
				require.Len(t, tree.SubCourses[0].Chapters, 4)
				assert.Equal(t, "第 3 章: 通用工具与基础设施", tree.SubCourses[0].Chapters[0].Name)
				assert.Equal(t, "第 6 章: 代理协议与出站入站实现", tree.SubCourses[0].Chapters[3].Name)

				// 模块 3：关键断言，第 8 章绝不进入第一组或 OverviewCourse
				assert.Equal(t, "模块 3: 应用扩展与综合实战", tree.SubCourses[1].Name)
				require.Len(t, tree.SubCourses[1].Chapters, 2)
				assert.Equal(t, "第 7 章: 应用层功能与扩展模块", tree.SubCourses[1].Chapters[0].Name)
				assert.Equal(t, "第 8 章: 综合实战与二次开发指南", tree.SubCourses[1].Chapters[1].Name)
				assert.Equal(t, "模块 3: 应用扩展与综合实战", tree.SubCourses[1].Chapters[1].PartTitle)
			},
		},
		{
			name:     "抗倒错测试：子课严格教学顺序，严禁按章节数量倒序排布",
			repoName: "sort-order-repo",
			plan: []PlanChapter{
				{ModuleTitle: "模块 1: 基础", Name: "第 1 章: 入门", Phase: "入门"},
				{ModuleTitle: "模块 2: 核心组件", Name: "第 2 章: 核心", Phase: "进阶"},
				{ModuleTitle: "模块 3: 扩展生态", Name: "第 3 章: 插件 A", Phase: "实战"},
				{ModuleTitle: "模块 3: 扩展生态", Name: "第 4 章: 插件 B", Phase: "实战"},
				{ModuleTitle: "模块 3: 扩展生态", Name: "第 5 章: 插件 C", Phase: "实战"},
			},
			chapters: []cognitive.OutlineChapter{
				{Name: "第 1 章: 入门", Files: []cognitive.ChapterFile{{Path: "a.go"}}},
				{Name: "第 2 章: 核心", Files: []cognitive.ChapterFile{{Path: "b.go"}}},
				{Name: "第 3 章: 插件 A", Files: []cognitive.ChapterFile{{Path: "c.go"}}},
				{Name: "第 4 章: 插件 B", Files: []cognitive.ChapterFile{{Path: "d.go"}}},
				{Name: "第 5 章: 插件 C", Files: []cognitive.ChapterFile{{Path: "e.go"}}},
			},
			checkFn: func(t *testing.T, tree *CourseTree) {
				t.Helper()
				require.Len(t, tree.SubCourses, 2)
				// 模块 2 仅 1 章，模块 3 有 3 章；模块 2 必须在前，绝不能被 sort.SliceStable 颠倒
				assert.Equal(t, "模块 2: 核心组件", tree.SubCourses[0].Name)
				assert.Equal(t, "模块 3: 扩展生态", tree.SubCourses[1].Name)
			},
		},
		{
			name:     "无 ModuleTitle 兜底：基于 Phase 状态机推导模块",
			repoName: "fallback-phase-repo",
			plan: []PlanChapter{
				{Name: "第 1 章: 概览", Phase: "入门"},
				{Name: "第 2 章: 快速上手", Phase: "入门"},
				{Name: "第 3 章: 架构深潜", Phase: "进阶"},
				{Name: "第 4 章: 业务开发", Phase: "实战"},
			},
			chapters: []cognitive.OutlineChapter{
				{Name: "第 1 章: 概览", Files: []cognitive.ChapterFile{{Path: "a.go"}}},
				{Name: "第 2 章: 快速上手", Files: []cognitive.ChapterFile{{Path: "b.go"}}},
				{Name: "第 3 章: 架构深潜", Files: []cognitive.ChapterFile{{Path: "c.go"}}},
				{Name: "第 4 章: 业务开发", Files: []cognitive.ChapterFile{{Path: "d.go"}}},
			},
			checkFn: func(t *testing.T, tree *CourseTree) {
				t.Helper()
				require.NotNil(t, tree.OverviewCourse)
				assert.Equal(t, "模块 1: 架构全景与基础上手", tree.OverviewCourse.Name)
				require.Len(t, tree.OverviewCourse.Chapters, 2)
				assert.Equal(t, "第 1 章: 概览", tree.OverviewCourse.Chapters[0].Name)
				assert.Equal(t, "第 2 章: 快速上手", tree.OverviewCourse.Chapters[1].Name)

				require.Len(t, tree.SubCourses, 2)
				assert.Equal(t, "模块 2: 核心机制与架构深入", tree.SubCourses[0].Name)
				require.Len(t, tree.SubCourses[0].Chapters, 1)
				assert.Equal(t, "模块 3: 扩展功能与综合实战", tree.SubCourses[1].Name)
				require.Len(t, tree.SubCourses[1].Chapters, 1)
			},
		},
		{
			name:     "多根路径防碎裂与按分区聚集：README 与根目录合并进 OverviewCourse，同分区合并进同一子课",
			repoName: "targetpaths-phase-repo",
			plan: []PlanChapter{
				{Name: "第 1 章: 概览", Phase: "入门", TargetPaths: []string{"README.md"}},
				{Name: "第 2 章: 快速上手", Phase: "入门", TargetPaths: []string{"."}},
				{Name: "第 3 章: 架构深潜", Phase: "进阶", TargetPaths: []string{"core"}},
				{Name: "第 4 章: 核心通信", Phase: "进阶", TargetPaths: []string{"core"}},
				{Name: "第 5 章: 业务开发", Phase: "实战", TargetPaths: []string{"app"}},
				{Name: "第 6 章: 综合实操", Phase: "实战", TargetPaths: []string{"app"}},
			},
			chapters: []cognitive.OutlineChapter{
				{Name: "第 1 章: 概览", Files: []cognitive.ChapterFile{{Path: "README.md"}}},
				{Name: "第 2 章: 快速上手", Files: []cognitive.ChapterFile{{Path: "main.go"}}},
				{Name: "第 3 章: 架构深潜", Files: []cognitive.ChapterFile{{Path: "core/b.go"}}},
				{Name: "第 4 章: 核心通信", Files: []cognitive.ChapterFile{{Path: "core/c.go"}}},
				{Name: "第 5 章: 业务开发", Files: []cognitive.ChapterFile{{Path: "app/d.go"}}},
				{Name: "第 6 章: 综合实操", Files: []cognitive.ChapterFile{{Path: "app/e.go"}}},
			},
			checkFn: func(t *testing.T, tree *CourseTree) {
				t.Helper()
				require.NotNil(t, tree.OverviewCourse)
				assert.Equal(t, "模块 1: 架构全景与基础上手", tree.OverviewCourse.Name)
				require.Len(t, tree.OverviewCourse.Chapters, 2)
				assert.Equal(t, "第 1 章: 概览", tree.OverviewCourse.Chapters[0].Name)
				assert.Equal(t, "第 2 章: 快速上手", tree.OverviewCourse.Chapters[1].Name)

				require.Len(t, tree.SubCourses, 2)
				assert.Equal(t, "模块 2: core 核心实现", tree.SubCourses[0].Name)
				require.Len(t, tree.SubCourses[0].Chapters, 2)
				assert.Equal(t, "第 3 章: 架构深潜", tree.SubCourses[0].Chapters[0].Name)
				assert.Equal(t, "第 4 章: 核心通信", tree.SubCourses[0].Chapters[1].Name)

				assert.Equal(t, "模块 3: app 核心实现", tree.SubCourses[1].Name)
				require.Len(t, tree.SubCourses[1].Chapters, 2)
				assert.Equal(t, "第 5 章: 业务开发", tree.SubCourses[1].Chapters[0].Name)
				assert.Equal(t, "第 6 章: 综合实操", tree.SubCourses[1].Chapters[1].Name)
			},
		},
		{
			name:     "非连续模块名输入防护：保持严格章节时序，绝不将后序章节回提到首部",
			repoName: "non-contiguous-repo",
			plan: []PlanChapter{
				{ModuleTitle: "模块 1: 基础", Name: "第 1 章: 入门 A"},
				{ModuleTitle: "模块 2: 核心", Name: "第 2 章: 核心 B"},
				{ModuleTitle: "模块 2: 核心", Name: "第 3 章: 核心 C"},
				{ModuleTitle: "模块 1: 基础", Name: "第 4 章: 入门 D (非连续)"},
			},
			chapters: []cognitive.OutlineChapter{
				{Name: "第 1 章: 入门 A", Files: []cognitive.ChapterFile{{Path: "a.go"}}},
				{Name: "第 2 章: 核心 B", Files: []cognitive.ChapterFile{{Path: "b.go"}}},
				{Name: "第 3 章: 核心 C", Files: []cognitive.ChapterFile{{Path: "c.go"}}},
				{Name: "第 4 章: 入门 D (非连续)", Files: []cognitive.ChapterFile{{Path: "d.go"}}},
			},
			checkFn: func(t *testing.T, tree *CourseTree) {
				t.Helper()
				require.NotNil(t, tree.OverviewCourse)
				assert.Equal(t, "模块 1: 基础", tree.OverviewCourse.Name)
				require.Len(t, tree.OverviewCourse.Chapters, 1, "第 4 章绝不能逆向插入 OverviewCourse")
				assert.Equal(t, "第 1 章: 入门 A", tree.OverviewCourse.Chapters[0].Name)

				require.Len(t, tree.SubCourses, 2)
				assert.Equal(t, "模块 2: 核心", tree.SubCourses[0].Name)
				require.Len(t, tree.SubCourses[0].Chapters, 2)
				assert.Equal(t, "第 2 章: 核心 B", tree.SubCourses[0].Chapters[0].Name)
				assert.Equal(t, "第 3 章: 核心 C", tree.SubCourses[0].Chapters[1].Name)

				assert.Equal(t, "模块 1: 基础 (续)", tree.SubCourses[1].Name)
				require.Len(t, tree.SubCourses[1].Chapters, 1)
				assert.Equal(t, "第 4 章: 入门 D (非连续)", tree.SubCourses[1].Chapters[0].Name)
			},
		},
		{
			name:     "英文 Phase 国际化兜底：返回 Module 1..3 英文标题",
			repoName: "en-phase-repo",
			plan: []PlanChapter{
				{Name: "Chapter 1: Intro", Phase: "intro"},
				{Name: "Chapter 2: Advanced", Phase: "advanced"},
				{Name: "Chapter 3: Practice", Phase: "practice"},
			},
			chapters: []cognitive.OutlineChapter{
				{Name: "Chapter 1: Intro", Files: []cognitive.ChapterFile{{Path: "a.go"}}},
				{Name: "Chapter 2: Advanced", Files: []cognitive.ChapterFile{{Path: "b.go"}}},
				{Name: "Chapter 3: Practice", Files: []cognitive.ChapterFile{{Path: "c.go"}}},
			},
			checkFn: func(t *testing.T, tree *CourseTree) {
				t.Helper()
				require.NotNil(t, tree.OverviewCourse)
				assert.Equal(t, "Module 1: Overview & Fundamentals", tree.OverviewCourse.Name)
				require.Len(t, tree.SubCourses, 2)
				assert.Equal(t, "Module 2: Core Mechanisms & Architecture", tree.SubCourses[0].Name)
				assert.Equal(t, "Module 3: Extensions & Real-world Practice", tree.SubCourses[1].Name)
			},
		},
		{
			name:     "全空无元数据兜底：全部归入模块 1 基础总览",
			repoName: "fallback-empty-repo",
			plan:     nil,
			chapters: []cognitive.OutlineChapter{
				{Name: "第 1 章: 简单章 A", Files: []cognitive.ChapterFile{{Path: "a.go"}}},
				{Name: "第 2 章: 简单章 B", Files: []cognitive.ChapterFile{{Path: "b.go"}}},
			},
			checkFn: func(t *testing.T, tree *CourseTree) {
				t.Helper()
				require.NotNil(t, tree.OverviewCourse)
				assert.Equal(t, "模块 1: 基础总览", tree.OverviewCourse.Name)
				require.Len(t, tree.OverviewCourse.Chapters, 2)
				assert.Empty(t, tree.SubCourses)
			},
		},
		{
			name:     "零章节边界安全：空输入不崩溃",
			repoName: "empty-repo",
			plan:     nil,
			chapters: nil,
			checkFn: func(t *testing.T, tree *CourseTree) {
				t.Helper()
				assert.Nil(t, tree.OverviewCourse)
				assert.Empty(t, tree.SubCourses)
			},
		},
		{
			name:     "章节名称阶段后缀清洗：自动剔除 (入门)/(进阶)/(实战) 后缀",
			repoName: "test-repo",
			plan: []PlanChapter{
				{ModuleTitle: "模块 1: 架构全景与快速上手", Name: "第 1 章:全景与上手(入门)", TargetPaths: []string{"README.md"}, Phase: "入门"},
				{ModuleTitle: "模块 2: 核心子系统实现", Name: "第 2 章:transport(实战)", TargetPaths: []string{"transport"}, Phase: "实战"},
				{ModuleTitle: "模块 2: 核心子系统实现", Name: "第 3 章: proxy （进阶）", TargetPaths: []string{"proxy"}, Phase: "进阶"},
			},
			chapters: []cognitive.OutlineChapter{
				{Name: "第 1 章:全景与上手(入门)", Files: []cognitive.ChapterFile{{Path: "README.md"}}},
				{Name: "第 2 章:transport(实战)", Files: []cognitive.ChapterFile{{Path: "transport/pipe.go"}}},
				{Name: "第 3 章: proxy （进阶）", Files: []cognitive.ChapterFile{{Path: "proxy/inbound.go"}}},
			},
			checkFn: func(t *testing.T, tree *CourseTree) {
				t.Helper()
				require.NotNil(t, tree.OverviewCourse)
				assert.Equal(t, "第 1 章:全景与上手", tree.OverviewCourse.Chapters[0].Name)
				require.Len(t, tree.SubCourses, 1)
				assert.Equal(t, "第 2 章:transport", tree.SubCourses[0].Chapters[0].Name)
				assert.Equal(t, "第 3 章: proxy", tree.SubCourses[0].Chapters[1].Name)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := &DrillResult{
				Plan:     tt.plan,
				Chapters: tt.chapters,
			}
			tree := BuildCourseTree(tt.repoName, res, &RepoTreeNode{Name: tt.repoName})
			tt.checkFn(t, tree)
		})
	}
}
