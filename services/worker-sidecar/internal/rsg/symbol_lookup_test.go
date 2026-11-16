package rsg

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type testSymbolLookupServer struct {
	h   *Handler
	cfg Config
}

func (s *testSymbolLookupServer) routes() http.Handler {
	return s.h.testRoutes(s.cfg.InternalToken)
}

func newTestSymbolLookupServer(t *testing.T) *testSymbolLookupServer {
	t.Helper()
	cfg := Config{
		InternalToken:    "test-secret-token",
		SemanticGraphDir: t.TempDir(),
	}
	h := NewHandler(cfg, nil, nil)
	return &testSymbolLookupServer{h: h, cfg: cfg}
}

func makeSymbolLookupTestArtifact(t *testing.T) *SemanticGraphArtifact {
	t.Helper()
	return &SemanticGraphArtifact{
		Version:     2,
		GitSha:      "sha987654",
		GeneratedAt: "2026-09-14T00:00:00Z",
		Nodes: []SemanticGraphArtifactNode{
			{
				Path:       "src/core/contract.ts",
				Language:   "typescript",
				PageRank:   0.8504,
				Role:       RoleCoreContract,
				IsBackbone: true,
			},
			{
				Path:       "src/util/helper.ts",
				Language:   "typescript",
				PageRank:   0.1201,
				Role:       RoleLeafUtility,
				IsBackbone: false,
			},
			{
				Path:         "src/entry/main.ts",
				Language:     "typescript",
				PageRank:     0.6009,
				Role:         RoleEntryPoint,
				IsEntryPoint: true,
			},
			{
				Path:     "src/api/handler.ts",
				Language: "typescript",
				PageRank: 0.4501,
				Role:     RolePipelineFlow,
			},
		},
		SymbolsByFile: map[string][]SymbolEntry{
			"src/core/contract.ts": {
				{
					Name:      "ExecuteTransaction",
					Kind:      "function",
					StartLine: 10,
					EndLine:   35,
					Exported:  true,
					Importers: 15,
				},
				{
					Name:      "TransactionConfig",
					Kind:      "type",
					StartLine: 40,
					EndLine:   50,
					Exported:  true,
					Importers: 8,
				},
			},
			"src/util/helper.ts": {
				{
					Name:      "ExecuteTransaction",
					Kind:      "function",
					StartLine: 5,
					EndLine:   12,
					Exported:  false,
					Importers: 1,
				},
			},
			"src/entry/main.ts": {
				{
					Name:      "Run",
					Kind:      "function",
					StartLine: 1,
					EndLine:   20,
					Exported:  true,
					Importers: 0,
				},
			},
		},
		GoldenSymbols: []GoldenSymbol{
			{
				File:      "src/core/contract.ts",
				Name:      "ExecuteTransaction",
				Kind:      "function",
				Score:     0.95,
				Importers: 15,
			},
		},
		CallEdges: []CallEdge{
			{
				CallerFile:   "src/entry/main.ts",
				CallerSymbol: "Run",
				CalleeFile:   "src/core/contract.ts",
				CalleeSymbol: "ExecuteTransaction",
				Line:         15,
			},
			{
				CallerFile:   "src/api/handler.ts",
				CallerSymbol: "HandleTx",
				CalleeFile:   "src/core/contract.ts",
				CalleeSymbol: "ExecuteTransaction",
				Line:         22,
			},
			{
				CallerFile:   "src/core/contract.ts",
				CallerSymbol: "ExecuteInternal",
				CalleeFile:   "src/core/contract.ts",
				CalleeSymbol: "ExecuteTransaction",
				Line:         28,
			},
			{
				// Crucial regression test: this edge calls TransactionConfig in the same file!
				// It must NOT be attributed to ExecuteTransaction.
				CallerFile:   "src/config/loader.ts",
				CallerSymbol: "LoadConfig",
				CalleeFile:   "src/core/contract.ts",
				CalleeSymbol: "TransactionConfig",
				Line:         5,
			},
			{
				CallerFile:   "src/service/tx_runner.ts",
				CallerSymbol: "RunTx",
				CalleeFile:   "src/core/contract.ts",
				CalleeSymbol: "ExecuteTransaction",
				Line:         42,
			},
			{
				// 5th caller for ExecuteTransaction to test capping at 4
				CallerFile:   "src/extra/overflow.ts",
				CallerSymbol: "OverflowCaller",
				CalleeFile:   "src/core/contract.ts",
				CalleeSymbol: "ExecuteTransaction",
				Line:         99,
			},
		},
	}
}

