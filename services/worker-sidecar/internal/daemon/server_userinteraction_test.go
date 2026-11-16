package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/userinteraction"
)

type mockUserInteractionStore struct {
	incrementViewsFunc      func(ctx context.Context, repoID string) error
	updatePinnedReposFunc   func(ctx context.Context, userID, repoID string, isPinned bool) ([]string, error)
	markNotificationsReadFn func(ctx context.Context, userID string, ids []string, all bool) (int64, error)
	clearNotificationsFn    func(ctx context.Context, userID string) (int64, error)
	getActiveOutlineFn      func(ctx context.Context, repoID string) (*userinteraction.ActiveOutlineView, error)
	toggleHelpfulFn         func(ctx context.Context, repoID, userID string) (bool, int, error)
	getDocumentStatusFn     func(ctx context.Context, docID string) (*userinteraction.DocumentStatusResult, error)
}

func (m *mockUserInteractionStore) IncrementRepoViews(ctx context.Context, repoID string) error {
	if m.incrementViewsFunc != nil {
		return m.incrementViewsFunc(ctx, repoID)
	}
	return nil
}

func (m *mockUserInteractionStore) UpdatePinnedRepos(ctx context.Context, userID, repoID string, isPinned bool) ([]string, error) {
	if m.updatePinnedReposFunc != nil {
		return m.updatePinnedReposFunc(ctx, userID, repoID, isPinned)
	}
	return []string{repoID}, nil
}

func (m *mockUserInteractionStore) MarkNotificationsRead(ctx context.Context, userID string, ids []string, all bool) (int64, error) {
	if m.markNotificationsReadFn != nil {
		return m.markNotificationsReadFn(ctx, userID, ids, all)
	}
	return 1, nil
}

func (m *mockUserInteractionStore) GetActiveOutline(ctx context.Context, repoID string) (*userinteraction.ActiveOutlineView, error) {
	if m.getActiveOutlineFn != nil {
		return m.getActiveOutlineFn(ctx, repoID)
	}
	return nil, nil
}

func (m *mockUserInteractionStore) ToggleHelpfulVote(ctx context.Context, repoID, userID string) (bool, int, error) {
	if m.toggleHelpfulFn != nil {
		return m.toggleHelpfulFn(ctx, repoID, userID)
	}
	return true, 1, nil
}

func (m *mockUserInteractionStore) GetDocumentStatus(ctx context.Context, docID string) (*userinteraction.DocumentStatusResult, error) {
	if m.getDocumentStatusFn != nil {
		return m.getDocumentStatusFn(ctx, docID)
	}
	return &userinteraction.DocumentStatusResult{Found: true, Status: "PROCESSED", Progress: 100, Step: "编纂完成"}, nil
}

func (m *mockUserInteractionStore) GetIngestStatus(ctx context.Context, owner, repo, branch string, edition *string, userID *string) (*userinteraction.IngestStatusResult, error) {
	return &userinteraction.IngestStatusResult{
		Found: true,
		Repository: &userinteraction.IngestStatusRepo{
			ID:       "repo-1",
			Owner:    owner,
			Repo:     repo,
			Branch:   branch,
			IsPublic: true,
		},
	}, nil
}

func (m *mockUserInteractionStore) GetFeaturedRepos(ctx context.Context, limit int) ([]userinteraction.FeaturedRepo, error) {
	return []userinteraction.FeaturedRepo{
		{ID: "r1", Owner: "facebook", Repo: "react"},
	}, nil
}

func (m *mockUserInteractionStore) ListNotifications(ctx context.Context, userID string, page, pageSize int) (*userinteraction.NotificationListResult, error) {
	return &userinteraction.NotificationListResult{
		Items:       []userinteraction.NotificationItem{{ID: "notif-1", UserID: userID, Title: "Test"}},
		Total:       1,
		UnreadCount: 1,
	}, nil
}

func (m *mockUserInteractionStore) ClearNotifications(ctx context.Context, userID string) (int64, error) {
	if m.clearNotificationsFn != nil {
		return m.clearNotificationsFn(ctx, userID)
	}
	return 1, nil
}

