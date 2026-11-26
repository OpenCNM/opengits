package userinteraction

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockStore struct {
	incrementViewsFn                 func(ctx context.Context, repoID string) error
	updatePinsFn                     func(ctx context.Context, userID, repoID string, isPinned bool) ([]string, error)
	markReadFn                       func(ctx context.Context, userID string, ids []string, all bool) (int64, error)
	getActiveOutlineFn               func(ctx context.Context, repoID string) (*ActiveOutlineView, error)
	toggleHelpfulFn                  func(ctx context.Context, repoID, userID string) (bool, int, error)
	getDocumentStatusFn              func(ctx context.Context, docID string) (*DocumentStatusResult, error)
	getIngestStatusFn                func(ctx context.Context, owner, repo, branch string, edition *string, userID *string) (*IngestStatusResult, error)
	getFeaturedReposFn               func(ctx context.Context, limit int) ([]FeaturedRepo, error)
	listNotificationsFn              func(ctx context.Context, userID string, page, pageSize int) (*NotificationListResult, error)
	clearNotificationsFn             func(ctx context.Context, userID string) (int64, error)
	createNotificationsFn            func(ctx context.Context, items []CreateNotificationInput) error
	pauseRepoFn                      func(ctx context.Context, owner, repo, branch string, edition *string, userID *string, paused bool) (*PauseRepoResult, error)
	toggleChapterVersionVoteFn       func(ctx context.Context, versionID, userID string) (*ChapterVersionVoteResult, error)
	getReadingProgressSyncFn         func(ctx context.Context, userID, owner, repo string, edition *string) (*ReadingProgressSyncResult, error)
	recordTelemetryEventsFn          func(ctx context.Context, userID string, events []TelemetryEventInput) (int, error)
	recordMonitorEventsFn            func(ctx context.Context, userID string, events []MonitorEventInput) (int, error)
	getUserPreferencesFn             func(ctx context.Context, userID string) (*UserPreferencesResult, error)
	getUsageSummaryFn                func(ctx context.Context, userID string) (*UsageSummaryResult, error)
	getDocumentContentFn             func(ctx context.Context, repoID string, candidatePaths []string, userID *string) (*DocumentContentResult, error)
	listChapterVersionsFn            func(ctx context.Context, docID string, userID *string) ([]ChapterVersionItem, error)
	listConversationsFn              func(ctx context.Context, owner, repo, userID string) ([]ConversationSummary, error)
	getConversationMessagesFn        func(ctx context.Context, conversationID, userID string) ([]ConversationMessageItem, error)
	setUserPreferencesFn             func(ctx context.Context, input UserPreferencesSetInput) (*UserPreferencesRecord, error)
	listMcpTokensFn                  func(ctx context.Context, userID string) ([]McpTokenSummary, error)
	createConversationFn             func(ctx context.Context, input ConversationCreateInput) (*ConversationRecord, error)
	updateConversationFn             func(ctx context.Context, input ConversationUpdateInput) (*ConversationRecord, error)
	deleteConversationFn             func(ctx context.Context, input ConversationDeleteInput) error
	createMcpTokenFn                 func(ctx context.Context, input McpTokenCreateInput) (*McpTokenCreatedRecord, error)
	revokeMcpTokenFn                 func(ctx context.Context, input McpTokenRevokeInput) (int64, error)
	listUserModelProvidersFn         func(ctx context.Context, userID string) ([]UserModelProviderView, error)
	upsertUserModelProviderFn        func(ctx context.Context, input UserModelProviderUpsertInput) (*UserModelProviderView, error)
	patchUserModelProviderFn         func(ctx context.Context, input UserModelProviderPatchInput) (*UserModelProviderView, error)
	deleteUserModelProviderFn        func(ctx context.Context, input UserModelProviderDeleteInput) error
	getActiveUserModelProviderFn     func(ctx context.Context, userID string) (*UserModelProviderRecord, error)
	getUserModelProviderCipherFn     func(ctx context.Context, userID, providerKey string) (string, error)
	createChapterVersionFn           func(ctx context.Context, input ChapterVersionCreateInput) (*ChapterVersionCreateResult, error)
	publishChapterVersionFn          func(ctx context.Context, versionID, userID string) (*ChapterVersionPublishResult, error)
	deleteChapterVersionFn           func(ctx context.Context, versionID, userID string) (*ChapterVersionDeleteResult, error)
	pinChapterVersionFn              func(ctx context.Context, input ChapterVersionPinInput) (*ChapterVersionPinResult, error)
	promoteCanonicalChapterVersionFn func(ctx context.Context, input CanonicalPromotionInput) (*CanonicalPromotionResult, error)
}

func (m *mockStore) IncrementRepoViews(ctx context.Context, repoID string) error {
	if m.incrementViewsFn != nil {
		return m.incrementViewsFn(ctx, repoID)
	}
	return nil
}

func (m *mockStore) UpdatePinnedRepos(ctx context.Context, userID, repoID string, isPinned bool) ([]string, error) {
	if m.updatePinsFn != nil {
		return m.updatePinsFn(ctx, userID, repoID, isPinned)
	}
	return []string{}, nil
}

func (m *mockStore) MarkNotificationsRead(ctx context.Context, userID string, ids []string, all bool) (int64, error) {
	if m.markReadFn != nil {
		return m.markReadFn(ctx, userID, ids, all)
	}
	return 0, nil
}

func (m *mockStore) GetActiveOutline(ctx context.Context, repoID string) (*ActiveOutlineView, error) {
	if m.getActiveOutlineFn != nil {
		return m.getActiveOutlineFn(ctx, repoID)
	}
	return nil, nil
}

func (m *mockStore) ToggleHelpfulVote(ctx context.Context, repoID, userID string) (bool, int, error) {
	if m.toggleHelpfulFn != nil {
		return m.toggleHelpfulFn(ctx, repoID, userID)
	}
	return false, 0, nil
}

func (m *mockStore) GetDocumentStatus(ctx context.Context, docID string) (*DocumentStatusResult, error) {
	if m.getDocumentStatusFn != nil {
		return m.getDocumentStatusFn(ctx, docID)
	}
	return &DocumentStatusResult{Found: false}, nil
}