func TestSymbolLookupEndpoint(t *testing.T) {
	s := newTestSymbolLookupServer(t)
	handler := s.routes()
	artifact := makeSymbolLookupTestArtifact(t)

	// Persist artifact to test disk
	_, err := SaveSemanticGraphArtifact(s.cfg.SemanticGraphDir, "testorg", "testrepo", "sha987654", artifact)
	require.NoError(t, err)

	tests := []struct {
		name           string
		token          string
		payload        SymbolLookupRequest
		rawBody        string
		expectedStatus int
		assertFunc     func(t *testing.T, resp SymbolLookupResponse)
	}{
		{
			name:  "401 unauthorized when internal token missing",
			token: "",
			payload: SymbolLookupRequest{
				Owner: "testorg",
				Repo:  "testrepo",
				Sha:   "sha987654",
				Name:  "ExecuteTransaction",
			},
			expectedStatus: http.StatusUnauthorized,
		},
		{
			name:  "400 bad request on path traversal in owner",
			token: "test-secret-token",
			payload: SymbolLookupRequest{
				Owner: "../evil",
				Repo:  "testrepo",
				Sha:   "sha987654",
				Name:  "ExecuteTransaction",
			},
			expectedStatus: http.StatusBadRequest,
			assertFunc: func(t *testing.T, resp SymbolLookupResponse) {
				assert.False(t, resp.Ok)
				assert.Contains(t, resp.Error, "unsafe path segment")
			},
		},
		{
			name:  "400 bad request when symbol name is empty",
			token: "test-secret-token",
			payload: SymbolLookupRequest{
				Owner: "testorg",
				Repo:  "testrepo",
				Sha:   "sha987654",
				Name:  "   ",
			},
			expectedStatus: http.StatusBadRequest,
			assertFunc: func(t *testing.T, resp SymbolLookupResponse) {
				assert.False(t, resp.Ok)
				assert.Contains(t, resp.Error, "symbol name is required")
			},
		},
		{
			name:  "404 not found when graph artifact is missing",
			token: "test-secret-token",
			payload: SymbolLookupRequest{
				Owner: "testorg",
				Repo:  "testrepo",
				Sha:   "nonexistent_sha",
				Name:  "ExecuteTransaction",
			},
			expectedStatus: http.StatusNotFound,
			assertFunc: func(t *testing.T, resp SymbolLookupResponse) {
				assert.False(t, resp.Ok)
				assert.False(t, resp.Found)
				assert.Contains(t, resp.Error, "not found")
			},
		},
		{
			name:  "exact preferFile match selects preferred file symbol even with lower PageRank",
			token: "test-secret-token",
			payload: SymbolLookupRequest{
				Owner: "testorg",
				Repo:  "testrepo",
				Sha:   "sha987654",
				Name:  "ExecuteTransaction",
				File:  "src/util/helper.ts",
			},
			expectedStatus: http.StatusOK,
			assertFunc: func(t *testing.T, resp SymbolLookupResponse) {
				assert.True(t, resp.Ok)
				assert.True(t, resp.Found)
				require.NotNil(t, resp.Symbol)
				assert.Equal(t, "ExecuteTransaction", resp.Symbol.Name)
				assert.Equal(t, "src/util/helper.ts", resp.Symbol.File)
				assert.Equal(t, 5, resp.Symbol.StartLine)
				assert.Equal(t, 12, resp.Symbol.EndLine)
				assert.Equal(t, "leaf_utility", resp.Symbol.Role)
				assert.Equal(t, 0.12, resp.Symbol.PageRank)
			},
		},
		{
			name:  "global PageRank tie-breaker match when preferFile not provided",
			token: "test-secret-token",
			payload: SymbolLookupRequest{
				Owner: "testorg",
				Repo:  "testrepo",
				Sha:   "sha987654",
				Name:  "ExecuteTransaction",
			},
			expectedStatus: http.StatusOK,
			assertFunc: func(t *testing.T, resp SymbolLookupResponse) {
				assert.True(t, resp.Ok)
				assert.True(t, resp.Found)
				require.NotNil(t, resp.Symbol)
				assert.Equal(t, "ExecuteTransaction", resp.Symbol.Name)
				assert.Equal(t, "src/core/contract.ts", resp.Symbol.File)
				assert.Equal(t, 10, resp.Symbol.StartLine)
				assert.Equal(t, 35, resp.Symbol.EndLine)
				assert.Equal(t, "core_contract", resp.Symbol.Role)
				assert.Equal(t, 0.85, resp.Symbol.PageRank)
				assert.Equal(t, 15, resp.Symbol.Importers)

				// Callers extraction verification: exactly 4 callers (capped at 4)
				require.Len(t, resp.Symbol.Callers, 4)
				assert.Contains(t, resp.Symbol.Callers, "src/entry/main.ts")
				assert.Contains(t, resp.Symbol.Callers, "src/api/handler.ts")
				assert.Contains(t, resp.Symbol.Callers, "ExecuteInternal")
				assert.Contains(t, resp.Symbol.Callers, "src/service/tx_runner.ts")
				// Must NOT contain TransactionConfig's caller (symbol isolation)
				assert.NotContains(t, resp.Symbol.Callers, "src/config/loader.ts")
				// Must NOT contain 5th caller (capped at 4)
				assert.NotContains(t, resp.Symbol.Callers, "src/extra/overflow.ts")
			},
		},
		{
			name:  "symbol isolation: TransactionConfig callers only receive its own call edges",
			token: "test-secret-token",
			payload: SymbolLookupRequest{
				Owner: "testorg",
				Repo:  "testrepo",
				Sha:   "sha987654",
				Name:  "TransactionConfig",
			},
			expectedStatus: http.StatusOK,
			assertFunc: func(t *testing.T, resp SymbolLookupResponse) {
				assert.True(t, resp.Ok)
				assert.True(t, resp.Found)
				require.NotNil(t, resp.Symbol)
				assert.Equal(t, "TransactionConfig", resp.Symbol.Name)
				assert.Equal(t, "src/core/contract.ts", resp.Symbol.File)
				// Should only have src/config/loader.ts, not callers of ExecuteTransaction
				require.Len(t, resp.Symbol.Callers, 1)
				assert.Equal(t, "src/config/loader.ts", resp.Symbol.Callers[0])
			},
		},
		{
			name:  "preferFile with leading dot-slash normalizes and matches",
			token: "test-secret-token",
			payload: SymbolLookupRequest{
				Owner: "testorg",
				Repo:  "testrepo",
				Sha:   "sha987654",
				Name:  "ExecuteTransaction",
				File:  "./src/util/helper.ts",
			},
			expectedStatus: http.StatusOK,
			assertFunc: func(t *testing.T, resp SymbolLookupResponse) {
				assert.True(t, resp.Ok)
				assert.True(t, resp.Found)
				require.NotNil(t, resp.Symbol)
				assert.Equal(t, "ExecuteTransaction", resp.Symbol.Name)
				assert.Equal(t, "src/util/helper.ts", resp.Symbol.File)
				assert.Equal(t, 5, resp.Symbol.StartLine)
			},
		},
		{
			name:  "symbol not found returns found=false with 200 OK",
			token: "test-secret-token",
			payload: SymbolLookupRequest{
				Owner: "testorg",
				Repo:  "testrepo",
				Sha:   "sha987654",
				Name:  "NoSuchSymbol",
			},
			expectedStatus: http.StatusOK,
			assertFunc: func(t *testing.T, resp SymbolLookupResponse) {
				assert.True(t, resp.Ok)
				assert.False(t, resp.Found)
				assert.Nil(t, resp.Symbol)
			},
		},
		{
			name:  "in-memory artifact payload lookup",
			token: "test-secret-token",
			payload: SymbolLookupRequest{
				Artifact: artifact,
				Name:     "TransactionConfig",
			},
			expectedStatus: http.StatusOK,
			assertFunc: func(t *testing.T, resp SymbolLookupResponse) {
				assert.True(t, resp.Ok)
				assert.True(t, resp.Found)
				require.NotNil(t, resp.Symbol)
				assert.Equal(t, "TransactionConfig", resp.Symbol.Name)
				assert.Equal(t, "type", resp.Symbol.Kind)
				assert.Equal(t, "src/core/contract.ts", resp.Symbol.File)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var body []byte
			if tt.rawBody != "" {
				body = []byte(tt.rawBody)
			} else {
				var err error
				body, err = json.Marshal(tt.payload)
				require.NoError(t, err)
			}

			req := httptest.NewRequest(http.MethodPost, "/v1/graph/symbol-lookup", bytes.NewReader(body))
			if tt.token != "" {
				req.Header.Set("x-internal-token", tt.token)
			}
			req.Header.Set("Content-Type", "application/json")

			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			assert.Equal(t, tt.expectedStatus, rec.Code)
			if tt.assertFunc != nil {
				var resp SymbolLookupResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				tt.assertFunc(t, resp)
			}
		})
	}
}

