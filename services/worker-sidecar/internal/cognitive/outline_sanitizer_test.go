package cognitive

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestRenumberChapterTitle_TableDriven 章节单项标题重编号表驱动测试。
func TestRenumberChapterTitle_TableDriven(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		newNo    int
		expected string
	}{
		{
			name:     "chinese full-width colon renumber down",
			input:    "第 4 章：核心实现与架构剖析",
			newNo:    2,
			expected: "第 2 章：核心实现与架构剖析",
		},
		{
			name:     "chinese half-width colon renumber down",
			input:    "第4章:核心实现与架构剖析",
			newNo:    1,
			expected: "第 1 章：核心实现与架构剖析",
		},
		{
			name:     "chinese dash separator renumber",
			input:    "第 5 章 - 架构探索与实战",
			newNo:    3,
			expected: "第 3 章：架构探索与实战",
		},
		{
			name:     "chinese title without subtitle",
			input:    "第 6 章",
			newNo:    2,
			expected: "第 2 章",
		},
		{
			name:     "english title with colon",
			input:    "Chapter 6: Deep Dive Architecture",
			newNo:    2,
			expected: "Chapter 2: Deep Dive Architecture",
		},
		{
			name:     "english lowercase with dash",
			input:    "chapter 1 - intro to engine",
			newNo:    3,
			expected: "Chapter 3: intro to engine",
		},
		{
			name:     "english title without subtitle",
			input:    "CHAPTER 10",
			newNo:    4,
			expected: "Chapter 4",
		},
		{
			name:     "bare title without chapter prefix untouched",
			input:    "核心实现与架构剖析",
			newNo:    5,
			expected: "核心实现与架构剖析",
		},
		{
			name:     "english dot separator renumber",
			input:    "Chapter 1. Introduction",
			newNo:    2,
			expected: "Chapter 2: Introduction",
		},
		{
			name:     "english en-dash separator renumber",
			input:    "Chapter 1 – Getting Started",
			newNo:    2,
			expected: "Chapter 2: Getting Started",
		},
		{
			name:     "english double-hyphen separator renumber",
			input:    "Chapter 1 -- Getting Started",
			newNo:    2,
			expected: "Chapter 2: Getting Started",
		},
		{
			name:     "chinese double em-dash separator renumber",
			input:    "第 1 章——快速上手",
			newNo:    2,
			expected: "第 2 章：快速上手",
		},
		{
			name:     "chinese pause mark separator renumber",
			input:    "第 1 章、快速上手",
			newNo:    2,
			expected: "第 2 章：快速上手",
		},
		{
			name:     "chinese dot separator renumber",
			input:    "第 1 章. 快速上手",
			newNo:    2,
			expected: "第 2 章：快速上手",
		},
		{
			name:     "mixed punctuation and spacing renumber",
			input:    "第 1 章: --- 核心架构剖析",
			newNo:    2,
			expected: "第 2 章：核心架构剖析",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			actual := RenumberChapterTitle(tt.input, tt.newNo)
			assert.Equal(t, tt.expected, actual)
		})
	}
}

// TestRenumberOutlineChapters_TableDriven 章节列表剔除空章后连续重排测试。
func TestRenumberOutlineChapters_TableDriven(t *testing.T) {
	tests := []struct {
		name     string
		input    []OutlineChapter
		expected []string
	}{
		{
			name: "chinese skipped numbers renumbered consecutively",
			input: []OutlineChapter{
				{Name: "第 1 章：环境配置"},
				{Name: "第 2 章：数据契约"},
				{Name: "第 4 章：核心损失函数"},
				{Name: "第 6 章：端到端工作流"},
			},
			expected: []string{
				"第 1 章：环境配置",
				"第 2 章：数据契约",
				"第 3 章：核心损失函数",
				"第 4 章：端到端工作流",
			},
		},
		{
			name: "english skipped numbers renumbered consecutively",
			input: []OutlineChapter{
				{Name: "Chapter 1: Getting Started"},
				{Name: "Chapter 3: Core Concepts"},
				{Name: "Chapter 5: Advanced Optimization"},
			},
			expected: []string{
				"Chapter 1: Getting Started",
				"Chapter 2: Core Concepts",
				"Chapter 3: Advanced Optimization",
			},
		},
		{
			name:     "empty list remains empty",
			input:    []OutlineChapter{},
			expected: []string{},
		},
		{
			name: "single chapter renumbers to 1",
			input: []OutlineChapter{
				{Name: "第 4 章：单章独秀"},
			},
			expected: []string{
				"第 1 章：单章独秀",
			},
		},
		{
			name: "mixed titles preserve bare titles and renumber prefixed",
			input: []OutlineChapter{
				{Name: "项目概览与入门指南"},
				{Name: "第 3 章：核心实现"},
				{Name: "第 5 章：网络通信"},
			},
			expected: []string{
				"项目概览与入门指南",
				"第 2 章：核心实现",
				"第 3 章：网络通信",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out := RenumberOutlineChapters(tt.input)
			actual := make([]string, len(out))
			for i, ch := range out {
				actual[i] = ch.Name
			}
			assert.Equal(t, tt.expected, actual)
		})
	}
}

