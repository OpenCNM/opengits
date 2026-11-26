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

type testGroundingServer struct {
	h   *Handler
	cfg Config
}

func (s *testGroundingServer) routes() http.Handler {
	mux := http.NewServeMux()
	wrap := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {

			token := r.Header.Get("x-internal-token")
			if token != s.cfg.InternalToken {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			next(w, r)
		}
	}
	mux.HandleFunc("POST /v1/graph/concept-grounding", wrap(s.h.HandleGrounding))
	mux.HandleFunc("POST /v1/graph/symbol-lookup", wrap(s.h.HandleSymbolLookup))
	mux.HandleFunc("POST /v1/graph/symbol-search", wrap(s.h.HandleSymbolSearch))
	mux.HandleFunc("POST /v1/graph/slice-context", wrap(s.h.HandleTopologySlice))
	mux.HandleFunc("POST /v1/symbols/extract", wrap(s.h.HandleSymbolsExtract))
	return mux
}

func newTestGroundingServer(t *testing.T) *testGroundingServer {
	t.Helper()
	cfg := Config{
		InternalToken:    "test-secret-token",
		SemanticGraphDir: t.TempDir(),
	}
	h := NewHandler(cfg, nil, nil)
	return &testGroundingServer{h: h, cfg: cfg}
}

func makeGroundingTestArtifact(t *testing.T) *SemanticGraphArtifact {
	t.Helper()
	return &SemanticGraphArtifact{
		Version:     2,
		GitSha:      "sha123456",
		GeneratedAt: "2026-09-14T00:00:00Z",
		Nodes: []SemanticGraphArtifactNode{
			{
				Path:         "src/core/contract.ts",
				Language:     "typescript",
				PageRank:     0.4567,
				Role:         RoleCoreContract,
				IsBackbone:   true,
				IsEntryPoint: false,
			},
			{
				Path:         "src/entry/main.ts",
				Language:     "typescript",
				PageRank:     0.3551,
				Role:         RoleEntryPoint,
				IsBackbone:   false,
				IsEntryPoint: true,
			},
			{
				Path:         "src/pipeline/flow.ts",
				Language:     "typescript",
				PageRank:     0.2504,
				Role:         RolePipelineFlow,
				IsBackbone:   true,
				IsEntryPoint: false,
			},
			{
				Path:         "src/models/user.ts",
				Language:     "typescript",
				PageRank:     0.1802,
				Role:         RoleCoreContract,
				IsBackbone:   true,
				IsEntryPoint: false,
			},
			{
				Path:         "src/extra/extra.ts",
				Language:     "typescript",
				PageRank:     0.1200,
				Role:         RoleCoreContract,
				IsBackbone:   true,
				IsEntryPoint: false,
			},
			{
				Path:         "src/utils/helper.ts",
				Language:     "typescript",
				PageRank:     0.0509,
				Role:         RoleLeafUtility,
				IsBackbone:   false,
				IsEntryPoint: false,
			},
		},
		EntryPoints:   []string{"src/entry/main.ts"},
		BackboneNodes: []string{"src/core/contract.ts", "src/pipeline/flow.ts", "src/models/user.ts", "src/extra/extra.ts"},
		GoldenSymbols: []GoldenSymbol{
			{File: "src/core/contract.ts", Name: "RouterContract", Kind: "type", Score: 0.95},
			{File: "src/core/contract.ts", Name: "RouterContract", Kind: "type", Score: 0.95},
			{File: "src/entry/main.ts", Name: "bootstrap", Kind: "function", Score: 0.88},
			{File: "src/pipeline/flow.ts", Name: "executePipeline", Kind: "function", Score: 0.82},
			{File: "src/models/user.ts", Name: "UserModel", Kind: "type", Score: 0.70},
			{File: "src/extra/extra.ts", Name: "ExtraHandler", Kind: "function", Score: 0.65},
			{File: "src/utils/helper.ts", Name: "formatRouterHelper", Kind: "function", Score: 0.60},
			{File: "src/utils/helper.ts", Name: "cleanHelper", Kind: "function", Score: 0.55},
		},
	}
}

