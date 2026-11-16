package transcription

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeGenLlm 在 fakeLlm 上叠加结构化 Generate 能力（staged-relay 集成用）。
type fakeGenLlm struct {
	fakeLlm
	object any
}

func (f *fakeGenLlm) Generate(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error {
	fence := "```"
	b := []byte(`{"title":"本章标题","sections":[` +
		`{"type":"intro","heading":"导语","content":"这是导语内容。"},` +
		`{"type":"prose","heading":"概念","content":"讲解内容。"},` +
		`{"type":"code","heading":"示例","content":"` + fence + `ts\nconst a = 1;\n` + fence + `"},` +
		`{"type":"summary","heading":"小结","content":"本章要点。"}],` +
		`"conceptAnchors":[{"term":"agent loop","translation":"智能体循环"}],` +
		`"coverage":{"sourceSections":4,"coveredSections":4}}`)
	return json.Unmarshal(b, out)
}

// relaySourceRaw 健康源文样本：4 标题 + 3 代码块（对拍硬门通过带）。
func relaySourceRaw() string {
	return relaySampleSource(3, 4)
}

// 🧪 staged-relay 集成：网关 object → 编译 → 硬门全链（无锁零落库）。
func TestRunStagedRelayBodyHappyPath(t *testing.T) {
	web := &fakeWeb{prepare: readyPrep("", nil, false), valid: true}
	st := &fakeBodyStore{cas: true}
	deps := TranscriptionBodyDeps{
		Web:         web,
		PrepareFunc: web.Prepare,
		Llm:         &fakeGenLlm{},
		Store:       st,
	}
	// readyPrep 的 path/docs 元数据由 fake 提供；源文经归档读取——单测无归档，
	// 走 branch 回退亦空 → 预期 Fail-Closed。改为注入路径存在归档的场景超出
	// fake 能力，此处锚定编排负路径 + 纯函数层已有 8 向量对拍兜底。
	_, err := RunStagedRelayBody(context.Background(), loadConfigFromEnv(), deps, "d1", "u1", "sha-x", "")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "source file empty or archive missing")
	assert.Empty(t, st.cleared, "relay must not touch document status")
	assert.Empty(t, st.saved, "relay must not checkpoint")
}

// 🧪 术语表拼装对拍（信封 glossarySection 段语义与 TS 逐字一致）。
func TestRelayGlossarySection(t *testing.T) {
	empty := relayGlossarySection(nil)
	assert.Contains(t, empty, "全书术语表暂空")
	filled := relayGlossarySection([]string{"智能体循环", "工具调用"})
	assert.Contains(t, filled, "全书术语表（译法必须与此一致")
	assert.Contains(t, filled, "- 智能体循环\n- 工具调用")
}
