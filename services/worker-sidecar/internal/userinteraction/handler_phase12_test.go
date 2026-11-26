package userinteraction

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHandleChapterVersionCreate(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockResult     *ChapterVersionCreateResult
		mockErr        error
		expectedStatus int
		expectedOk     bool
		expectedID     string
	}{
		{
			name: "successful creation",
			body: `{"documentId":"doc-1","repositoryId":"repo-1","authorId":"u-1","contentId":"cnt-1"}`,
			mockResult: &ChapterVersionCreateResult{
				VersionID: "ver-123",
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
			expectedID:     "ver-123",
		},
		{
			name:           "missing required fields",
			body:           `{"documentId":"doc-1"}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "store error",
			body:           `{"documentId":"doc-1","repositoryId":"repo-1","authorId":"u-1","contentId":"cnt-1"}`,
			mockErr:        errors.New("db error"),
			expectedStatus: http.StatusInternalServerError,
			expectedOk:     false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				createChapterVersionFn: func(ctx context.Context, input ChapterVersionCreateInput) (*ChapterVersionCreateResult, error) {
					if tc.mockErr != nil {
						return nil, tc.mockErr
					}
					return tc.mockResult, nil
				},
			}

			h := NewHandler(store)
			req := httptest.NewRequest(http.MethodPost, "/v1/chapter-versions/create", bytes.NewBufferString(tc.body))
			w := httptest.NewRecorder()

			h.HandleChapterVersionCreate(w, req)
			assert.Equal(t, tc.expectedStatus, w.Code)

			if tc.expectedStatus == http.StatusOK {
				var res ChapterVersionCreateResponse
				err := json.Unmarshal(w.Body.Bytes(), &res)
				require.NoError(t, err)
				assert.Equal(t, tc.expectedOk, res.Ok)
				assert.Equal(t, tc.expectedID, res.VersionID)
			}
		})
	}
}

func TestHandleChapterVersionPublish(t *testing.T) {
	tests := []struct {
		name              string
		body              string
		mockResult        *ChapterVersionPublishResult
		mockErr           error
		expectedStatus    int
		expectedOk        bool
		expectedNotFound  bool
		expectedForbidden bool
		expectedBase      int
	}{
		{
			name: "successful publish",
			body: `{"versionId":"v-1","userId":"u-1"}`,
			mockResult: &ChapterVersionPublishResult{
				Found: true,
				Base:  0,
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
			expectedBase:   0,
		},
		{
			name: "version not found",
			body: `{"versionId":"v-missing","userId":"u-1"}`,
			mockResult: &ChapterVersionPublishResult{
				Found: false,
			},
			expectedStatus:   http.StatusOK,
			expectedOk:       false,
			expectedNotFound: true,
		},
		{
			name: "forbidden non-author",
			body: `{"versionId":"v-1","userId":"u-other"}`,
			mockResult: &ChapterVersionPublishResult{
				Found:     true,
				Forbidden: true,
			},
			expectedStatus:    http.StatusOK,
			expectedOk:        false,
			expectedForbidden: true,
		},
		{
			name:           "missing fields",
			body:           `{"versionId":""}`,
			expectedStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				publishChapterVersionFn: func(ctx context.Context, versionID, userID string) (*ChapterVersionPublishResult, error) {
					if tc.mockErr != nil {
						return nil, tc.mockErr
					}
					return tc.mockResult, nil
				},
			}

			h := NewHandler(store)
			req := httptest.NewRequest(http.MethodPost, "/v1/chapter-versions/publish", bytes.NewBufferString(tc.body))
			w := httptest.NewRecorder()

			h.HandleChapterVersionPublish(w, req)
			assert.Equal(t, tc.expectedStatus, w.Code)

			if tc.expectedStatus == http.StatusOK {
				var res ChapterVersionPublishResponse
				err := json.Unmarshal(w.Body.Bytes(), &res)
				require.NoError(t, err)
				assert.Equal(t, tc.expectedOk, res.Ok)
				assert.Equal(t, tc.expectedNotFound, res.NotFound)
				assert.Equal(t, tc.expectedForbidden, res.Forbidden)
				assert.Equal(t, tc.expectedBase, res.Base)
			}
		})
	}
}

func TestHandleChapterVersionDelete(t *testing.T) {
	tests := []struct {
		name                 string
		body                 string
		mockResult           *ChapterVersionDeleteResult
		mockErr              error
		expectedStatus       int
		expectedOk           bool
		expectedNotFound     bool
		expectedForbidden    bool
		expectedInvalidState bool
	}{
		{
			name: "successful delete",
			body: `{"versionId":"v-1","userId":"u-1"}`,
			mockResult: &ChapterVersionDeleteResult{
				Found: true,
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
		},
		{
			name: "version not found",
			body: `{"versionId":"v-missing","userId":"u-1"}`,
			mockResult: &ChapterVersionDeleteResult{
				Found: false,
			},
			expectedStatus:   http.StatusOK,
			expectedOk:       false,
			expectedNotFound: true,
		},
		{
			name: "forbidden non-author",
			body: `{"versionId":"v-1","userId":"u-other"}`,
			mockResult: &ChapterVersionDeleteResult{
				Found:     true,
				Forbidden: true,
			},
			expectedStatus:    http.StatusOK,
			expectedOk:        false,
			expectedForbidden: true,
		},
		{
			name: "cannot delete public version",
			body: `{"versionId":"v-public","userId":"u-1"}`,
			mockResult: &ChapterVersionDeleteResult{
				Found:        true,
				InvalidState: true,
			},
			expectedStatus:       http.StatusOK,
			expectedOk:           false,
			expectedInvalidState: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				deleteChapterVersionFn: func(ctx context.Context, versionID, userID string) (*ChapterVersionDeleteResult, error) {
					if tc.mockErr != nil {
						return nil, tc.mockErr
					}
					return tc.mockResult, nil
				},
			}

			h := NewHandler(store)
			req := httptest.NewRequest(http.MethodPost, "/v1/chapter-versions/delete", bytes.NewBufferString(tc.body))
			w := httptest.NewRecorder()

			h.HandleChapterVersionDelete(w, req)
			assert.Equal(t, tc.expectedStatus, w.Code)

			if tc.expectedStatus == http.StatusOK {
				var res ChapterVersionDeleteResponse
				err := json.Unmarshal(w.Body.Bytes(), &res)
				require.NoError(t, err)
				assert.Equal(t, tc.expectedOk, res.Ok)
				assert.Equal(t, tc.expectedNotFound, res.NotFound)
				assert.Equal(t, tc.expectedForbidden, res.Forbidden)
				assert.Equal(t, tc.expectedInvalidState, res.InvalidState)
			}
		})
	}
}

func TestHandleChapterVersionPin(t *testing.T) {
	tests := []struct {
		name              string
		body              string
		mockResult        *ChapterVersionPinResult
		mockErr           error
		expectedStatus    int
		expectedOk        bool
		expectedNotFound  bool
		expectedForbidden bool
		expectedSuccess   bool
		expectedReason    string
	}{
		{
			name: "successful pin",
			body: `{"versionId":"v-1","userId":"m-1"}`,
			mockResult: &ChapterVersionPinResult{
				Found:      true,
				Success:    true,
				Flipped:    true,
				Reason:     "SUCCESS",
				DocumentID: "doc-1",
				PostSwapPayload: &PostSwapPayload{
					RepositoryID: "repo-1",
					DocumentID:   "doc-1",
					Path:         "docs/ch1.md",
					ContentID:    "cnt-1",
					Content:      "# Content",
				},
			},
			expectedStatus:  http.StatusOK,
			expectedOk:      true,
			expectedSuccess: true,
			expectedReason:  "SUCCESS",
		},
		{
			name: "version not found",
			body: `{"versionId":"v-missing","userId":"m-1"}`,
			mockResult: &ChapterVersionPinResult{
				Found: false,
			},
			expectedStatus:   http.StatusOK,
			expectedOk:       false,
			expectedNotFound: true,
		},
		{
			name: "forbidden non-maintainer non-admin",
			body: `{"versionId":"v-1","userId":"u-rando"}`,
			mockResult: &ChapterVersionPinResult{
				Found:     true,
				Forbidden: true,
			},
			expectedStatus:    http.StatusOK,
			expectedOk:        false,
			expectedForbidden: true,
		},
		{
			name: "already canonical",
			body: `{"versionId":"v-1","userId":"m-1"}`,
			mockResult: &ChapterVersionPinResult{
				Found:      true,
				Success:    true,
				Flipped:    false,
				Reason:     "ALREADY_CANONICAL",
				DocumentID: "doc-1",
			},
			expectedStatus:  http.StatusOK,
			expectedOk:      true,
			expectedSuccess: true,
			expectedReason:  "ALREADY_CANONICAL",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				pinChapterVersionFn: func(ctx context.Context, input ChapterVersionPinInput) (*ChapterVersionPinResult, error) {
					if tc.mockErr != nil {
						return nil, tc.mockErr
					}
					return tc.mockResult, nil
				},
			}

			h := NewHandler(store)
			req := httptest.NewRequest(http.MethodPost, "/v1/chapter-versions/pin", bytes.NewBufferString(tc.body))
			w := httptest.NewRecorder()

			h.HandleChapterVersionPin(w, req)
			assert.Equal(t, tc.expectedStatus, w.Code)

			if tc.expectedStatus == http.StatusOK {
				var res ChapterVersionPinResponse
				err := json.Unmarshal(w.Body.Bytes(), &res)
				require.NoError(t, err)
				assert.Equal(t, tc.expectedOk, res.Ok)
				assert.Equal(t, tc.expectedNotFound, res.NotFound)
				assert.Equal(t, tc.expectedForbidden, res.Forbidden)
				assert.Equal(t, tc.expectedSuccess, res.Success)
				assert.Equal(t, tc.expectedReason, res.Reason)
			}
		})
	}
}

func TestHandleChapterVersionPromote(t *testing.T) {
	cand := "cand-1"
	tests := []struct {
		name            string
		body            string
		mockResult      *CanonicalPromotionResult
		mockErr         error
		expectedStatus  int
		expectedOk      bool
		expectedFlipped bool
		expectedReason  string
	}{
		{
			name: "successful community flip",
			body: `{"documentId":"doc-1","flipMargin":2}`,
			mockResult: &CanonicalPromotionResult{
				Flipped:            true,
				CanonicalVersionID: &cand,
				Reason:             "SUCCESS",
			},
			expectedStatus:  http.StatusOK,
			expectedOk:      true,
			expectedFlipped: true,
			expectedReason:  "SUCCESS",
		},
		{
			name: "maintainer pin immune",
			body: `{"documentId":"doc-1"}`,
			mockResult: &CanonicalPromotionResult{
				Flipped:            false,
				CanonicalVersionID: &cand,
				Reason:             "MAINTAINER_PINNED_IMMUNE",
			},
			expectedStatus:  http.StatusOK,
			expectedOk:      true,
			expectedFlipped: false,
			expectedReason:  "MAINTAINER_PINNED_IMMUNE",
		},
		{
			name: "margin not met",
			body: `{"documentId":"doc-1","flipMargin":2}`,
			mockResult: &CanonicalPromotionResult{
				Flipped:            false,
				CanonicalVersionID: &cand,
				Reason:             "MARGIN_NOT_MET",
			},
			expectedStatus:  http.StatusOK,
			expectedOk:      true,
			expectedFlipped: false,
			expectedReason:  "MARGIN_NOT_MET",
		},
		{
			name:           "missing documentId",
			body:           `{}`,
			expectedStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				promoteCanonicalChapterVersionFn: func(ctx context.Context, input CanonicalPromotionInput) (*CanonicalPromotionResult, error) {
					if tc.mockErr != nil {
						return nil, tc.mockErr
					}
					return tc.mockResult, nil
				},
			}

			h := NewHandler(store)
			req := httptest.NewRequest(http.MethodPost, "/v1/chapter-versions/promote", bytes.NewBufferString(tc.body))
			w := httptest.NewRecorder()

			h.HandleChapterVersionPromote(w, req)
			assert.Equal(t, tc.expectedStatus, w.Code)

			if tc.expectedStatus == http.StatusOK {
				var res ChapterVersionPromoteResponse
				err := json.Unmarshal(w.Body.Bytes(), &res)
				require.NoError(t, err)
				assert.Equal(t, tc.expectedOk, res.Ok)
				assert.Equal(t, tc.expectedFlipped, res.Flipped)
				assert.Equal(t, tc.expectedReason, res.Reason)
			}
		})
	}
}
