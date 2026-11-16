package dissect

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/opengits/worker-sidecar/internal/treesitter"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestProjectCodeAstTable(t *testing.T) {
	ctx := context.Background()
	engine, err := treesitter.NewEngine(ctx)
	require.NoError(t, err)
	defer engine.Close()

	tests := []struct {
		name         string
		code         string
		lang         string
		wantIsAst    bool
		minNodes     int
		maxNodes     int
		expectInCode []string
	}{
		{
			name: "Go function with branch and return",
			code: `package main

func FetchData(ctx context.Context, id string) (*Data, error) {
	if id == "" {
		return nil, errors.New("empty id")
	}
	res, err := http.Get("https://api.example.com/" + id)
	if err != nil {
		return nil, err
	}
	return &Data{Body: res.Body}, nil
}
`,
			lang:         "go",
			wantIsAst:    true,
			minNodes:     2,
			maxNodes:     8,
			expectInCode: []string{"flowchart TD", "N1", "@Payload[N1]"},
		},
		{
			name: "TypeScript async method with try/catch",
			code: `export class UserService {
  async getUser(id: string): Promise<User> {
    try {
      if (!id) throw new Error("ID required");
      const user = await db.find(id);
      return user;
    } catch (e) {
      throw e;
    }
  }
}
`,
			lang:         "typescript",
			wantIsAst:    true,
			minNodes:     2,
			maxNodes:     8,
			expectInCode: []string{"flowchart TD", "@Payload"},
		},
		{
			name: "Python def with branch and loop",
			code: `def process_records(records):
    results = []
    for r in records:
        if r.is_valid():
            results.append(r.data)
    return results
`,
			lang:         "python",
			wantIsAst:    true,
			minNodes:     2,
			maxNodes:     8,
			expectInCode: []string{"flowchart TD", "@Payload"},
		},
		{
			name: "Clamping when code has many branches (> 8 nodes)",
			code: `func MassiveFlow() {
	if a { }
	if b { }
	if c { }
	if d { }
	if e { }
	if f { }
	if g { }
	if h { }
	if i { }
	if j { }
	return
}
`,
			lang:         "go",
			wantIsAst:    true,
			minNodes:     1,
			maxNodes:     MaxDissectSteps,
			expectInCode: []string{"flowchart TD"},
		},
		{
			name:         "Empty code snippet",
			code:         "",
			lang:         "go",
			wantIsAst:    false,
			minNodes:     1,
			maxNodes:     1,
			expectInCode: []string{"flowchart TD", "空代码块"},
		},
		{
			name: "Plain text fallback",
			code: `Line 1: system start
Line 2: loading config
Line 3: listening on port 8080
Line 4: ready
`,
			lang:         "plaintext",
			wantIsAst:    false,
			minNodes:     1,
			maxNodes:     8,
			expectInCode: []string{"flowchart TD", "@Payload"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp, err := ProjectCodeAst(ctx, engine, tt.code, tt.lang)
			require.NoError(t, err)
			require.NotNil(t, resp)

			assert.Equal(t, tt.wantIsAst, resp.IsAst)
			assert.GreaterOrEqual(t, len(resp.Nodes), tt.minNodes)
			assert.LessOrEqual(t, len(resp.Nodes), tt.maxNodes)

			for _, exp := range tt.expectInCode {
				assert.Contains(t, resp.MermaidCode, exp)
			}

			// Validate line numbers are within bounds
			lines := strings.Split(tt.code, "\n")
			total := len(lines)
			if total == 0 {
				total = 1
			}
			for _, n := range resp.Nodes {
				assert.GreaterOrEqual(t, n.StartLine, 1)
				assert.LessOrEqual(t, n.EndLine, total)
				assert.LessOrEqual(t, n.StartLine, n.EndLine)
			}
		})
	}
}

func TestHandleDissectAstEndpoint(t *testing.T) {
	ctx := context.Background()
	engine, err := treesitter.NewEngine(ctx)
	require.NoError(t, err)
	defer engine.Close()

	handler := HandleDissectAst(engine)

	reqBody := DissectRequest{
		Code: `func Add(a, b int) int {
	return a + b
}`,
		Language: "go",
	}
	bodyBytes, err := json.Marshal(reqBody)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/v1/dissect/ast", bytes.NewReader(bodyBytes))
	rec := httptest.NewRecorder()

	handler(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))

	var resp DissectResponse
	err = json.NewDecoder(rec.Body).Decode(&resp)
	require.NoError(t, err)

	assert.True(t, resp.IsAst)
	assert.NotEmpty(t, resp.MermaidCode)
	assert.NotEmpty(t, resp.Nodes)
}
