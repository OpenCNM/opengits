package pipelineb

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/platform/client"
)

// captureGateway 记录 purpose 与变量的网关桩（teachingDepth 透传对拍）。
type captureGateway struct {
	purpose   string
	variables map[string]any
}

func (c *captureGateway) Complete(_ context.Context, purpose string, variables map[string]any, _ *string) (client.LlmTextResult, error) {
	c.purpose = purpose
	c.variables = variables
	return client.LlmTextResult{Text: `{"chapters":[{"name":"第 1 章: 桩","summary":"s","files":["a.go"],"phase":"入门"}]}`}, nil
}

func (c *captureGateway) Generate(_ context.Context, purpose string, variables map[string]any, _ *string, out any) error {
	c.purpose = purpose
	c.variables = variables
	obj := map[string]any{
		"chapters": []any{map[string]any{
			"name": "第 1 章: 桩", "summary": "s", "files": []any{"a.go"}, "phase": "入门",
		}},
	}
	*out.(*map[string]any) = obj
	return nil
}

// TestGatewayTeachingDepthThreading 教学深度全链路透传：网关适配器把
// TeachingDepth 原样注入 purpose 变量；空值省略（零注入面）。
func TestGatewayTeachingDepthThreading(t *testing.T) {
	tests := []struct {
		name       string
		depth      string
		wantVarVal any // nil = 变量应缺席
	}{
		{name: "overview 透传", depth: "overview", wantVarVal: "overview"},
		{name: "standard 透传", depth: "standard", wantVarVal: "standard"},
		{name: "deep 透传", depth: "deep", wantVarVal: "deep"},
		{name: "空值省略变量（零注入面）", depth: "", wantVarVal: nil},
	}

	for _, tt := range tests {
		t.Run("planner "+tt.name, func(t *testing.T) {
			gw := &captureGateway{}
			gp := &GatewayPlanner{Client: gw, TeachingDepth: tt.depth, Pacing: "normal"}
			_, err := gp.Plan(context.Background(), "skeleton", nil, "", "zh-CN")
			require.NoError(t, err)
			assert.Equal(t, OutlinePlanPurpose, gw.purpose)
			assert.Equal(t, tt.wantVarVal, gw.variables["teachingDepth"])
		})
		t.Run("model "+tt.name, func(t *testing.T) {
			gw := &captureGateway{}
			gm := &GatewayModel{Client: gw, TeachingDepth: tt.depth}
			_, err := gm.Complete(context.Background(), ModelRequest{
				RepoMap:        &RepoMap{RepoName: "r"},
				TargetLanguage: "zh-CN",
			})
			require.NoError(t, err)
			assert.Equal(t, OutlinePurpose, gw.purpose)
			assert.Equal(t, tt.wantVarVal, gw.variables["teachingDepth"])
		})
	}
}

// TestHandlerForReqThreading 请求意图（customPrompt/pacing/teachingDepth/learnerArchetype）
// 动态挂载到按用户派生的网关适配器克隆上。
func TestHandlerForReqThreading(t *testing.T) {
	base := &GatewayPlanner{Client: &captureGateway{}}
	h := &Handler{
		plannerFor: func(string) PlannerModel { return base },
		modelFor:   func(string) OutlineModel { return &GatewayModel{Client: &captureGateway{}} },
	}

	gp, ok := h.plannerForReq("user-1", "聚焦网络层", "compact", "deep", "architecture_overview").(*GatewayPlanner)
	require.True(t, ok)
	assert.Equal(t, "聚焦网络层", gp.CustomPrompt)
	assert.Equal(t, "compact", gp.Pacing)
	assert.Equal(t, "deep", gp.TeachingDepth)
	assert.Equal(t, "architecture_overview", gp.LearnerArchetype)

	gm, ok := h.modelForReq("user-1", "聚焦网络层", "overview", "deep_dive_internals", "detailed").(*GatewayModel)
	require.True(t, ok)
	assert.Equal(t, "聚焦网络层", gm.CustomPrompt)
	assert.Equal(t, "overview", gm.TeachingDepth)
	assert.Equal(t, "deep_dive_internals", gm.LearnerArchetype)
	assert.Equal(t, "detailed", gm.Pacing)
}

// TestGatewayLearnerArchetypeThreading 学习者画像（learnerArchetype）透传：
// 网关适配器把 LearnerArchetype 注入 purpose 变量；空值省略。
func TestGatewayLearnerArchetypeThreading(t *testing.T) {
	archetypes := []string{
		"architecture_overview",
		"deep_dive_internals",
		"cross_language_migrant",
		"pedagogical_beginner",
	}

	for _, at := range archetypes {
		t.Run("model "+at, func(t *testing.T) {
			gw := &captureGateway{}
			gm := &GatewayModel{Client: gw, LearnerArchetype: at, Pacing: "compact"}
			_, err := gm.Complete(context.Background(), ModelRequest{
				RepoMap:        &RepoMap{RepoName: "r"},
				TargetLanguage: "zh-CN",
			})
			require.NoError(t, err)
			assert.Equal(t, OutlinePurpose, gw.purpose)
			assert.Equal(t, at, gw.variables["learnerArchetype"])
			assert.Equal(t, "compact", gw.variables["pacing"])
		})

		t.Run("planner "+at, func(t *testing.T) {
			gw := &captureGateway{}
			gp := &GatewayPlanner{Client: gw, LearnerArchetype: at}
			_, err := gp.Plan(context.Background(), "skeleton", nil, "", "zh-CN")
			require.NoError(t, err)
			assert.Equal(t, OutlinePlanPurpose, gw.purpose)
			assert.Equal(t, at, gw.variables["learnerArchetype"])
		})
	}
}

