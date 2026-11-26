package pipelineb

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func covSpecs() []SubsystemSpec {
	return []SubsystemSpec{
		{ID: "sub_alpha", Name: "alpha", Prefix: "packages/alpha", FileCount: 3, EstLOC: 1200},
		{ID: "sub_beta", Name: "beta", Prefix: "packages/beta", FileCount: 1, EstLOC: 400},
		{ID: "sub_gamma", Name: "gamma", Prefix: "packages/gamma", FileCount: 2, EstLOC: 8400},
	}
}

func TestEvaluateSubsystemCoverage_TableDriven(t *testing.T) {
	gammaChapter := []cognitive.OutlineChapter{
		{Name: "gamma 章", Files: []cognitive.ChapterFile{{Path: "packages/gamma/src/index.ts"}}},
	}

	tests := []struct {
		name          string
		subsystems    []SubsystemSpec
		chapters      []cognitive.OutlineChapter
		prefix        string
		teachingDepth string
		customPrompt  string
		wantNil       bool
		wantMissing   []string
	}{
		{
			name:        "EstLOC 占比恰好 12% 且 0 章节覆盖 -> 触发（边界含等号）",
			subsystems:  covSpecs(),
			chapters:    gammaChapter,
			wantMissing: []string{"alpha"},
		},
		{
			name: "EstLOC 占比 11.99% -> 不触发",
			subsystems: func() []SubsystemSpec {
				s := covSpecs()
				s[0].EstLOC = 1199
				return s
			}(),
			chapters: gammaChapter,
			wantNil:  true,
		},
		{
			name:       "已覆盖的子系统不算缺失",
			subsystems: covSpecs(),
			chapters: []cognitive.OutlineChapter{
				{Files: []cognitive.ChapterFile{
					{Path: "packages/alpha/src/index.ts"},
					{Path: "packages/gamma/src/index.ts"},
				}},
			},
			wantNil: true,
		},
		{
			name: "辅助目录豁免（即便占比极高且未覆盖）",
			subsystems: func() []SubsystemSpec {
				s := covSpecs()
				s[0].IsAuxiliary = true
				return s
			}(),
			chapters: gammaChapter,
			wantNil:  true,
		},
		{
			name:         "customPrompt 非空 -> 返回 nil（用户聚焦意图主权，仅记录指标）",
			subsystems:   covSpecs(),
			chapters:     gammaChapter,
			customPrompt: "聚焦网络层",
			wantNil:      true,
		},
		{
			name:          "teachingDepth == overview -> 返回 nil（跳过强制重规划）",
			subsystems:    covSpecs(),
			chapters:      gammaChapter,
			teachingDepth: TeachingDepthOverview,
			wantNil:       true,
		},
		{
			name:        "prefix 作用域聚焦：作用域外缺失不进反馈，作用域内缺失触发",
			subsystems:  covSpecs(),
			chapters:    gammaChapter,
			prefix:      "packages/beta",
			wantMissing: []string{"beta"},
		},
		{
			name:       "prefix 作用域内已覆盖 -> nil",
			subsystems: covSpecs(),
			chapters:   gammaChapter,
			prefix:     "packages/gamma",
			wantNil:    true,
		},
		{
			name:        "全仓作用域：仅 >= 12% 的未覆盖核心进缺失清单",
			subsystems:  covSpecs(),
			chapters:    gammaChapter,
			wantMissing: []string{"alpha"},
		},
		{
			name:     "空子系统清单 -> nil",
			chapters: gammaChapter,
			wantNil:  true,
		},
		{
			name:       "章节均不命中子系统 -> 缺失按 EstLOC 降序全量上报",
			subsystems: covSpecs(),
			chapters: []cognitive.OutlineChapter{
				{Name: "游离章", Files: []cognitive.ChapterFile{{Path: "loose/root.go"}}},
			},
			wantMissing: []string{"gamma", "alpha"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fb := evaluateSubsystemCoverage(tt.subsystems, tt.chapters, tt.prefix, tt.teachingDepth, tt.customPrompt)
			if tt.wantNil {
				assert.Nil(t, fb)
				return
			}
			require.NotNil(t, fb)
			assert.Equal(t, tt.wantMissing, fb.MissingSubsystems)
			assert.NotEmpty(t, fb.Feedback, "缺失时必须携带可回流 outline_map_v1 的修订指令")
		})
	}
}