func TestConceptGrounding_Auth(t *testing.T) {
	s := newTestGroundingServer(t)
	handler := s.routes()

	tests := []struct {
		name       string
		token      string
		queryToken string
		wantStatus int
	}{
		{
			name:       "no token returns 401 unauthorized",
			token:      "",
			queryToken: "",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "invalid token returns 401 unauthorized",
			token:      "wrong-token",
			queryToken: "",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "valid token in header returns 200 ok",
			token:      "test-secret-token",
			queryToken: "",
			wantStatus: http.StatusOK,
		},
		{
			name:       "token in query param is not accepted (header-only contract)",
			token:      "",
			queryToken: "?token=test-secret-token",
			wantStatus: http.StatusUnauthorized,
		},
	}

	artifact := makeGroundingTestArtifact(t)

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, err := json.Marshal(ConceptGroundingRequest{
				Artifact:    artifact,
				ConceptName: "router",
			})
			require.NoError(t, err)

			req := httptest.NewRequest(http.MethodPost, "/v1/graph/concept-grounding"+tt.queryToken, bytes.NewReader(body))
			if tt.token != "" {
				req.Header.Set("x-internal-token", tt.token)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)
		})
	}
}

func TestConceptGrounding_ValidationAndPathTraversal(t *testing.T) {
	s := newTestGroundingServer(t)
	handler := s.routes()

	tests := []struct {
		name        string
		body        string
		wantStatus  int
		errContains string
	}{
		{
			name:        "invalid json body returns 400",
			body:        "{malformed-json}",
			wantStatus:  http.StatusBadRequest,
			errContains: "invalid json body",
		},
		{
			name:        "path traversal in owner returns 400",
			body:        `{"owner":"../etc","repo":"myrepo","sha":"abc1234","conceptName":"router"}`,
			wantStatus:  http.StatusBadRequest,
			errContains: "unsafe path segment",
		},
		{
			name:        "path traversal with slash in repo returns 400",
			body:        `{"owner":"myorg","repo":"repo/sub","sha":"abc1234","conceptName":"router"}`,
			wantStatus:  http.StatusBadRequest,
			errContains: "unsafe path segment",
		},
		{
			name:        "path traversal with backslash in sha returns 400",
			body:        `{"owner":"myorg","repo":"myrepo","sha":"abc\\1234","conceptName":"router"}`,
			wantStatus:  http.StatusBadRequest,
			errContains: "unsafe path segment",
		},
		{
			name:        "empty owner returns 400",
			body:        `{"owner":"","repo":"myrepo","sha":"abc1234","conceptName":"router"}`,
			wantStatus:  http.StatusBadRequest,
			errContains: "unsafe path segment",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/graph/concept-grounding", bytes.NewBufferString(tt.body))
			req.Header.Set("x-internal-token", "test-secret-token")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)
			var resp ConceptGroundingResponse
			err := json.NewDecoder(rec.Body).Decode(&resp)
			require.NoError(t, err)
			assert.False(t, resp.OK)
			assert.Contains(t, resp.Error, tt.errContains)
		})
	}
}

func TestConceptGrounding_NotFound(t *testing.T) {
	s := newTestGroundingServer(t)
	handler := s.routes()

	tests := []struct {
		name       string
		req        ConceptGroundingRequest
		wantStatus int
		wantError  string
	}{
		{
			name: "missing artifact on disk returns 404",
			req: ConceptGroundingRequest{
				Owner:       "validowner",
				Repo:        "validrepo",
				Sha:         "nonexistentsha",
				ConceptName: "router",
			},
			wantStatus: http.StatusNotFound,
			wantError:  "semantic graph artifact not found",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, err := json.Marshal(tt.req)
			require.NoError(t, err)

			req := httptest.NewRequest(http.MethodPost, "/v1/graph/concept-grounding", bytes.NewReader(body))
			req.Header.Set("x-internal-token", "test-secret-token")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)
			var resp ConceptGroundingResponse
			err = json.NewDecoder(rec.Body).Decode(&resp)
			require.NoError(t, err)
			assert.False(t, resp.OK)
			assert.Contains(t, resp.Error, tt.wantError)
		})
	}
}

