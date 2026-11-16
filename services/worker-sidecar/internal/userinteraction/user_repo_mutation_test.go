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

type mutationMockStore struct {
	mockStore
	createUserAuthFn func(ctx context.Context, input AuthCreateUserInput) (*AuthUserResult, error)
	updateUserFn     func(ctx context.Context, input UpdateUserInput) (*UserMutationResult, error)
	deleteUserFn     func(ctx context.Context, id string) error
	patchRepoFn      func(ctx context.Context, input RepoPatchInput) error
	batchPatchFn     func(ctx context.Context, input RepoBatchPatchInput) (int64, error)
	incrementFn      func(ctx context.Context, input RepoIncrementInput) (*RepoIncrementResult, error)
	deleteRepoFn         func(ctx context.Context, input RepoDeleteInput) (int64, error)
	unpublishRepoFn      func(ctx context.Context, input RepoUnpublishInput) (*RepoUnpublishResult, error)
	promoteEditionRepoFn func(ctx context.Context, input RepoPromoteEditionInput) (*RepoPromoteEditionResult, error)
}

func (m *mutationMockStore) UnpublishRepo(ctx context.Context, input RepoUnpublishInput) (*RepoUnpublishResult, error) {
	if m.unpublishRepoFn != nil {
		return m.unpublishRepoFn(ctx, input)
	}
	return &RepoUnpublishResult{
		OK:                          true,
		IsPublic:                    false,
		CancelledPendingGrantsCount: 1,
		DetachedSavedReposCount:     3,
	}, nil
}

func (m *mutationMockStore) PromoteEditionRepo(ctx context.Context, input RepoPromoteEditionInput) (*RepoPromoteEditionResult, error) {
	if m.promoteEditionRepoFn != nil {
		return m.promoteEditionRepoFn(ctx, input)
	}
	return &RepoPromoteEditionResult{
		OK:             true,
		PromotedRepoID: input.ID,
	}, nil
}



func (m *mutationMockStore) CreateUserAuth(ctx context.Context, input AuthCreateUserInput) (*AuthUserResult, error) {
	if m.createUserAuthFn != nil {
		return m.createUserAuthFn(ctx, input)
	}
	return &AuthUserResult{ID: "created-user-1"}, nil
}

func (m *mutationMockStore) UpdateUser(ctx context.Context, input UpdateUserInput) (*UserMutationResult, error) {
	if m.updateUserFn != nil {
		return m.updateUserFn(ctx, input)
	}
	return &UserMutationResult{ID: input.ID}, nil
}

func (m *mutationMockStore) DeleteUser(ctx context.Context, id string) error {
	if m.deleteUserFn != nil {
		return m.deleteUserFn(ctx, id)
	}
	return nil
}

func (m *mutationMockStore) PatchRepo(ctx context.Context, input RepoPatchInput) error {
	if m.patchRepoFn != nil {
		return m.patchRepoFn(ctx, input)
	}
	return nil
}

func (m *mutationMockStore) BatchPatchRepos(ctx context.Context, input RepoBatchPatchInput) (int64, error) {
	if m.batchPatchFn != nil {
		return m.batchPatchFn(ctx, input)
	}
	return int64(len(input.IDs)), nil
}

func (m *mutationMockStore) IncrementRepoCounters(ctx context.Context, input RepoIncrementInput) (*RepoIncrementResult, error) {
	if m.incrementFn != nil {
		return m.incrementFn(ctx, input)
	}
	n := 5
	return &RepoIncrementResult{OK: true, AutoSwapCount: &n}, nil
}

func (m *mutationMockStore) DeleteRepo(ctx context.Context, input RepoDeleteInput) (int64, error) {
	if m.deleteRepoFn != nil {
		return m.deleteRepoFn(ctx, input)
	}
	return 1, nil
}

