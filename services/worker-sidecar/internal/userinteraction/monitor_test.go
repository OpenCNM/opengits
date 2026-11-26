package userinteraction

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMonitorFingerprintStability(t *testing.T) {
	const stack = "Error: boom\n" +
		"    at renderChapter (https://app.example.com/_next/static/chunks/app/page-abc123.js:101:20)\n" +
		"    at React.dispatch (https://app.example.com/_next/static/chunks/framework-def456.js:55:10)\n" +
		"    at https://app.example.com/_next/static/chunks/main-789.js:12:3\n" +
		"    at irrelevantFourthFrame (https://app.example.com/x.js:1:1)"

	tests := []struct {
		name    string
		kind    string
		message string
		stack   string
		want    string
	}{
		{
			name:    "base",
			kind:    "JS_ERROR",
			message: "Cannot read properties of undefined (reading 'title')",
			stack:   stack,
			want:    "base",
		},
		{
			name:    "line drift",
			kind:    "JS_ERROR",
			message: "Cannot read properties of undefined (reading 'title')",
			stack:   strings.ReplaceAll(stack, ":101:20", ":203:40"),
			want:    "base",
		},
		{
			name:    "bundle hash drift",
			kind:    "JS_ERROR",
			message: "Cannot read properties of undefined (reading 'title')",
			stack:   strings.ReplaceAll(stack, "page-abc123.js", "page-fff999.js"),
			want:    "different",
		},
		{
			name:    "numeric message drift",
			kind:    "JS_ERROR",
			message: "Failed to fetch 404",
			stack:   stack,
			want:    "numeric-base",
		},
		{
			name:    "numeric message drift 2",
			kind:    "JS_ERROR",
			message: "Failed to fetch 500",
			stack:   stack,
			want:    "numeric-base",
		},
		{
			name:    "uuid message drift",
			kind:    "RENDER_ERROR",
			message: "digest 550e8400-e29b-41d4-a716-446655440000 mismatch",
			stack:   stack,
			want:    "hex-base",
		},
		{
			name:    "hex message drift 2",
			kind:    "RENDER_ERROR",
			message: "digest aabbccddeeff00112233 mismatch",
			stack:   stack,
			want:    "hex-base",
		},
		{
			name:    "kind split",
			kind:    "PROMISE_REJECTION",
			message: "Cannot read properties of undefined (reading 'title')",
			stack:   stack,
			want:    "different",
		},
		{
			name:    "empty inputs",
			kind:    "JS_ERROR",
			message: "",
			stack:   "",
			want:    "empty-base",
		},
		{
			name:    "empty inputs repeat",
			kind:    "JS_ERROR",
			message: "",
			stack:   "",
			want:    "empty-base",
		},
	}

	fps := make(map[string]string, len(tests))
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fp := monitorFingerprint(tc.kind, tc.message, tc.stack)
			assert.Len(t, fp, 16, "指纹应为 16 hex 字符")
			fps[tc.name] = fp
		})
	}

	require.Equal(t, fps["base"], fps["line drift"], "行号漂移必须聚合")
	require.Equal(t, fps["numeric message drift"], fps["numeric message drift 2"], "状态码漂移必须聚合")
	require.Equal(t, fps["uuid message drift"], fps["hex message drift 2"], "hex/uuid 漂移必须聚合")
	require.Equal(t, fps["empty inputs"], fps["empty inputs repeat"], "空输入必须确定性")
	require.NotEqual(t, fps["base"], fps["bundle hash drift"], "产物 hash 变化应分裂（文件基名参与指纹）")
	require.NotEqual(t, fps["base"], fps["kind split"], "kind 参与指纹")
}

func TestMonitorTopFrames(t *testing.T) {
	tests := []struct {
		name  string
		stack string
		n     int
		want  []string
	}{
		{
			name: "named frames",
			stack: "Error: x\n" +
				"    at fnA (https://cdn.x.com/chunks/page-1.js:10:5)\n" +
				"    at fnB (https://cdn.x.com/chunks/framework-2.js:20:6)",
			n:    3,
			want: []string{"fnA|page-1.js", "fnB|framework-2.js"},
		},
		{
			name: "anonymous frame",
			stack: "    at https://cdn.x.com/main.js:1:1\n" +
				"    at fnB (app:///local/file.ts:2:2)",
			n:    3,
			want: []string{"<anonymous>|main.js", "fnB|file.ts"},
		},
		{
			name:  "cap at n",
			stack: "    at a (a.js:1:1)\n    at b (b.js:1:1)\n    at c (c.js:1:1)\n    at d (d.js:1:1)",
			n:     2,
			want:  []string{"a|a.js", "b|b.js"},
		},
		{
			name:  "non-v8 stack ignored",
			stack: "python-style traceback\n  File \"x.py\", line 1",
			n:     3,
			want:  []string{},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, monitorTopFrames(tc.stack, tc.n))
		})
	}
}

func TestAllowedMonitorEventKinds(t *testing.T) {
	for kind := range monitorErrorKinds {
		_, ok := allowedMonitorEventKinds[kind]
		assert.True(t, ok, "monitorErrorKinds 的 %s 必须在 allowedMonitorEventKinds 内", kind)
	}
}

func TestHandleMonitorEvents(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		storeFn        func(ctx context.Context, userID string, events []MonitorEventInput) (int, error)
		expectedStatus int
		expectedCount  int
	}{
		{
			name: "valid batch forwards to store",
			body: `{"userId":"user-1","events":[{"kind":"JS_ERROR","pageUrl":"/docs/a/b","sessionId":"s-1","payload":{"message":"boom","stack":"at x (y.js:1:1)"}}]}`,
			storeFn: func(ctx context.Context, userID string, events []MonitorEventInput) (int, error) {
				if userID != "user-1" || len(events) != 1 || events[0].Kind != "JS_ERROR" {
					t.Errorf("unexpected store args: %+v", events)
				}
				return 1, nil
			},
			expectedStatus: http.StatusOK,
			expectedCount:  1,
		},
		{
			name:           "missing userId rejected",
			body:           `{"events":[]}`,
			expectedStatus: http.StatusBadRequest,
		},
		{
			name:           "malformed json rejected",
			body:           `{not-json`,
			expectedStatus: http.StatusBadRequest,
		},
		{
			name: "empty events forwards and returns zero",
			body: `{"userId":"user-1","events":[]}`,
			storeFn: func(ctx context.Context, userID string, events []MonitorEventInput) (int, error) {
				return len(events), nil
			},
			expectedStatus: http.StatusOK,
			expectedCount:  0,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHandler(&mockStore{recordMonitorEventsFn: tc.storeFn})
			req := httptest.NewRequest(http.MethodPost, "/v1/monitor/events", strings.NewReader(tc.body))
			rec := httptest.NewRecorder()

			h.HandleMonitorEvents(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code)
			if tc.expectedStatus == http.StatusOK {
				var res MonitorBatchResponse
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res))
				assert.Equal(t, tc.expectedCount, res.Count)
				assert.True(t, res.Ok)
			}
		})
	}
}
