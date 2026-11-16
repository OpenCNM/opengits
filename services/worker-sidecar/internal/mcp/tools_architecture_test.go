package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 🧪 Table-driven tests for MCP Architecture Topology (C4 L1-L3)

func TestExtractMacroTopologySection(t *testing.T) {
	mermaidSample := "```mermaid\nflowchart TD\n  sub_api[\"API\"] --> sub_core[\"Core\"]\n```"
	profileWithMermaid, _ := json.Marshal(map[string]any{
		"macroTopologyMermaid": mermaidSample,
		"codeClusters": []map[string]any{
			{"teachingOrder": 1, "title": "API Gateway", "files": []string{"cmd/api/main.go"}, "cognitive": map[string]any{"phase": "interface"}},
			{"teachingOrder": 2, "title": "Core Service", "files": []string{"internal/core/service.go"}, "cognitive": map[string]any{"phase": "core"}},
		},
	})

	topoMermaid := "```mermaid\nflowchart TD\n  subgraph Interface[\"接入与调度层\"]\n    sub_api[\"API Entry<br/>3 files · 500 LOC\"]\n  end\n  subgraph Infra[\"基础支持与数据底座\"]\n    sub_db[\"DB Layer<br/>5 files · 1.2k LOC\"]\n  end\n  sub_api -->|\"queries\"| sub_db\n```"
	profileWithTopo, _ := json.Marshal(map[string]any{
		"macroTopology": map[string]any{
			"nodes": []map[string]any{
				{"id": "sub_api", "name": "API Entry", "role": "interface", "fileCount": 3, "loc": 500},
				{"id": "sub_db", "name": "DB Layer", "role": "infra", "fileCount": 5, "loc": 1200},
			},
			"edges": []map[string]any{
				{"from": "sub_api", "to": "sub_db", "weight": 2, "label": "queries"},
			},
			"rawMermaid": topoMermaid,
		},
	})

	tests := []struct {
		name         string
		repo         RepoRow
		wantContains []string
		wantEmpty    bool
	}{
		{
			name: "explicit macroTopologyMermaid string in repoProfile",
			repo: RepoRow{
				Owner: "opengits", Repo: "sample-core",
				RepoProfile: profileWithMermaid,
			},
			wantContains: []string{
				"🏛️ Architecture Topology (C4 L1 System Context):",
				"flowchart TD",
				"sub_api[\"API\"] --> sub_core[\"Core\"]",
				"### Subsystems & Modules:",
				"**API Gateway**",
				"**Core Service**",
			},
		},
		{
			name: "macroTopology struct in repoProfile",
			repo: RepoRow{
				Owner: "opengits", Repo: "sample-topo",
				RepoProfile: profileWithTopo,
			},
			wantContains: []string{
				"🏛️ Architecture Topology (C4 L1 System Context):",
				"subgraph Interface",
				"subgraph Infra",
				"sub_api -->|\"queries\"| sub_db",
				"### Subsystems & Modules:",
				"**API Entry** (3 files · 500 LOC) [Interface & Delivery]",
				"**DB Layer** (5 files · 1200 LOC) [Infrastructure & Storage]",
			},
		},
		{
			name: "dynamic projection from codeClusters with cognitive metadata",
			repo: RepoRow{
				Owner: "opengits", Repo: "sample-clusters",
				RepoProfile: json.RawMessage(`{
					"codeClusters": [
						{
							"teachingOrder": 1,
							"title": "HTTP Gateway",
							"directories": ["cmd/server"],
							"files": ["cmd/server/main.go", "cmd/server/router.go"],
							"cognitive": {
								"phase": "interface",
								"upstreamModules": []
							}
						},
						{
							"teachingOrder": 2,
							"title": "Business Engine",
							"directories": ["internal/engine"],
							"files": ["internal/engine/processor.go"],
							"cognitive": {
								"phase": "core",
								"upstreamModules": ["cmd/server"]
							}
						},
						{
							"teachingOrder": 3,
							"title": "Database Storage",
							"directories": ["internal/storage"],
							"files": ["internal/storage/db.go"],
							"cognitive": {
								"phase": "infra",
								"upstreamModules": ["internal/engine"]
							}
						}
					]
				}`),
			},
			wantContains: []string{
				"🏛️ Architecture Topology (C4 L1 System Context):",
				"```mermaid\nflowchart TD",
				"subgraph Interface[\"接入与调度层\"]",
				"subgraph Core[\"核心业务引擎\"]",
				"subgraph Infra[\"基础支持与数据底座\"]",
				"-->|\"depends on\"|",
				"### Subsystems & Modules:",
				"**HTTP Gateway** (2 files) [Interface & Delivery]",
				"**Business Engine** (1 files) [Core Logic]",
				"**Database Storage** (1 files) [Infrastructure & Storage]",
			},
		},
		{
			name: "pure doc repository (web-docs without codeClusters)",
			repo: RepoRow{
				Owner: "opengits", Repo: "react-docs",
				RepoProfile: json.RawMessage(`{"repoType": "web-docs", "description": "Official React Documentation"}`),
			},
			wantEmpty: true,
		},
		{
			name: "empty repoProfile",
			repo: RepoRow{
				Owner: "opengits", Repo: "empty-repo",
				RepoProfile: nil,
			},
			wantEmpty: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractMacroTopologySection(tt.repo)
			if tt.wantEmpty {
				assert.Empty(t, got)
			} else {
				require.NotEmpty(t, got)
				for _, substr := range tt.wantContains {
					assert.Contains(t, got, substr)
				}
			}
		})
	}
}