func TestSearchSymbols(t *testing.T) {
	artifact := makeSymbolLookupTestArtifact(t)

	tests := []struct {
		name       string
		artifact   *SemanticGraphArtifact
		opts       SearchSymbolsOptions
		assertFunc func(t *testing.T, results []*SymbolLookupDetail)
	}{
		{
			name:     "nil artifact returns nil",
			artifact: nil,
			opts:     SearchSymbolsOptions{Query: "Run"},
			assertFunc: func(t *testing.T, results []*SymbolLookupDetail) {
				assert.Nil(t, results)
			},
		},
		{
			name:     "exact match ranks higher PageRank first",
			artifact: artifact,
			opts:     SearchSymbolsOptions{Query: "ExecuteTransaction"},
			assertFunc: func(t *testing.T, results []*SymbolLookupDetail) {
				require.NotEmpty(t, results)
				// Both src/core/contract.ts and src/util/helper.ts define ExecuteTransaction,
				// but core/contract.ts has PageRank 0.8504 vs helper.ts 0.1201
				assert.Equal(t, "ExecuteTransaction", results[0].Name)
				assert.Equal(t, "src/core/contract.ts", results[0].File)
				assert.Equal(t, "core_contract", results[0].Role)
				assert.Equal(t, 0.85, results[0].PageRank)
				assert.Equal(t, 15, results[0].Importers)
				assert.Contains(t, results[0].Callers, "src/entry/main.ts")
			},
		},
		{
			name:     "prefix match finds TransactionConfig",
			artifact: artifact,
			opts:     SearchSymbolsOptions{Query: "Trans"},
			assertFunc: func(t *testing.T, results []*SymbolLookupDetail) {
				require.NotEmpty(t, results)
				assert.Equal(t, "TransactionConfig", results[0].Name)
				assert.Equal(t, "type", results[0].Kind)
				assert.Equal(t, "src/core/contract.ts", results[0].File)
			},
		},
		{
			name:     "substring case-insensitive match finds Run",
			artifact: artifact,
			opts:     SearchSymbolsOptions{Query: "run"},
			assertFunc: func(t *testing.T, results []*SymbolLookupDetail) {
				require.NotEmpty(t, results)
				assert.Equal(t, "Run", results[0].Name)
				assert.Equal(t, "src/entry/main.ts", results[0].File)
				assert.Equal(t, "entry_point", results[0].Role)
			},
		},
		{
			name:     "preferFile isolates symbol to specific file",
			artifact: artifact,
			opts:     SearchSymbolsOptions{Query: "ExecuteTransaction", PreferFile: "helper.ts"},
			assertFunc: func(t *testing.T, results []*SymbolLookupDetail) {
				require.Len(t, results, 1)
				assert.Equal(t, "ExecuteTransaction", results[0].Name)
				assert.Equal(t, "src/util/helper.ts", results[0].File)
				assert.Equal(t, "leaf_utility", results[0].Role)
			},
		},
		{
			name:     "role filter limits candidates",
			artifact: artifact,
			opts:     SearchSymbolsOptions{RoleFilter: "entry_point"},
			assertFunc: func(t *testing.T, results []*SymbolLookupDetail) {
				require.NotEmpty(t, results)
				for _, r := range results {
					assert.Equal(t, "entry_point", r.Role)
				}
				assert.Equal(t, "Run", results[0].Name)
			},
		},
		{
			name:     "empty query returns top symbols by PageRank",
			artifact: artifact,
			opts:     SearchSymbolsOptions{Limit: 2},
			assertFunc: func(t *testing.T, results []*SymbolLookupDetail) {
				require.Len(t, results, 2)
				// Highest PageRank symbols should be first
				assert.True(t, results[0].PageRank >= results[1].PageRank)
			},
		},
		{
			name:     "unknown query returns nil",
			artifact: artifact,
			opts:     SearchSymbolsOptions{Query: "NonExistentSymbol12345"},
			assertFunc: func(t *testing.T, results []*SymbolLookupDetail) {
				assert.Nil(t, results)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := SearchSymbols(tt.artifact, tt.opts)
			tt.assertFunc(t, res)
		})
	}
}

