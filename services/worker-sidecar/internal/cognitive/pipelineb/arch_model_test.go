package pipelineb

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// errorModel 恒返回失败的模型桩（测试降级兜底）。
type errorModel struct{}

func (errorModel) Complete(_ context.Context, _ ModelRequest) (string, error) {
	return "", errors.New("simulated gateway rate limit / timeout")
}

// invalidJSONModel 返回畸形文本的模型桩。
type invalidJSONModel struct{}

func (invalidJSONModel) Complete(_ context.Context, _ ModelRequest) (string, error) {
	return "I am unable to output JSON: ```error```", nil
}

func TestBuildArchitecturalModel_FiveDimensions(t *testing.T) {
	patterns := loadPatterns(t)

	tests := []struct {
		name              string
		files             []FileMap
		edges             []ASTCallEdge
		wantDimCount      int
		wantSpecialized   bool
		wantBranchNames   []string
		wantInterfaceKey  string
		wantDomainKey     string
		wantCoreKey       string
		wantVerificationK string
	}{
		{
			name: "multi-layered repo with specialized tuners",
			files: []FileMap{
				{Path: "README.md", LOC: 50, IsDoc: true},
				{Path: "src/peft/auto.py", LOC: 120, Exports: []string{"AutoPeftModel", "get_peft_model"}, Layer: LayerInterface},
				{Path: "src/peft/config.py", LOC: 80, Exports: []string{"PeftConfig", "PeftType"}, Layer: LayerFoundation},
				{Path: "src/peft/peft_model.py", LOC: 450, Exports: []string{"PeftModel"}, Hotness: 90, Layer: LayerPipeline},
				{Path: "src/peft/tuners/tuners_utils.py", LOC: 300, Exports: []string{"BaseTuner"}, Hotness: 70, Layer: LayerPipeline},
				{Path: "src/peft/tuners/lora/model.py", LOC: 350, Exports: []string{"LoraModel"}, Layer: LayerPipeline},
				{Path: "src/peft/tuners/lora/config.py", LOC: 100, Exports: []string{"LoraConfig"}, Layer: LayerFoundation},
				{Path: "src/peft/tuners/ia3/model.py", LOC: 250, Exports: []string{"IA3Model"}, Layer: LayerPipeline},
				{Path: "tests/test_peft_model.py", LOC: 200, Exports: []string{"TestPeftModel"}, IsTest: true},
			},
			edges: []ASTCallEdge{
				{Caller: "src/peft/auto.py", Callee: "src/peft/peft_model.py", Symbol: "PeftModel"},
				{Caller: "src/peft/peft_model.py", Callee: "src/peft/config.py", Symbol: "PeftConfig"},
				{Caller: "src/peft/tuners/lora/model.py", Callee: "src/peft/tuners/tuners_utils.py", Symbol: "BaseTuner"},
			},
			wantDimCount:      5,
			wantSpecialized:   true,
			wantBranchNames:   []string{"lora", "ia3"},
			wantInterfaceKey:  "src/peft/auto.py",
			wantDomainKey:     "src/peft/config.py",
			wantCoreKey:       "src/peft/peft_model.py",
			wantVerificationK: "tests/test_peft_model.py",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := &RepoMap{
				RepoName:  "peft-demo",
				Files:     tt.files,
				CallEdges: tt.edges,
			}
			for _, f := range tt.files {
				m.TotalLOC += f.LOC
			}

			model := BuildArchitecturalModel(m, patterns)
			require.NotNil(t, model)
			assert.Equal(t, tt.wantDimCount, len(model.Dimensions), "应归入 5 大架构维度")

			dimMap := map[string]ArchDimension{}
			for _, d := range model.Dimensions {
				dimMap[d.ID] = d
			}

			// 验证维度 1: 交付入口与门面
			dim1, ok := dimMap[DimInterfaceFacade]
			require.True(t, ok, "维度 1 应存在")
			assert.Contains(t, dim1.KeyFiles, tt.wantInterfaceKey)

			// 验证维度 2: 领域模型与状态
			dim2, ok := dimMap[DimDomainState]
			require.True(t, ok, "维度 2 应存在")
			assert.Contains(t, dim2.KeyFiles, tt.wantDomainKey)

			// 验证维度 3: 核心执行引擎
			dim3, ok := dimMap[DimCoreEngine]
			require.True(t, ok, "维度 3 应存在")
			assert.Contains(t, dim3.KeyFiles, tt.wantCoreKey)

			// 验证维度 4: 特化算法与扩展
			dim4, ok := dimMap[DimSpecialized]
			require.True(t, ok, "维度 4 应存在")
			if tt.wantSpecialized {
				assert.NotEmpty(t, dim4.SubBranches, "特化实现应聚类子分支")
				var names []string
				for _, b := range dim4.SubBranches {
					names = append(names, b.Name)
				}
				for _, expected := range tt.wantBranchNames {
					assert.Contains(t, names, expected)
				}
			}

			// 验证维度 5: 规范约束与验证边界
			dim5, ok := dimMap[DimVerification]
			require.True(t, ok, "维度 5 应存在")
			assert.Contains(t, dim5.KeyFiles, tt.wantVerificationK)
		})
	}
}