// TestSanitizeAndIntersectOutline_RenumberChaptersOnPruning 验证在空章被装甲裁除后，最终产出章号自动连续收敛。
func TestSanitizeAndIntersectOutline_RenumberChaptersOnPruning(t *testing.T) {
	nodes := []GitNode{
		{Path: "README.md", Type: "blob"},
		{Path: "core/a.go", Type: "blob"},
		{Path: "net/x.go", Type: "blob"},
	}

	chapters := []OutlineChapter{
		{
			Name: "第 1 章: 起步",
			Files: []ChapterFile{
				{Path: "README.md"},
			},
		},
		{
			Name: "第 2 章: 幻觉章节",
			Files: []ChapterFile{
				{Path: "ghost/nonexistent.go"}, // 真实树中不存在，将被装甲剔除
			},
		},
		{
			Name: "第 3 章: 核心实现",
			Files: []ChapterFile{
				{Path: "core/a.go"},
			},
		},
		{
			Name: "第 4 章: 网络层",
			Files: []ChapterFile{
				{Path: "net/x.go"},
			},
		},
	}

	patterns, _ := LoadIngestPatterns("")
	candidates := []CandidateOutlineFile{
		{Path: "README.md", IsDoc: true},
		{Path: "core/a.go"},
		{Path: "net/x.go"},
	}

	res := SanitizeAndIntersectOutline(chapters, nodes, "", "zh-CN", candidates, patterns)
	require.Len(t, res.Sanitized, 3, "第 2 章因全文件无效被剔除，应剩余 3 章")

	assert.Equal(t, "第 1 章：起步", res.Sanitized[0].Name)
	assert.Equal(t, "第 2 章：核心实现", res.Sanitized[1].Name, "原第 3 章应自动连续归一为第 2 章")
	assert.Equal(t, "第 3 章：网络层", res.Sanitized[2].Name, "原第 4 章应自动连续归一为第 3 章")
}

// TestCleanChapterTitle 验证消除章节标题中模型泄露的物理文件名和扩展名（File ≠ Cognitive Unit）。
func TestCleanChapterTitle(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "DPO 训练脚本 train.py",
			input:    "第 1 章: 项目全景与训练入口 train.py",
			expected: "第 1 章：项目全景与训练入口",
		},
		{
			name:     "工具集 utils.py",
			input:    "第 2 章: 分布式基础设施 utils.py",
			expected: "第 2 章：分布式基础设施",
		},
		{
			name:     "偏好数据 preference_datasets.py",
			input:    "第 3 章: 偏好数据管线 preference_datasets.py",
			expected: "第 3 章：偏好数据管线",
		},
		{
			name:     "Go 类型文件 types.go",
			input:    "第 2 章：领域类型与配置模型 types.go",
			expected: "第 2 章：领域类型与配置模型",
		},
		{
			name:     "Go 请求文件 request.go",
			input:    "第 5 章：HTTP 协议请求引擎 request.go",
			expected: "第 5 章：HTTP 协议请求引擎",
		},
		{
			name:     "仅有文件名的极端情况 train.py",
			input:    "第 1 章: train.py",
			expected: "第 1 章：train",
		},
		{
			name:     "保护专有名词 Node.js",
			input:    "第 1 章: Node.js 异步运行时",
			expected: "第 1 章：Node.js 异步运行时",
		},
		{
			name:     "英文标题清理 train.py",
			input:    "Chapter 1: Training Entrypoint train.py",
			expected: "Chapter 1: Training Entrypoint",
		},
		{
			name:     "括号包裹的文件名 (train.py)",
			input:    "第 1 章: 项目入口 (train.py)",
			expected: "第 1 章：项目入口",
		},
		{
			name:     "剥除抽象门面契约与末尾括号罗列符号",
			input:    "第 1 章: 门面契约与域名匹配体系 (Domain、NewDomain 与 matcherset)",
			expected: "第 1 章：域名匹配体系",
		},
		{
			name:     "剥除网络领域模型前缀与括号符号",
			input:    "第 2 章: 网络领域模型: 地址、端口与多缓冲区 (Address、Port、multi_buffer)",
			expected: "第 2 章：地址、端口与多缓冲区",
		},
		{
			name:     "剥除中文连词末尾括号符号",
			input:    "第 3 章: 信号生命周期与序列化基础 (Done、Instance 与字符串工具)",
			expected: "第 3 章：信号生命周期与序列化基础",
		},
		{
			name:     "剥除核心执行引擎前缀与括号符号",
			input:    "第 4 章: 核心执行引擎: 命令框架与错误处理管线 (Command、errors)",
			expected: "第 4 章：命令框架与错误处理管线",
		},
		{
			name:     "英文门面契约前缀与括号符号清洗",
			input:    "Chapter 1: Interface & Facade: Routing and Domain Matching (Domain, NewDomain and matcherset)",
			expected: "Chapter 1: Routing and Domain Matching",
		},
		{
			name:     "英文核心引擎前缀与括号符号清洗",
			input:    "Chapter 2: Core Engine: Command Framework and Errors (Command, errors)",
			expected: "Chapter 2: Command Framework and Errors",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, CleanChapterTitle(tt.input))
		})
	}
}