func TestUserMutationEndpoints(t *testing.T) {
	t.Run("HandleUserAuthCreate success", func(t *testing.T) {
		mock := &mutationMockStore{
			createUserAuthFn: func(ctx context.Context, input AuthCreateUserInput) (*AuthUserResult, error) {
				return &AuthUserResult{ID: "u-123", Name: input.Name, Email: input.Email, CreditBalance: 30}, nil
			},
		}
		h := NewHandler(mock)
		body := `{"name":"Alice","email":"alice@test.local","grantGift":true}`
		req := httptest.NewRequest(http.MethodPost, "/v1/user/auth-create", bytes.NewReader([]byte(body)))
		w := httptest.NewRecorder()
		h.HandleUserAuthCreate(w, req)

		require.Equal(t, http.StatusOK, w.Code)
		var resp map[string]any
		err := json.Unmarshal(w.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.Equal(t, true, resp["ok"])
	})

	t.Run("HandleUserUpdate success and not found", func(t *testing.T) {
		mock := &mutationMockStore{
			updateUserFn: func(ctx context.Context, input UpdateUserInput) (*UserMutationResult, error) {
				if input.ID == "missing" {
					return nil, ErrUserNotFound
				}
				return &UserMutationResult{ID: input.ID, Tier: "PRO"}, nil
			},
		}
		h := NewHandler(mock)

		// Success
		body := `{"id":"u-123","tier":"PRO"}`
		req := httptest.NewRequest(http.MethodPost, "/v1/user/update", bytes.NewReader([]byte(body)))
		w := httptest.NewRecorder()
		h.HandleUserUpdate(w, req)
		require.Equal(t, http.StatusOK, w.Code)

		// Not found
		bodyNotFound := `{"id":"missing","tier":"PRO"}`
		reqNotFound := httptest.NewRequest(http.MethodPost, "/v1/user/update", bytes.NewReader([]byte(bodyNotFound)))
		wNotFound := httptest.NewRecorder()
		h.HandleUserUpdate(wNotFound, reqNotFound)
		require.Equal(t, http.StatusNotFound, wNotFound.Code)

		// Bad request missing id
		bodyNoID := `{"tier":"PRO"}`
		reqNoID := httptest.NewRequest(http.MethodPost, "/v1/user/update", bytes.NewReader([]byte(bodyNoID)))
		wNoID := httptest.NewRecorder()
		h.HandleUserUpdate(wNoID, reqNoID)
		require.Equal(t, http.StatusBadRequest, wNoID.Code)
	})

	t.Run("HandleUserDelete success", func(t *testing.T) {
		mock := &mutationMockStore{
			deleteUserFn: func(ctx context.Context, id string) error {
				if id == "notfound" {
					return ErrUserNotFound
				}
				return nil
			},
		}
		h := NewHandler(mock)

		body := `{"id":"u-123"}`
		req := httptest.NewRequest(http.MethodPost, "/v1/user/delete", bytes.NewReader([]byte(body)))
		w := httptest.NewRecorder()
		h.HandleUserDelete(w, req)
		require.Equal(t, http.StatusOK, w.Code)

		bodyNotFound := `{"id":"notfound"}`
		reqNotFound := httptest.NewRequest(http.MethodPost, "/v1/user/delete", bytes.NewReader([]byte(bodyNotFound)))
		wNotFound := httptest.NewRecorder()
		h.HandleUserDelete(wNotFound, reqNotFound)
		require.Equal(t, http.StatusNotFound, wNotFound.Code)
	})
}

func TestRepoMutationEndpoints(t *testing.T) {
	t.Run("HandleRepoPatch success and not found", func(t *testing.T) {
		mock := &mutationMockStore{
			patchRepoFn: func(ctx context.Context, input RepoPatchInput) error {
				if input.ID == "missing" {
					return ErrRepositoryNotFound
				}
				return nil
			},
		}
		h := NewHandler(mock)

		body := `{"id":"repo-1","isPublic":true,"touchPublishedAt":true}`
		req := httptest.NewRequest(http.MethodPost, "/v1/repos/patch", bytes.NewReader([]byte(body)))
		w := httptest.NewRecorder()
		h.HandleRepoPatch(w, req)
		require.Equal(t, http.StatusOK, w.Code)

		bodyMissing := `{"id":"missing","isPublic":true}`
		reqMissing := httptest.NewRequest(http.MethodPost, "/v1/repos/patch", bytes.NewReader([]byte(bodyMissing)))
		wMissing := httptest.NewRecorder()
		h.HandleRepoPatch(wMissing, reqMissing)
		require.Equal(t, http.StatusNotFound, wMissing.Code)
	})

	t.Run("HandleRepoBatchPatch success", func(t *testing.T) {
		mock := &mutationMockStore{
			batchPatchFn: func(ctx context.Context, input RepoBatchPatchInput) (int64, error) {
				return int64(len(input.IDs)), nil
			},
		}
		h := NewHandler(mock)
		body := `{"ids":["r1","r2"],"hasUpstreamUpdate":true,"touchUpstreamCheckedAt":true,"clearUpstreamEtag":true}`
		req := httptest.NewRequest(http.MethodPost, "/v1/repos/batch-patch", bytes.NewReader([]byte(body)))
		w := httptest.NewRecorder()
		h.HandleRepoBatchPatch(w, req)

		require.Equal(t, http.StatusOK, w.Code)
		var resp map[string]any
		err := json.Unmarshal(w.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.Equal(t, float64(2), resp["updated"])
	})

	t.Run("HandleRepoIncrement success", func(t *testing.T) {
		mock := &mutationMockStore{
			incrementFn: func(ctx context.Context, input RepoIncrementInput) (*RepoIncrementResult, error) {
				count := 42
				return &RepoIncrementResult{OK: true, AutoSwapCount: &count}, nil
			},
		}
		h := NewHandler(mock)
		body := `{"id":"r1","autoSwapCount":1}`
		req := httptest.NewRequest(http.MethodPost, "/v1/repos/increment", bytes.NewReader([]byte(body)))
		w := httptest.NewRecorder()
		h.HandleRepoIncrement(w, req)

		require.Equal(t, http.StatusOK, w.Code)
		var resp map[string]any
		err := json.Unmarshal(w.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.Equal(t, float64(42), resp["autoSwapCount"])
	})

	t.Run("HandleRepoDelete success", func(t *testing.T) {
		mock := &mutationMockStore{
			deleteRepoFn: func(ctx context.Context, input RepoDeleteInput) (int64, error) {
				return 1, nil
			},
		}
		h := NewHandler(mock)
		body := `{"id":"r1"}`
		req := httptest.NewRequest(http.MethodPost, "/v1/repos/delete", bytes.NewReader([]byte(body)))
		w := httptest.NewRecorder()
		h.HandleRepoDelete(w, req)

		require.Equal(t, http.StatusOK, w.Code)
		var resp map[string]any
		err := json.Unmarshal(w.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.Equal(t, float64(1), resp["deleted"])
	})

	t.Run("HandleRepoUnpublish success", func(t *testing.T) {
		mock := &mutationMockStore{
			unpublishRepoFn: func(ctx context.Context, input RepoUnpublishInput) (*RepoUnpublishResult, error) {
				assert.Equal(t, "repo-xyz", input.ID)
				return &RepoUnpublishResult{
					OK:                          true,
					IsPublic:                    false,
					CancelledPendingGrantsCount: 2,
					DetachedSavedReposCount:     5,
				}, nil
			},
		}
		h := NewHandler(mock)
		body := `{"id":"repo-xyz","userId":"u1"}`
		req := httptest.NewRequest(http.MethodPost, "/v1/repos/unpublish", bytes.NewReader([]byte(body)))
		w := httptest.NewRecorder()
		h.HandleRepoUnpublish(w, req)

		require.Equal(t, http.StatusOK, w.Code)
		var resp map[string]any
		err := json.Unmarshal(w.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp["ok"].(bool))
		assert.False(t, resp["isPublic"].(bool))
		assert.Equal(t, float64(2), resp["cancelledPendingGrantsCount"])
		assert.Equal(t, float64(5), resp["detachedSavedReposCount"])
	})

	t.Run("HandleRepoUnpublish missing id returns 400", func(t *testing.T) {
		h := NewHandler(&mutationMockStore{})
		req := httptest.NewRequest(http.MethodPost, "/v1/repos/unpublish", bytes.NewReader([]byte(`{}`)))
		w := httptest.NewRecorder()
		h.HandleRepoUnpublish(w, req)
		require.Equal(t, http.StatusBadRequest, w.Code)
	})

	t.Run("HandleRepoUnpublish non-public repo returns 400", func(t *testing.T) {
		mock := &mutationMockStore{
			unpublishRepoFn: func(ctx context.Context, input RepoUnpublishInput) (*RepoUnpublishResult, error) {
				return nil, errors.New("repository is already private or not public")
			},
		}
		h := NewHandler(mock)
		body := `{"id":"repo-xyz","userId":"u1"}`
		req := httptest.NewRequest(http.MethodPost, "/v1/repos/unpublish", bytes.NewReader([]byte(body)))
		w := httptest.NewRecorder()
		h.HandleRepoUnpublish(w, req)
		require.Equal(t, http.StatusBadRequest, w.Code)
	})

	t.Run("HandleRepoPromoteEdition success", func(t *testing.T) {
		mock := &mutationMockStore{
			promoteEditionRepoFn: func(ctx context.Context, input RepoPromoteEditionInput) (*RepoPromoteEditionResult, error) {
				assert.Equal(t, "repo-custom", input.ID)
				return &RepoPromoteEditionResult{
					OK:               true,
					PromotedRepoID:   "repo-custom",
					OldDefaultRepoID: "repo-default",
					MigratedSaves:    3,
				}, nil
			},
		}
		h := NewHandler(mock)
		body := `{"id":"repo-custom","userId":"u1"}`
		req := httptest.NewRequest(http.MethodPost, "/v1/repos/promote-edition", bytes.NewReader([]byte(body)))
		w := httptest.NewRecorder()
		h.HandleRepoPromoteEdition(w, req)

		require.Equal(t, http.StatusOK, w.Code)
		var resp map[string]any
		err := json.Unmarshal(w.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp["ok"].(bool))
		assert.Equal(t, "repo-custom", resp["promotedRepoId"])
		assert.Equal(t, "repo-default", resp["oldDefaultRepoId"])
		assert.Equal(t, float64(3), resp["migratedSaves"])
	})

	t.Run("HandleRepoPromoteEdition success without old default", func(t *testing.T) {
		mock := &mutationMockStore{
			promoteEditionRepoFn: func(ctx context.Context, input RepoPromoteEditionInput) (*RepoPromoteEditionResult, error) {
				assert.Equal(t, "repo-custom-standalone", input.ID)
				return &RepoPromoteEditionResult{
					OK:             true,
					PromotedRepoID: "repo-custom-standalone",
					MigratedSaves:  0,
				}, nil
			},
		}
		h := NewHandler(mock)
		body := `{"id":"repo-custom-standalone","userId":"u1"}`
		req := httptest.NewRequest(http.MethodPost, "/v1/repos/promote-edition", bytes.NewReader([]byte(body)))
		w := httptest.NewRecorder()
		h.HandleRepoPromoteEdition(w, req)

		require.Equal(t, http.StatusOK, w.Code)
		var resp map[string]any
		err := json.Unmarshal(w.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp["ok"].(bool))
		assert.Equal(t, "repo-custom-standalone", resp["promotedRepoId"])
		assert.Empty(t, resp["oldDefaultRepoId"])
		assert.Equal(t, float64(0), resp["migratedSaves"])
	})

	t.Run("HandleRepoPromoteEdition missing id returns 400", func(t *testing.T) {
		h := NewHandler(&mutationMockStore{})
		req := httptest.NewRequest(http.MethodPost, "/v1/repos/promote-edition", bytes.NewReader([]byte(`{}`)))
		w := httptest.NewRecorder()
		h.HandleRepoPromoteEdition(w, req)
		require.Equal(t, http.StatusBadRequest, w.Code)
	})

	t.Run("HandleRepoPromoteEdition already default returns 400", func(t *testing.T) {
		mock := &mutationMockStore{
			promoteEditionRepoFn: func(ctx context.Context, input RepoPromoteEditionInput) (*RepoPromoteEditionResult, error) {
				return nil, errors.New("repository is already the default edition")
			},
		}
		h := NewHandler(mock)
		body := `{"id":"repo-xyz","userId":"u1"}`
		req := httptest.NewRequest(http.MethodPost, "/v1/repos/promote-edition", bytes.NewReader([]byte(body)))
		w := httptest.NewRecorder()
		h.HandleRepoPromoteEdition(w, req)
		require.Equal(t, http.StatusBadRequest, w.Code)
	})
}

