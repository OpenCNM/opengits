package pipelineb

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/platform/client"
)

// ─────────────────────────────────────────────────────────────
// Phase 1.3 长尾形态矩阵回归（Table-Driven）。
//
// 样本来源：pbtool -gen-fixture 收敛漏斗校验通过的 testdata/longtail/*.json
// （纯 Proto/IDL 仓、无 README 硬核 C 库、Rust+Python+C FFI 混编、非标
// 平铺布局）+ 巨仓规模用程序化合成（静态 JSON 不承载 2 万行）。
//
// 断言面（不 panic、不死循环、fail-closed 语义正确）：
//   - 树构建 round-trip：叶子数与文件数一致、上卷 FileCount 正确；
//   - 退化判定：整仓一章/根目标劫持在长尾形态下依旧被判退化；
//   - needRollup 有界封顶：模型超额请求确定性截断为前 3；
//   - 幽灵目标预验证：规划引用不存在路径被剔除并登记 DroppedPlan；
//   - 巨仓规模：2 万文件确定性装配在秒级完成且章数有界。
// ─────────────────────────────────────────────────────────────

// longtailFixture 与 pbtool -gen-fixture 输出同构（收敛漏斗落盘格式）。
type longtailFixture struct {
	Name  string           `json:"name"`
	Files []longtailFileFD `json:"files"`
}

type longtailFileFD struct {
	Path     string `json:"path"`
	Loc      int    `json:"loc"`
	Lang     string `json:"lang"`
	IsDoc    bool   `json:"isDoc"`
	IsTest   bool   `json:"isTest"`
	IsConfig bool   `json:"isConfig"`
}

// loadLongtailFixture 加载并物化长尾 fixture 为 RepoMap（确定性：
// 字典序输入契约 + BuildRepoTree round-trip 守恒校验）。
func loadLongtailFixture(t *testing.T, name string) *RepoMap {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "longtail", name+".json"))
	require.NoError(t, err, "fixture 文件缺失: %s", name)
	var fx longtailFixture
	require.NoError(t, json.Unmarshal(raw, &fx), "fixture JSON 解析失败: %s", name)
	require.NotEmpty(t, fx.Files, "fixture 文件列表为空: %s", name)

	// 字典序契约（tree.go BuildRepoTree 输入前提）：fixture 必须经
	// pbtool -gen-fixture 收敛漏斗落盘——手工乱序样本在此显式拒绝
	for i := 1; i < len(fx.Files); i++ {
		require.Less(t, fx.Files[i-1].Path, fx.Files[i].Path,
			"fixture %s 非字典序（请经 go run ./cmd/pbtool -gen-fixture 重新洗盘）: %q > %q",
			name, fx.Files[i-1].Path, fx.Files[i].Path)
	}

	files := make([]FileMap, 0, len(fx.Files))
	for _, fd := range fx.Files {
		files = append(files, FileMap{
			Path: fd.Path, Lang: fd.Lang, LOC: fd.Loc,
			IsDoc: fd.IsDoc, IsTest: fd.IsTest, IsConfig: fd.IsConfig,
		})
	}
	tree := BuildRepoTree(files, fx.Name)
	leaves := tree.LeafFiles()
	require.Len(t, leaves, len(files), "round-trip 守恒破坏: %s", name)
	return &RepoMap{RepoName: fx.Name, Files: files, Tree: tree}
}

// longtailFixtureNames 矩阵全集（新增 fixture 自动进矩阵——无清单漂移）。
func longtailFixtureNames(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join("testdata", "longtail"))
	require.NoError(t, err)
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".json") {
			names = append(names, strings.TrimSuffix(e.Name(), ".json"))
		}
	}
	require.NotEmpty(t, names, "testdata/longtail 无 fixture")
	return names
}