// TestSanitizeAndIntersectOutline_RunRecordDumpGate 验证运行记录转储
// （UUID/散列命名 .txt、.log）被装甲挡截，不得成为一等大纲节点；
// 人类可读的 requirements.txt / README.md 不受影响。
func TestSanitizeAndIntersectOutline_RunRecordDumpGate(t *testing.T) {
	nodes := []GitNode{
		{Path: "records/2025-01-16_Sub3Min/README.md", Type: "blob"},
		{Path: "records/results/20260506_trustlight/requirements.txt", Type: "blob"},
		{Path: "records/results/20260501_contra_muon/08cd60f9-99e2-4e28-b1ac-19136dd42a05.txt", Type: "blob"},
		{Path: "logs/train.log", Type: "blob"},
	}

	chapters := []OutlineChapter{
		{
			Name: "第 8 章：优化赛道参数调优方法",
			Files: []ChapterFile{
				{Path: "records/2025-01-16_Sub3Min/README.md"},
				{Path: "records/results/20260506_trustlight/requirements.txt"},
				{Path: "records/results/20260501_contra_muon/08cd60f9-99e2-4e28-b1ac-19136dd42a05.txt"},
				{Path: "logs/train.log"},
			},
		},
	}

	patterns, _ := LoadIngestPatterns("")
	candidates := []CandidateOutlineFile{
		{Path: "records/2025-01-16_Sub3Min/README.md", IsDoc: true},
		{Path: "records/results/20260506_trustlight/requirements.txt", IsDoc: true},
		{Path: "records/results/20260501_contra_muon/08cd60f9-99e2-4e28-b1ac-19136dd42a05.txt", IsDoc: true},
		{Path: "logs/train.log", IsDoc: true},
	}

	res := SanitizeAndIntersectOutline(chapters, nodes, "", "zh-CN", candidates, patterns)
	require.Len(t, res.Sanitized, 1, "仅剩 1 章")
	require.Len(t, res.Sanitized[0].Files, 2, "UUID 转储与 .log 被挡截，README 与 requirements 保留")

	gotPaths := []string{res.Sanitized[0].Files[0].Path, res.Sanitized[0].Files[1].Path}
	assert.Contains(t, gotPaths, "records/2025-01-16_Sub3Min/README.md")
	assert.Contains(t, gotPaths, "records/results/20260506_trustlight/requirements.txt")
	assert.NotContains(t, gotPaths, "records/results/20260501_contra_muon/08cd60f9-99e2-4e28-b1ac-19136dd42a05.txt")
	assert.NotContains(t, gotPaths, "logs/train.log")
}

func TestCognitiveLoadIngestPatternsFailClosed(t *testing.T) {
	t.Run("空路径返回原生预置", func(t *testing.T) {
		p, err := LoadIngestPatterns("")
		require.NoError(t, err)
		require.NotNil(t, p)
		assert.True(t, p.IsCodeFile("server.ts"))
		assert.True(t, p.IsDocFile("readme.md"))
	})

	t.Run("显式缺失路径坚决报错", func(t *testing.T) {
		badPath := filepath.Join(t.TempDir(), "nonexistent-patterns.json")
		p, err := LoadIngestPatterns(badPath)
		require.Error(t, err)
		assert.Nil(t, p)
		assert.Contains(t, err.Error(), "LoadIngestPatterns: read")
	})
}