func TestBuildArchitecturalModel_MicroRepo(t *testing.T) {
	patterns := loadPatterns(t)

	// 微型仓：例如 mitt (3 个文件)
	m := &RepoMap{
		RepoName:    "mitt",
		IsMicroRepo: true,
		Files: []FileMap{
			{Path: "README.md", LOC: 40, IsDoc: true},
			{Path: "src/index.ts", LOC: 110, Exports: []string{"mitt", "EventHandler"}, Layer: LayerInterface},
			{Path: "test/index.test.ts", LOC: 80, IsTest: true},
		},
	}
	for _, f := range m.Files {
		m.TotalLOC += f.LOC
	}

	model := BuildArchitecturalModel(m, patterns)
	require.NotNil(t, model)
	assert.True(t, model.IsMicroRepo)
	// 微型仓维度自适应收缩为 2~3 个维度（门面起步 ➔ 算法内核 ➔ 规范测试）
	assert.LessOrEqual(t, len(model.Dimensions), 3)
	assert.GreaterOrEqual(t, len(model.Dimensions), 2)
}

func TestRenderArchModel_TokenBudget(t *testing.T) {
	patterns := loadPatterns(t)

	// 模拟 100 个文件规模
	var files []FileMap
	files = append(files, FileMap{Path: "README.md", LOC: 80, IsDoc: true})
	files = append(files, FileMap{Path: "src/index.ts", LOC: 150, Exports: []string{"startServer", "createApp"}, Layer: LayerInterface})
	files = append(files, FileMap{Path: "src/models/user.ts", LOC: 120, Exports: []string{"User", "UserRole"}, Layer: LayerFoundation})
	files = append(files, FileMap{Path: "src/engine/pipeline.ts", LOC: 500, Exports: []string{"Pipeline", "Executor"}, Hotness: 85, Layer: LayerPipeline})
	files = append(files, FileMap{Path: "src/adapters/redis/cache.ts", LOC: 220, Exports: []string{"RedisCache"}, Layer: LayerPipeline})
	files = append(files, FileMap{Path: "src/adapters/mem/cache.ts", LOC: 180, Exports: []string{"MemCache"}, Layer: LayerPipeline})
	files = append(files, FileMap{Path: "tests/pipeline.test.ts", LOC: 160, Exports: []string{"TestPipeline"}, IsTest: true})

	m := &RepoMap{
		RepoName: "token-benchmark-repo",
		Files:    files,
	}

	model := BuildArchitecturalModel(m, patterns)
	rendered := RenderArchModel(model)
	require.NotEmpty(t, rendered)

	tok := mdpat.EstimateTokens(rendered)
	// 架构模型 Token 严控在 500 Token 以内 (目标 ~300-400)
	assert.Less(t, tok, 500, "RenderArchModel 输出必须严格保持在 500 Tokens 以内，实际: %d", tok)

	// 验证包含关键维度标记
	assert.Contains(t, rendered, "维度 1: 交付入口与门面契约")
	assert.Contains(t, rendered, "维度 2: 领域模型与核心状态")
	assert.Contains(t, rendered, "维度 3: 核心执行引擎与管线")
}

func TestDeriveDeterministicOutline(t *testing.T) {
	patterns := loadPatterns(t)

	m := &RepoMap{
		RepoName: "demo",
		Files: []FileMap{
			{Path: "README.md", LOC: 50, IsDoc: true},
			{Path: "main.go", LOC: 100, Exports: []string{"Start"}, Layer: LayerInterface},
			{Path: "config.go", LOC: 80, Exports: []string{"Config"}, Layer: LayerFoundation},
			{Path: "engine.go", LOC: 300, Exports: []string{"Engine"}, Hotness: 90, Layer: LayerPipeline},
			{Path: "plugins/auth/oauth.go", LOC: 200, Exports: []string{"OAuthPlugin"}, Layer: LayerPipeline},
			{Path: "main_test.go", LOC: 120, Exports: []string{"TestMain"}, IsTest: true},
		},
	}
	model := BuildArchitecturalModel(m, patterns)
	chapters := DeriveDeterministicOutline(model, "zh-CN")

	require.NotEmpty(t, chapters)
	assert.GreaterOrEqual(t, len(chapters), 4)

	// 验证所有章节的文件真实落地
	realFiles := map[string]bool{}
	for _, f := range m.Files {
		realFiles[f.Path] = true
	}

	for _, ch := range chapters {
		assert.NotEmpty(t, ch.Name)
		assert.NotEmpty(t, ch.Summary)
		assert.NotEmpty(t, ch.Files)
		for _, cf := range ch.Files {
			assert.True(t, realFiles[cf.Path], "大纲文件 %s 必须真实存在于仓库中", cf.Path)
		}
	}
}