func TestEvaluateSubsystemCoverageRecommendations(t *testing.T) {
	files := []FileMap{
		{Path: "packages/alpha/src/util.ts", LOC: 30},
		{Path: "packages/alpha/src/engine.ts", LOC: 500, Hotness: 70},
		{Path: "packages/alpha/src/index.ts", LOC: 60, Hotness: 20},
		{Path: "packages/alpha/src/worker_test.go", LOC: 400, Hotness: 99, IsTest: true},
		{Path: "packages/beta/src/index.ts", LOC: 80, Hotness: 10},
	}
	specs := []SubsystemSpec{{Name: "alpha", Prefix: "packages/alpha", EstLOC: 1200}}
	chapters := []cognitive.OutlineChapter{{Name: "别处", Files: []cognitive.ChapterFile{{Path: "packages/beta/src/index.ts"}}}}

	fb := evaluateSubsystemCoverageFromFiles(specs, chapters, files, "", TeachingDepthStandard, "")
	require.NotNil(t, fb)
	assert.Equal(t, []string{"alpha"}, fb.MissingSubsystems)
	assert.Equal(t, []string{
		"packages/alpha/src/engine.ts",
		"packages/alpha/src/index.ts",
		"packages/alpha/src/util.ts",
	}, fb.RecommendedFiles["packages/alpha"])
	assert.Contains(t, fb.Feedback, "packages/alpha/src/engine.ts", "修订指令必须内联推荐核心入口文件")
}

type coverageFakeModel struct {
	mu           sync.Mutex
	calls        []ModelRequest
	first        string
	revision     string
	depth        string
	customPrompt string
}

func (f *coverageFakeModel) Complete(_ context.Context, req ModelRequest) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, req)
	if len(f.calls) == 1 {
		return f.first, nil
	}
	return f.revision, nil
}

func (f *coverageFakeModel) TeachingContext() (string, string) {
	return f.depth, f.customPrompt
}

func coverageMonorepo() *RepoMap {
	files := []FileMap{
		{Path: "packages/alpha/src/index.ts", LOC: 400, Exports: []string{"createAlpha"}, Hotness: 40, Layer: LayerPipeline},
		{Path: "packages/alpha/src/util.ts", LOC: 200},
		{Path: "packages/beta/src/index.ts", LOC: 400, Exports: []string{"createBeta"}, Hotness: 30, Layer: LayerFoundation},
	}
	m := &RepoMap{RepoName: "covrepo", Files: files}
	m.TotalLOC = 1000
	m.Tree = BuildRepoTree(files, m.RepoName)
	return m
}

const covAlphaChapter = `{"chapters":[{"name":"alpha 章","summary":"s","files":["packages/alpha/src/index.ts"],"phase":"入门"}]}`
const covAlphaBetaChapters = `{"chapters":[
	{"name":"alpha 章","summary":"s","files":["packages/alpha/src/index.ts"],"phase":"入门"},
	{"name":"beta 章","summary":"s","files":["packages/beta/src/index.ts"],"phase":"实战"}
]}`

func chaptersCoverPrefix(t *testing.T, chapters []cognitive.OutlineChapter, prefix string) bool {
	t.Helper()
	for _, ch := range chapters {
		for _, f := range ch.Files {
			if f.Path == prefix || strings.HasPrefix(f.Path, prefix+"/") {
				return true
			}
		}
	}
	return false
}

func TestRunCoverageGateDepth1SingleRevisionLoop(t *testing.T) {
	patterns := loadPatterns(t)
	m := coverageMonorepo()

	model := &coverageFakeModel{first: covAlphaChapter, revision: covAlphaBetaChapters, depth: TeachingDepthStandard}
	res, err := Run(context.Background(), m, model, patterns, "zh-CN")
	require.NoError(t, err)

	require.Len(t, model.calls, 2, "覆盖率门禁只允许追加 1 次 outline_map_v1 调用")
	assert.Empty(t, model.calls[0].CoverageFeedback, "首发调用不得携带 coverageFeedback")
	assert.NotEmpty(t, model.calls[1].CoverageFeedback, "修订调用必须携带 coverageFeedback（契约 C7）")
	assert.Contains(t, model.calls[1].CoverageFeedback, "beta", "修订指令必须点名缺失子系统")

	assert.True(t, chaptersCoverPrefix(t, res.Chapters, "packages/beta"), "修订后 beta 应被覆盖")
}

func TestRunCoverageGateStillMissingAllowsWithWarning(t *testing.T) {
	patterns := loadPatterns(t)
	m := coverageMonorepo()

	model := &coverageFakeModel{first: covAlphaChapter, revision: covAlphaChapter, depth: TeachingDepthStandard}
	res, err := Run(context.Background(), m, model, patterns, "zh-CN")
	require.NoError(t, err)

	require.Len(t, model.calls, 2, "仍缺失也只允许 1 次修订（封顶，不循环）")
	assert.False(t, chaptersCoverPrefix(t, res.Chapters, "packages/beta"), "未改善的修订不得采信，保留原大纲")
	assert.True(t, chaptersCoverPrefix(t, res.Chapters, "packages/alpha"), "原大纲内容保持完整")
}