func (m *mockStore) GetIngestStatus(ctx context.Context, owner, repo, branch string, edition *string, userID *string) (*IngestStatusResult, error) {
	if m.getIngestStatusFn != nil {
		return m.getIngestStatusFn(ctx, owner, repo, branch, edition, userID)
	}
	return &IngestStatusResult{Found: false}, nil
}

func (m *mockStore) GetFeaturedRepos(ctx context.Context, limit int) ([]FeaturedRepo, error) {
	if m.getFeaturedReposFn != nil {
		return m.getFeaturedReposFn(ctx, limit)
	}
	return []FeaturedRepo{}, nil
}

func (m *mockStore) ListNotifications(ctx context.Context, userID string, page, pageSize int) (*NotificationListResult, error) {
	if m.listNotificationsFn != nil {
		return m.listNotificationsFn(ctx, userID, page, pageSize)
	}
	return &NotificationListResult{}, nil
}

func (m *mockStore) ClearNotifications(ctx context.Context, userID string) (int64, error) {
	if m.clearNotificationsFn != nil {
		return m.clearNotificationsFn(ctx, userID)
	}
	return 0, nil
}

func (m *mockStore) PauseRepo(ctx context.Context, owner, repo, branch string, edition *string, userID *string, paused bool) (*PauseRepoResult, error) {
	if m.pauseRepoFn != nil {
		return m.pauseRepoFn(ctx, owner, repo, branch, edition, userID, paused)
	}
	return &PauseRepoResult{Found: true, Paused: paused}, nil
}

func (m *mockStore) ToggleChapterVersionVote(ctx context.Context, versionID, userID string) (*ChapterVersionVoteResult, error) {
	if m.toggleChapterVersionVoteFn != nil {
		return m.toggleChapterVersionVoteFn(ctx, versionID, userID)
	}
	return &ChapterVersionVoteResult{Found: true, Voted: true, VoteCount: 1}, nil
}

func (m *mockStore) GetReadingProgressSync(ctx context.Context, userID, owner, repo string, edition *string) (*ReadingProgressSyncResult, error) {
	if m.getReadingProgressSyncFn != nil {
		return m.getReadingProgressSyncFn(ctx, userID, owner, repo, edition)
	}
	return &ReadingProgressSyncResult{ChapterScores: map[string]float64{}, OverallProgress: 0, ViewedCount: 0}, nil
}

func (m *mockStore) RecordTelemetryEvents(ctx context.Context, userID string, events []TelemetryEventInput) (int, error) {
	if m.recordTelemetryEventsFn != nil {
		return m.recordTelemetryEventsFn(ctx, userID, events)
	}
	return len(events), nil
}

func (m *mockStore) RecordMonitorEvents(ctx context.Context, userID string, events []MonitorEventInput) (int, error) {
	if m.recordMonitorEventsFn != nil {
		return m.recordMonitorEventsFn(ctx, userID, events)
	}
	return len(events), nil
}

func (m *mockStore) GetUserPreferences(ctx context.Context, userID string) (*UserPreferencesResult, error) {
	if m.getUserPreferencesFn != nil {
		return m.getUserPreferencesFn(ctx, userID)
	}
	return &UserPreferencesResult{HasPreferencesSet: true, FontSize: "small", SavedRepositories: []SavedRepositoryOverview{}}, nil
}

func (m *mockStore) GetUsageSummary(ctx context.Context, userID string) (*UsageSummaryResult, error) {
	if m.getUsageSummaryFn != nil {
		return m.getUsageSummaryFn(ctx, userID)
	}
	return &UsageSummaryResult{Tier: "FREE", ReposUsed: 1, MaxRepos: 0, McpCallsToday: 0, DailyMcpCalls: 100, Tokens30d: 0}, nil
}

func (m *mockStore) GetDocumentContent(ctx context.Context, repoID string, candidatePaths []string, userID *string) (*DocumentContentResult, error) {
	if m.getDocumentContentFn != nil {
		return m.getDocumentContentFn(ctx, repoID, candidatePaths, userID)
	}
	return &DocumentContentResult{Found: true, ID: "doc-1", Path: "readme.md", Title: "Readme", Status: "PROCESSED", Content: "# Hello"}, nil
}

func (m *mockStore) ListChapterVersions(ctx context.Context, docID string, userID *string) ([]ChapterVersionItem, error) {
	if m.listChapterVersionsFn != nil {
		return m.listChapterVersionsFn(ctx, docID, userID)
	}
	return []ChapterVersionItem{}, nil
}

func (m *mockStore) CreateChapterVersion(ctx context.Context, input ChapterVersionCreateInput) (*ChapterVersionCreateResult, error) {
	if m.createChapterVersionFn != nil {
		return m.createChapterVersionFn(ctx, input)
	}
	return &ChapterVersionCreateResult{VersionID: "v-new"}, nil
}

func (m *mockStore) PublishChapterVersion(ctx context.Context, versionID, userID string) (*ChapterVersionPublishResult, error) {
	if m.publishChapterVersionFn != nil {
		return m.publishChapterVersionFn(ctx, versionID, userID)
	}
	return &ChapterVersionPublishResult{Found: true, Base: 0}, nil
}

func (m *mockStore) DeleteChapterVersion(ctx context.Context, versionID, userID string) (*ChapterVersionDeleteResult, error) {
	if m.deleteChapterVersionFn != nil {
		return m.deleteChapterVersionFn(ctx, versionID, userID)
	}
	return &ChapterVersionDeleteResult{Found: true}, nil
}

func (m *mockStore) PinChapterVersion(ctx context.Context, input ChapterVersionPinInput) (*ChapterVersionPinResult, error) {
	if m.pinChapterVersionFn != nil {
		return m.pinChapterVersionFn(ctx, input)
	}
	return &ChapterVersionPinResult{Found: true, Success: true, Flipped: true, DocumentID: "doc-1"}, nil
}

func (m *mockStore) PromoteCanonicalChapterVersion(ctx context.Context, input CanonicalPromotionInput) (*CanonicalPromotionResult, error) {
	if m.promoteCanonicalChapterVersionFn != nil {
		return m.promoteCanonicalChapterVersionFn(ctx, input)
	}
	cand := "cand-1"
	return &CanonicalPromotionResult{Flipped: true, CanonicalVersionID: &cand, Reason: "SUCCESS"}, nil
}