func TestFallbackSearchClusters(t *testing.T) {
	clustersJSON := []byte(`[
		{
			"title": "Task Scheduler",
			"teachingOrder": 1,
			"cognitive": {
				"goldenSymbols": [
					{"name": "InitScheduler", "file": "src/sched/init.go", "kind": "function"},
					{"name": "ScheduleJob", "file": "src/sched/job.go", "kind": "function"}
				],
				"callFlow": [
					{"caller": "main.go", "callee": "InitScheduler"},
					{"caller": "worker.go", "callee": "ScheduleJob"}
				]
			}
		}
	]`)

	tests := []struct {
		name       string
		raw        []byte
		opts       SearchSymbolsOptions
		assertFunc func(t *testing.T, results []*SymbolLookupDetail)
	}{
		{
			name: "empty raw returns nil",
			raw:  nil,
			opts: SearchSymbolsOptions{Query: "Init"},
			assertFunc: func(t *testing.T, results []*SymbolLookupDetail) {
				assert.Nil(t, results)
			},
		},
		{
			name: "invalid json returns nil",
			raw:  []byte(`{invalid`),
			opts: SearchSymbolsOptions{Query: "Init"},
			assertFunc: func(t *testing.T, results []*SymbolLookupDetail) {
				assert.Nil(t, results)
			},
		},
		{
			name: "finds InitScheduler with caller from call flow",
			raw:  clustersJSON,
			opts: SearchSymbolsOptions{Query: "Init"},
			assertFunc: func(t *testing.T, results []*SymbolLookupDetail) {
				require.Len(t, results, 1)
				assert.Equal(t, "InitScheduler", results[0].Name)
				assert.Equal(t, "src/sched/init.go", results[0].File)
				assert.Equal(t, "core_contract", results[0].Role)
				assert.Contains(t, results[0].Callers, "main.go")
			},
		},
		{
			name: "empty query returns all golden symbols up to limit",
			raw:  clustersJSON,
			opts: SearchSymbolsOptions{Limit: 1},
			assertFunc: func(t *testing.T, results []*SymbolLookupDetail) {
				require.Len(t, results, 1)
			},
		},
		{
			name: "preferFile filtering in fallback",
			raw:  clustersJSON,
			opts: SearchSymbolsOptions{Query: "Job", PreferFile: "job.go"},
			assertFunc: func(t *testing.T, results []*SymbolLookupDetail) {
				require.Len(t, results, 1)
				assert.Equal(t, "ScheduleJob", results[0].Name)
				assert.Equal(t, "src/sched/job.go", results[0].File)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := FallbackSearchClusters(tt.raw, tt.opts)
			tt.assertFunc(t, res)
		})
	}
}