// TestLongtailTreeRoundTrip_TableDriven 全 fixture：树构建不丢叶、上卷正确。
func TestLongtailTreeRoundTrip_TableDriven(t *testing.T) {
	for _, name := range longtailFixtureNames(t) {
		t.Run(name, func(t *testing.T) {
			m := loadLongtailFixture(t, name)
			assert.Equal(t, len(m.Files), m.Tree.FileCount, "上卷 FileCount 应等于文件总数")
			_, idx := m.Tree.leafFilesIndexed()
			for _, f := range m.Files {
				_, ok := idx[f.Path]
				assert.True(t, ok, "叶子丢失: %s", f.Path)
			}
		})
	}
}

// TestLongtailPlanDegenerate_TableDriven 长尾形态下退化判定不失效：
// 整仓一章（全指向根）必判退化；跨分区三章在有多分区的形态下不判退化。
func TestLongtailPlanDegenerate_TableDriven(t *testing.T) {
	tests := []struct {
		name       string
		fixture    string
		plan       []PlanChapter
		degenerate bool
	}{
		{
			name:    "proto 仓整仓一章 → 退化",
			fixture: "proto-only-repo",
			plan: []PlanChapter{
				{Name: "第 1 章", Summary: "s", TargetPaths: []string{"."}, Phase: "入门"},
			},
			degenerate: true,
		},
		{
			name:    "硬核 C 仓跨分区三章 → 不退化",
			fixture: "no-readme-hardcore",
			plan: []PlanChapter{
				{Name: "内存管理", Summary: "s", TargetPaths: []string{"src/alloc.c"}, Phase: "入门"},
				{Name: "数学核心", Summary: "s", TargetPaths: []string{"src/math.c"}, Phase: "实战"},
				{Name: "IO 层", Summary: "s", TargetPaths: []string{"src/io.c"}, Phase: "实战"},
			},
			degenerate: false,
		},
		{
			name:    "平铺布局全指向根 → 退化",
			fixture: "weird-layout",
			plan: []PlanChapter{
				{Name: "cli", Summary: "s", TargetPaths: []string{"cli"}, Phase: "入门"},
				{Name: "daemon", Summary: "s", TargetPaths: []string{"daemon"}, Phase: "入门"},
			},
			degenerate: true, // 仅 2 章（<3）且微型规则不适用（>3 文件）
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := loadLongtailFixture(t, tt.fixture)
			assert.Equal(t, tt.degenerate, planDegenerate(tt.plan, skipRootWrapper(m.Tree)))
		})
	}
}

// TestLongtailNeedRollupBoundedCap needRollup 超额请求确定性截断为前 3：
// 模型概率性多要（长尾仓自然倾向上卷更多分区）不放大补料预算。
func TestLongtailNeedRollupBoundedCap(t *testing.T) {
	m := loadLongtailFixture(t, "mixed-ffi")
	planner := &scriptedPlanner{
		first: `{"curriculumMode":"matrix","chapters":[` +
			`{"name":"第 1 章","summary":"s","targetPaths":["rust/ext/src/lib.rs"],"phase":"入门"},` +
			`{"name":"第 2 章","summary":"s","targetPaths":["python/wrapper/core.py"],"phase":"实战"},` +
			`{"name":"第 3 章","summary":"s","targetPaths":["c_compat/shim.c"],"phase":"实战"}],` +
			`"needRollup":["rust/ext","python/wrapper","c_compat","tools","docs"]}`,
		second: `{"curriculumMode":"matrix","chapters":[` +
			`{"name":"第 1 章","summary":"s","targetPaths":["rust/ext/src/lib.rs"],"phase":"入门"},` +
			`{"name":"第 2 章","summary":"s","targetPaths":["python/wrapper/core.py"],"phase":"实战"},` +
			`{"name":"第 3 章","summary":"s","targetPaths":["c_compat/shim.c"],"phase":"实战"}]}`,
	}
	root := skipRootWrapper(m.Tree)
	resp, replanned, diag, err := obtainPlan(context.Background(), planner, root, "zh-CN", 3, 1)
	require.NoError(t, err)
	assert.True(t, replanned, "带 rollup 的补料重规划应发生（封顶一次）")
	assert.Equal(t, 2, planner.calls, "补料重规划封顶：首发 + 一次修订，绝不迭代")
	require.NotNil(t, resp)
	assert.GreaterOrEqual(t, len(resp.Chapters), 3)
	// Phase 2 观测契约：原始请求数 5、触顶 true、健康规划不触发退化路径
	assert.Equal(t, 5, diag.NeedRollupRequested)
	assert.True(t, diag.NeedRollupCapped)
	assert.False(t, diag.PlanDegenerateTriggered)
}

