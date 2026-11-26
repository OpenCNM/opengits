package daemon

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/transcription"
)

func newTestMdxServer(t *testing.T) *Server {
	t.Helper()
	cfg := Config{InternalToken: "test-secret-token"}
	return newServer(cfg, nil, nil, nil, nil)
}

func newTestTransformServer(t *testing.T) *Server {
	t.Helper()
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	dead.Close()
	cfg := Config{
		InternalToken: "test-secret-token",
		ArchiveRoot:   t.TempDir(),
		RawBase:       dead.URL,
		WebBase:       "https://github.com",
	}
	return newServer(cfg, nil, nil, nil, nil)
}

func TestFetchDocContentGoOnly(t *testing.T) {
	sha := "abc1234"
	prep := &transcription.PrepareResult{}
	prep.Doc.Repository.Owner = "o"
	prep.Doc.Repository.Repo = "r"
	prep.Doc.Repository.Branch = "main"
	prep.Doc.Repository.GitSha = &sha
	prep.Doc.Path = "docs/a.md"

	t.Run("GoTransform 失败显式上抛", func(t *testing.T) {
		deps := transcription.BodyDeps{
			GoTransform: func(ctx context.Context, owner, repo, branch string, gitSha *string, path string) (string, error) {
				return "", assert.AnError
			},
		}
		_, err := transcription.FetchDocContent(t.Context(), Config{}.TranscriptionConfig(), deps, prep)
		require.ErrorIs(t, err, assert.AnError)
	})

	t.Run("未配置 GoTransform 显式报错", func(t *testing.T) {
		_, err := transcription.FetchDocContent(t.Context(), Config{}.TranscriptionConfig(), transcription.BodyDeps{}, prep)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "not configured")
	})
}