func TestRunCoverageGateConflictRulesSkip(t *testing.T) {
	patterns := loadPatterns(t)

	tests := []struct {
		name         string
		depth        string
		customPrompt string
	}{
		{name: "customPrompt 非空跳过强制重规划", depth: TeachingDepthStandard, customPrompt: "聚焦编译器"},
		{name: "overview 跳过强制重规划", depth: TeachingDepthOverview},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := coverageMonorepo()
			model := &coverageFakeModel{first: covAlphaChapter, revision: covAlphaBetaChapters, depth: tt.depth, customPrompt: tt.customPrompt}
			res, err := Run(context.Background(), m, model, patterns, "zh-CN")
			require.NoError(t, err)
			assert.Len(t, model.calls, 1, "冲突规则命中时绝不追加修订调用")
			assert.False(t, chaptersCoverPrefix(t, res.Chapters, "packages/beta"), "跳过重规划时大纲保持原样")
		})
	}
}

func TestRunCoverageGateDepth2ObservabilityOnly(t *testing.T) {
	patterns := loadPatterns(t)
	files := []FileMap{
		{Path: "README.md", LOC: 20, IsDoc: true},
		{Path: "packages/alpha/index.ts", LOC: 600, Exports: []string{"createAlpha"}},
		{Path: "packages/beta/index.ts", LOC: 400, Exports: []string{"createBeta"}},
	}
	m := &RepoMap{RepoName: "depth2repo", Files: files}
	m.Tree = BuildRepoTree(files, m.RepoName)

	planner := &fakePlanner{first: `{"chapters":[
		{"name":"第 1 章:起步","summary":"s","targetPaths":["README.md"],"phase":"入门"},
		{"name":"第 2 章:alpha","summary":"s","targetPaths":["packages/alpha"],"phase":"实战"}
	]}`}
	model := &coverageFakeModel{first: covAlphaBetaChapters, depth: TeachingDepthDeep}

	res, err := RunDrill(context.Background(), m, planner, model, patterns, "zh-CN", TeachingDepthDeep, 0)
	require.NoError(t, err)

	assert.Equal(t, 1, planner.calls, "深度 2 严禁覆盖率驱动的重规划")
	assert.Len(t, model.calls, 0, "深度 2 严禁子树 LLM 重跑（默认方案 A 路径 0 次模型调用）")
	require.Len(t, res.Chapters, 2)
	assert.False(t, chaptersCoverPrefix(t, res.Chapters, "packages/beta"), "深度 2 仅告警，不得改动大纲")
}

func TestRunDrillDepth2CoverageConflictRules_TableDriven(t *testing.T) {
	patterns := loadPatterns(t)

	buildRepo := func() *RepoMap {
		files := []FileMap{
			{Path: "README.md", LOC: 20, IsDoc: true},
			{Path: "packages/alpha/index.ts", LOC: 600, Exports: []string{"createAlpha"}},
			{Path: "packages/beta/index.ts", LOC: 400, Exports: []string{"createBeta"}},
		}
		m := &RepoMap{RepoName: "depth2repo", Files: files}
		m.Tree = BuildRepoTree(files, m.RepoName)
		return m
	}
	plan := `{"chapters":[
		{"name":"第 1 章:起步","summary":"s","targetPaths":["README.md"],"phase":"入门"},
		{"name":"第 2 章:alpha","summary":"s","targetPaths":["packages/alpha"],"phase":"实战"}
	]}`

	tests := []struct {
		name        string
		planner     PlannerModel
		model       OutlineModel
		wantWarning bool
	}{
		{
			name:        "model 携带 customPrompt → 深度 2 不误报",
			planner:     &fakePlanner{first: plan},
			model:       &coverageFakeModel{first: covAlphaBetaChapters, depth: TeachingDepthDeep, customPrompt: "聚焦编译器"},
			wantWarning: false,
		},
		{
			name: "model 无 aware 接口时回读 planner（GatewayPlanner）条件 → 不误报",
			planner: &GatewayPlanner{
				Client:        &mapCaptureGateway{resp: plan},
				CustomPrompt:  "聚焦编译器",
				TeachingDepth: TeachingDepthDeep,
			},
			model:       reqFake{},
			wantWarning: false,
		},
		{
			name:        "无聚焦条件 → 缺失告警照常触发（对照）",
			planner:     &fakePlanner{first: plan},
			model:       &coverageFakeModel{first: covAlphaBetaChapters, depth: TeachingDepthDeep},
			wantWarning: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logBuf := captureStdlibLog(t)
			res, err := RunDrill(context.Background(), buildRepo(), tt.planner, tt.model, patterns, "zh-CN", TeachingDepthDeep, 0)
			require.NoError(t, err)
			require.Len(t, res.Chapters, 2)
			out := logBuf.String()
			if tt.wantWarning {
				assert.Contains(t, out, "[pipelineb] CoverageGate depth2 warning", "对照组（无聚焦条件）必须触发缺失告警")
			} else {
				assert.NotContains(t, out, "[pipelineb] CoverageGate depth2 warning", "用户聚焦意图主权：customPrompt 非空严禁误报遗漏告警")
			}
		})
	}
}