// TestLongtailNeedRollupBoundedCap needRollup 超额请求确定性截断为前 3：
// 模型概率性多要（长尾仓自然倾向上卷更多分区）不放大补料预算。
// （显式默认档：obtainPlan(..., quota=3, depth=1) 与历史行为逐字节一致。）

// TestRollupBudgetForLevel_TableDriven 档位表契约：默认档与历史一致、
// 越界收敛 [0,3]、天花板 8×2。
func TestRollupBudgetForLevel_TableDriven(t *testing.T) {
	tests := []struct {
		level     int
		wantQuota int
		wantDepth int
	}{
		{-2, 3, 1}, // 负值收敛默认
		{0, 3, 1},  // 默认档 = 历史行为
		{1, 4, 1},
		{2, 5, 2},
		{3, 8, 2}, // 天花板
		{9, 8, 2}, // 越上界收敛
	}
	for _, tt := range tests {
		t.Run(fmt.Sprintf("level=%d", tt.level), func(t *testing.T) {
			quota, depth := RollupBudgetForLevel(tt.level)
			assert.Equal(t, tt.wantQuota, quota)
			assert.Equal(t, tt.wantDepth, depth)
		})
	}
}

// TestObtainPlanRollupQuotaLevels 探查配额档位端到端：默认档截断 3 条
// （历史行为不变）；level=2（quota=5/depth=2）5 条全保留且补料骨架
// 下钻两层——用户「更深入」点击确实放大探查预算。
func TestObtainPlanRollupQuotaLevels(t *testing.T) {
	m := loadLongtailFixture(t, "mixed-ffi")
	root := skipRootWrapper(m.Tree)
	// 5 条 needRollup：rust/ext、python/wrapper、c_compat（真实分区）+ tools、docs（幽灵）
	first := `{"curriculumMode":"matrix","chapters":[` +
		`{"name":"第 1 章","summary":"s","targetPaths":["rust/ext/src/lib.rs"],"phase":"入门"},` +
		`{"name":"第 2 章","summary":"s","targetPaths":["python/wrapper/core.py"],"phase":"实战"},` +
		`{"name":"第 3 章","summary":"s","targetPaths":["c_compat/shim.c"],"phase":"实战"}],` +
		`"needRollup":["rust/ext","python/wrapper","c_compat","tools","docs"]}`
	second := `{"curriculumMode":"matrix","chapters":[` +
		`{"name":"第 1 章","summary":"s","targetPaths":["rust/ext/src/lib.rs"],"phase":"入门"},` +
		`{"name":"第 2 章","summary":"s","targetPaths":["python/wrapper/core.py"],"phase":"实战"},` +
		`{"name":"第 3 章","summary":"s","targetPaths":["c_compat/shim.c"],"phase":"实战"}]}`

	t.Run("默认档 quota=3：截断 + 触顶诊断（历史行为不变）", func(t *testing.T) {
		planner := &scriptedPlanner{first: first, second: second}
		_, _, diag, err := obtainPlan(context.Background(), planner, root, "zh-CN", 3, 1)
		require.NoError(t, err)
		assert.True(t, diag.NeedRollupCapped)
		assert.Equal(t, 3, diag.NeedRollupQuota)
		assert.Equal(t, 1, diag.NeedRollupDepth)
		assert.Equal(t, 3, planner.lastRollupCount, "截断后仅前 3 条进补料")
	})

	t.Run("level=2 quota=5：5 条全保留 + depth=2 双层骨架", func(t *testing.T) {
		planner := &scriptedPlanner{first: first, second: second}
		_, _, diag, err := obtainPlan(context.Background(), planner, root, "zh-CN", 5, 2)
		require.NoError(t, err)
		assert.False(t, diag.NeedRollupCapped, "配额 5 时 5 条请求不再触顶")
		assert.False(t, diag.NeedRollupRequested != 5)
		assert.Equal(t, 5, diag.NeedRollupQuota)
		assert.Equal(t, 2, diag.NeedRollupDepth)
		// 真实分区 3 条进补料（tools/docs 为幽灵路径被 findSubtree 剔除）
		assert.Equal(t, 3, planner.lastRollupCount)
		// depth=2 语义直接验证（fixture 单链折叠后 rust/ext 无二层子目录，
		// 行数比较用程序化三层树——depth 每加一层多展示一层目录行）
		// a/b 下 c 有两个子目录 d/e：depth=1 只见 c，depth=2 再展开 d/e
		deep := make([]FileMap, 0, 5)
		for _, p := range []string{"a/b/c/d/x.go", "a/b/c/e/y.go", "a/b/keep.go", "a/top.go"} {
			deep = append(deep, FileMap{Path: p, Lang: "go", LOC: 50})
		}
		deepTree := BuildRepoTree(deep, "deep-repo")
		one := RenderSubtreeSkeleton(findSubtree(skipRootWrapper(deepTree), "a/b"), 1)
		two := RenderSubtreeSkeleton(findSubtree(skipRootWrapper(deepTree), "a/b"), 2)
		assert.Less(t, strings.Count(one, "\n"), strings.Count(two, "\n"), "depth=2 应比 depth=1 多展示一层目录行")
		assert.Contains(t, one, "c", "depth=1 可见 a/b 的直接子目录 c")
		assert.Contains(t, two, "d", "depth=2 应展开 c 下的 d 目录层")
	})
}