func (m *mockUserInteractionStore) PauseRepo(ctx context.Context, owner, repo, branch string, edition *string, userID *string, paused bool) (*userinteraction.PauseRepoResult, error) {
	return &userinteraction.PauseRepoResult{
		Found:  true,
		Paused: paused,
	}, nil
}

func (m *mockUserInteractionStore) ToggleChapterVersionVote(ctx context.Context, versionID, userID string) (*userinteraction.ChapterVersionVoteResult, error) {
	return &userinteraction.ChapterVersionVoteResult{
		Found:      true,
		Voted:      true,
		VoteCount:  5,
		DocumentID: "doc-1",
	}, nil
}

func (m *mockUserInteractionStore) GetReadingProgressSync(ctx context.Context, userID, owner, repo string, edition *string) (*userinteraction.ReadingProgressSyncResult, error) {
	return &userinteraction.ReadingProgressSyncResult{
		ChapterScores:   map[string]float64{"doc-1": 100},
		OverallProgress: 100,
		ViewedCount:     1,
	}, nil
}

func (m *mockUserInteractionStore) RecordTelemetryEvents(ctx context.Context, userID string, events []userinteraction.TelemetryEventInput) (int, error) {
	return len(events), nil
}

func (m *mockUserInteractionStore) RecordMonitorEvents(ctx context.Context, userID string, events []userinteraction.MonitorEventInput) (int, error) {
	return len(events), nil
}

func (m *mockUserInteractionStore) GetUserPreferences(ctx context.Context, userID string) (*userinteraction.UserPreferencesResult, error) {
	return &userinteraction.UserPreferencesResult{
		HasPreferencesSet: true,
		FontSize:          "small",
		SavedRepositories: []userinteraction.SavedRepositoryOverview{},
	}, nil
}

func (m *mockUserInteractionStore) GetUsageSummary(ctx context.Context, userID string) (*userinteraction.UsageSummaryResult, error) {
	return &userinteraction.UsageSummaryResult{
		Tier:          "PRO",
		IsAdmin:       false,
		ReposUsed:     3,
		MaxRepos:      0,
		McpCallsToday: 5,
		DailyMcpCalls: 3000,
		Tokens30d:     50000,
	}, nil
}

func (m *mockUserInteractionStore) GetDocumentContent(ctx context.Context, repoID string, candidatePaths []string, userID *string) (*userinteraction.DocumentContentResult, error) {
	return &userinteraction.DocumentContentResult{
		Found:   true,
		ID:      "doc-1",
		Path:    "readme.md",
		Title:   "Readme",
		Status:  "PROCESSED",
		Content: "# Hello World",
	}, nil
}

func (m *mockUserInteractionStore) ListChapterVersions(ctx context.Context, docID string, userID *string) ([]userinteraction.ChapterVersionItem, error) {
	return []userinteraction.ChapterVersionItem{
		{
			ID:             "ver-1",
			AuthorID:       "user-1",
			VoteCount:      1,
			IsCanonical:    true,
			Visibility:     "PUBLIC",
			Source:         "ORIGINAL",
			CreatedAt:      "2026-09-21T00:00:00Z",
			HasVoted:       false,
			IsContentValid: true,
		},
	}, nil
}

func (m *mockUserInteractionStore) CreateChapterVersion(ctx context.Context, input userinteraction.ChapterVersionCreateInput) (*userinteraction.ChapterVersionCreateResult, error) {
	return &userinteraction.ChapterVersionCreateResult{VersionID: "v-new"}, nil
}

func (m *mockUserInteractionStore) PublishChapterVersion(ctx context.Context, versionID, userID string) (*userinteraction.ChapterVersionPublishResult, error) {
	return &userinteraction.ChapterVersionPublishResult{Found: true, Base: 0}, nil
}

func (m *mockUserInteractionStore) DeleteChapterVersion(ctx context.Context, versionID, userID string) (*userinteraction.ChapterVersionDeleteResult, error) {
	return &userinteraction.ChapterVersionDeleteResult{Found: true}, nil
}

func (m *mockUserInteractionStore) PinChapterVersion(ctx context.Context, input userinteraction.ChapterVersionPinInput) (*userinteraction.ChapterVersionPinResult, error) {
	return &userinteraction.ChapterVersionPinResult{Found: true, Success: true, Flipped: true, DocumentID: "doc-1"}, nil
}