func (m *mockStore) ListConversations(ctx context.Context, owner, repo, userID string) ([]ConversationSummary, error) {
	if m.listConversationsFn != nil {
		return m.listConversationsFn(ctx, owner, repo, userID)
	}
	return []ConversationSummary{}, nil
}

func (m *mockStore) GetConversationMessages(ctx context.Context, conversationID, userID string) ([]ConversationMessageItem, error) {
	if m.getConversationMessagesFn != nil {
		return m.getConversationMessagesFn(ctx, conversationID, userID)
	}
	return []ConversationMessageItem{}, nil
}

func (m *mockStore) SetUserPreferences(ctx context.Context, input UserPreferencesSetInput) (*UserPreferencesRecord, error) {
	if m.setUserPreferencesFn != nil {
		return m.setUserPreferencesFn(ctx, input)
	}
	return &UserPreferencesRecord{ID: input.UserID, HasPreferencesSet: true}, nil
}

func (m *mockStore) ListMcpTokens(ctx context.Context, userID string) ([]McpTokenSummary, error) {
	if m.listMcpTokensFn != nil {
		return m.listMcpTokensFn(ctx, userID)
	}
	return []McpTokenSummary{}, nil
}

func (m *mockStore) CreateConversation(ctx context.Context, input ConversationCreateInput) (*ConversationRecord, error) {
	if m.createConversationFn != nil {
		return m.createConversationFn(ctx, input)
	}
	return &ConversationRecord{
		ID:           "conv-123",
		UserID:       input.UserID,
		RepositoryID: input.RepositoryID,
		Title:        input.Title,
		CreatedAt:    "2026-09-22T00:00:00Z",
		UpdatedAt:    "2026-09-22T00:00:00Z",
	}, nil
}

func (m *mockStore) UpdateConversation(ctx context.Context, input ConversationUpdateInput) (*ConversationRecord, error) {
	if m.updateConversationFn != nil {
		return m.updateConversationFn(ctx, input)
	}
	return &ConversationRecord{
		ID:           input.ID,
		UserID:       input.UserID,
		RepositoryID: "repo-123",
		Title:        input.Title,
		CreatedAt:    "2026-09-22T00:00:00Z",
		UpdatedAt:    "2026-09-22T00:00:00Z",
	}, nil
}

func (m *mockStore) DeleteConversation(ctx context.Context, input ConversationDeleteInput) error {
	if m.deleteConversationFn != nil {
		return m.deleteConversationFn(ctx, input)
	}
	return nil
}

func (m *mockStore) CreateMcpToken(ctx context.Context, input McpTokenCreateInput) (*McpTokenCreatedRecord, error) {
	if m.createMcpTokenFn != nil {
		return m.createMcpTokenFn(ctx, input)
	}
	return &McpTokenCreatedRecord{
		ID:        "tok-1",
		Name:      input.Name,
		Prefix:    input.Prefix,
		CreatedAt: "2026-09-22T00:00:00Z",
	}, nil
}

func (m *mockStore) RevokeMcpToken(ctx context.Context, input McpTokenRevokeInput) (int64, error) {
	if m.revokeMcpTokenFn != nil {
		return m.revokeMcpTokenFn(ctx, input)
	}
	return 1, nil
}

func (m *mockStore) ListUserModelProviders(ctx context.Context, userID string) ([]UserModelProviderView, error) {
	if m.listUserModelProvidersFn != nil {
		return m.listUserModelProvidersFn(ctx, userID)
	}
	return []UserModelProviderView{}, nil
}

func (m *mockStore) UpsertUserModelProvider(ctx context.Context, input UserModelProviderUpsertInput) (*UserModelProviderView, error) {
	if m.upsertUserModelProviderFn != nil {
		return m.upsertUserModelProviderFn(ctx, input)
	}
	return &UserModelProviderView{
		ID:            "provider-1",
		ProviderKey:   input.ProviderKey,
		Name:          input.Name,
		BaseURL:       input.BaseURL,
		MaskedApiKey:  "sk-•••",
		HasApiKey:     true,
		APIFormat:     input.APIFormat,
		Models:        input.Models,
		SelectedModel: input.SelectedModel,
		IsActive:      input.IsActive != nil && *input.IsActive,
		CreatedAt:     "2026-09-22T00:00:00Z",
		UpdatedAt:     "2026-09-22T00:00:00Z",
	}, nil
}

func (m *mockStore) PatchUserModelProvider(ctx context.Context, input UserModelProviderPatchInput) (*UserModelProviderView, error) {
	if m.patchUserModelProviderFn != nil {
		return m.patchUserModelProviderFn(ctx, input)
	}
	selectedModel := "gpt-4o"
	if input.SelectedModel != nil {
		selectedModel = *input.SelectedModel
	}
	isActive := false
	if input.MakeActive != nil {
		isActive = *input.MakeActive
	}
	return &UserModelProviderView{
		ID:            "provider-1",
		ProviderKey:   input.ProviderKey,
		Name:          "OpenAI",
		BaseURL:       "https://api.openai.com/v1",
		MaskedApiKey:  "sk-•••",
		HasApiKey:     true,
		APIFormat:     "openai",
		Models:        []string{selectedModel},
		SelectedModel: selectedModel,
		IsActive:      isActive,
		CreatedAt:     "2026-09-22T00:00:00Z",
		UpdatedAt:     "2026-09-22T00:00:00Z",
	}, nil
}

func (m *mockStore) DeleteUserModelProvider(ctx context.Context, input UserModelProviderDeleteInput) error {
	if m.deleteUserModelProviderFn != nil {
		return m.deleteUserModelProviderFn(ctx, input)
	}
	return nil
}

func (m *mockStore) GetActiveUserModelProvider(ctx context.Context, userID string) (*UserModelProviderRecord, error) {
	if m.getActiveUserModelProviderFn != nil {
		return m.getActiveUserModelProviderFn(ctx, userID)
	}
	return &UserModelProviderRecord{
		ID:            "provider-1",
		UserID:        userID,
		ProviderKey:   "openai",
		Name:          "OpenAI",
		BaseURL:       "https://api.openai.com/v1",
		APIKey:        "enc:v1:test",
		APIFormat:     "openai",
		Models:        []string{"gpt-4o"},
		SelectedModel: "gpt-4o",
		IsActive:      true,
		CreatedAt:     "2026-09-22T00:00:00Z",
		UpdatedAt:     "2026-09-22T00:00:00Z",
	}, nil
}