func TestRunWithFailClosedAndOffline(t *testing.T) {
	patterns := loadPatterns(t)

	m := &RepoMap{
		RepoName: "fallback-demo",
		Files: []FileMap{
			{Path: "README.md", LOC: 30, IsDoc: true},
			{Path: "main.go", LOC: 120, Exports: []string{"Main"}},
			{Path: "worker.go", LOC: 250, Exports: []string{"Worker"}},
			{Path: "worker_test.go", LOC: 90, IsTest: true},
		},
	}

	// 1. 无模型传参 (model == nil) -> 确定性极速推导直出（纯本地离线测试基线）
	resNil, err := Run(context.Background(), m, nil, patterns, "zh-CN")
	require.NoError(t, err)
	require.NotNil(t, resNil)
	assert.NotEmpty(t, resNil.Chapters, "nil 模型应瞬出确定性大纲")
	assert.LessOrEqual(t, resNil.EstPromptTok, 500)

	// 2. 网关报错桩 -> 失效封闭（坚决废除静默兜底伪弹性，避免伪造 AI 思考）
	resErr, err := Run(context.Background(), m, errorModel{}, patterns, "zh-CN")
	require.Error(t, err, "网关报错且无法自愈时 Run 应当失效封闭明确报错")
	assert.Nil(t, resErr)

	// 3. 模型返回无效 JSON 桩 -> 失效封闭明确报错
	resInvalid, err := Run(context.Background(), m, invalidJSONModel{}, patterns, "zh-CN")
	require.Error(t, err, "模型返回无法自愈的畸形内容时应失效封闭明确报错")
	assert.Nil(t, resInvalid)
}

// validMockModel 返回结构合法的大纲 JSON。
type validMockModel struct {
	payload string
}

func (v validMockModel) Complete(_ context.Context, _ ModelRequest) (string, error) {
	return v.payload, nil
}

func TestBuildArchitecturalModel_SingleFileSpecializedAndHotDomain(t *testing.T) {
	patterns := loadPatterns(t)

	m := &RepoMap{
		RepoName: "hot-domain-and-flat-adapters",
		Files: []FileMap{
			{Path: "README.md", LOC: 50, IsDoc: true},
			{Path: "cmd/server/main.go", LOC: 100, Exports: []string{"main"}, Layer: LayerInterface},
			// 高热度领域配置模型 (Hotness 80)：不可被误判为 CoreEngine
			{Path: "internal/models/config.go", LOC: 150, Exports: []string{"ServerConfig"}, Hotness: 80, Layer: LayerFoundation},
			// 单文件特化实现与基础抽象
			{Path: "internal/adapters/sqlite.go", LOC: 200, Exports: []string{"SqliteAdapter"}, Hotness: 30},
			{Path: "internal/adapters/mysql.go", LOC: 220, Exports: []string{"MySQLAdapter"}, Hotness: 35},
			{Path: "internal/adapters/base.go", LOC: 60, Exports: []string{"BaseAdapter"}, Hotness: 50},
			// 核心引擎
			{Path: "internal/engine/dispatcher.go", LOC: 400, Exports: []string{"Dispatcher"}, Hotness: 90, Layer: LayerPipeline},
			// 测试
			{Path: "internal/engine/dispatcher_test.go", LOC: 180, Exports: []string{"TestDispatcher"}, IsTest: true},
		},
	}

	model := BuildArchitecturalModel(m, patterns)
	require.NotNil(t, model)

	dimMap := map[string]ArchDimension{}
	for _, d := range model.Dimensions {
		dimMap[d.ID] = d
	}

	// 1. 验证高热度领域模型依然稳固归入 DimDomainState
	dimDomain, ok := dimMap[DimDomainState]
	require.True(t, ok, "维度 2 应存在")
	assert.Contains(t, dimDomain.KeyFiles, "internal/models/config.go", "高热度 domain 模型必须归入 DimDomainState，绝不能被 CoreEngine 抢夺")

	// 2. 验证单文件特化实现被正确聚类为 SubBranches，而 base.go 不被误识别为特化分支
	dimSpec, ok := dimMap[DimSpecialized]
	require.True(t, ok, "维度 4 特化实现应存在")
	branchNames := map[string]bool{}
	for _, b := range dimSpec.SubBranches {
		branchNames[b.Name] = true
	}
	assert.True(t, branchNames["sqlite"], "sqlite 单文件特化适配器应被识别")
	assert.True(t, branchNames["mysql"], "mysql 单文件特化适配器应被识别")
	assert.False(t, branchNames["base"], "base.go 抽象基类绝不能被误识别为特化分支")
}

