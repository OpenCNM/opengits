package pipelineb

import (
	"context"
	"errors"
	"fmt"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/platform/client"
)

// ─────────────────────────────────────────────────────────────
// 网关 purpose 适配器（生产路径）。
//
// purpose: outline_map_v1（registry.ts 注册，kind=structured——流式直出通道
// 在网关侧终局 zod 校验后才发 done，validated object 以 text 承载）。本适配器
// 只搬运变量；流式 NDJSON 传输（x-stream-mode）带来活性看门狗与截止抢救
// 两个物理收益：消费方可据 chunk 增量判活、按剩余预算切断并回收残文。
// ─────────────────────────────────────────────────────────────

// OutlinePurpose 网关 purpose 名（与 apps/client registry.ts 单一登记对应）。
const OutlinePurpose = "outline_map_v1"

// outline_map_v1 深度 1 走全仓宏观拓扑：scope 根目录空串 + Scale 1
// (C4 L1 系统上下文；子系统下钻 Scale 2 属深度 2 drill 路径)。
const (
	outlineMapScope = ""
	outlineMapScale = 1
)

// LlmGateway 结构化 purpose 调用面（*client.LlmGatewayClient 即满足）。
// Generate: 一元 JSON（历史路径，转录等批量用途）；Complete: 流式 NDJSON
// （交互路径——活性判定 + 截止抢救的物理载体）。
type LlmGateway interface {
	Generate(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error
	Complete(ctx context.Context, purpose string, variables map[string]any, userId *string) (client.LlmTextResult, error)
}

// GatewayModel 网关模型实现（BYOK/预算/记账走网关既有漏斗）。
type GatewayModel struct {
	Client       LlmGateway
	UserID       *string
	CustomPrompt string
	// TeachingDepth 教学深度(overview/standard/deep)——compile 侧据此切换
	// 章节带与文件选取策略(门面契约 / 核心业务流 / 底层实现与边界)；
	// 同时加权 RenderMultiScaleMap 的确定性选材评分。
	TeachingDepth string
	// LearnerArchetype 学习者画像(architecture_overview/deep_dive_internals/cross_language_migrant/pedagogical_beginner)。
	LearnerArchetype string
	// Pacing 节奏 (compact/normal/detailed)。
	Pacing string
	// PatternsFn 内容卫生模式工厂（子系统发现/宏拓扑消费）；
	// nil 时回退 cognitive.DefaultPatterns() 原生预编译单例（与 Handler
	// 生产注入的默认注册表同源）。
	PatternsFn func() cognitive.Patterns
}

// patternsFor 解析内容卫生模式（失效封闭：绝不向下游传 nil patterns）。
func (g *GatewayModel) patternsFor() cognitive.Patterns {
	if g.PatternsFn != nil {
		if p := g.PatternsFn(); p != nil {
			return p
		}
	}
	return cognitive.DefaultPatterns()
}

// TeachingContext 暴露教学条件供确定性覆盖率门禁做冲突裁决
// （Run 签名保持不变——teachingDepth/customPrompt 经模型实例随路携带，
// 实现 teachingContextAware 可选接口）。
func (g *GatewayModel) TeachingContext() (teachingDepth, customPrompt string) {
	return g.TeachingDepth, g.CustomPrompt
}

// Complete 变量搬运 + object 回编（解析闸门在 Run 统一执行）。
func (g *GatewayModel) Complete(ctx context.Context, req ModelRequest) (string, error) {
	mapText := ""
	if req.RepoMap != nil {
		// LLM 路径主道：多尺度子系统地图（全景 + 跨包依赖 + Top-K 锚点），
		// 取代 RenderArchModel 的 5 维截断投影（子系统/锚点从未进过 prompt）。
		patterns := g.patternsFor()
		subsystems := DiscoverSubsystems(SubsystemSourcesFromRepoMap(req.RepoMap), patterns)
		topo := BuildMacroTopology(req.RepoMap, outlineMapScope, outlineMapScale, patterns)
		mapText = RenderMultiScaleMap(req.RepoMap, subsystems, topo, g.TeachingDepth, MultiScaleMapMaxTokens)
	} else if req.ArchModel != nil {
		// 失效封闭兜底：无 RepoMap 物理事实时退回旧确定性五维投影（保留不删）。
		mapText = RenderArchModel(req.ArchModel)
	}
	vars := map[string]any{
		"map":              mapText,
		"targetLanguage":   req.TargetLanguage,
		"skipMetaCompiler": true,
	}
	prompt := g.CustomPrompt
	if req.ContinuationPrompt != "" {
		if prompt != "" {
			prompt = prompt + "\n\n" + req.ContinuationPrompt
		} else {
			prompt = req.ContinuationPrompt
		}
	}
	if prompt != "" {
		vars["customPrompt"] = prompt
	}
	if g.TeachingDepth != "" {
		vars["teachingDepth"] = g.TeachingDepth
	}
	if g.LearnerArchetype != "" {
		vars["learnerArchetype"] = g.LearnerArchetype
	}
	if g.Pacing != "" {
		vars["pacing"] = g.Pacing
	}
	// 契约 C7：覆盖率门禁修订指令，仅非空才传（深度 1 单次回流专用变量）
	if req.CoverageFeedback != "" {
		vars["coverageFeedback"] = req.CoverageFeedback
	}
	// 流式直出（活性看门狗 + 截止抢救）：validated object 由网关终局 zod
	// 闸门保证并以 text 承载；deadline 切断时残文随 ErrStreamPartial 上抛，
	// 由调用方（Run）做确定性章节抢救。
	res, err := g.Client.Complete(ctx, OutlinePurpose, vars, g.UserID)
	if err != nil {
		if errors.Is(err, client.ErrStreamPartial) && res.Text != "" {
			return res.Text, err
		}
		return "", fmt.Errorf("gateway %s: %w", OutlinePurpose, err)
	}
	return res.Text, nil
}

var _ OutlineModel = (*GatewayModel)(nil)

// OutlinePlanPurpose 规划 purpose 名(registry.ts 登记,zod:chapters/needRollup)。
const OutlinePlanPurpose = "outline_plan_v1"

// GatewayPlanner 规划调用的网关适配器(outline_plan_v1,结构化 zod 漏斗)。
type GatewayPlanner struct {
	Client       LlmGateway
	UserID       *string
	CustomPrompt string
	Pacing       string
	// TeachingDepth 教学深度(overview/standard/deep)——compile 侧据此切换
	// 章节带(3~6/7~10/10~14)与 drillDown 倾向;pacing 显式时仍以最近意图定带。
	TeachingDepth string
	// LearnerArchetype 学习者画像(architecture_overview/deep_dive_internals/cross_language_migrant/pedagogical_beginner)。
	LearnerArchetype string
}

// Plan 骨架(+可选补料/反馈)→ 网关规划 → 校验后的 JSON 文本(解析闸门在 obtainPlan)。
// feedback 非空 = 退化规划的反馈重规划(vars.planFeedback 由 compile 渲染)。
func (g *GatewayPlanner) Plan(ctx context.Context, skeleton string, rollups map[string]string, feedback string, targetLanguage string) (string, error) {
	vars := map[string]any{
		"skeleton":         skeleton,
		"targetLanguage":   targetLanguage,
		"maxChapters":      10,
		"skipMetaCompiler": true,
	}
	if g.Pacing != "" {
		vars["pacing"] = g.Pacing
		if g.Pacing == "compact" {
			vars["maxChapters"] = 6
		} else if g.Pacing == "detailed" {
			vars["maxChapters"] = 14
		}
	}
	if g.CustomPrompt != "" {
		vars["customPrompt"] = g.CustomPrompt
	}
	if g.TeachingDepth != "" {
		vars["teachingDepth"] = g.TeachingDepth
	}
	if g.LearnerArchetype != "" {
		vars["learnerArchetype"] = g.LearnerArchetype
	}
	if len(rollups) > 0 {
		vars["rollups"] = rollups
	}
	if feedback != "" {
		vars["planFeedback"] = feedback
	}
	// 流式直出：与 GatewayModel 同一传输契约（validated object 以 text 承载）。
	// 规划层不做截止抢救（有反馈重规划机制兜底），错误原样上抛。
	res, err := g.Client.Complete(ctx, OutlinePlanPurpose, vars, g.UserID)
	if err != nil {
		return "", fmt.Errorf("gateway %s: %w", OutlinePlanPurpose, err)
	}
	return res.Text, nil
}

// TeachingContext 暴露教学条件供覆盖率门禁冲突裁决（teachingContextAware
// 可选接口）：深度 2 观测在 model 侧缺席该接口时回读 planner 条件——
// 条件字段在 handler clone 注入时已存在，读自身字段即可。
func (g *GatewayPlanner) TeachingContext() (teachingDepth, customPrompt string) {
	return g.TeachingDepth, g.CustomPrompt
}

var _ PlannerModel = (*GatewayPlanner)(nil)
