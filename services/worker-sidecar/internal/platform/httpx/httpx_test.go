package httpx

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type testPayload struct {
	Message string `json:"message"`
	Count   int    `json:"count"`
}

func TestReadJSON(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		limit          int64
		expectedOK     bool
		expectedStatus int
		expectedMsg    string
	}{
		{
			name:       "valid json within limit",
			body:       `{"message":"hello","count":42}`,
			limit:      LimitSmall,
			expectedOK: true,
		},
		{
			name:           "invalid json syntax",
			body:           `{"message": invalid`,
			limit:          LimitSmall,
			expectedOK:     false,
			expectedStatus: http.StatusBadRequest,
			expectedMsg:    "invalid json payload",
		},
		{
			name:           "body exceeds limitBytes",
			body:           `{"message":"large payload","count":100}`,
			limit:          10,
			expectedOK:     false,
			expectedStatus: http.StatusRequestEntityTooLarge,
			expectedMsg:    "request body exceeds limit",
		},
		{
			name:           "empty body string",
			body:           "",
			limit:          LimitSmall,
			expectedOK:     false,
			expectedStatus: http.StatusBadRequest,
			expectedMsg:    "invalid json payload",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/test", strings.NewReader(tt.body))
			w := httptest.NewRecorder()

			var dst testPayload
			ok := ReadJSON(w, r, &dst, tt.limit)
			assert.Equal(t, tt.expectedOK, ok)

			if tt.expectedOK {
				assert.Equal(t, "hello", dst.Message)
				assert.Equal(t, 42, dst.Count)
			} else {
				assert.Equal(t, tt.expectedStatus, w.Code)
				var errResp map[string]string
				err := json.Unmarshal(w.Body.Bytes(), &errResp)
				require.NoError(t, err)
				assert.Contains(t, errResp["error"], tt.expectedMsg)
			}
		})
	}
}

func TestReadJSON_NilBody(t *testing.T) {
	t.Run("nil request body returns 400 without panic", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/test", nil)
		r.Body = nil
		w := httptest.NewRecorder()

		var dst testPayload
		ok := ReadJSON(w, r, &dst, LimitSmall)
		assert.False(t, ok)
		assert.Equal(t, http.StatusBadRequest, w.Code)
		assert.Contains(t, w.Body.String(), "request body is missing")
	})

	t.Run("nil request pointer returns 400 without panic", func(t *testing.T) {
		w := httptest.NewRecorder()

		var dst testPayload
		ok := ReadJSON(w, nil, &dst, LimitSmall)
		assert.False(t, ok)
		assert.Equal(t, http.StatusBadRequest, w.Code)
		assert.Contains(t, w.Body.String(), "request body is missing")
	})
}

func TestWriteJSON(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		data       any
		expectJSON string
	}{
		{
			name:       "status 200 with map",
			status:     http.StatusOK,
			data:       map[string]string{"result": "ok"},
			expectJSON: `{"result":"ok"}` + "\n",
		},
		{
			name:       "status 201 with struct",
			status:     http.StatusCreated,
			data:       testPayload{Message: "created", Count: 1},
			expectJSON: `{"message":"created","count":1}` + "\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			WriteJSON(w, tt.status, tt.data)

			assert.Equal(t, tt.status, w.Code)
			assert.Equal(t, "application/json", w.Header().Get("Content-Type"))
			assert.Equal(t, tt.expectJSON, w.Body.String())
		})
	}
}

func TestError(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		message    string
		expectJSON string
	}{
		{
			name:       "bad request",
			status:     http.StatusBadRequest,
			message:    "missing parameter",
			expectJSON: `{"error":"missing parameter"}` + "\n",
		},
		{
			name:       "internal error",
			status:     http.StatusInternalServerError,
			message:    "db down",
			expectJSON: `{"error":"db down"}` + "\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			Error(w, tt.status, tt.message)

			assert.Equal(t, tt.status, w.Code)
			assert.Equal(t, "application/json", w.Header().Get("Content-Type"))
			assert.Equal(t, tt.expectJSON, w.Body.String())
		})
	}
}

func TestAssertSafeSegment(t *testing.T) {
	tests := []struct {
		name      string
		segment   string
		wantError bool
	}{
		{name: "clean segment", segment: "v1.0.0", wantError: false},
		{name: "sha segment", segment: "a1b2c3d4e5", wantError: false},
		{name: "empty string", segment: "", wantError: true},
		{name: "single dot segment", segment: ".", wantError: true},
		{name: "dot dot traversal", segment: "..", wantError: true},
		{name: "embedded dot dot", segment: "foo..bar", wantError: true},
		{name: "forward slash", segment: "foo/bar", wantError: true},
		{name: "backslash", segment: `foo\bar`, wantError: true},
		{name: "null byte", segment: "foo\x00bar", wantError: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := AssertSafeSegment(tt.segment)
			if tt.wantError {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestAssertSegments(t *testing.T) {
	tests := []struct {
		name           string
		fields         []SegmentField
		expectedOK     bool
		expectedStatus int
		expectedMsg    string
	}{
		{
			name:           "empty fields slice",
			fields:         nil,
			expectedOK:     true,
			expectedStatus: http.StatusOK,
		},
		{
			name: "all valid segments",
			fields: []SegmentField{
				{Name: "owner", Value: "facebook"},
				{Name: "repo", Value: "react"},
				{Name: "sha", Value: "main"},
			},
			expectedOK: true,
		},
		{
			name: "unsafe segment detected on first field",
			fields: []SegmentField{
				{Name: "owner", Value: ".."},
				{Name: "repo", Value: "react"},
			},
			expectedOK:     false,
			expectedStatus: http.StatusBadRequest,
			expectedMsg:    "invalid path segment in owner",
		},
		{
			name: "unsafe segment detected on later field",
			fields: []SegmentField{
				{Name: "owner", Value: "facebook"},
				{Name: "repo", Value: "../secret"},
			},
			expectedOK:     false,
			expectedStatus: http.StatusBadRequest,
			expectedMsg:    "invalid path segment in repo",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			ok := AssertSegments(w, tt.fields...)

			assert.Equal(t, tt.expectedOK, ok)
			if !tt.expectedOK {
				assert.Equal(t, tt.expectedStatus, w.Code)
				var errResp map[string]string
				err := json.Unmarshal(w.Body.Bytes(), &errResp)
				require.NoError(t, err)
				assert.Contains(t, errResp["error"], tt.expectedMsg)
			}
		})
	}
}
