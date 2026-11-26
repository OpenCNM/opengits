package search

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHandler_HandleUnified(t *testing.T) {
	tests := []struct {
		name       string
		token      string
		body       string
		setupStore func(m *mockSearchStore)
		wantStatus int
		checkResp  func(t *testing.T, rec *httptest.ResponseRecorder, store *mockSearchStore)
	}{
		{
			name:       "缺少内部鉴权 token 返回 401",
			token:      "",
			body:       `{"query":"test"}`,
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "空 query 与 rawQuery 返回空 hits 数组",
			token:      "test-token",
			body:       `{"query":"","rawQuery":"  "}`,
			wantStatus: http.StatusOK,
			checkResp: func(t *testing.T, rec *httptest.ResponseRecorder, store *mockSearchStore) {
				var resp UnifiedSearchResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.OK)
				assert.Empty(t, resp.Hits)
			},
		},
		{
			name:  "Store 返回异常时返回 500",
			token: "test-token",
			body:  `{"query":"err-query"}`,
			setupStore: func(m *mockSearchStore) {
				m.unifiedErr = errors.New("db query failed")
			},
			wantStatus: http.StatusInternalServerError,
		},
		{
			name:  "成功执行统一检索并透传字段",
			token: "test-token",
			body:  `{"query":"react","owner":"facebook","repo":"react","exactOwner":"facebook","exactRepo":"react","limit":10}`,
			setupStore: func(m *mockSearchStore) {
				isIngested := true
				m.unifiedHits = []UnifiedSearchHit{
					{
						ID:          "exact-repo-1",
						Type:        "repository_exists",
						IsIngested:  &isIngested,
						Title:       "facebook/react",
						Description: "React",
						Owner:       "facebook",
						Repo:        "react",
						URL:         "/docs/facebook/react",
						Category:    "Framework",
						Score:       1000,
					},
				}
			},
			wantStatus: http.StatusOK,
			checkResp: func(t *testing.T, rec *httptest.ResponseRecorder, store *mockSearchStore) {
				assert.Equal(t, "react", store.lastUnifiedReq.Query)
				assert.Equal(t, "facebook", store.lastUnifiedReq.Owner)
				assert.Equal(t, "react", store.lastUnifiedReq.Repo)
				assert.Equal(t, "facebook", store.lastUnifiedReq.ExactOwner)
				assert.Equal(t, "react", store.lastUnifiedReq.ExactRepo)
				assert.Equal(t, 10, store.lastUnifiedReq.Limit)

				var resp UnifiedSearchResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.OK)
				require.Len(t, resp.Hits, 1)
				assert.Equal(t, "exact-repo-1", resp.Hits[0].ID)
				assert.Equal(t, "repository_exists", resp.Hits[0].Type)
				assert.Equal(t, 1000, resp.Hits[0].Score)
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockSearchStore{}
			if tc.setupStore != nil {
				tc.setupStore(store)
			}

			h := NewHandler(store, nil, nil, nil)
			routes := newTestRoutes(h, "test-token")

			req := httptest.NewRequest(http.MethodPost, "/v1/search/unified", bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			if tc.token != "" {
				req.Header.Set("x-internal-token", tc.token)
			}

			rec := httptest.NewRecorder()
			routes.ServeHTTP(rec, req)

			assert.Equal(t, tc.wantStatus, rec.Code)
			if tc.checkResp != nil {
				tc.checkResp(t, rec, store)
			}
		})
	}
}