func TestRun_LLMChaptersDimensionDecorated(t *testing.T) {
	patterns := loadPatterns(t)

	m := &RepoMap{
		RepoName: "decor-demo",
		Files: []FileMap{
			{Path: "README.md", LOC: 40, IsDoc: true},
			{Path: "src/index.ts", LOC: 100, Exports: []string{"start"}},
			{Path: "src/models/user.ts", LOC: 150, Exports: []string{"User"}},
			{Path: "src/engine/runner.ts", LOC: 300, Exports: []string{"Runner"}, Hotness: 80},
			{Path: "src/invariants/verify.ts", LOC: 90, Exports: []string{"VerifyInvariants"}},
			{Path: "tests/runner.test.ts", LOC: 120, IsTest: true},
		},
	}

	// 模拟 LLM 返回未标注 partTitle 的大纲
	llmResponse := `{"chapters":[
		{"name":"第 1 章：交付门面与快速启动","summary":"掌握系统入口","files":["src/index.ts","README.md"],"phase":"入门"},
		{"name":"第 2 章：实体领域状态建模","summary":"理解用户数据结构","files":["src/models/user.ts"],"phase":"进阶"},
		{"name":"第 3 章：执行管线生命周期调度","summary":"深入核心执行器调度机制","files":["src/engine/runner.ts"],"phase":"进阶"},
		{"name":"第 4 章：行为规范与断言验证","summary":"保障管线不变式与回归测试","files":["src/invariants/verify.ts"],"phase":"实战"}
	]}`

	res, err := Run(context.Background(), m, validMockModel{payload: llmResponse}, patterns, "zh-CN")
	require.NoError(t, err)
	require.NotNil(t, res)
	assert.Equal(t, 4, len(res.Chapters))

	// 验证每个章节都被自动赋予物理架构维度标签
	for _, ch := range res.Chapters {
		assert.NotEmpty(t, ch.PartTitle, "LLM 返回的章节必须经 decorateChapterDimensions 注入架构维度 PartTitle")
	}

	assert.Contains(t, res.Chapters[0].PartTitle, "交付入口与门面契约")
	assert.Contains(t, res.Chapters[1].PartTitle, "领域模型与核心状态")
	assert.Contains(t, res.Chapters[2].PartTitle, "核心执行引擎与管线")
	assert.Contains(t, res.Chapters[3].PartTitle, "规范约束与验证边界")
}

// 🧪 [346 准则 · 第一性原理] 验证 AI/ML 算法仓的数据契约 (如 preference_datasets.py) 正确归入 DimDomainState，并保证维度连续编号。
func TestBuildArchitecturalModel_DPODatasetScenario(t *testing.T) {
	patterns := loadPatterns(t)

	m := &RepoMap{
		RepoName: "direct-preference-optimization",
		Files: []FileMap{
			{Path: "train.py", LOC: 118, Layer: LayerInterface, Exports: []string{"main"}},
			{Path: "trainers.py", LOC: 545, Layer: LayerInterface, Exports: []string{"BasicTrainer", "preference_loss"}},
			{Path: "preference_datasets.py", LOC: 386, Layer: 0, Exports: []string{"get_dataset", "get_batch_iterator"}},
			{Path: "utils.py", LOC: 176, Layer: 0, Hotness: 100, Exports: []string{"get_open_port"}},
		},
	}

	model := BuildArchitecturalModel(m, patterns)
	require.NotNil(t, model)
	require.Equal(t, 3, len(model.Dimensions), "DPO 仓库应识别为 3 个维度（入口、领域数据契约、核心工具引擎）")

	// 1. 验证维度 1、2、3 严格连续编号，无跳号
	assert.Equal(t, "维度 1: 交付入口与门面契约 (Interface & Facade)", model.Dimensions[0].Title)
	assert.Equal(t, "维度 2: 领域模型与核心状态 (Domain Models & State)", model.Dimensions[1].Title)
	assert.Equal(t, "维度 3: 核心执行引擎与管线 (Core Engine & Pipelines)", model.Dimensions[2].Title)

	// 2. 验证 preference_datasets.py 正确进入领域状态与数据契约层
	dimMap := map[string]ArchDimension{}
	for _, d := range model.Dimensions {
		dimMap[d.ID] = d
	}
	assert.Contains(t, dimMap[DimDomainState].KeyFiles, "preference_datasets.py", "preference_datasets.py 必须归入 DimDomainState")
}

