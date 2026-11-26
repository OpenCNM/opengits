package userinteraction

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func ptr[T any](v T) *T { return &v }

func ingestStatusGoldenResponse() IngestStatusResponse {
	publishedAt := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	claimedAt := time.Date(2026, 10, 19, 11, 59, 0, 0, time.UTC)
	createdAt := time.Date(2026, 10, 19, 11, 58, 0, 0, time.UTC)

	return IngestStatusResponse{
		Ok: true,
		Repository: &IngestStatusRepo{
			ID:                         "repo-0001",
			Owner:                      "octo",
			Repo:                       "kit",
			Branch:                     "main",
			Edition:                    "",
			IsPublic:                   false,
			OwnerUserID:                ptr("user-0001"),
			TranscriptionPaused:        false,
			ReviewStatus:               "NONE",
			PublishedAt:                &publishedAt,
			TranscriptionCreditsEarned: 0,
			TranscriptionTokens:        1200,
			RepoProfile:                json.RawMessage(`{"ingestPrefix":"docs/"}`),
			NavTree:                    json.RawMessage(`[{"name":"Intro","path":"docs/intro.md","type":"file"}]`),
		},
		Documents: []IngestStatusDoc{
			{
				ID: "doc-0001", Path: "docs/intro.md", Title: ptr("Intro"), Status: "PROCESSED",
			},
			{
				ID: "doc-0002", Path: "docs/engine.md", Title: ptr("Engine"), Status: "PROCESSING",
				TranscriptionJob: &IngestStatusTJ{
					Status:      "RUNNING",
					SavedChunks: 3,
					TotalChunks: ptr(5),
					ClaimedAt:   &claimedAt,
					CreatedAt:   &createdAt,
					StartedAtMs: ptr(int64(1776436740000)),
				},
			},
			{
				ID: "doc-0003", Path: "docs/queue.md", Title: ptr("Queue"), Status: "UNPROCESSED",
				TranscriptionJob: &IngestStatusTJ{
					Status:        "QUEUED",
					SavedChunks:   0,
					TotalChunks:   nil,
					QueuePosition: ptr(2),
				},
			},
			{
				ID: "doc-0004", Path: "docs/broken.md", Title: nil, Status: "ERROR",
				ErrorMessage:     ptr("LLM timeout"),
				TranscriptionJob: &IngestStatusTJ{Status: "FAILED", SavedChunks: 0},
			},
		},
		PublishRequested: true,
		AvgJobSeconds:    ptr(42.5),
	}
}

func TestIngestStatusContractGolden(t *testing.T) {
	goldenPath := filepath.Join("testdata", "ingest-status.response.json")

	got, err := json.MarshalIndent(ingestStatusGoldenResponse(), "", "  ")
	require.NoError(t, err)
	gotWithNL := append(append([]byte{}, got...), '\n')

	if os.Getenv("UPDATE_GOLDEN") == "1" {
		require.NoError(t, os.MkdirAll(filepath.Dir(goldenPath), 0o755))
		require.NoError(t, os.WriteFile(goldenPath, gotWithNL, 0o644))
		t.Logf("golden updated: %s", goldenPath)
		return
	}

	want, err := os.ReadFile(goldenPath)
	require.NoError(t, err, "金样本缺失：先运行 UPDATE_GOLDEN=1 go test ./internal/userinteraction/ -run TestIngestStatusContractGolden 生成")
	assert.Equal(t, string(want), string(gotWithNL),
		"ingest-status DTO 与跨语言金样本不一致：Go 改动需 UPDATE_GOLDEN=1 再生成，并同步检查 TS 侧 tests/unit/sidecar-contract.test.ts 是否仍认得新形状")
}

func chapterVersionsListGoldenResponse() ChapterVersionsListResponse {
	canonical := "正典正文：L1 已通过机检。"
	return ChapterVersionsListResponse{
		Ok: true,
		Versions: []ChapterVersionItem{
			{
				ID: "cv-0001", AuthorID: "user-0001", VoteCount: 3, IsCanonical: true,
				Visibility: "PUBLIC", Source: "RELAY", CreatedAt: "2026-10-19T12:00:00Z",
				ContentID: ptr("content-0001"),
				Author:    ChapterVersionAuthor{Name: ptr("Alice"), Image: ptr("https://example.com/a.png")},
				HasVoted:  false, IsContentValid: true, Content: &canonical,
			},
			{
				ID: "cv-0002", AuthorID: "user-0002", VoteCount: 0, IsCanonical: false,
				Visibility: "PRIVATE", Source: "RETRANSLATE", CreatedAt: "2026-10-19T13:00:00Z",
				ContentID: nil,
				Author:    ChapterVersionAuthor{Name: nil, Image: nil},
				HasVoted:  true, IsContentValid: false,
			},
		},
	}
}

func readingProgressSyncGoldenResponse() ReadingProgressSyncResponse {
	return ReadingProgressSyncResponse{
		Ok:              true,
		ChapterScores:   map[string]float64{"docs/intro.md": 65, "docs/engine.md": 100},
		OverallProgress: 82.5,
		ViewedCount:     2,
		LastReadPath:    ptr("docs/engine.md"),
		LastReadAt:      ptr("2026-10-19T12:30:00Z"),
	}
}

func repoPatchInputGolden() RepoPatchInput {
	return RepoPatchInput{
		ID:                     "repo-0001",
		GitSha:                 ptr("abc123"),
		HasUpstreamUpdate:      ptr(false),
		UpstreamEtag:           ptr(`W/"etag-1"`),
		TouchUpstreamCheckedAt: true,
		IsPublic:               ptr(true),
		TouchPublishedAt:       true,
		TouchRelayNotifiedAt:   true,
		ReviewStatus:           ptr("APPROVED"),
		ReviewAutoApproved:     ptr(true),
		ClearRejectionReason:   true,
		TouchReviewedAt:        true,
		RelayEnabled:           ptr(true),
	}
}

func TestChapterVersionsListContractGolden(t *testing.T) {
	runGoldenRoundTrip(t, "chapter-versions-list.response.json", chapterVersionsListGoldenResponse())
}

func TestReadingProgressSyncContractGolden(t *testing.T) {
	runGoldenRoundTrip(t, "reading-progress-sync.response.json", readingProgressSyncGoldenResponse())
}

func TestRepoPatchInputContractGolden(t *testing.T) {
	runGoldenRoundTrip(t, "repos-patch.request.json", repoPatchInputGolden())
}

func runGoldenRoundTrip(t *testing.T, filename string, payload any) {
	t.Helper()
	goldenPath := filepath.Join("testdata", filename)

	got, err := json.MarshalIndent(payload, "", "  ")
	require.NoError(t, err)
	gotWithNL := append(append([]byte{}, got...), '\n')

	if os.Getenv("UPDATE_GOLDEN") == "1" {
		require.NoError(t, os.MkdirAll(filepath.Dir(goldenPath), 0o755))
		require.NoError(t, os.WriteFile(goldenPath, gotWithNL, 0o644))
		t.Logf("golden updated: %s", goldenPath)
		return
	}

	want, err := os.ReadFile(goldenPath)
	require.NoError(t, err, "金样本缺失：先运行 UPDATE_GOLDEN=1 go test ./internal/userinteraction/ -run ContractGolden 生成")
	assert.Equal(t, string(want), string(gotWithNL),
		filename+" 与跨语言金样本不一致：Go 改动需 UPDATE_GOLDEN=1 再生成，并同步检查 TS 侧 tests/unit/sidecar-contract.test.ts")
}