func TestConceptGrounding_ScopeFilesAndPageRank(t *testing.T) {
	artifact := makeGroundingTestArtifact(t)

	tests := []struct {
		name          string
		conceptName   string
		scopeFiles    []string
		wantBackbones []string
		wantPRs       []float64
	}{
		{
			name:        "no scopeFiles selects top 4 global backbone/contract/entrypoint nodes sorted by PageRank",
			conceptName: "test",
			scopeFiles:  nil,
			wantBackbones: []string{
				"src/core/contract.ts",
				"src/entry/main.ts",
				"src/pipeline/flow.ts",
				"src/models/user.ts",
			},
			wantPRs: []float64{0.457, 0.355, 0.250, 0.180},
		},
		{
			name:        "scopeFiles restricts backbone candidate nodes to specified set",
			conceptName: "test",
			scopeFiles:  []string{"src/models/user.ts", "src/utils/helper.ts"},
			wantBackbones: []string{
				"src/models/user.ts",
				"src/utils/helper.ts",
			},
			wantPRs: []float64{0.180, 0.051},
		},
		{
			name:        "scopeFiles with whitespace-only entries falls back to global backbone selection",
			conceptName: "test",
			scopeFiles:  []string{"", "  "},
			wantBackbones: []string{
				"src/core/contract.ts",
				"src/entry/main.ts",
				"src/pipeline/flow.ts",
				"src/models/user.ts",
			},
			wantPRs: []float64{0.457, 0.355, 0.250, 0.180},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := QueryConceptGrounding(artifact, tt.conceptName, tt.scopeFiles)
			require.True(t, res.OK)
			require.Len(t, res.BackboneFiles, len(tt.wantBackbones))

			for i, expPath := range tt.wantBackbones {
				assert.Equal(t, expPath, res.BackboneFiles[i].Path)
				assert.Equal(t, tt.wantPRs[i], res.BackboneFiles[i].PageRank)
			}
		})
	}
}