// samplerCaptureGateway 采样 purpose 网关桩：捕获 vars 并产出 OutlineSamplerResult。
type samplerCaptureGateway struct {
	variables map[string]any
}

func (c *samplerCaptureGateway) Complete(_ context.Context, _ string, _ map[string]any, _ *string) (client.LlmTextResult, error) {
	return client.LlmTextResult{}, errors.New("not implemented")
}

func (c *samplerCaptureGateway) Generate(_ context.Context, _ string, variables map[string]any, _ *string, out any) error {
	c.variables = variables
	ptr, ok := out.(*OutlineSamplerResult)
	if !ok {
		return errors.New("out must be *OutlineSamplerResult")
	}
	*ptr = OutlineSamplerResult{ArchitectureArchetype: "stub", NeedFiles: []string{"a.go"}}
	return nil
}

// TestGatewaySamplerConditionThreading 采样器条件透传（契约 C3/C5·策略 B）：
// GatewaySampler 把 TeachingDepth/LearnerArchetype/CustomPrompt 注入网关 vars
// （键名 teachingDepth / learnerArchetype / customPrompt）；空值省略（零注入面）。
func TestGatewaySamplerConditionThreading(t *testing.T) {
	tests := []struct {
		name             string
		teachingDepth    string
		archetype        string
		customPrompt     string
		wantDepth        any // nil = 变量应缺席
		wantArchetype    any
		wantCustomPrompt any
	}{
		{
			name:             "三字段全透传",
			teachingDepth:    "deep",
			archetype:        "deep_dive_internals",
			customPrompt:     "聚焦编译器管线",
			wantDepth:        "deep",
			wantArchetype:    "deep_dive_internals",
			wantCustomPrompt: "聚焦编译器管线",
		},
		{
			name:          "仅教学深度，其余缺席",
			teachingDepth: "overview",
			wantDepth:     "overview",
			wantArchetype: nil,
		},
		{
			name: "空值全部省略（零注入面）",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gw := &samplerCaptureGateway{}
			gs := &GatewaySampler{
				Client:           gw,
				TeachingDepth:    tt.teachingDepth,
				LearnerArchetype: tt.archetype,
				CustomPrompt:     tt.customPrompt,
			}
			_, err := gs.SampleCoreFiles(context.Background(), SampleRequest{
				Skeleton: "skeleton",
				Readme:   "# README",
				Prefix:   "packages/core",
			})
			require.NoError(t, err)
			assert.Equal(t, "skeleton", gw.variables["skeleton"])
			assert.Equal(t, "# README", gw.variables["readme"])
			assert.Equal(t, "packages/core", gw.variables["prefix"])
			assert.Equal(t, tt.wantDepth, gw.variables["teachingDepth"])
			assert.Equal(t, tt.wantArchetype, gw.variables["learnerArchetype"])
			assert.Equal(t, tt.wantCustomPrompt, gw.variables["customPrompt"])
		})
	}
}

// TestHandlerSamplerForReqThreading 采样器按请求克隆挂载条件（与 plannerForReq/
// modelForReq 同构）：网关采样器带条件克隆，非网关采样器原样返回。
func TestHandlerSamplerForReqThreading(t *testing.T) {
	gw := &samplerCaptureGateway{}
	base := &GatewaySampler{Client: gw}
	h := &Handler{
		sampler:    base,
		samplerFor: func(string) OutlineSampler { return base },
	}

	s := h.samplerForReq("user-1", "聚焦网络层", "deep", "architecture_overview")
	cloned, ok := s.(*GatewaySampler)
	require.True(t, ok)
	assert.Equal(t, "聚焦网络层", cloned.CustomPrompt)
	assert.Equal(t, "deep", cloned.TeachingDepth)
	assert.Equal(t, "architecture_overview", cloned.LearnerArchetype)

	res, err := cloned.SampleCoreFiles(context.Background(), SampleRequest{Skeleton: "s", Readme: "r"})
	require.NoError(t, err)
	require.NotNil(t, res)
	assert.Equal(t, "deep", gw.variables["teachingDepth"], "挂载条件必须注入网关 vars")
	assert.NotNil(t, h.samplerForReq("user-2", "", "", ""), "条件全空且基础采样器存在时仍返回采样器")
}