// 🧪 [346 准则 · 动态序数连续性] 稀疏维度仓库（仅命中接口与核心引擎）必须自适应重编为连续的“维度 1”与“维度 2”，严禁出现跳跃至“维度 3”。
func TestBuildArchitecturalModel_SparseDimensionsSequentialOrder(t *testing.T) {
	patterns := loadPatterns(t)

	m := &RepoMap{
		RepoName: "minimal-cli-tool",
		Files: []FileMap{
			{Path: "cmd/main.go", LOC: 80, Layer: LayerInterface, Exports: []string{"main"}},
			{Path: "internal/engine/worker.go", LOC: 200, Layer: LayerPipeline, Exports: []string{"DoWork"}},
		},
	}

	model := BuildArchitecturalModel(m, patterns)
	require.NotNil(t, model)
	require.Equal(t, 2, len(model.Dimensions), "极简仓应仅命中 2 个维度")

	// 验证动态自然序连续编号：第二个维度是“维度 2”，绝非硬编码的“维度 3”
	assert.Equal(t, "维度 1: 交付入口与门面契约 (Interface & Facade)", model.Dimensions[0].Title)
	assert.Equal(t, "维度 2: 核心执行引擎与管线 (Core Engine & Pipelines)", model.Dimensions[1].Title)
}

// 🧪 [346 准则 · LLM 意图尊崇] 当 LLM 产出包含特定业务语境的 PartTitle 时，系统坚决保留其业务命名，绝不以硬编码模板霸占。
func TestDecorateChapterDimensions_PreservesLLMPartTitles(t *testing.T) {
	arch := &ArchitecturalModel{
		Dimensions: []ArchDimension{
			{ID: DimInterfaceFacade, Title: "维度 1: 交付入口与门面契约 (Interface & Facade)"},
			{ID: DimCoreEngine, Title: "维度 2: 核心执行引擎与管线 (Core Engine & Pipelines)"},
		},
	}

	chapters := []cognitive.OutlineChapter{
		{
			Name:      "第 1 章：DPO 训练启动入口",
			PartTitle: "DPO 训练架构与门面接入",
			Files:     []cognitive.ChapterFile{{Path: "train.py"}},
		},
		{
			Name:      "第 2 章：多卡训练器与并行调度",
			PartTitle: "DPO 训练架构与门面接入",
			Files:     []cognitive.ChapterFile{{Path: "trainers.py"}},
		},
		{
			Name:      "第 3 章：偏好数据集与批量预处理",
			PartTitle: "偏好数据加载与样本管线",
			Files:     []cognitive.ChapterFile{{Path: "preference_datasets.py"}},
		},
	}

	decorateChapterDimensions(chapters, arch)

	assert.Equal(t, "Part 1: DPO 训练架构与门面接入", chapters[0].PartTitle, "LLM 原生业务命名必须保留，并由收敛漏斗赋予连续自然序")
	assert.Equal(t, "Part 1: DPO 训练架构与门面接入", chapters[1].PartTitle, "LLM 原生业务命名必须保留，并由收敛漏斗赋予连续自然序")
	assert.Equal(t, "Part 2: 偏好数据加载与样本管线", chapters[2].PartTitle, "LLM 原生业务命名必须保留，并由收敛漏斗赋予连续自然序")
}

// 🧪 [346 准则 · 孤儿章节自愈] 当 LLM 部分章节缺漏 PartTitle 时，系统自动沿用上下文补齐，保证连续无孤儿。
func TestDecorateChapterDimensions_HealsMissingPartTitles(t *testing.T) {
	arch := &ArchitecturalModel{
		Dimensions: []ArchDimension{
			{ID: DimInterfaceFacade, Title: "维度 1: 交付入口与门面契约 (Interface & Facade)"},
		},
	}

	chapters := []cognitive.OutlineChapter{
		{
			Name:      "第 1 章：启动入口",
			PartTitle: "第一分卷：核心系统",
			Files:     []cognitive.ChapterFile{{Path: "main.go"}},
		},
		{
			Name:      "第 2 章：工作流执行",
			PartTitle: "", // 缺漏
			Files:     []cognitive.ChapterFile{{Path: "worker.go"}},
		},
	}

	decorateChapterDimensions(chapters, arch)

	assert.Equal(t, "Part 1: 核心系统", chapters[0].PartTitle, "机械序数壳剥离后由漏斗统一重编自然序")
	assert.Equal(t, "Part 1: 核心系统", chapters[1].PartTitle, "缺漏的章节必须自动向前继承分卷归属")
}