func (m *mockUserInteractionStore) PromoteCanonicalChapterVersion(ctx context.Context, input userinteraction.CanonicalPromotionInput) (*userinteraction.CanonicalPromotionResult, error) {
	cand := "cand-1"
	return &userinteraction.CanonicalPromotionResult{Flipped: true, CanonicalVersionID: &cand, Reason: "SUCCESS"}, nil
}

func (m *mockUserInteractionStore) ListConversations(ctx context.Context, owner, repo, userID string) ([]userinteraction.ConversationSummary, error) {
	return []userinteraction.ConversationSummary{
		{
			ID:        "conv-1",
			Title:     "Chat 1",
			CreatedAt: "2026-09-21T00:00:00Z",
			UpdatedAt: "2026-09-21T01:00:00Z",
		},
	}, nil
}

func (m *mockUserInteractionStore) GetConversationMessages(ctx context.Context, conversationID, userID string) ([]userinteraction.ConversationMessageItem, error) {
	return []userinteraction.ConversationMessageItem{
		{
			ID:        "msg-1",
			Role:      "user",
			Content:   "hello",
			CreatedAt: "2026-09-21T00:00:00Z",
		},
	}, nil
}

func (m *mockUserInteractionStore) SetUserPreferences(ctx context.Context, input userinteraction.UserPreferencesSetInput) (*userinteraction.UserPreferencesRecord, error) {
	return &userinteraction.UserPreferencesRecord{
		ID:                 input.UserID,
		HasPreferencesSet:  true,
		FontSize:           "small",
		DisabledMcpRepoIds: []string{},
	}, nil
}

func (m *mockUserInteractionStore) ListMcpTokens(ctx context.Context, userID string) ([]userinteraction.McpTokenSummary, error) {
	return []userinteraction.McpTokenSummary{
		{
			ID:        "tok-1",
			Name:      "test-token",
			Prefix:    "mcp_1234",
			CreatedAt: "2026-09-21T00:00:00Z",
		},
	}, nil
}

func (m *mockUserInteractionStore) CreateConversation(ctx context.Context, input userinteraction.ConversationCreateInput) (*userinteraction.ConversationRecord, error) {
	return &userinteraction.ConversationRecord{
		ID:           "conv-test-1",
		UserID:       input.UserID,
		RepositoryID: "repo-test-1",
		Title:        input.Title,
		CreatedAt:    "2026-09-22T00:00:00Z",
		UpdatedAt:    "2026-09-22T00:00:00Z",
	}, nil
}

func (m *mockUserInteractionStore) UpdateConversation(ctx context.Context, input userinteraction.ConversationUpdateInput) (*userinteraction.ConversationRecord, error) {
	return &userinteraction.ConversationRecord{
		ID:           input.ID,
		UserID:       input.UserID,
		RepositoryID: "repo-test-1",
		Title:        input.Title,
		CreatedAt:    "2026-09-22T00:00:00Z",
		UpdatedAt:    "2026-09-22T00:00:00Z",
	}, nil
}

func (m *mockUserInteractionStore) DeleteConversation(ctx context.Context, input userinteraction.ConversationDeleteInput) error {
	return nil
}

func (m *mockUserInteractionStore) CreateMcpToken(ctx context.Context, input userinteraction.McpTokenCreateInput) (*userinteraction.McpTokenCreatedRecord, error) {
	return &userinteraction.McpTokenCreatedRecord{
		ID:        "tok-test-1",
		Name:      input.Name,
		Prefix:    input.Prefix,
		CreatedAt: "2026-09-22T00:00:00Z",
	}, nil
}

func (m *mockUserInteractionStore) RevokeMcpToken(ctx context.Context, input userinteraction.McpTokenRevokeInput) (int64, error) {
	return 1, nil
}

func (m *mockUserInteractionStore) ListUserModelProviders(ctx context.Context, userID string) ([]userinteraction.UserModelProviderView, error) {
	return []userinteraction.UserModelProviderView{
		{
			ID:          "p-1",
			ProviderKey: "openai",
			Name:        "OpenAI",
			IsActive:    true,
		},
	}, nil
}