func TestRenderOutlineArchitectureHeader(t *testing.T) {
	tests := []struct {
		name         string
		repo         RepoRow
		docs         []DocMeta
		wantPrefix   string
		wantContains []string
		wantSuffix   string
	}{
		{
			name: "repo with codeClusters renders topology before docs list",
			repo: RepoRow{
				Owner: "octo", Repo: "engine",
				RepoProfile: json.RawMessage(`{
					"codeClusters": [
						{"teachingOrder": 1, "title": "Engine Core", "files": ["main.go"], "cognitive": {"phase": "core"}}
					]
				}`),
			},
			docs: []DocMeta{
				{ID: "doc-1", Path: "README.md", Title: "Introduction"},
			},
			wantPrefix: "🏛️ Architecture Topology (C4 L1 System Context):",
			wantContains: []string{
				"flowchart TD",
				"Available Documentation in octo/engine:",
				"- Introduction (README.md)",
			},
			wantSuffix: "(Next steps: use explore_concept with action=\"architecture\" to drill down into subsystem architecture diagrams, outline with \"path\" to inspect document headings, search to find keywords, or read with \"target\" to read content.)",
		},
		{
			name: "pure doc repo leaves out architecture topology and preserves standard next steps",
			repo: RepoRow{
				Owner: "octo", Repo: "docs-only",
				RepoProfile: json.RawMessage(`{"description": "Documentation Only"}`),
			},
			docs: []DocMeta{
				{ID: "doc-1", Path: "guide.md", Title: "Guide"},
			},
			wantPrefix: "Available Documentation in octo/docs-only:",
			wantContains: []string{
				"- Guide (guide.md)",
			},
			wantSuffix: "(Next steps: use outline with \"path\" to inspect document headings, search to find keywords, or read with \"target\" to read content.)",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := RenderOutlineFromResolved(tt.repo, tt.docs, nil)
			assert.True(t, strings.HasPrefix(got, tt.wantPrefix), "expected prefix %q in output", tt.wantPrefix)
			for _, substr := range tt.wantContains {
				assert.Contains(t, got, substr)
			}
			assert.True(t, strings.HasSuffix(got, tt.wantSuffix), "expected suffix %q in output", tt.wantSuffix)
		})
	}
}

