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

type testSymbolsServer struct {
	h     *Handler
	token string
}

func (s *testSymbolsServer) routes() http.Handler {
	return s.h.testRoutes(s.token)
}

func newTestSymbolsServer(t *testing.T) *testSymbolsServer {
	t.Helper()
	cfg := Config{
		InternalToken: "test-secret-token",
	}
	h := NewHandler(cfg, nil, nil)
	return &testSymbolsServer{h: h, token: cfg.InternalToken}
}

func TestSymbolsExtractEndpoint(t *testing.T) {
	s := newTestSymbolsServer(t)
	handler := s.routes()

	tests := []struct {
		name           string
		method         string
		token          string
		payload        SymbolsExtractRequest
		rawPayload     string
		expectedStatus int
		assertFunc     func(t *testing.T, resp SymbolsExtractResponse)
	}{
		{
			name:           "unauthorized without internal token",
			token:          "",
			payload:        SymbolsExtractRequest{FilePath: "src/index.ts", Content: "export function test() {}"},
			expectedStatus: http.StatusUnauthorized,
			assertFunc:     nil,
		},
		{
			name:           "empty content returns ok with empty arrays",
			token:          "test-secret-token",
			payload:        SymbolsExtractRequest{FilePath: "src/index.ts", Content: ""},
			expectedStatus: http.StatusOK,
			assertFunc: func(t *testing.T, resp SymbolsExtractResponse) {
				assert.True(t, resp.Ok)
				assert.Empty(t, resp.Symbols)
				assert.Empty(t, resp.Imports)
				assert.Empty(t, resp.CallSites)
				assert.Empty(t, resp.ReferencedConstants)
			},
		},
		{
			name:           "empty filepath returns ok with empty arrays",
			token:          "test-secret-token",
			payload:        SymbolsExtractRequest{FilePath: "", Content: "const x = 1;"},
			expectedStatus: http.StatusOK,
			assertFunc: func(t *testing.T, resp SymbolsExtractResponse) {
				assert.True(t, resp.Ok)
				assert.Empty(t, resp.Symbols)
			},
		},
		{
			name:  "non-code markdown file returns ok with empty arrays",
			token: "test-secret-token",
			payload: SymbolsExtractRequest{
				FilePath: "README.md",
				Content:  "# Hello World\nSome documentation text.",
			},
			expectedStatus: http.StatusOK,
			assertFunc: func(t *testing.T, resp SymbolsExtractResponse) {
				assert.True(t, resp.Ok)
				assert.Empty(t, resp.Symbols)
				assert.Empty(t, resp.Imports)
			},
		},
		{
			name:  "typescript extraction with functions, types, exports and imports",
			token: "test-secret-token",
			payload: SymbolsExtractRequest{
				FilePath: "src/auth.ts",
				Content: `import { helper } from './helper';

export interface User {
  id: string;
}

export function login(name: string): void {
  console.log(name);
}

class Internal {}`,
			},
			expectedStatus: http.StatusOK,
			assertFunc: func(t *testing.T, resp SymbolsExtractResponse) {
				assert.True(t, resp.Ok)
				require.NotEmpty(t, resp.Symbols)

				var loginSym *SymbolEntry
				var userSym *SymbolEntry
				var internalSym *SymbolEntry
				for i := range resp.Symbols {
					s := &resp.Symbols[i]
					if s.Name == "login" {
						loginSym = s
					} else if s.Name == "User" {
						userSym = s
					} else if s.Name == "Internal" {
						internalSym = s
					}
				}

				require.NotNil(t, loginSym, "login function should exist")
				assert.Equal(t, "function", loginSym.Kind)
				assert.True(t, loginSym.Exported)
				assert.Equal(t, 7, loginSym.StartLine)

				require.NotNil(t, userSym, "User interface should exist")
				assert.Equal(t, "type", userSym.Kind)
				assert.True(t, userSym.Exported)

				require.NotNil(t, internalSym, "Internal class should exist")
				assert.Equal(t, "type", internalSym.Kind)
				assert.False(t, internalSym.Exported)

				require.NotEmpty(t, resp.Imports)
				var helperImp *SymbolsExtractImport
				for i := range resp.Imports {
					if resp.Imports[i].Module == "./helper" {
						helperImp = &resp.Imports[i]
					}
				}
				require.NotNil(t, helperImp)
				assert.Contains(t, helperImp.Bindings, "helper")
			},
		},
		{
			name:  "python extraction with def, class, and from_import",
			token: "test-secret-token",
			payload: SymbolsExtractRequest{
				FilePath: "app/handlers.py",
				Content: `from models import User

@app.route("/login")
def login():
    return "ok"

class Account:
    pass
`,
			},
			expectedStatus: http.StatusOK,
			assertFunc: func(t *testing.T, resp SymbolsExtractResponse) {
				assert.True(t, resp.Ok)
				var loginFound, accountFound bool
				for _, s := range resp.Symbols {
					if s.Name == "login" && s.Kind == "function" {
						loginFound = true
					}
					if s.Name == "Account" && s.Kind == "type" {
						accountFound = true
					}
				}
				assert.True(t, loginFound, "python login function found")
				assert.True(t, accountFound, "python Account class found")

				require.NotEmpty(t, resp.Imports)
				assert.Equal(t, "models", resp.Imports[0].Module)
				assert.Contains(t, resp.Imports[0].Bindings, "User")
			},
		},
		{
			name:  "go extraction with capitalized export convention and imports",
			token: "test-secret-token",
			payload: SymbolsExtractRequest{
				FilePath: "cmd/server/main.go",
				Content: `package server

import "fmt"

type Server struct {
	Port int
}

type internalState struct {
	started bool
}

func Start() {
	fmt.Println("hi")
}
`,
			},
			expectedStatus: http.StatusOK,
			assertFunc: func(t *testing.T, resp SymbolsExtractResponse) {
				assert.True(t, resp.Ok)
				var serverSym, internalSym, startSym *SymbolEntry
				for i := range resp.Symbols {
					s := &resp.Symbols[i]
					if s.Name == "Server" {
						serverSym = s
					} else if s.Name == "internalState" {
						internalSym = s
					} else if s.Name == "Start" {
						startSym = s
					}
				}
				require.NotNil(t, serverSym)
				assert.True(t, serverSym.Exported)
				assert.Equal(t, "type", serverSym.Kind)

				require.NotNil(t, internalSym)
				assert.False(t, internalSym.Exported)
				assert.Equal(t, "type", internalSym.Kind)

				require.NotNil(t, startSym)
				assert.True(t, startSym.Exported)
				assert.Equal(t, "function", startSym.Kind)

				require.NotEmpty(t, resp.Imports)
				assert.Equal(t, "fmt", resp.Imports[0].Module)
				assert.Empty(t, resp.Imports[0].Bindings)
			},
		},
		{
			name:           "method not allowed for GET request",
			method:         http.MethodGet,
			token:          "test-secret-token",
			expectedStatus: http.StatusMethodNotAllowed,
			assertFunc:     nil,
		},
		{
			name:           "bad request for invalid json payload",
			token:          "test-secret-token",
			rawPayload:     `{not-valid-json`,
			expectedStatus: http.StatusBadRequest,
			assertFunc:     nil,
		},
		{
			name:  "unsupported unknown file extension returns ok with empty arrays",
			token: "test-secret-token",
			payload: SymbolsExtractRequest{
				FilePath: "script.unknownext",
				Content:  "function foo() {}",
			},
			expectedStatus: http.StatusOK,
			assertFunc: func(t *testing.T, resp SymbolsExtractResponse) {
				assert.True(t, resp.Ok)
				assert.Empty(t, resp.Symbols)
				assert.Empty(t, resp.Imports)
				assert.Empty(t, resp.CallSites)
				assert.Empty(t, resp.ReferencedConstants)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var body []byte
			var err error
			if tt.rawPayload != "" {
				body = []byte(tt.rawPayload)
			} else {
				body, err = json.Marshal(tt.payload)
				require.NoError(t, err)
			}

			method := http.MethodPost
			if tt.method != "" {
				method = tt.method
			}

			req := httptest.NewRequest(method, "/v1/symbols/extract", bytes.NewReader(body))
			if tt.token != "" {
				req.Header.Set("x-internal-token", tt.token)
			}
			req.Header.Set("Content-Type", "application/json")

			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			assert.Equal(t, tt.expectedStatus, rec.Code)
			if tt.assertFunc != nil {
				var resp SymbolsExtractResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				tt.assertFunc(t, resp)
			}
		})
	}
}