func (m *mockStore) GetUserModelProviderCipher(ctx context.Context, userID, providerKey string) (string, error) {
	if m.getUserModelProviderCipherFn != nil {
		return m.getUserModelProviderCipherFn(ctx, userID, providerKey)
	}
	return "enc:v1:mock_cipher_key", nil
}

func (m *mockStore) TouchMcpPresence(ctx context.Context, userID, clientName, clientVer, ip string) error {
	return nil
}

func (m *mockStore) IncrementMcpUsage(ctx context.Context, userID, day string) error {
	return nil
}

func (m *mockStore) RecordMcpCallLog(ctx context.Context, input McpCallLogInput) error {
	return nil
}

func (m *mockStore) RecordGithubQuotaSample(ctx context.Context, input GithubQuotaSampleInput) error {
	return nil
}

func (m *mockStore) CreateNotifications(ctx context.Context, items []CreateNotificationInput) error {
	if m.createNotificationsFn != nil {
		return m.createNotificationsFn(ctx, items)
	}
	return nil
}

func (m *mockStore) TouchMcpTokenUsage(ctx context.Context, tokenID string) error {
	return nil
}

func (m *mockStore) IncrementBundleUseCount(ctx context.Context, bundleID string) error {
	return nil
}

func (m *mockStore) CreateBundle(ctx context.Context, input BundleCreateInput) (*BundleDetail, error) {
	return &BundleDetail{
		ID:    "b-1",
		Title: input.Title,
		Slug:  input.Slug,
	}, nil
}

func (m *mockStore) UpdateBundle(ctx context.Context, input BundleUpdateInput) (*BundleDetail, error) {
	return &BundleDetail{
		ID:    input.ID,
		Title: input.Title,
	}, nil
}

func (m *mockStore) DeleteBundle(ctx context.Context, id string) error {
	return nil
}

func (m *mockStore) ClearDocumentConceptChunks(ctx context.Context, documentId string) error {
	return nil
}

func (m *mockStore) UpdateCanonicalConcepts(ctx context.Context, updates []CanonicalConceptUpdate) (int64, error) {
	return 1, nil
}

func (m *mockStore) ReplaceConceptEdges(ctx context.Context, input ReplaceConceptEdgesInput) (int, error) {
	return len(input.Edges), nil
}

func (m *mockStore) UnsaveRepo(ctx context.Context, userID, repositoryID string) error {
	return nil
}

func (m *mockStore) SetSavedRepoFollow(ctx context.Context, userID, repositoryID string, autoFollow bool) (bool, error) {
	return true, nil
}

func (m *mockStore) CreateUserAuth(ctx context.Context, input AuthCreateUserInput) (*AuthUserResult, error) {
	return &AuthUserResult{ID: "test-user"}, nil
}

func (m *mockStore) UpdateUser(ctx context.Context, input UpdateUserInput) (*UserMutationResult, error) {
	return &UserMutationResult{ID: input.ID}, nil
}

func (m *mockStore) DeleteUser(ctx context.Context, id string) error {
	return nil
}

func (m *mockStore) PatchRepo(ctx context.Context, input RepoPatchInput) error {
	return nil
}

func (m *mockStore) BatchPatchRepos(ctx context.Context, input RepoBatchPatchInput) (int64, error) {
	return int64(len(input.IDs)), nil
}

func (m *mockStore) IncrementRepoCounters(ctx context.Context, input RepoIncrementInput) (*RepoIncrementResult, error) {
	return &RepoIncrementResult{OK: true}, nil
}

func (m *mockStore) DeleteRepo(ctx context.Context, input RepoDeleteInput) (int64, error) {
	return 1, nil
}

func (m *mockStore) UnpublishRepo(ctx context.Context, input RepoUnpublishInput) (*RepoUnpublishResult, error) {
	return &RepoUnpublishResult{
		OK:                          true,
		IsPublic:                    false,
		CancelledPendingGrantsCount: 1,
		DetachedSavedReposCount:     3,
	}, nil
}

func (m *mockStore) PromoteEditionRepo(ctx context.Context, input RepoPromoteEditionInput) (*RepoPromoteEditionResult, error) {
	return &RepoPromoteEditionResult{
		OK:             true,
		PromotedRepoID: input.ID,
	}, nil
}

