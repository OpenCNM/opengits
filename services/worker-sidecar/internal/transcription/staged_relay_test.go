package transcription

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

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

func relaySourceRaw() string {
	return relaySampleSource(3, 4)
}

func TestRunStagedRelayBodyHappyPath(t *testing.T) {
	web := &fakeWeb{prepare: readyPrep("", nil, false), valid: true}
	st := &fakeBodyStore{cas: true}
	deps := TranscriptionBodyDeps{
		Web:         web,
		PrepareFunc: web.Prepare,
		Llm:         &fakeGenLlm{},
		Store:       st,
	}
	_, err := RunStagedRelayBody(context.Background(), loadConfigFromEnv(), deps, "d1", "u1", "sha-x", "")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "source file empty or archive missing")
	assert.Empty(t, st.cleared, "relay must not touch document status")
	assert.Empty(t, st.saved, "relay must not checkpoint")
}

func TestRelayGlossarySection(t *testing.T) {
	empty := relayGlossarySection(nil)
	assert.Contains(t, empty, "全书术语表暂空")
	filled := relayGlossarySection([]string{"智能体循环", "工具调用"})
	assert.Contains(t, filled, "全书术语表（译法必须与此一致")
	assert.Contains(t, filled, "- 智能体循环\n- 工具调用")
}