func (m *mockUserInteractionStore) UpsertUserModelProvider(ctx context.Context, input userinteraction.UserModelProviderUpsertInput) (*userinteraction.UserModelProviderView, error) {
	return &userinteraction.UserModelProviderView{
		ID:          "p-1",
		ProviderKey: input.ProviderKey,
		Name:        input.Name,
		IsActive:    true,
	}, nil
}

func (m *mockUserInteractionStore) PatchUserModelProvider(ctx context.Context, input userinteraction.UserModelProviderPatchInput) (*userinteraction.UserModelProviderView, error) {
	return &userinteraction.UserModelProviderView{
		ID:          "p-1",
		ProviderKey: input.ProviderKey,
		Name:        "OpenAI",
		IsActive:    true,
	}, nil
}

func (m *mockUserInteractionStore) DeleteUserModelProvider(ctx context.Context, input userinteraction.UserModelProviderDeleteInput) error {
	return nil
}

func (m *mockUserInteractionStore) GetActiveUserModelProvider(ctx context.Context, userID string) (*userinteraction.UserModelProviderRecord, error) {
	return &userinteraction.UserModelProviderRecord{
		ID:          "p-1",
		UserID:      userID,
		ProviderKey: "openai",
		Name:        "OpenAI",
		APIKey:      "enc:v1:test",
		IsActive:    true,
	}, nil
}

func (m *mockUserInteractionStore) GetUserModelProviderCipher(ctx context.Context, userID, providerKey string) (string, error) {
	return "enc:v1:test_cipher", nil
}

func (m *mockUserInteractionStore) TouchMcpPresence(ctx context.Context, userID, clientName, clientVer, ip string) error {
	return nil
}

func (m *mockUserInteractionStore) IncrementMcpUsage(ctx context.Context, userID, day string) error {
	return nil
}

func (m *mockUserInteractionStore) RecordMcpCallLog(ctx context.Context, input userinteraction.McpCallLogInput) error {
	return nil
}

func (m *mockUserInteractionStore) RecordGithubQuotaSample(ctx context.Context, input userinteraction.GithubQuotaSampleInput) error {
	return nil
}

func (m *mockUserInteractionStore) CreateNotifications(ctx context.Context, items []userinteraction.CreateNotificationInput) error {
	return nil
}

func (m *mockUserInteractionStore) TouchMcpTokenUsage(ctx context.Context, tokenID string) error {
	return nil
}

func (m *mockUserInteractionStore) IncrementBundleUseCount(ctx context.Context, bundleID string) error {
	return nil
}

func (m *mockUserInteractionStore) CreateBundle(ctx context.Context, input userinteraction.BundleCreateInput) (*userinteraction.BundleDetail, error) {
	return &userinteraction.BundleDetail{ID: "b-1", Title: input.Title, Slug: input.Slug}, nil
}

func (m *mockUserInteractionStore) UpdateBundle(ctx context.Context, input userinteraction.BundleUpdateInput) (*userinteraction.BundleDetail, error) {
	return &userinteraction.BundleDetail{ID: input.ID, Title: input.Title}, nil
}

func (m *mockUserInteractionStore) DeleteBundle(ctx context.Context, id string) error {
	return nil
}

func (m *mockUserInteractionStore) ClearDocumentConceptChunks(ctx context.Context, documentId string) error {
	return nil
}

func (m *mockUserInteractionStore) UpdateCanonicalConcepts(ctx context.Context, updates []userinteraction.CanonicalConceptUpdate) (int64, error) {
	return 1, nil
}

func (m *mockUserInteractionStore) ReplaceConceptEdges(ctx context.Context, input userinteraction.ReplaceConceptEdgesInput) (int, error) {
	return len(input.Edges), nil
}

func (m *mockUserInteractionStore) UnsaveRepo(ctx context.Context, userID, repositoryID string) error {
	return nil
}

func (m *mockUserInteractionStore) SetSavedRepoFollow(ctx context.Context, userID, repositoryID string, autoFollow bool) (bool, error) {
	return true, nil
}

func (m *mockUserInteractionStore) CreateUserAuth(ctx context.Context, input userinteraction.AuthCreateUserInput) (*userinteraction.AuthUserResult, error) {
	return &userinteraction.AuthUserResult{ID: "test-user"}, nil
}