func TestHandleView(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockErr        error
		expectedStatus int
		expectedOk     bool
	}{
		{
			name:           "valid repository view increment",
			body:           `{"repositoryId":"repo-123"}`,
			expectedStatus: http.StatusOK,
			expectedOk:     true,
		},
		{
			name:           "missing repositoryId",
			body:           `{}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "invalid json payload",
			body:           `not-json`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/repos/view", bytes.NewBufferString(tc.body))
			rec := httptest.NewRecorder()

			h.HandleView(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code)
			if tc.expectedOk {
				var resp ViewResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.Ok)
			}
		})
	}
}

func TestHandlePin(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockPins       []string
		mockErr        error
		expectedStatus int
		expectedPins   []string
	}{
		{
			name:           "successfully pins repo",
			body:           `{"userId":"user-1","repositoryId":"repo-1","isPinned":true}`,
			mockPins:       []string{"repo-1"},
			expectedStatus: http.StatusOK,
			expectedPins:   []string{"repo-1"},
		},
		{
			name:           "missing userId",
			body:           `{"repositoryId":"repo-1"}`,
			expectedStatus: http.StatusBadRequest,
		},
		{
			name:           "user not found in db",
			body:           `{"userId":"user-ghost","repositoryId":"repo-1"}`,
			mockErr:        pgx.ErrNoRows,
			expectedStatus: http.StatusNotFound,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				updatePinsFn: func(ctx context.Context, userID, repoID string, isPinned bool) ([]string, error) {
					return tc.mockPins, tc.mockErr
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/user/pin", bytes.NewBufferString(tc.body))
			rec := httptest.NewRecorder()

			h.HandlePin(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code)
			if tc.expectedStatus == http.StatusOK {
				var resp PinResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.Ok)
				assert.Equal(t, tc.expectedPins, resp.PinnedRepoIds)
			}
		})
	}
}

func TestHandleNotificationsRead(t *testing.T) {
	tests := []struct {
		name            string
		body            string
		mockCount       int64
		expectedStatus  int
		expectedUpdated int64
	}{
		{
			name:            "marks specific ids as read",
			body:            `{"userId":"user-1","ids":["n-1","n-2"],"all":false}`,
			mockCount:       2,
			expectedStatus:  http.StatusOK,
			expectedUpdated: 2,
		},
		{
			name:            "marks all unread as read",
			body:            `{"userId":"user-1","all":true}`,
			mockCount:       5,
			expectedStatus:  http.StatusOK,
			expectedUpdated: 5,
		},
		{
			name:           "missing userId",
			body:           `{"all":true}`,
			expectedStatus: http.StatusBadRequest,
		},
		{
			name:           "missing both ids and all",
			body:           `{"userId":"user-1","ids":[],"all":false}`,
			expectedStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				markReadFn: func(ctx context.Context, userID string, ids []string, all bool) (int64, error) {
					return tc.mockCount, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/notifications/read", bytes.NewBufferString(tc.body))
			rec := httptest.NewRecorder()

			h.HandleNotificationsRead(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code)
			if tc.expectedStatus == http.StatusOK {
				var resp NotificationsReadResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.Ok)
				assert.Equal(t, tc.expectedUpdated, resp.Updated)
			}
		})
	}
}

func TestHandleActiveOutline(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockOutline    *ActiveOutlineView
		expectedStatus int
		expectOutline  bool
	}{
		{
			name: "returns active outline when found",
			body: `{"repositoryId":"repo-100"}`,
			mockOutline: &ActiveOutlineView{
				OutlineID: "outline-1",
				Version:   1,
				Mode:      "tutorial",
				Parts:     []OutlinePartView{},
				Chapters: []OutlineChapterView{
					{
						ID:            "ch-1",
						Title:         "Introduction",
						TeachingOrder: 1,
						Nodes: []OutlineNodeView{
							{
								ID:       "node-1",
								Title:    "Quickstart",
								NodeType: "doc",
							},
						},
					},
				},
			},
			expectedStatus: http.StatusOK,
			expectOutline:  true,
		},
		{
			name:           "returns null outline when not found",
			body:           `{"repositoryId":"repo-empty"}`,
			mockOutline:    nil,
			expectedStatus: http.StatusOK,
			expectOutline:  false,
		},
		{
			name:           "missing repositoryId returns 400",
			body:           `{}`,
			expectedStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				getActiveOutlineFn: func(ctx context.Context, repoID string) (*ActiveOutlineView, error) {
					return tc.mockOutline, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/outline/active", bytes.NewBufferString(tc.body))
			rec := httptest.NewRecorder()

			h.HandleActiveOutline(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code)
			if tc.expectedStatus == http.StatusOK {
				var resp ActiveOutlineResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.Ok)
				if tc.expectOutline {
					require.NotNil(t, resp.Outline)
					assert.Equal(t, "outline-1", resp.Outline.OutlineID)
					assert.Len(t, resp.Outline.Chapters, 1)
				} else {
					assert.Nil(t, resp.Outline)
				}
			}
		})
	}
}

func TestHandleHelpful(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockVoted      bool
		mockCount      int
		mockErr        error
		expectedStatus int
		expectedVoted  bool
		expectedCount  int
	}{
		{
			name:           "votes helpful successfully",
			body:           `{"repositoryId":"repo-1","userId":"user-1"}`,
			mockVoted:      true,
			mockCount:      42,
			expectedStatus: http.StatusOK,
			expectedVoted:  true,
			expectedCount:  42,
		},
		{
			name:           "unvotes helpful successfully",
			body:           `{"repositoryId":"repo-1","userId":"user-1"}`,
			mockVoted:      false,
			mockCount:      41,
			expectedStatus: http.StatusOK,
			expectedVoted:  false,
			expectedCount:  41,
		},
		{
			name:           "repository not found returns 404",
			body:           `{"repositoryId":"repo-ghost","userId":"user-1"}`,
			mockErr:        pgx.ErrNoRows,
			expectedStatus: http.StatusNotFound,
		},
		{
			name:           "missing userId returns 400",
			body:           `{"repositoryId":"repo-1"}`,
			expectedStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				toggleHelpfulFn: func(ctx context.Context, repoID, userID string) (bool, int, error) {
					return tc.mockVoted, tc.mockCount, tc.mockErr
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/repos/helpful", bytes.NewBufferString(tc.body))
			rec := httptest.NewRecorder()

			h.HandleHelpful(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code)
			if tc.expectedStatus == http.StatusOK {
				var resp HelpfulResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.Ok)
				assert.Equal(t, tc.expectedVoted, resp.Voted)
				assert.Equal(t, tc.expectedCount, resp.HelpfulCount)
			}
		})
	}
}

func TestHandleDocumentStatus(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockResult     *DocumentStatusResult
		expectedStatus int
		expectedFound  bool
		expectedProg   int
	}{
		{
			name: "returns document status when found",
			body: `{"documentId":"doc-1"}`,
			mockResult: &DocumentStatusResult{
				Found:    true,
				Status:   "PROCESSED",
				Progress: 100,
				Step:     "编纂完成",
			},
			expectedStatus: http.StatusOK,
			expectedFound:  true,
			expectedProg:   100,
		},
		{
			name: "returns ERROR status with structured errorMessage intact",
			body: `{"documentId":"doc-err-1"}`,
			mockResult: &DocumentStatusResult{
				Found:        true,
				Status:       "ERROR",
				ErrorMessage: strPtr(`__OG_ERR__:{"code":"UPSTREAM_AUTH_ERROR","provider":"openai","model":"gpt-4o","upstreamStatus":401,"message":"Invalid API key"}`),
				Progress:     100,
				Step:         "编纂失败: Invalid API key",
			},
			expectedStatus: http.StatusOK,
			expectedFound:  true,
			expectedProg:   100,
		},
		{
			name: "returns 404 when document not found",
			body: `{"documentId":"doc-ghost"}`,
			mockResult: &DocumentStatusResult{
				Found: false,
			},
			expectedStatus: http.StatusNotFound,
		},
		{
			name:           "missing documentId returns 400",
			body:           `{}`,
			expectedStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				getDocumentStatusFn: func(ctx context.Context, docID string) (*DocumentStatusResult, error) {
					return tc.mockResult, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/documents/status", bytes.NewBufferString(tc.body))
			rec := httptest.NewRecorder()

			h.HandleDocumentStatus(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code)
			if tc.expectedStatus == http.StatusOK {
				var resp DocumentStatusResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.Ok)
				assert.True(t, resp.Found)
				assert.Equal(t, tc.expectedProg, resp.Progress)
				assert.Equal(t, tc.mockResult.ErrorMessage, resp.ErrorMessage)
				assert.Equal(t, tc.mockResult.Step, resp.Step)
			}
		})
	}
}

func TestHandleIngestStatus(t *testing.T) {
	tests := []struct {
		name              string
		body              string
		mockResult        *IngestStatusResult
		expectedStatus    int
		expectedOk        bool
		expectedNotFound  bool
		expectedForbidden bool
		expectedDocCount  int
		expectedPublish   bool
	}{
		{
			name: "public repo with documents and publish requested",
			body: `{"owner":"facebook","repo":"react","branch":"main"}`,
			mockResult: &IngestStatusResult{
				Found:     true,
				Forbidden: false,
				Repository: &IngestStatusRepo{
					ID:       "repo-1",
					Owner:    "facebook",
					Repo:     "react",
					Branch:   "main",
					IsPublic: true,
				},
				Documents: []IngestStatusDoc{
					{
						ID:     "doc-1",
						Path:   "docs/intro.md",
						Status: "PROCESSING",
						TranscriptionJob: &IngestStatusTJ{
							Status:      "RUNNING",
							SavedChunks: 2,
						},
					},
				},
				PublishRequested: true,
			},
			expectedStatus:   http.StatusOK,
			expectedOk:       true,
			expectedDocCount: 1,
			expectedPublish:  true,
		},
		{
			name: "repository not found",
			body: `{"owner":"facebook","repo":"not-exists"}`,
			mockResult: &IngestStatusResult{
				Found: false,
			},
			expectedStatus:   http.StatusOK,
			expectedOk:       false,
			expectedNotFound: true,
		},
		{
			name: "private repo without access forbidden",
			body: `{"owner":"secret","repo":"private"}`,
			mockResult: &IngestStatusResult{
				Found:     true,
				Forbidden: true,
			},
			expectedStatus:    http.StatusOK,
			expectedOk:        false,
			expectedForbidden: true,
		},
		{
			name:           "missing owner or repo",
			body:           `{"owner":"","repo":"react"}`,
			expectedStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				getIngestStatusFn: func(ctx context.Context, owner, repo, branch string, edition *string, userID *string) (*IngestStatusResult, error) {
					return tc.mockResult, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/repos/ingest-status", bytes.NewBufferString(tc.body))
			rec := httptest.NewRecorder()

			h.HandleIngestStatus(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code)
			if tc.expectedStatus == http.StatusOK {
				var resp IngestStatusResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.Equal(t, tc.expectedOk, resp.Ok)
				assert.Equal(t, tc.expectedNotFound, resp.NotFound)
				assert.Equal(t, tc.expectedForbidden, resp.Forbidden)
				if tc.expectedOk {
					assert.Equal(t, tc.expectedDocCount, len(resp.Documents))
					assert.Equal(t, tc.expectedPublish, resp.PublishRequested)
				}
			}
		})
	}
}

func TestHandleFeaturedSearch(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockRepos      []FeaturedRepo
		expectedStatus int
		expectedCount  int
	}{
		{
			name: "returns featured repos successfully",
			body: `{"limit":6}`,
			mockRepos: []FeaturedRepo{
				{ID: "r1", Owner: "facebook", Repo: "react"},
				{ID: "r2", Owner: "vercel", Repo: "next.js"},
			},
			expectedStatus: http.StatusOK,
			expectedCount:  2,
		},
		{
			name:           "default limit fallback",
			body:           `{}`,
			mockRepos:      []FeaturedRepo{},
			expectedStatus: http.StatusOK,
			expectedCount:  0,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				getFeaturedReposFn: func(ctx context.Context, limit int) ([]FeaturedRepo, error) {
					return tc.mockRepos, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/search/featured", bytes.NewBufferString(tc.body))
			rec := httptest.NewRecorder()

			h.HandleFeaturedSearch(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code)
			var resp FeaturedSearchResponse
			err := json.Unmarshal(rec.Body.Bytes(), &resp)
			require.NoError(t, err)
			assert.True(t, resp.Ok)
			assert.Equal(t, tc.expectedCount, len(resp.Repos))
		})
	}
}

func TestHandleNotificationsList(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockResult     *NotificationListResult
		expectedStatus int
		expectedOk     bool
		expectedTotal  int64
	}{
		{
			name:           "missing userId",
			body:           `{"page":1}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name: "valid list query",
			body: `{"userId":"u1","page":1,"pageSize":20}`,
			mockResult: &NotificationListResult{
				Items: []NotificationItem{
					{ID: "n1", UserID: "u1", Title: "New update"},
				},
				Total:       1,
				UnreadCount: 1,
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
			expectedTotal:  1,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				listNotificationsFn: func(ctx context.Context, userID string, page, pageSize int) (*NotificationListResult, error) {
					return tc.mockResult, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/notifications/list", bytes.NewBufferString(tc.body))
			rec := httptest.NewRecorder()

			h.HandleNotificationsList(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code)
			if tc.expectedOk {
				var resp NotificationsListResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.Ok)
				assert.Equal(t, tc.expectedTotal, resp.Total)
				assert.Equal(t, 1, len(resp.Items))
			}
		})
	}
}

