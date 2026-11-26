package transcription

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeLlmEdgeStore struct {
	concepts []SavedConceptNode
	replaced []LlmConceptEdgeInput
}

func (f *fakeLlmEdgeStore) GetDocumentConceptNodes(_ context.Context, _ string) ([]SavedConceptNode, error) {
	return f.concepts, nil
}

func (f *fakeLlmEdgeStore) ReplaceLlmConceptEdges(_ context.Context, _, _ string, edges []LlmConceptEdgeInput) (int, error) {
	f.replaced = edges
	return len(edges), nil
}

func llmEdgesFixture() []SavedConceptNode {
	return []SavedConceptNode{
		{ID: "c1", Slug: "s-event-loop", ConceptName: "Event Loop"},
		{ID: "c2", Slug: "s-promises", ConceptName: "Promises"},
		{ID: "c3", Slug: "s-async", ConceptName: "Async Patterns"},
	}
}

func TestSyncLlmEdgesForDocument(t *testing.T) {
	edgesPayload := map[string]any{
		"edges": []map[string]any{
			{"fromConcept": "Promises", "toConcept": "Event Loop", "type": "prerequisite", "weight": 0.9, "evidence": "事件循环是 Promise 的执行基础"},
			{"fromConcept": "s-async", "toConcept": "Promises", "type": "related", "weight": 0.4, "evidence": "异步模式常与 Promise 组合"},
			{"fromConcept": "Event Loop", "toConcept": "Unknown", "type": "related", "weight": 0.5, "evidence": "未解析概念应被丢弃"},
			{"fromConcept": "Event Loop", "toConcept": "Event Loop", "type": "related", "weight": 0.5, "evidence": "自环丢弃"},
			{"fromConcept": "A", "toConcept": "B", "type": "invalid_kind", "weight": 0.5, "evidence": "非法类型丢弃"},
		},
	}
	payload, err := json.Marshal(edgesPayload)
	require.NoError(t, err)

	t.Run("disabled by default (env gate off)", func(t *testing.T) {
		store := &fakeLlmEdgeStore{concepts: llmEdgesFixture()}
		llm := &fakeLlm{text: string(payload)}
		assert.Zero(t, SyncLlmEdgesForDocument(context.Background(), llm, store, "repo", "doc", "content", "u1"))
		assert.Empty(t, store.replaced)
	})

	t.Run("parses edges, resolves names/slugs, caps weight, drops unknown/self/invalid", func(t *testing.T) {
		t.Setenv("MCP_LLM_EDGES", "true")
		store := &fakeLlmEdgeStore{concepts: llmEdgesFixture()}
		llm := &fakeLlm{text: "前置说明\n" + string(payload)}
		n := SyncLlmEdgesForDocument(context.Background(), llm, store, "repo", "doc", strings.Repeat("x", 20000), "u1")
		assert.Equal(t, 2, n)
		require.Len(t, store.replaced, 2)
		assert.Equal(t, "c2", store.replaced[0].FromID)
		assert.Equal(t, "c1", store.replaced[0].ToID)
		assert.Equal(t, "prerequisite", store.replaced[0].Type)
		assert.Equal(t, llmEdgeWeightCap, store.replaced[0].Weight, "weight must cap at 0.6")
		assert.Equal(t, "c3", store.replaced[1].FromID, "slug must resolve to node id")
	})

	t.Run("fewer than two concepts short-circuits", func(t *testing.T) {
		t.Setenv("MCP_LLM_EDGES", "true")
		store := &fakeLlmEdgeStore{concepts: llmEdgesFixture()[:1]}
		llm := &fakeLlm{text: string(payload)}
		assert.Zero(t, SyncLlmEdgesForDocument(context.Background(), llm, store, "repo", "doc", "c", "u1"))
		assert.Empty(t, store.replaced)
	})

	t.Run("gateway failure stays silent without deleting old edges", func(t *testing.T) {
		t.Setenv("MCP_LLM_EDGES", "true")
		store := &fakeLlmEdgeStore{concepts: llmEdgesFixture()}
		llm := &fakeLlm{err: &LlmGatewayError{Code: "MISSING_API_KEY", Status: 409}}
		assert.Zero(t, SyncLlmEdgesForDocument(context.Background(), llm, store, "repo", "doc", "c", "u1"))
		assert.Empty(t, store.replaced)
	})
}