func TestSymbolSearchEndpoint(t *testing.T) {
	server := newTestSymbolLookupServer(t)
	handler := server.routes()
	artifact := makeSymbolLookupTestArtifact(t)

	tests := []struct {
		name           string
		token          string
		payload        any
		rawBody        string
		expectedStatus int
		assertFunc     func(t *testing.T, resp SymbolSearchResponse)
	}{
		{
			name:           "401 unauthorized when internal token missing",
			token:          "",
			payload:        SymbolSearchRequest{Query: "Run"},
			expectedStatus: http.StatusUnauthorized,
		},
		{
			name:           "400 bad request on path traversal in owner",
			token:          "test-secret-token",
			payload:        SymbolSearchRequest{Owner: "../bad", Repo: "repo", Sha: "main", Query: "Run"},
			expectedStatus: http.StatusBadRequest,
			assertFunc: func(t *testing.T, resp SymbolSearchResponse) {
				assert.False(t, resp.Ok)
				assert.Contains(t, resp.Error, "unsafe path segment")
			},
		},
		{
			name:           "404 not found when graph artifact is missing",
			token:          "test-secret-token",
			payload:        SymbolSearchRequest{Owner: "owner", Repo: "repo", Sha: "missing-sha", Query: "Run"},
			expectedStatus: http.StatusNotFound,
			assertFunc: func(t *testing.T, resp SymbolSearchResponse) {
				assert.False(t, resp.Ok)
				assert.Contains(t, resp.Error, "not found")
			},
		},
		{
			name:  "in-memory artifact payload search",
			token: "test-secret-token",
			payload: SymbolSearchRequest{
				Artifact: artifact,
				Query:    "ExecuteTransaction",
			},
			expectedStatus: http.StatusOK,
			assertFunc: func(t *testing.T, resp SymbolSearchResponse) {
				assert.True(t, resp.Ok)
				require.NotEmpty(t, resp.Symbols)
				assert.Equal(t, "ExecuteTransaction", resp.Symbols[0].Name)
				assert.Equal(t, "src/core/contract.ts", resp.Symbols[0].File)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var body []byte
			if tt.rawBody != "" {
				body = []byte(tt.rawBody)
			} else {
				var err error
				body, err = json.Marshal(tt.payload)
				require.NoError(t, err)
			}

			req := httptest.NewRequest(http.MethodPost, "/v1/graph/symbol-search", bytes.NewReader(body))
			if tt.token != "" {
				req.Header.Set("x-internal-token", tt.token)
			}
			req.Header.Set("Content-Type", "application/json")

			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			assert.Equal(t, tt.expectedStatus, rec.Code)
			if tt.assertFunc != nil {
				var resp SymbolSearchResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				tt.assertFunc(t, resp)
			}
		})
	}
}