// TestLongtailDegenerateDiagnostics 退化 → 反馈重规划救回的全程诊断：
// Triggered=true + Recovered=true；fail-closed 路径 Triggered=true + Recovered=false。
func TestLongtailDegenerateDiagnostics(t *testing.T) {
	m := loadLongtailFixture(t, "weird-layout")
	root := skipRootWrapper(m.Tree)

	t.Run("反馈重规划救回", func(t *testing.T) {
		planner := &fakePlanner{
			first: `{"curriculumMode":"matrix","chapters":[{"name":"独章","summary":"s","targetPaths":["."],"phase":"入门"}]}`,
			feedbackPlan: `{"curriculumMode":"matrix","chapters":[` +
				`{"name":"第 1 章","summary":"s","targetPaths":["cli"],"phase":"入门"},` +
				`{"name":"第 2 章","summary":"s","targetPaths":["daemon"],"phase":"实战"},` +
				`{"name":"第 3 章","summary":"s","targetPaths":["plugins/alpha.sh"],"phase":"实战"}]}`,
		}
		_, _, diag, err := obtainPlan(context.Background(), planner, root, "zh-CN", 3, 1)
		require.NoError(t, err)
		assert.True(t, diag.PlanDegenerateTriggered, "退化判定命中应记录")
		assert.True(t, diag.PlanDegenerateRecovered, "反馈重规划救回应记录")
	})

	t.Run("持续退化 fail-closed", func(t *testing.T) {
		degenerate := `{"curriculumMode":"matrix","chapters":[{"name":"独章","summary":"s","targetPaths":["."],"phase":"入门"}]}`
		planner := &fakePlanner{first: degenerate, second: degenerate}
		_, _, diag, err := obtainPlan(context.Background(), planner, root, "zh-CN", 3, 1)
		require.Error(t, err, "仍退化必须 fail-closed 上抛")
		assert.True(t, diag.PlanDegenerateTriggered)
		assert.False(t, diag.PlanDegenerateRecovered)
	})
}

// scriptedPlanner 顺序回放脚本：第一次返回 first，之后返回 second。
type scriptedPlanner struct {
	first  string
	second string
	calls  int
	// lastRollups / lastRollupDepth 记录补料调用的实参（quota/depth 参数化断言用）
	lastRollups     map[string]string
	lastRollupCount int
}