func TestHandleNotificationsCreate(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		mockErr        error
		nilStore       bool
		expectedStatus int
		expectedOk     bool
		expectedCount  int
	}{
		{
			name:           "empty notifications list returns 200 count 0",
			body:           `{"notifications":[]}`,
			expectedStatus: http.StatusOK,
			expectedOk:     true,
			expectedCount:  0,
		},
		{
			name:           "nil store returns 500",
			body:           `{"notifications":[{"userId":"u1","type":"transcription_failed","title":"fail"}]}`,
			nilStore:       true,
			expectedStatus: http.StatusInternalServerError,
			expectedOk:     false,
		},
		{
			name:           "store error returns 500",
			body:           `{"notifications":[{"userId":"u1","type":"transcription_failed","title":"fail"}]}`,
			mockErr:        errors.New("db error"),
			expectedStatus: http.StatusInternalServerError,
			expectedOk:     false,
		},
		{
			name:           "valid create with failed and rejected types",
			body:           `{"notifications":[{"userId":"u1","type":"transcription_failed","title":"教程转录中断","body":"err","payload":{"error":"timeout"}},{"userId":"u2","type":"tutorial_rejected","title":"审核未通过","body":"rejected","payload":{"reason":"copyright"}}]}`,
			expectedStatus: http.StatusOK,
			expectedOk:     true,
			expectedCount:  2,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var h *Handler
			if tc.nilStore {
				h = NewHandler(nil)
			} else {
				store := &mockStore{
					createNotificationsFn: func(ctx context.Context, items []CreateNotificationInput) error {
						return tc.mockErr
					},
				}
				h = NewHandler(store)
			}

			req := httptest.NewRequest(http.MethodPost, "/v1/notifications/create", bytes.NewBufferString(tc.body))
			rec := httptest.NewRecorder()

			h.HandleNotificationsCreate(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code)
			if tc.expectedOk {
				var resp NotificationCreateResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.Ok)
				assert.Equal(t, tc.expectedCount, resp.Count)
			}
		})
	}
}