func TestExploreConceptArchitecture(t *testing.T) {
	service := &readService{store: newReadFakeStore()}
	ctx := context.Background()

	codeRepo := RepoRow{
		ID:    "repo-code",
		Owner: "opengits",
		Repo:  "sidecar",
		RepoProfile: json.RawMessage(`{
			"codeClusters": [
				{
					"teachingOrder": 1,
					"chapterNo": 1,
					"title": "MCP Server Engine",
					"summary": "Core JSON-RPC protocol implementation and tool dispatch",
					"directories": ["internal/mcp"],
					"files": ["internal/mcp/server.go", "internal/mcp/tool_handler.go"],
					"cognitive": {
						"phase": "core",
						"rationale": "High throughput tool handler with zero materialization",
						"upstreamModules": ["cmd/mcp-sidecar"],
						"downstreamModules": ["internal/storage"],
						"goldenSymbols": [
							{"name": "Server", "kind": "struct", "file": "internal/mcp/server.go"},
							{"name": "HandleToolCall", "kind": "func", "file": "internal/mcp/tool_handler.go"}
						],
						"callFlow": [
							{"caller": "Server.routes", "callee": "handleToolCall", "callerFile": "internal/mcp/server.go", "calleeFile": "internal/mcp/tool_handler.go"},
							{"caller": "handleToolCall", "callee": "runExploreConcept", "callerFile": "internal/mcp/tool_handler.go", "calleeFile": "internal/mcp/tools_concepts.go"}
						]
					}
				},
				{
					"teachingOrder": 2,
					"chapterNo": 2,
					"title": "Persistent Storage",
					"summary": "Postgres and SQLite read model storage",
					"directories": ["internal/storage"],
					"files": ["internal/storage/store.go"],
					"cognitive": {
						"phase": "infra",
						"upstreamModules": ["internal/mcp"]
					}
				}
			]
		}`),
	}

	pureDocRepo := RepoRow{
		ID:          "repo-doc",
		Owner:       "opengits",
		Repo:        "manual",
		RepoProfile: json.RawMessage(`{"repoType": "web-docs"}`),
	}

	tests := []struct {
		name         string
		repo         RepoRow
		concept      string
		wantContains []string
	}{
		{
			name:    "global architecture with empty concept",
			repo:    codeRepo,
			concept: "",
			wantContains: []string{
				"# 🏛️ System Architecture Topology (C4 L1 System Context)",
				"Repository: opengits/sidecar",
				"flowchart TD",
				"MCP Server Engine",
				"Persistent Storage",
			},
		},
		{
			name:    "global architecture with 'all' keyword",
			repo:    codeRepo,
			concept: "all",
			wantContains: []string{
				"# 🏛️ System Architecture Topology (C4 L1 System Context)",
				"Repository: opengits/sidecar",
			},
		},
		{
			name:    "subsystem drilldown by title",
			repo:    codeRepo,
			concept: "MCP Server Engine",
			wantContains: []string{
				"# 🏛️ Subsystem Architecture (C4 L2 Component Map)",
				"Subsystem: MCP Server Engine (Chapter 1)",
				"Repository: opengits/sidecar",
				"Server.routes()",
				"handleToolCall()",
				"runExploreConcept()",
				"fn1 --> fn2",
				"fn2 --> fn3",
				"Prerequisite: cmd/mcp-sidecar",
				"Dependent: internal/storage",
				"### Verified AST Golden Symbols:",
				"- `Server` (struct) in `internal/mcp/server.go`",
				"- `HandleToolCall` (func) in `internal/mcp/tool_handler.go`",
				"### Architectural Rationale:",
				"High throughput tool handler with zero materialization",
			},
		},
		{
			name:    "subsystem drilldown by directory",
			repo:    codeRepo,
			concept: "internal/mcp",
			wantContains: []string{
				"# 🏛️ Subsystem Architecture (C4 L2 Component Map)",
				"Subsystem: MCP Server Engine (Chapter 1)",
			},
		},
		{
			name:    "subsystem drilldown by chapter number",
			repo:    codeRepo,
			concept: "1",
			wantContains: []string{
				"# 🏛️ Subsystem Architecture (C4 L2 Component Map)",
				"Subsystem: MCP Server Engine (Chapter 1)",
			},
		},
		{
			name:    "subsystem not found returns available subsystem choices",
			repo:    codeRepo,
			concept: "unknown_module",
			wantContains: []string{
				"Subsystem \"unknown_module\" not found in architecture topology",
				"Available subsystems:",
				"- MCP Server Engine",
				"- Persistent Storage",
			},
		},
		{
			name:    "pure doc repo gracefully returns non-code message",
			repo:    pureDocRepo,
			concept: "",
			wantContains: []string{
				"No code architecture topology available for opengits/manual (non-code documentation repository).",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := service.runConceptArchitecture(ctx, tt.repo, "test-user", "test-client", tt.concept)
			require.False(t, res.IsError)
			for _, substr := range tt.wantContains {
				assert.Contains(t, res.Text, substr)
			}
		})
	}
}

func TestSearchArchitectureTopologyInjection(t *testing.T) {
	service := &readService{store: newReadFakeStore()}
	ctx := context.Background()

	codeRepo := RepoRow{
		ID:    "repo-code",
		Owner: "opengits",
		Repo:  "sidecar",
		RepoProfile: json.RawMessage(`{
			"codeClusters": [
				{
					"teachingOrder": 1,
					"title": "Core Engine",
					"directories": ["internal/core"],
					"files": ["internal/core/engine.go"],
					"cognitive": {"phase": "core"}
				}
			]
		}`),
	}

	resolved := &ResolvedRepo{
		Repository: codeRepo,
		Documents:  []DocMeta{},
	}

	// 1. Architecture search with macro query on repo with 0 chunks -> returns C4 Mermaid diagram
	macroFilter := "architecture"
	macroQuery := "architecture"
	res := service.runSearch(ctx, resolved, "u1", "c1", searchCallArgs{
		Filter: &macroFilter,
		Query:  &macroQuery,
	})
	assert.Contains(t, res.Text, "🏛️ Architecture Topology (C4 L1 System Context):")
	assert.Contains(t, res.Text, "flowchart TD")
	assert.Contains(t, res.Text, "Core Engine")

	// 2. Normal docs search with query="architecture" does NOT inject Mermaid diagram
	docsFilter := "docs"
	resDocs := service.runSearch(ctx, resolved, "u1", "c1", searchCallArgs{
		Filter: &docsFilter,
		Query:  &macroQuery,
	})
	assert.NotContains(t, resDocs.Text, "🏛️ Architecture Topology (C4 L1 System Context):")
}