func (s *scriptedPlanner) Plan(_ context.Context, _ string, rollups map[string]string, _ string, _ string) (string, error) {
	s.calls++
	if rollups != nil {
		s.lastRollups = rollups
		s.lastRollupCount = len(rollups)
	}
	if s.calls == 1 {
		return s.first, nil
	}
	return s.second, nil
}

// TestLongtailGhostTargetDropped 幽灵目标预验证：规划引用骨架外路径被
// 剔除、全无效规划章登记 DroppedPlan（fail-closed：不浪费下钻预算）。
func TestLongtailGhostTargetDropped(t *testing.T) {
	m := loadLongtailFixture(t, "no-readme-hardcore")
	planner := &fakePlanner{first: `{"curriculumMode":"matrix","chapters":[` +
		`{"name":"幽灵章","summary":"s","targetPaths":["does/not/exist"],"phase":"入门"},` +
		`{"name":"真实章","summary":"s","targetPaths":["src/alloc.c"],"phase":"实战"},` +
		`{"name":"真实章 2","summary":"s","targetPaths":["src/math.c"],"phase":"实战"},` +
		`{"name":"真实章 3","summary":"s","targetPaths":["src/io.c"],"phase":"实战"}]}`}
	res, err := RunDrill(context.Background(), m, planner, perReqFakeStub{}, loadPatterns(t), "zh-CN", "", 0)
	require.NoError(t, err)
	assert.Equal(t, []string{"幽灵章"}, res.DroppedPlan, "全无效目标的规划章应登记丢弃")
	assert.NotEmpty(t, res.Chapters)
	for _, ch := range res.Chapters {
		for _, f := range ch.Files {
			assert.False(t, strings.HasPrefix(f.Path, "does/"), "幽灵路径不得进入章节: %s", f.Path)
		}
	}
}

// perReqFakeStub 最小子树模型桩（每子树 1 章，取前 3 文件——与 pbtool 同款语义）。
type perReqFakeStub struct{}

func (perReqFakeStub) Complete(_ context.Context, req ModelRequest) (string, error) {
	var files []string
	for i, f := range req.RepoMap.Files {
		if i >= 3 {
			break
		}
		files = append(files, f.Path)
	}
	b, _ := json.Marshal(map[string]any{
		"chapters": []map[string]any{
			{"name": "桩章:" + req.RepoMap.RepoName, "summary": "fake", "files": files, "phase": "实战"},
		},
	})
	return string(b), nil
}

// countingFailModel 记录调用次数并恒返指定错误（深度 1 零重试断言用）。
type countingFailModel struct {
	err   error
	calls int
}

func (m *countingFailModel) Complete(_ context.Context, _ ModelRequest) (string, error) {
	m.calls++
	return "", m.err
}

// TestRunDepth1PermanentConfigErrorZeroRetry 深度 1 遇永久性配置错误
// （KEY_DECRYPT_FAILED 等）必须零成本退出：绝不触发 Layer 2 靶向修复
// 二次调用（round-2 交叉验收：永久错误伪装成"格式瑕疵"空耗预算）。
func TestRunDepth1PermanentConfigErrorZeroRetry(t *testing.T) {
	m := loadLongtailFixture(t, "mixed-ffi")
	model := &countingFailModel{
		err: &client.LlmGatewayError{Code: client.ErrCodeKeyDecryptFailed, Status: 409, Message: "云端已保存的 AI 密钥无法解密"},
	}
	_, err := Run(context.Background(), m, model, loadPatterns(t), "zh-CN")
	require.Error(t, err)
	assert.Equal(t, 1, model.calls, "永久配置错误必须零成本退出，严禁 Layer 2 修复二次调用")
	var gw *client.LlmGatewayError
	require.True(t, errors.As(err, &gw), "错误码必须可被 errors.As 提取（sendPipelineError 透传依赖）")
	assert.Equal(t, client.ErrCodeKeyDecryptFailed, gw.Code)
}