// ─────────────────────────────────────────────────────────────
// RenderMultiScaleMap (契约 C6) 表驱动测试
// ─────────────────────────────────────────────────────────────

// multiScaleSectionLines 提取 text 中 [header] 起始、下一个 [ 或文末终止的段内行。
func multiScaleSectionLines(t *testing.T, text, header string) []string {
	t.Helper()
	marker := "[" + header + "]"
	lines := strings.Split(text, "\n")
	start := -1
	for i, ln := range lines {
		if strings.HasPrefix(ln, marker) {
			start = i + 1
			break
		}
	}
	require.NotEqual(t, -1, start, "段落 %s 应存在于渲染输出中", marker)
	var out []string
	for i := start; i < len(lines); i++ {
		if strings.HasPrefix(lines[i], "[") {
			break
		}
		if strings.TrimSpace(lines[i]) != "" {
			out = append(out, lines[i])
		}
	}
	return out
}

// multiScaleLineIndex 返回 block 中首个包含 sub 的行下标（不存在返回 -1）。
func multiScaleLineIndex(block []string, sub string) int {
	for i, ln := range block {
		if strings.Contains(ln, sub) {
			return i
		}
	}
	return -1
}

// newMultiPackageRepoMap 构造三包 Monorepo 夹具（reactivity / runtime-core /
// compiler-core），含跨包 AST 调用边。子系统发现与宏拓扑用与 gateway 生产
// 路径完全一致的两步管线推导。
func newMultiPackageRepoMap(t *testing.T) (*RepoMap, []SubsystemSpec, *MacroTopology) {
	t.Helper()
	patterns := loadPatterns(t)

	files := []FileMap{
		// packages/reactivity：入口 + 文档 + 高热核心 + 底座契约
		{Path: "packages/reactivity/src/index.ts", LOC: 60, Exports: []string{"reactive", "effect"}, Layer: LayerInterface},
		{Path: "packages/reactivity/README.md", LOC: 30, IsDoc: true},
		{Path: "packages/reactivity/src/effect.ts", LOC: 320, Exports: []string{"track", "trigger"}, Hotness: 85, Layer: LayerPipeline},
		{Path: "packages/reactivity/src/deps.ts", LOC: 140, Exports: []string{"Dep"}, Layer: LayerFoundation},
		// packages/runtime-core
		{Path: "packages/runtime-core/src/index.ts", LOC: 70, Exports: []string{"createApp"}, Layer: LayerInterface},
		{Path: "packages/runtime-core/src/vdom.ts", LOC: 500, Exports: []string{"render", "patch"}, Hotness: 95, Layer: LayerPipeline},
		{Path: "packages/runtime-core/src/h.ts", LOC: 90, Exports: []string{"h"}, Layer: LayerFoundation},
		// packages/compiler-core
		{Path: "packages/compiler-core/src/index.ts", LOC: 55, Exports: []string{"compile"}, Layer: LayerInterface},
		{Path: "packages/compiler-core/src/parser.ts", LOC: 420, Exports: []string{"parse"}, Hotness: 70, Layer: LayerPipeline},
		{Path: "packages/compiler-core/src/codegen.ts", LOC: 380, Exports: []string{"generate"}, Hotness: 40, Layer: LayerPipeline},
	}
	m := &RepoMap{
		RepoName: "vue-ish-monorepo",
		Files:    files,
		CallEdges: []ASTCallEdge{
			{Caller: "packages/runtime-core/src/vdom.ts", Callee: "packages/reactivity/src/effect.ts", Symbol: "track"},
			{Caller: "packages/compiler-core/src/codegen.ts", Callee: "packages/runtime-core/src/h.ts", Symbol: "h"},
		},
	}
	for _, f := range files {
		m.TotalLOC += f.LOC
	}
	m.Tree = BuildRepoTree(m.Files, m.RepoName)

	subsystems := DiscoverSubsystems(SubsystemSourcesFromRepoMap(m), patterns)
	topo := BuildMacroTopology(m, "", 1, patterns)
	return m, subsystems, topo
}