func TestHandleNotificationsClear(t *testing.T) {
	tests := []struct {
		name            string
		body            string
		mockDeleted     int64
		mockErr         error
		nilStore        bool
		expectedStatus  int
		expectedOk      bool
		expectedDeleted int64
	}{
		{
			name:           "missing userId returns 400",
			body:           `{}`,
			expectedStatus: http.StatusBadRequest,
			expectedOk:     false,
		},
		{
			name:           "nil store returns 500",
			body:           `{"userId":"u1"}`,
			nilStore:       true,
			expectedStatus: http.StatusInternalServerError,
			expectedOk:     false,
		},
		{
			name:           "store error returns 500",
			body:           `{"userId":"u1"}`,
			mockErr:        errors.New("db error"),
			expectedStatus: http.StatusInternalServerError,
			expectedOk:     false,
		},
		{
			name:            "valid clear returns 200 and deleted count",
			body:            `{"userId":"u1"}`,
			mockDeleted:     7,
			expectedStatus:  http.StatusOK,
			expectedOk:      true,
			expectedDeleted: 7,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var h *Handler
			if tc.nilStore {
				h = NewHandler(nil)
			} else {
				store := &mockStore{
					clearNotificationsFn: func(ctx context.Context, userID string) (int64, error) {
						return tc.mockDeleted, tc.mockErr
					},
				}
				h = NewHandler(store)
			}

			req := httptest.NewRequest(http.MethodPost, "/v1/notifications/clear", bytes.NewBufferString(tc.body))
			rec := httptest.NewRecorder()

			h.HandleNotificationsClear(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code)
			if tc.expectedOk {
				var resp NotificationsClearResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.Ok)
				assert.Equal(t, tc.expectedDeleted, resp.Deleted)
			}
		})
	}
}

