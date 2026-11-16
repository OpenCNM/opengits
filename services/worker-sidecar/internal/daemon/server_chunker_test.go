package daemon

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/fingerprint"
)

func TestChunkerHandlers_HTTP(t *testing.T) {
	cfg := Config{InternalToken: "test-token"}
	srv := newServer(cfg, nil, nil, nil, nil)
	ts := httptest.NewServer(srv.routes())
	defer ts.Close()

	tests := []struct {
		name           string
		path           string
		token          string
		payload        string
		expectedStatus int
		verifyResponse func(t *testing.T, body []byte)
	}{
		{
			name:           "unauthorized without token",
			path:           "/v1/chunk/markdown",
			token:          "",
			payload:        `{"content":"hello"}`,
			expectedStatus: http.StatusForbidden,
		},
		{
			name:           "POST /v1/chunk/code-module",
			path:           "/v1/chunk/code-module",
			token:          "test-token",
			payload:        `{"moduleName":"Core","mdxContent":"## S1\nBody1\n## S2\nBody2"}`,
			expectedStatus: http.StatusOK,
			verifyResponse: func(t *testing.T, body []byte) {
				var resp chunker.CodeModuleChunkResponse
				err := json.Unmarshal(body, &resp)
				require.NoError(t, err)
				assert.GreaterOrEqual(t, len(resp.Chunks), 2)
			},
		},
		{
			name:           "POST /v1/chunk/markdown",
			path:           "/v1/chunk/markdown",
			token:          "test-token",
			payload:        `{"content":"# Title\nParagraph text.","docPath":"docs/a.md"}`,
			expectedStatus: http.StatusOK,
			verifyResponse: func(t *testing.T, body []byte) {
				var resp chunker.MarkdownChunkResponse
				err := json.Unmarshal(body, &resp)
				require.NoError(t, err)
				require.Len(t, resp.Chunks, 1)
				assert.Equal(t, "Title", resp.Chunks[0].Heading)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodPost, ts.URL+tt.path, strings.NewReader(tt.payload))
			require.NoError(t, err)
			req.Header.Set("Content-Type", "application/json")
			if tt.token != "" {
				req.Header.Set("x-internal-token", tt.token)
			}

			resp, err := ts.Client().Do(req)
			require.NoError(t, err)
			defer resp.Body.Close()

			assert.Equal(t, tt.expectedStatus, resp.StatusCode)
			respBody, err := io.ReadAll(resp.Body)
			require.NoError(t, err)

			if tt.verifyResponse != nil {
				tt.verifyResponse(t, respBody)
			}
		})
	}
}

// 🧪 [3.6.1.5 · HIGH] Server 路由装配与指纹 RPC 端点内部鉴权防御
func TestFingerprintHandlers_HTTP(t *testing.T) {
	cfg := Config{InternalToken: "test-token"}
	srv := newServer(cfg, nil, nil, nil, nil)
	ts := httptest.NewServer(srv.routes())
	defer ts.Close()

	tests := []struct {
		name           string
		path           string
		token          string
		payload        string
		expectedStatus int
		verifyResponse func(t *testing.T, body []byte)
	}{
		{
			name:           "unauthorized without token - compute",
			path:           "/v1/fingerprint/compute",
			token:          "",
			payload:        `{"chapters":[],"events":[]}`,
			expectedStatus: http.StatusForbidden,
		},
		{
			name:           "unauthorized without token - compute-batch",
			path:           "/v1/fingerprint/compute-batch",
			token:          "",
			payload:        `{"items":[]}`,
			expectedStatus: http.StatusForbidden,
		},
		{
			name:           "POST /v1/fingerprint/compute",
			path:           "/v1/fingerprint/compute",
			token:          "test-token",
			payload:        `{"chapters":[{"path":"g.md","wordCount":300,"codeBlockCount":1,"headingCount":4,"pageUrl":"/docs/g"}],"events":[{"eventType":"PAGE_VIEW","pageUrl":"/docs/g"}]}`,
			expectedStatus: http.StatusOK,
			verifyResponse: func(t *testing.T, body []byte) {
				var resp fingerprint.FingerprintComputeResponse
				err := json.Unmarshal(body, &resp)
				require.NoError(t, err)
				assert.True(t, resp.OK)
				require.NotNil(t, resp.Result)
				assert.Equal(t, 1, resp.Result.TotalChapters)
			},
		},
		{
			name:           "POST /v1/fingerprint/compute malformed JSON",
			path:           "/v1/fingerprint/compute",
			token:          "test-token",
			payload:        `{invalid-json`,
			expectedStatus: http.StatusBadRequest,
		},
		{
			name:           "POST /v1/fingerprint/compute-batch",
			path:           "/v1/fingerprint/compute-batch",
			token:          "test-token",
			payload:        `{"items":[{"repoId":"r1","chapters":[{"path":"g.md","wordCount":100,"codeBlockCount":0,"headingCount":1,"pageUrl":"/docs/g"}],"events":[{"eventType":"PAGE_VIEW","pageUrl":"/docs/g"}]}]}`,
			expectedStatus: http.StatusOK,
			verifyResponse: func(t *testing.T, body []byte) {
				var resp fingerprint.FingerprintComputeBatchResponse
				err := json.Unmarshal(body, &resp)
				require.NoError(t, err)
				assert.True(t, resp.OK)
				assert.Contains(t, resp.Results, "r1")
			},
		},
		{
			name:           "POST /v1/fingerprint/compute-batch malformed JSON",
			path:           "/v1/fingerprint/compute-batch",
			token:          "test-token",
			payload:        `{invalid-json`,
			expectedStatus: http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodPost, ts.URL+tt.path, strings.NewReader(tt.payload))
			require.NoError(t, err)
			req.Header.Set("Content-Type", "application/json")
			if tt.token != "" {
				req.Header.Set("x-internal-token", tt.token)
			}

			resp, err := ts.Client().Do(req)
			require.NoError(t, err)
			defer resp.Body.Close()

			assert.Equal(t, tt.expectedStatus, resp.StatusCode)
			respBody, err := io.ReadAll(resp.Body)
			require.NoError(t, err)

			if tt.verifyResponse != nil {
				tt.verifyResponse(t, respBody)
			}
		})
	}
}