// TestLongtailGiantRepoScale 巨仓规模（2 万文件程序化合成）：确定性装配
// 不 panic、不死循环、章数有界、耗时秒级（规模护栏回归）。
func TestLongtailGiantRepoScale(t *testing.T) {
	if testing.Short() {
		t.Skip("short 模式跳过 2 万文件规模护栏")
	}
	const total = 20000
	files := make([]FileMap, 0, total)
	for pkg := 0; pkg < 200; pkg++ {
		for i := 0; i < 100; i++ {
			files = append(files, FileMap{
				Path: "packages/pkg" + strconv.Itoa(pkg) + "/src/file" + strconv.Itoa(i) + ".ts",
				Lang: "ts", LOC: 120,
			})
		}
	}
	m := &RepoMap{RepoName: "giant-mono", Files: files}
	m.Tree = BuildRepoTree(files, "giant-mono")
	require.Equal(t, total, m.Tree.FileCount, "上卷 FileCount 必须等于合成总数（2 万叶不丢）")

	planner := giantFakePlanner{}
	start := time.Now()
	res, err := RunDrill(context.Background(), m, planner, perReqFakeStub{}, loadPatterns(t), "zh-CN", "", 0)
	elapsed := time.Since(start)
	require.NoError(t, err)
	assert.Less(t, elapsed, 10*time.Second, "2 万文件确定性装配必须秒级完成（规模护栏）")
	assert.NotEmpty(t, res.Chapters)
	// 幽灵目标拦截：桩规划含虚构 README.md 章（合成仓无根 README），必须
	// 被预验证剔除并登记 DroppedPlan——巨仓规划幻觉不烧下钻预算
	assert.Equal(t, []string{"第 1 章:起步"}, res.DroppedPlan, "虚构 README 目标的规划章应被剔除登记")
	assert.Empty(t, res.DroppedPaths, "真实目标路径不得被幻觉装甲误砍")
	// 产出文件归属检查：所有入章路径必须真实存在于 2 万输入集（零幻觉出口）
	_, inputIdx := m.Tree.leafFilesIndexed()
	for _, ch := range res.Chapters {
		for _, f := range ch.Files {
			_, ok := inputIdx[f.Path]
			assert.True(t, ok, "入章文件不在输入集（幻觉出口）: %s", f.Path)
		}
	}
	assert.LessOrEqual(t, len(res.Chapters), 14, "章数受规划上限约束")
	covered := 0
	for _, ch := range res.Chapters {
		covered += len(ch.Files)
	}
	assert.LessOrEqual(t, covered, len(res.Chapters)*drillChapterFileCap, "单章文件封顶不被巨仓冲破")
	assert.Positive(t, covered, "巨仓装配不得产出全空章")
}

// giantFakePlanner 巨仓桩规划：前 3 个 packages 子树各成一章。
type giantFakePlanner struct{}

func (giantFakePlanner) Plan(_ context.Context, skeleton string, _ map[string]string, _ string, _ string) (string, error) {
	var dirs []string
	for _, line := range strings.Split(skeleton, "\n")[1:] {
		if len(dirs) >= 3 {
			break
		}
		if name := strings.TrimSpace(strings.Split(line, " |")[0]); name != "" && !strings.Contains(name, "README") {
			dirs = append(dirs, name)
		}
	}
	b, _ := json.Marshal(map[string]any{
		"curriculumMode": "matrix",
		"chapters": []map[string]any{
			{"name": "第 1 章:起步", "summary": "fake", "targetPaths": []string{"README.md"}, "phase": "入门"},
			{"name": "第 2 章:核心分区", "summary": "fake", "targetPaths": dirs, "phase": "实战"},
			{"name": "第 3 章:核心分区 B", "summary": "fake", "targetPaths": dirs, "phase": "实战"},
			{"name": "第 4 章:核心分区 C", "summary": "fake", "targetPaths": dirs, "phase": "实战"},
		},
	})
	return string(b), nil
}