func TestConceptGrounding_GoldenSymbolsKeywordDedupeAndLimit(t *testing.T) {
	artifact := makeGroundingTestArtifact(t)

	tenSymbolsArtifact := makeGroundingTestArtifact(t)
	tenSymbolsArtifact.GoldenSymbols = []GoldenSymbol{
		{File: "src/core/contract.ts", Name: "Sym1", Kind: "type", Score: 0.9},
		{File: "src/core/contract.ts", Name: "Sym2", Kind: "type", Score: 0.8},
		{File: "src/core/contract.ts", Name: "Sym3", Kind: "type", Score: 0.7},
		{File: "src/core/contract.ts", Name: "Sym4", Kind: "type", Score: 0.6},
		{File: "src/core/contract.ts", Name: "Sym5", Kind: "type", Score: 0.5},
		{File: "src/core/contract.ts", Name: "Sym6", Kind: "type", Score: 0.4},
		{File: "src/core/contract.ts", Name: "Sym7", Kind: "type", Score: 0.3},
		{File: "src/core/contract.ts", Name: "Sym8", Kind: "type", Score: 0.2},
	}

	tests := []struct {
		name        string
		conceptName string
		scopeFiles  []string
		artifact    *SemanticGraphArtifact
		validate    func(t *testing.T, res *ConceptGroundingResponse)
	}{
		{
			name:        "keyword router matches RouterContract and formatRouterHelper across files",
			conceptName: "router",
			artifact:    artifact,
			validate: func(t *testing.T, res *ConceptGroundingResponse) {
				require.True(t, res.OK)
				names := make([]string, 0, len(res.GoldenSymbols))
				for _, sym := range res.GoldenSymbols {
					names = append(names, sym.Name)
				}
				assert.Contains(t, names, "RouterContract")
				assert.Contains(t, names, "formatRouterHelper")
			},
		},
		{
			name:        "deduplicates identical file::symbol pair",
			conceptName: "RouterContract",
			artifact:    artifact,
			validate: func(t *testing.T, res *ConceptGroundingResponse) {
				require.True(t, res.OK)
				routerCount := 0
				for _, sym := range res.GoldenSymbols {
					if sym.File == "src/core/contract.ts" && sym.Name == "RouterContract" {
						routerCount++
					}
				}
				assert.Equal(t, 1, routerCount, "must deduplicate identical file::name symbol")
			},
		},
		{
			name:        "caps golden symbols at maximum 6 entries",
			conceptName: "sym",
			artifact:    tenSymbolsArtifact,
			validate: func(t *testing.T, res *ConceptGroundingResponse) {
				require.True(t, res.OK)
				assert.Equal(t, 6, len(res.GoldenSymbols), "must not exceed 6 golden symbols")
			},
		},
		{
			name:        "returns empty lists for nil artifact",
			conceptName: "router",
			artifact:    nil,
			validate: func(t *testing.T, res *ConceptGroundingResponse) {
				require.False(t, res.OK)
				assert.Equal(t, 0, len(res.BackboneFiles))
				assert.Equal(t, 0, len(res.GoldenSymbols))
			},
		},
		{
			name:        "whitespace only concept does not trigger keyword matching on unrelated leaf files",
			conceptName: "   ",
			artifact:    artifact,
			validate: func(t *testing.T, res *ConceptGroundingResponse) {
				require.True(t, res.OK)
				names := make([]string, 0, len(res.GoldenSymbols))
				for _, sym := range res.GoldenSymbols {
					names = append(names, sym.Name)
				}
				assert.NotContains(t, names, "formatRouterHelper")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := QueryConceptGrounding(tt.artifact, tt.conceptName, tt.scopeFiles)
			tt.validate(t, res)
		})
	}
}

func TestConceptGrounding_FullDiskRoundtrip(t *testing.T) {
	s := newTestGroundingServer(t)
	handler := s.routes()

	tests := []struct {
		name         string
		owner        string
		repo         string
		sha          string
		concept      string
		wantMinFiles int
		wantMinSyms  int
	}{
		{
			name:         "valid disk artifact query returns backbone files and golden symbols",
			owner:        "myorg",
			repo:         "myrepo",
			sha:          "sha123456",
			concept:      "Router",
			wantMinFiles: 4,
			wantMinSyms:  1,
		},
	}

	artifact := makeGroundingTestArtifact(t)
	_, err := SaveSemanticGraphArtifact(s.cfg.SemanticGraphDir, "myorg", "myrepo", "sha123456", artifact)
	require.NoError(t, err)

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, err := json.Marshal(ConceptGroundingRequest{
				Owner:       tt.owner,
				Repo:        tt.repo,
				Sha:         tt.sha,
				ConceptName: tt.concept,
			})
			require.NoError(t, err)

			req := httptest.NewRequest(http.MethodPost, "/v1/graph/concept-grounding", bytes.NewReader(body))
			req.Header.Set("x-internal-token", "test-secret-token")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusOK, rec.Code)
			var resp ConceptGroundingResponse
			err = json.NewDecoder(rec.Body).Decode(&resp)
			require.NoError(t, err)
			assert.True(t, resp.OK)
			assert.Len(t, resp.BackboneFiles, tt.wantMinFiles)
			assert.GreaterOrEqual(t, len(resp.GoldenSymbols), tt.wantMinSyms)
		})
	}
}