func TestHandleRepoPause(t *testing.T) {
	tests := []struct {
		name              string
		body              string
		mockResult        *PauseRepoResult
		expectedStatus    int
		expectedOk        bool
		expectedNotFound  bool
		expectedForbidden bool
		expectedPaused    bool
	}{
		{
			name:           "missing repo",
			body:           `{"owner":"facebook"}`,
			expectedStatus: http.StatusBadRequest,
		},
		{
			name: "pause success",
			body: `{"owner":"facebook","repo":"react","paused":true}`,
			mockResult: &PauseRepoResult{
				Found:  true,
				Paused: true,
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
			expectedPaused: true,
		},
		{
			name: "repo not found",
			body: `{"owner":"facebook","repo":"react","paused":true}`,
			mockResult: &PauseRepoResult{
				Found: false,
			},
			expectedStatus:   http.StatusOK,
			expectedOk:       false,
			expectedNotFound: true,
		},
		{
			name: "forbidden",
			body: `{"owner":"facebook","repo":"react","paused":true}`,
			mockResult: &PauseRepoResult{
				Found:     true,
				Forbidden: true,
			},
			expectedStatus:    http.StatusOK,
			expectedOk:        false,
			expectedForbidden: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				pauseRepoFn: func(ctx context.Context, owner, repo, branch string, edition *string, userID *string, paused bool) (*PauseRepoResult, error) {
					return tc.mockResult, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/repos/pause", bytes.NewBufferString(tc.body))
			rec := httptest.NewRecorder()

			h.HandleRepoPause(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code)
			if tc.expectedStatus == http.StatusOK {
				var resp RepoPauseResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.Equal(t, tc.expectedOk, resp.Ok)
				assert.Equal(t, tc.expectedNotFound, resp.NotFound)
				assert.Equal(t, tc.expectedForbidden, resp.Forbidden)
				assert.Equal(t, tc.expectedPaused, resp.Paused)
			}
		})
	}
}

func TestHandleChapterVersionVote(t *testing.T) {
	tests := []struct {
		name                 string
		body                 string
		mockResult           *ChapterVersionVoteResult
		expectedStatus       int
		expectedOk           bool
		expectedNotFound     bool
		expectedForbidden    bool
		expectedInvalidState bool
		expectedSelfVote     bool
		expectedVoted        bool
		expectedCount        int
	}{
		{
			name:           "missing versionId",
			body:           `{"userId":"u1"}`,
			expectedStatus: http.StatusBadRequest,
		},
		{
			name: "vote success",
			body: `{"versionId":"v1","userId":"u1"}`,
			mockResult: &ChapterVersionVoteResult{
				Found:      true,
				Voted:      true,
				VoteCount:  3,
				DocumentID: "doc-1",
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
			expectedVoted:  true,
			expectedCount:  3,
		},
		{
			name: "version not found",
			body: `{"versionId":"v1","userId":"u1"}`,
			mockResult: &ChapterVersionVoteResult{
				Found: false,
			},
			expectedStatus:   http.StatusOK,
			expectedOk:       false,
			expectedNotFound: true,
		},
		{
			name: "forbidden",
			body: `{"versionId":"v1","userId":"u1"}`,
			mockResult: &ChapterVersionVoteResult{
				Found:     true,
				Forbidden: true,
			},
			expectedStatus:    http.StatusOK,
			expectedOk:        false,
			expectedForbidden: true,
		},
		{
			name: "self vote disallowed",
			body: `{"versionId":"v1","userId":"u1"}`,
			mockResult: &ChapterVersionVoteResult{
				Found:    true,
				SelfVote: true,
			},
			expectedStatus:   http.StatusOK,
			expectedOk:       false,
			expectedSelfVote: true,
		},
		{
			name: "invalid state",
			body: `{"versionId":"v1","userId":"u1"}`,
			mockResult: &ChapterVersionVoteResult{
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
				toggleChapterVersionVoteFn: func(ctx context.Context, versionID, userID string) (*ChapterVersionVoteResult, error) {
					return tc.mockResult, nil
				},
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/chapter-versions/vote", bytes.NewBufferString(tc.body))
			rec := httptest.NewRecorder()

			h.HandleChapterVersionVote(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code)
			if tc.expectedStatus == http.StatusOK {
				var resp ChapterVersionVoteResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.Equal(t, tc.expectedOk, resp.Ok)
				assert.Equal(t, tc.expectedNotFound, resp.NotFound)
				assert.Equal(t, tc.expectedForbidden, resp.Forbidden)
				assert.Equal(t, tc.expectedSelfVote, resp.SelfVote)
				assert.Equal(t, tc.expectedInvalidState, resp.InvalidState)
				assert.Equal(t, tc.expectedVoted, resp.Voted)
				assert.Equal(t, tc.expectedCount, resp.VoteCount)
			}
		})
	}
}

func TestHandleReadingProgressSync(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		storeFn        func(ctx context.Context, userID, owner, repo string, edition *string) (*ReadingProgressSyncResult, error)
		expectedStatus int
		expectedOk     bool
		expectedProg   float64
	}{
		{
			name:           "invalid json",
			body:           `{invalid`,
			expectedStatus: http.StatusBadRequest,
		},
		{
			name:           "missing owner or repo",
			body:           `{"userId":"u1","owner":""}`,
			expectedStatus: http.StatusBadRequest,
		},
		{
			name: "success with progress",
			body: `{"userId":"u1","owner":"facebook","repo":"react"}`,
			storeFn: func(ctx context.Context, userID, owner, repo string, edition *string) (*ReadingProgressSyncResult, error) {
				return &ReadingProgressSyncResult{
					ChapterScores:   map[string]float64{"ch1": 80.0},
					OverallProgress: 80.0,
					ViewedCount:     1,
				}, nil
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
			expectedProg:   80.0,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				getReadingProgressSyncFn: tc.storeFn,
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/reading/progress-sync", bytes.NewBufferString(tc.body))
			rec := httptest.NewRecorder()

			h.HandleReadingProgressSync(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code)
			if tc.expectedStatus == http.StatusOK {
				var resp ReadingProgressSyncResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.Equal(t, tc.expectedOk, resp.Ok)
				assert.Equal(t, tc.expectedProg, resp.OverallProgress)
			}
		})
	}
}

func TestHandleTelemetryEvents(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		storeFn        func(ctx context.Context, userID string, events []TelemetryEventInput) (int, error)
		expectedStatus int
		expectedOk     bool
		expectedCount  int
	}{
		{
			name:           "invalid json",
			body:           `{bad`,
			expectedStatus: http.StatusBadRequest,
		},
		{
			name:           "missing userId",
			body:           `{"userId":"","events":[]}`,
			expectedStatus: http.StatusBadRequest,
		},
		{
			name: "success batch",
			body: `{"userId":"u1","events":[{"eventType":"PAGE_VIEW","pageUrl":"/docs/facebook/react"}]}`,
			storeFn: func(ctx context.Context, userID string, events []TelemetryEventInput) (int, error) {
				return len(events), nil
			},
			expectedStatus: http.StatusOK,
			expectedOk:     true,
			expectedCount:  1,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockStore{
				recordTelemetryEventsFn: tc.storeFn,
			}
			h := NewHandler(store)

			req := httptest.NewRequest(http.MethodPost, "/v1/telemetry/events", bytes.NewBufferString(tc.body))
			rec := httptest.NewRecorder()

			h.HandleTelemetryEvents(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code)
			if tc.expectedStatus == http.StatusOK {
				var resp TelemetryBatchResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.Equal(t, tc.expectedOk, resp.Ok)
				assert.Equal(t, tc.expectedCount, resp.Count)
			}
		})
	}
}

func TestHandleUserPreferencesGet(t *testing.T) {
	t.Run("missing userId", func(t *testing.T) {
		h := NewHandler(&mockStore{})
		req := httptest.NewRequest(http.MethodPost, "/v1/user/preferences/get", bytes.NewBufferString(`{"userId":""}`))
		rec := httptest.NewRecorder()
		h.HandleUserPreferencesGet(rec, req)
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("success", func(t *testing.T) {
		store := &mockStore{
			getUserPreferencesFn: func(ctx context.Context, userID string) (*UserPreferencesResult, error) {
				return &UserPreferencesResult{
					HasPreferencesSet: true,
					FontSize:          "small",
					SavedRepositories: []SavedRepositoryOverview{
						{
							ID:            "r1",
							Owner:         "vercel",
							Repo:          "next.js",
							TotalDocs:     10,
							ProcessedDocs: 10,
							IsProcessed:   true,
							Progress:      100,
						},
					},
				}, nil
			},
		}
		h := NewHandler(store)
		req := httptest.NewRequest(http.MethodPost, "/v1/user/preferences/get", bytes.NewBufferString(`{"userId":"u1"}`))
		rec := httptest.NewRecorder()
		h.HandleUserPreferencesGet(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)
		var resp UserPreferencesGetResponse
		err := json.Unmarshal(rec.Body.Bytes(), &resp)
		require.NoError(t, err)
		assert.True(t, resp.Ok)
		assert.Len(t, resp.Preferences.SavedRepositories, 1)
		assert.True(t, resp.Preferences.SavedRepositories[0].IsProcessed)
	})
}

func TestVersionDisplacedRemovedInvariants(t *testing.T) {
	srcBytes, err := os.ReadFile("store_chapter_versions.go")
	require.NoError(t, err)
	src := string(srcBytes)

	assert.NotContains(t, src, `"version_displaced"`,
		"store_chapter_versions.go 禁止生成 version_displaced 负反馈通知")
	assert.Contains(t, src, `"version_won"`,
		"store_chapter_versions.go 必须保留正向荣誉激励 version_won 通知")
}