// buildReadmeBackfillFixture 构造 README 保底豁免测试的统一夹具：
// README 真实存在但默认未入纲，另含一个幻觉路径章用于锁定其余装甲行为。
func buildReadmeBackfillFixture(t *testing.T, readmeInOutline bool) ([]OutlineChapter, []GitNode, []CandidateOutlineFile, Patterns) {
	t.Helper()

	nodes := []GitNode{
		{Path: "README.md", Type: "blob"},
		{Path: "core/a.go", Type: "blob"},
		{Path: "net/x.go", Type: "blob"},
	}

	chapterFiles := []ChapterFile{{Path: "core/a.go"}}
	chapterName := "第 1 章: 核心实现"
	if readmeInOutline {
		chapterFiles = []ChapterFile{{Path: "README.md"}, {Path: "core/a.go"}}
		chapterName = "第 1 章: 总览与核心实现"
	}
	chapters := []OutlineChapter{
		{Name: chapterName, Files: chapterFiles},
		{
			Name: "第 2 章: 幻觉章节",
			Files: []ChapterFile{
				{Path: "ghost/nonexistent.go"}, // 真实树中不存在，将被装甲剔除
			},
		},
	}

	patterns, err := LoadIngestPatterns("")
	require.NoError(t, err)

	candidates := []CandidateOutlineFile{
		{Path: "README.md", IsDoc: true},
		{Path: "core/a.go"},
		{Path: "net/x.go"},
	}
	return chapters, nodes, candidates, patterns
}

// TestSanitizeAndIntersectOutline_ReadmeBackfillOption 验证 README 保底的可选豁免：
// 默认不传 opts 时保底仍生效（零行为漂移）；传 WithoutReadmeBackfill 时不再插入，
// 且路径求交、幻觉剔除、章号重编号等其余装甲行为完全不变。
func TestSanitizeAndIntersectOutline_ReadmeBackfillOption(t *testing.T) {
	tests := []struct {
		name            string
		readmeInOutline bool
		opts            []SanitizeOption
		expectFiles     []string
		expectFirst     string
	}{
		{
			name:            "README 未入纲且不传 opts：保底仍生效并前插第一章首位",
			readmeInOutline: false,
			opts:            nil,
			expectFiles:     []string{"README.md", "core/a.go"},
			expectFirst:     "第 1 章：核心实现",
		},
		{
			name:            "README 未入纲且传 WithoutReadmeBackfill：不再插入，幻觉路径仍剔除",
			readmeInOutline: false,
			opts:            []SanitizeOption{WithoutReadmeBackfill()},
			expectFiles:     []string{"core/a.go"},
			expectFirst:     "第 1 章：核心实现",
		},
		{
			name:            "README 已显式入纲且不传 opts：位置不变且不重复插入",
			readmeInOutline: true,
			opts:            nil,
			expectFiles:     []string{"README.md", "core/a.go"},
			expectFirst:     "第 1 章：总览与核心实现",
		},
		{
			name:            "README 已显式入纲且传 WithoutReadmeBackfill：与默认产出完全一致",
			readmeInOutline: true,
			opts:            []SanitizeOption{WithoutReadmeBackfill()},
			expectFiles:     []string{"README.md", "core/a.go"},
			expectFirst:     "第 1 章：总览与核心实现",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chapters, nodes, candidates, patterns := buildReadmeBackfillFixture(t, tt.readmeInOutline)
			res := SanitizeAndIntersectOutline(chapters, nodes, "", "zh-CN", candidates, patterns, tt.opts...)

			require.Len(t, res.Sanitized, 1, "幻觉章被剔除后仅剩 1 章")
			assert.Equal(t, tt.expectFirst, res.Sanitized[0].Name, "幸存章章号应连续归一")

			gotPaths := make([]string, len(res.Sanitized[0].Files))
			for i, f := range res.Sanitized[0].Files {
				gotPaths[i] = f.Path
			}
			assert.Equal(t, tt.expectFiles, gotPaths)

			assert.Contains(t, res.DroppedPaths, "ghost/nonexistent.go", "幻觉路径应始终被装甲剔除")
		})
	}

	t.Run("默认保底插入携带中文短标题", func(t *testing.T) {
		chapters, nodes, candidates, patterns := buildReadmeBackfillFixture(t, false)
		res := SanitizeAndIntersectOutline(chapters, nodes, "", "zh-CN", candidates, patterns)
		require.Len(t, res.Sanitized, 1)
		require.NotEmpty(t, res.Sanitized[0].Files)
		assert.Equal(t, "项目概览与入门指南", res.Sanitized[0].Files[0].ShortTitle)
	})
}