func (m *mockUserInteractionStore) UpdateUser(ctx context.Context, input userinteraction.UpdateUserInput) (*userinteraction.UserMutationResult, error) {
	return &userinteraction.UserMutationResult{ID: input.ID}, nil
}

func (m *mockUserInteractionStore) DeleteUser(ctx context.Context, id string) error {
	return nil
}

func (m *mockUserInteractionStore) PatchRepo(ctx context.Context, input userinteraction.RepoPatchInput) error {
	return nil
}

func (m *mockUserInteractionStore) BatchPatchRepos(ctx context.Context, input userinteraction.RepoBatchPatchInput) (int64, error) {
	return int64(len(input.IDs)), nil
}

func (m *mockUserInteractionStore) IncrementRepoCounters(ctx context.Context, input userinteraction.RepoIncrementInput) (*userinteraction.RepoIncrementResult, error) {
	return &userinteraction.RepoIncrementResult{OK: true}, nil
}

func (m *mockUserInteractionStore) DeleteRepo(ctx context.Context, input userinteraction.RepoDeleteInput) (int64, error) {
	return 1, nil
}

func (m *mockUserInteractionStore) UnpublishRepo(ctx context.Context, input userinteraction.RepoUnpublishInput) (*userinteraction.RepoUnpublishResult, error) {
	return &userinteraction.RepoUnpublishResult{
		OK:                          true,
		IsPublic:                    false,
		CancelledPendingGrantsCount: 1,
		DetachedSavedReposCount:     3,
	}, nil
}

func (m *mockUserInteractionStore) PromoteEditionRepo(ctx context.Context, input userinteraction.RepoPromoteEditionInput) (*userinteraction.RepoPromoteEditionResult, error) {
	return &userinteraction.RepoPromoteEditionResult{
		OK:             true,
		PromotedRepoID: input.ID,
	}, nil
}