// TestRenderMultiScaleMap_MultiPackage 多包 Monorepo 夹具：保留全部核心
// 子系统全景与跨包依赖边；overview vs deep 产出不同的 Top-K 选材侧重。
func TestRenderMultiScaleMap_MultiPackage(t *testing.T) {
	m, subsystems, topo := newMultiPackageRepoMap(t)

	tests := []struct {
		name           string
		depth          string
		wantFirstInSub string // packages/reactivity 锚点块首行必含
		// 同块内行序断言：wantBefore 应先于 wantAfter 出现
		wantBefore string
		wantAfter  string
	}{
		{
			name:           "overview 前置文档与入口门面",
			depth:          "overview",
			wantFirstInSub: "effect.ts", // 高热度核心仍居首（热度基数占优）
			wantBefore:     "README.md",
			wantAfter:      "deps.ts",
		},
		{
			name:           "deep 前置高热度核心实现",
			depth:          "deep",
			wantFirstInSub: "effect.ts",
			wantBefore:     "deps.ts",
			wantAfter:      "README.md",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out := RenderMultiScaleMap(m, subsystems, topo, tt.depth, MultiScaleMapMaxTokens)
			require.NotEmpty(t, out)

			// 全景段：三个核心子系统一个不少
			pano := multiScaleSectionLines(t, out, "子系统全景")
			for _, name := range []string{"reactivity", "runtime-core", "compiler-core"} {
				require.NotEqual(t, -1, multiScaleLineIndex(pano, name), "全景行必须保留子系统 %s", name)
			}

			// 跨包依赖段：AST 边按子系统名渲染并携带调用符号
			deps := multiScaleSectionLines(t, out, "跨子系统依赖")
			require.NotEqual(t, -1, multiScaleLineIndex(deps, "runtime-core -> reactivity (track)"),
				"跨子系统依赖必须保留 runtime-core -> reactivity (track)，实际: %v", deps)

			// Top-K 锚点块按 teachingDepth 加权侧重
			block := multiScaleSectionLines(t, out, "reactivity 核心锚点")
			require.NotEmpty(t, block)
			assert.Equal(t, 0, multiScaleLineIndex(block, tt.wantFirstInSub),
				"reactivity 锚点块首行应为高热度核心实现，实际: %v", block)
			idxBefore := multiScaleLineIndex(block, tt.wantBefore)
			idxAfter := multiScaleLineIndex(block, tt.wantAfter)
			require.NotEqual(t, -1, idxBefore)
			require.NotEqual(t, -1, idxAfter)
			assert.Less(t, idxBefore, idxAfter,
				"%s 深度下 %s 应先于 %s（实际块序: %v）", tt.depth, tt.wantBefore, tt.wantAfter, block)

			// 锚点行格式：path | loc | hot | layer | exports(前3)
			assert.Contains(t, block[0], " | ", "锚点行应为管道分隔紧凑格式")
			assert.Contains(t, out, "Subsystem Topology")
		})
	}
}

// TestRenderMultiScaleMap_MicroRepo 微仓夹具：输出 RenderMap 全文 +
// m.Anchors 的 path#anchor | kind 逐行清单（现状二者从未进过 prompt 的新增增强）。
func TestRenderMultiScaleMap_MicroRepo(t *testing.T) {
	m := &RepoMap{
		RepoName:    "mitt-like",
		IsMicroRepo: true,
		Files: []FileMap{
			{Path: "README.md", LOC: 40, IsDoc: true},
			{Path: "src/index.ts", LOC: 110, Exports: []string{"mitt", "EventHandler"}, Layer: LayerInterface},
			{Path: "src/utils.ts", LOC: 55, Exports: []string{"once"}, Layer: LayerFoundation},
			{Path: "test/index.test.ts", LOC: 80, IsTest: true},
		},
		Anchors: []cognitive.CandidateOutlineFile{
			{Path: "src/index.ts", Anchor: "mitt", Kind: "function"},
			{Path: "src/index.ts", Anchor: "EventHandler", Kind: "type"},
			{Path: "src/utils.ts", Anchor: "once", Kind: "function"},
		},
	}
	for _, f := range m.Files {
		m.TotalLOC += f.LOC
	}

	out := RenderMultiScaleMap(m, nil, nil, "deep", MultiScaleMapMaxTokens)
	require.NotEmpty(t, out)

	// RenderMap 全文进 prompt（微仓头部标识）
	assert.Contains(t, out, "micro-repo mode")
	// path#anchor | kind 逐行锚点清单
	assert.Contains(t, out, "src/index.ts#mitt | function")
	assert.Contains(t, out, "src/index.ts#EventHandler | type")
	assert.Contains(t, out, "src/utils.ts#once | function")
	// 微仓分支不产出子系统全景
	assert.NotContains(t, out, "[子系统全景]")
}

