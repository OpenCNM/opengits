package mcp

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockToolHandler struct {
	response readResult
	invoked  bool
}

func (m *mockToolHandler) Execute(_ context.Context, _ *readService, _ ToolExecutionContext) readResult {
	m.invoked = true
	return m.response
}

type mockHubToolHandler struct {
	response readResult
	handled  bool
	invoked  bool
}

func (m *mockHubToolHandler) Execute(_ context.Context, _ *readService, _ HubToolExecutionContext) (readResult, bool) {
	m.invoked = true
	return m.response, m.handled
}

func TestToolRegistryDispatch(t *testing.T) {
	tests := []struct {
		name          string
		setupRegistry func() *ToolRegistry
		env           ToolExecutionContext
		expectedText  string
		expectedErr   bool
	}{
		{
			name: "direct handler hit",
			setupRegistry: func() *ToolRegistry {
				reg := newToolRegistry(nil)
				reg.Register("custom_tool", &mockToolHandler{response: readResult{Text: "custom output"}})
				return reg
			},
			env: ToolExecutionContext{
				Canonical: "custom_tool",
			},
			expectedText: "custom output",
			expectedErr:  false,
		},
		{
			name: "facade dispatches to browse",
			setupRegistry: func() *ToolRegistry {
				reg := newToolRegistry(nil)
				reg.Register("browse", &mockToolHandler{response: readResult{Text: "facade browse output"}})
				return reg
			},
			env: ToolExecutionContext{
				Canonical:            "read_document",
				IsReadDocumentFacade: true,
			},
			expectedText: "facade browse output",
			expectedErr:  false,
		},
		{
			name: "fallback to default handler",
			setupRegistry: func() *ToolRegistry {
				return newToolRegistry(&mockToolHandler{response: readResult{Text: "fallback output"}})
			},
			env: ToolExecutionContext{
				Canonical: "unknown_tool",
			},
			expectedText: "fallback output",
			expectedErr:  false,
		},
		{
			name: "unsupported tool without default handler",
			setupRegistry: func() *ToolRegistry {
				return newToolRegistry(nil)
			},
			env: ToolExecutionContext{
				Canonical: "non_existent_tool",
			},
			expectedText: "unsupported tool: non_existent_tool",
			expectedErr:  true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			reg := tc.setupRegistry()
			res := reg.Dispatch(context.Background(), nil, tc.env)
			assert.Equal(t, tc.expectedErr, res.IsError)
			assert.Equal(t, tc.expectedText, res.Text)
		})
	}
}

func TestHubToolRegistryDispatch(t *testing.T) {
	tests := []struct {
		name          string
		setupRegistry func() *HubToolRegistry
		env           HubToolExecutionContext
		expectedText  string
		expectedOK    bool
	}{
		{
			name: "direct hub handler hit",
			setupRegistry: func() *HubToolRegistry {
				reg := newHubToolRegistry()
				reg.Register("hub_tool", &mockHubToolHandler{response: readResult{Text: "hub result"}, handled: true})
				return reg
			},
			env: HubToolExecutionContext{
				Canonical: "hub_tool",
			},
			expectedText: "hub result",
			expectedOK:   true,
		},
		{
			name: "unknown hub tool returns false",
			setupRegistry: func() *HubToolRegistry {
				return newHubToolRegistry()
			},
			env: HubToolExecutionContext{
				Canonical: "missing_hub_tool",
			},
			expectedText: "",
			expectedOK:   false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			reg := tc.setupRegistry()
			res, ok := reg.Dispatch(context.Background(), nil, tc.env)
			assert.Equal(t, tc.expectedOK, ok)
			assert.Equal(t, tc.expectedText, res.Text)
		})
	}
}

func TestDefaultRegistriesContainCoreTools(t *testing.T) {
	reg := defaultToolRegistry()
	require.NotNil(t, reg)
	hubReg := defaultHubToolRegistry()
	require.NotNil(t, hubReg)

	canonicalSet := make(map[string]bool)
	for _, canonical := range toolCanonicalName {
		canonicalSet[canonical] = true
	}
	require.NotEmpty(t, canonicalSet)

	t.Run("single-repo registry", func(t *testing.T) {
		for canonical := range canonicalSet {
			_, ok := reg.handlers[canonical]
			assert.Truef(t, ok,
				"alias-table canonical %q has no explicit handler in single-repo registry (would hit fail-closed unsupportedToolHandler in production)", canonical)
		}
	})
	t.Run("hub registry", func(t *testing.T) {
		for canonical := range canonicalSet {
			_, ok := hubReg.handlers[canonical]
			assert.Truef(t, ok,
				"alias-table canonical %q has no explicit handler in hub registry (would break native hub dispatch)", canonical)
		}
	})

	reg.defaultH = unsupportedToolHandler{}
	out := reg.Dispatch(context.Background(), nil, ToolExecutionContext{Canonical: "nonexistent-tool"})
	assert.True(t, out.IsError)
	assert.Contains(t, out.Text, "unsupported tool: nonexistent-tool")
}