func TestServer_UserInteractionEndpoints(t *testing.T) {
	token := "test-internal-token-12345"
	cfg := Config{
		InternalToken: token,
		ArchiveRoot:   t.TempDir(),
	}

	mockStore := &mockUserInteractionStore{}
	s := newServer(cfg, nil, nil, nil, nil)
	s.SetUserInteractionStore(mockStore)
	handler := s.routes()

	t.Run("POST /v1/repos/view calls store and returns ok", func(t *testing.T) {
		called := false
		mockStore.incrementViewsFunc = func(ctx context.Context, repoID string) error {
			assert.Equal(t, "repo-123", repoID)
			called = true
			return nil
		}

		body, _ := json.Marshal(userinteraction.ViewRequest{RepositoryID: "repo-123"})
		req := httptest.NewRequest(http.MethodPost, "/v1/repos/view", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, called)

		var resp map[string]bool
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp["ok"])
	})

	t.Run("POST /v1/notifications/list returns notifications list", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.NotificationsListRequest{UserID: "u1", Page: 1, PageSize: 10})
		req := httptest.NewRequest(http.MethodPost, "/v1/notifications/list", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.NotificationsListResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		assert.Equal(t, int64(1), resp.Total)
		assert.Equal(t, 1, len(resp.Items))
	})

	t.Run("POST /v1/repos/pause returns pause state", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.RepoPauseRequest{
			Owner:  "owner1",
			Repo:   "repo1",
			Branch: "main",
			Paused: true,
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/repos/pause", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.RepoPauseResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		assert.True(t, resp.Paused)
	})

	t.Run("POST /v1/chapter-versions/vote returns vote result", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.ChapterVersionVoteRequest{
			VersionID: "ver-1",
			UserID:    "user-1",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/chapter-versions/vote", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.ChapterVersionVoteResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		assert.True(t, resp.Voted)
		assert.Equal(t, 5, resp.VoteCount)
		assert.Equal(t, "doc-1", resp.DocumentID)
	})

	t.Run("POST /v1/user/pin updates pins and returns new array", func(t *testing.T) {
		called := false
		mockStore.updatePinnedReposFunc = func(ctx context.Context, userID, repoID string, isPinned bool) ([]string, error) {
			assert.Equal(t, "user-456", userID)
			assert.Equal(t, "repo-123", repoID)
			assert.True(t, isPinned)
			called = true
			return []string{"repo-123"}, nil
		}

		isPinned := true
		body, _ := json.Marshal(userinteraction.PinRequest{
			UserID:       "user-456",
			RepositoryID: "repo-123",
			IsPinned:     &isPinned,
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/user/pin", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, called)

		var resp userinteraction.PinResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		assert.Equal(t, []string{"repo-123"}, resp.PinnedRepoIds)
	})

	t.Run("POST /v1/notifications/read marks notifications read", func(t *testing.T) {
		called := false
		mockStore.markNotificationsReadFn = func(ctx context.Context, userID string, ids []string, all bool) (int64, error) {
			assert.Equal(t, "user-789", userID)
			assert.Equal(t, []string{"notif-1", "notif-2"}, ids)
			assert.False(t, all)
			called = true
			return 2, nil
		}

		body, _ := json.Marshal(userinteraction.NotificationsReadRequest{
			UserID: "user-789",
			IDs:    []string{"notif-1", "notif-2"},
			All:    false,
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/notifications/read", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, called)

		var resp userinteraction.NotificationsReadResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		assert.Equal(t, int64(2), resp.Updated)
	})

	t.Run("POST /v1/notifications/clear deletes notifications", func(t *testing.T) {
		called := false
		mockStore.clearNotificationsFn = func(ctx context.Context, userID string) (int64, error) {
			assert.Equal(t, "user-789", userID)
			called = true
			return 5, nil
		}

		body, _ := json.Marshal(userinteraction.NotificationsClearRequest{
			UserID: "user-789",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/notifications/clear", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, called)

		var resp userinteraction.NotificationsClearResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		assert.Equal(t, int64(5), resp.Deleted)
	})

	t.Run("POST /v1/outline/active returns active outline", func(t *testing.T) {
		called := false
		mockStore.getActiveOutlineFn = func(ctx context.Context, repoID string) (*userinteraction.ActiveOutlineView, error) {
			assert.Equal(t, "repo-outline-1", repoID)
			called = true
			return &userinteraction.ActiveOutlineView{
				OutlineID: "outline-99",
				Version:   2,
				Mode:      "tutorial",
				Parts:     []userinteraction.OutlinePartView{},
				Chapters:  []userinteraction.OutlineChapterView{},
			}, nil
		}

		body, _ := json.Marshal(userinteraction.ActiveOutlineRequest{RepositoryID: "repo-outline-1"})
		req := httptest.NewRequest(http.MethodPost, "/v1/outline/active", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, called)

		var resp userinteraction.ActiveOutlineResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		require.NotNil(t, resp.Outline)
		assert.Equal(t, "outline-99", resp.Outline.OutlineID)
	})

	t.Run("POST /v1/repos/helpful toggles helpful vote", func(t *testing.T) {
		called := false
		mockStore.toggleHelpfulFn = func(ctx context.Context, repoID, userID string) (bool, int, error) {
			assert.Equal(t, "repo-help-1", repoID)
			assert.Equal(t, "user-voter-1", userID)
			called = true
			return true, 10, nil
		}

		body, _ := json.Marshal(userinteraction.HelpfulRequest{
			RepositoryID: "repo-help-1",
			UserID:       "user-voter-1",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/repos/helpful", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, called)

		var resp userinteraction.HelpfulResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		assert.True(t, resp.Voted)
		assert.Equal(t, 10, resp.HelpfulCount)
	})

	t.Run("POST /v1/documents/status returns document status", func(t *testing.T) {
		called := false
		mockStore.getDocumentStatusFn = func(ctx context.Context, docID string) (*userinteraction.DocumentStatusResult, error) {
			assert.Equal(t, "doc-status-1", docID)
			called = true
			return &userinteraction.DocumentStatusResult{
				Found:    true,
				Status:   "PROCESSED",
				Progress: 100,
				Step:     "编纂完成",
			}, nil
		}

		body, _ := json.Marshal(userinteraction.DocumentStatusRequest{DocumentID: "doc-status-1"})
		req := httptest.NewRequest(http.MethodPost, "/v1/documents/status", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, called)

		var resp userinteraction.DocumentStatusResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		assert.True(t, resp.Found)
		assert.Equal(t, "PROCESSED", resp.Status)
		assert.Equal(t, 100, resp.Progress)
		assert.Equal(t, "编纂完成", resp.Step)
	})

	t.Run("POST /v1/usage/summary returns usage summary", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.UsageSummaryRequest{UserID: "user-test"})
		req := httptest.NewRequest(http.MethodPost, "/v1/usage/summary", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.UsageSummaryResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		require.NotNil(t, resp.Summary)
		assert.Equal(t, "PRO", resp.Summary.Tier)
		assert.Equal(t, 3, resp.Summary.ReposUsed)
		assert.Equal(t, 5, resp.Summary.McpCallsToday)
	})

	t.Run("POST /v1/documents/content returns document content", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.DocumentContentRequest{
			RepositoryID:   "repo-1",
			CandidatePaths: []string{"readme.md"},
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/documents/content", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.DocumentContentResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		require.NotNil(t, resp.Document)
		assert.Equal(t, "# Hello World", resp.Document.Content)
	})

	t.Run("POST /v1/chapter-versions/list returns chapter versions", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.ChapterVersionsListRequest{
			DocumentID: "doc-1",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/chapter-versions/list", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.ChapterVersionsListResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		assert.Len(t, resp.Versions, 1)
		assert.Equal(t, "ver-1", resp.Versions[0].ID)
	})

	t.Run("POST /v1/conversations/list returns conversations list", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.ConversationsListRequest{
			Owner:  "test-owner",
			Repo:   "test-repo",
			UserID: "user-1",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/conversations/list", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.ConversationsListResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		assert.Len(t, resp.Conversations, 1)
		assert.Equal(t, "conv-1", resp.Conversations[0].ID)
	})

	t.Run("POST /v1/conversations/messages returns messages list", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.ConversationMessagesRequest{
			ConversationID: "conv-1",
			UserID:         "user-1",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/conversations/messages", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.ConversationMessagesResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		assert.Len(t, resp.Messages, 1)
		assert.Equal(t, "msg-1", resp.Messages[0].ID)
	})

	t.Run("POST /v1/user/preferences/set returns updated user record", func(t *testing.T) {
		lang := "zh"
		body, _ := json.Marshal(userinteraction.UserPreferencesSetRequest{
			UserID:         "user-1",
			PreferredLang1: &lang,
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/user/preferences/set", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.UserPreferencesSetResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		require.NotNil(t, resp.User)
		assert.Equal(t, "user-1", resp.User.ID)
	})

	t.Run("POST /v1/mcp/tokens/list returns token list", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.McpTokensListRequest{
			UserID: "user-1",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/mcp/tokens/list", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.McpTokensListResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		assert.Len(t, resp.Tokens, 1)
		assert.Equal(t, "tok-1", resp.Tokens[0].ID)
	})

	t.Run("POST /v1/conversations/create creates conversation", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.ConversationCreateRequest{
			UserID: "user-1",
			Owner:  "octocat",
			Repo:   "Hello-World",
			Title:  "My Chat",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/conversations/create", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.ConversationCreateResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		require.NotNil(t, resp.Conversation)
		assert.Equal(t, "conv-test-1", resp.Conversation.ID)
		assert.Equal(t, "My Chat", resp.Conversation.Title)
	})

	t.Run("POST /v1/conversations/update updates conversation title", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.ConversationUpdateRequest{
			UserID: "user-1",
			ID:     "conv-test-1",
			Title:  "Renamed Chat",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/conversations/update", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.ConversationUpdateResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		require.NotNil(t, resp.Conversation)
		assert.Equal(t, "Renamed Chat", resp.Conversation.Title)
	})

	t.Run("POST /v1/conversations/delete deletes conversation", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.ConversationDeleteRequest{
			UserID: "user-1",
			ID:     "conv-test-1",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/conversations/delete", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.ConversationDeleteResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		assert.Equal(t, "Conversation deleted", resp.Message)
	})

	t.Run("POST /v1/mcp/tokens/create creates token", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.McpTokenCreateRequest{
			UserID:    "user-1",
			Name:      "test-token",
			TokenHash: "hash123",
			Prefix:    "opgts_12",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/mcp/tokens/create", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.McpTokenCreateResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		require.NotNil(t, resp.Token)
		assert.Equal(t, "tok-test-1", resp.Token.ID)
		assert.Equal(t, "test-token", resp.Token.Name)
	})

	t.Run("POST /v1/mcp/tokens/revoke revokes token", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.McpTokenRevokeRequest{
			UserID: "user-1",
			ID:     "tok-test-1",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/mcp/tokens/revoke", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.McpTokenRevokeResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		assert.True(t, resp.Revoked)
	})

	t.Run("POST /v1/user/model-providers/list lists providers", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.UserModelProvidersListRequest{
			UserID: "user-1",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/user/model-providers/list", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.UserModelProvidersListResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		require.Len(t, resp.Providers, 1)
		assert.Equal(t, "openai", resp.Providers[0].ProviderKey)
	})

	t.Run("POST /v1/user/model-providers/upsert upserts provider", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.UserModelProviderUpsertRequest{
			UserID:          "user-1",
			ProviderKey:     "openai",
			Name:            "OpenAI",
			BaseURL:         "https://api.openai.com/v1",
			EncryptedApiKey: "enc:v1:test",
			APIFormat:       "openai",
			Models:          []string{"gpt-4o"},
			SelectedModel:   "gpt-4o",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/user/model-providers/upsert", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.UserModelProviderUpsertResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		require.NotNil(t, resp.Provider)
		assert.Equal(t, "openai", resp.Provider.ProviderKey)
	})

	t.Run("POST /v1/user/model-providers/patch patches provider", func(t *testing.T) {
		model := "gpt-4o-mini"
		body, _ := json.Marshal(userinteraction.UserModelProviderPatchRequest{
			UserID:        "user-1",
			ProviderKey:   "openai",
			SelectedModel: &model,
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/user/model-providers/patch", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.UserModelProviderPatchResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		require.NotNil(t, resp.Provider)
	})

	t.Run("POST /v1/user/model-providers/delete deletes provider", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.UserModelProviderDeleteRequest{
			UserID:      "user-1",
			ProviderKey: "openai",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/user/model-providers/delete", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.UserModelProviderDeleteResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		assert.True(t, resp.Deleted)
	})

	t.Run("POST /v1/user/model-providers/get-cipher gets cipher", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.UserModelProviderGetCipherRequest{
			UserID:      "user-1",
			ProviderKey: "openai",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/user/model-providers/get-cipher", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var resp userinteraction.UserModelProviderGetCipherResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		assert.Equal(t, "enc:v1:test_cipher", resp.APIKey)
	})

	t.Run("POST /v1/mcp/bundles/use increments use count", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.BundleUseRequest{
			BundleID: "b-1",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/mcp/bundles/use", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("POST /v1/mcp/bundles/create creates bundle", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.BundleCreateInput{
			Title: "Test Bundle",
			Slug:  "test-bundle",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/mcp/bundles/create", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("POST /v1/mcp/bundles/update updates bundle", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.BundleUpdateInput{
			ID:    "b-1",
			Title: "Updated Bundle",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/mcp/bundles/update", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("POST /v1/mcp/bundles/delete deletes bundle", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.BundleDeleteRequest{
			ID: "b-1",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/mcp/bundles/delete", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("POST /v1/concepts/canonical/update updates canonical concepts", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.UpdateCanonicalConceptsRequest{
			Updates: []userinteraction.CanonicalConceptUpdate{
				{IDs: []string{"c-1"}, CanonicalName: "RepName"},
			},
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/concepts/canonical/update", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("POST /v1/concepts/edges/replace replaces concept edges", func(t *testing.T) {
		body, _ := json.Marshal(userinteraction.ReplaceConceptEdgesInput{
			RepositoryID: "repo-1",
			Source:       "cooccurrence",
			ConceptIDs:   []string{"c-1", "c-2"},
			Edges: []userinteraction.ConceptEdgeItem{
				{SourceID: "c-1", TargetID: "c-2", Type: "related", Weight: 1.0},
			},
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/concepts/edges/replace", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})
}