// TestRenderMultiScaleMap_TokenBudgetTruncation 预算夹具：maxTokens=1500
// 时输出经 mdpat.EstimateTokens 校验不超硬上限，全景行保留到最后、
// 锚点行按低价值子系统优先被裁。
func TestRenderMultiScaleMap_TokenBudgetTruncation(t *testing.T) {
	patterns := loadPatterns(t)

	// 9 个长路径重符号子系统：宽预算渲染 >1500 tokens，
	// 强制预算漏斗逐级降 K / 砍低价值子系统锚点块
	var files []FileMap
	subNames := make([]string, 0, 9)
	for i := 1; i <= 9; i++ {
		sub := fmt.Sprintf("enterprise-analytics-reporting-suite-%02d", i)
		subNames = append(subNames, sub)
		for j := 1; j <= 6; j++ {
			files = append(files, FileMap{
				Path:    fmt.Sprintf("packages/%s/src/modules/realtime-event-stream/processors/temporal-windowing/windowed-aggregator-%d.ts", sub, j),
				LOC:     500 + j*40,
				Hotness: 60 + j,
				Layer:   LayerPipeline,
				Exports: []string{
					"InternationalizedCurrencyFormattingRegistry",
					"DistributedConsensusSchedulerCoordinator",
					"TemporalWindowBoundaryResolutionPolicyEngine",
				},
			})
		}
	}
	m := &RepoMap{RepoName: "budget-fixture", Files: files}
	for _, f := range files {
		m.TotalLOC += f.LOC
	}
	m.Tree = BuildRepoTree(m.Files, m.RepoName)
	subsystems := DiscoverSubsystems(SubsystemSourcesFromRepoMap(m), patterns)
	topo := BuildMacroTopology(m, "", 1, patterns)
	require.GreaterOrEqual(t, len(subsystems), 7, "预算夹具应识别出足够多子系统")
	// SSOT 契约：>8 候选截前 7 主干，尾流标记 auxiliary（锚点块只挂活跃子系统）
	activeCount := 0
	for _, s := range subsystems {
		if !s.IsAuxiliary {
			activeCount++
		}
	}
	require.LessOrEqual(t, activeCount, 7)

	// 宽预算基线：每活跃子系统 K=3 行锚点
	wideOut := RenderMultiScaleMap(m, subsystems, topo, "deep", MultiScaleMapMaxTokens)

	t.Run("宽预算下锚点块全保留且不超硬上限", func(t *testing.T) {
		assert.LessOrEqual(t, mdpat.EstimateTokens(wideOut), MultiScaleMapMaxTokens)
		assert.Equal(t, activeCount, strings.Count(wideOut, "核心锚点]"),
			"宽预算下每个活跃子系统都应保留锚点块")
	})

	t.Run("maxTokens=1500 硬上限内全景保留锚点行被裁", func(t *testing.T) {
		out := RenderMultiScaleMap(m, subsystems, topo, "deep", 1500)
		tok := mdpat.EstimateTokens(out)
		assert.LessOrEqual(t, tok, 1500, "渲染输出必须不超预算硬上限，实际: %d tokens", tok)

		// 全景行保留到最后：全部子系统行（含 auxiliary 尾流）一个不少
		pano := multiScaleSectionLines(t, out, "子系统全景")
		for _, name := range subNames {
			require.NotEqual(t, -1, multiScaleLineIndex(pano, name), "预算截断后全景行 %s 必须保留", name)
		}

		// 漏斗第一级"先降 K"：锚点行数严格少于宽预算（每活跃子系统 3 行 → 2 行）
		rowsWide := strings.Count(wideOut, ".ts | ")
		rowsNarrow := strings.Count(out, ".ts | ")
		assert.Less(t, rowsNarrow, rowsWide,
			"预算截断必须先降 K 裁锚点行：宽预算 %d 行 → 窄预算 %d 行", rowsWide, rowsNarrow)
	})

	t.Run("深预算下低价值子系统锚点块被裁全景保留", func(t *testing.T) {
		out := RenderMultiScaleMap(m, subsystems, topo, "deep", 900)
		assert.LessOrEqual(t, mdpat.EstimateTokens(out), 900, "深预算下仍不超硬上限")

		// 全景行保留：子系统一个不少
		pano := multiScaleSectionLines(t, out, "子系统全景")
		for _, name := range subNames {
			require.NotEqual(t, -1, multiScaleLineIndex(pano, name), "深预算截断后全景行 %s 必须保留", name)
		}

		// 漏斗第二级"砍低热度子系统锚点块"：保留块数严格少于活跃子系统总数
		kept := strings.Count(out, "核心锚点]")
		assert.Less(t, kept, activeCount, "深预算截断必须裁掉低价值子系统锚点块")
		// 被裁后仍保留的锚点块应是高价值（EstLOC 更大）子系统
		for _, s := range subsystems[kept:] {
			assert.NotContains(t, out, "["+s.Name+" 核心锚点]",
				"低价值子系统 %s 的锚点块应先被裁", s.Name)
		}
	})
}
