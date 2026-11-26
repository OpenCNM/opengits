package userinteraction

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/platform/pgtest"
)

func TestPatchRepoPreservesBookAuditIntegration(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()

	seedRepo := func(repoID string, profile string) {
		_, err := pool.Exec(ctx, `
			INSERT INTO "Repository" (id, owner, repo, branch, edition, "isPublic", "repoProfile", "createdAt", "updatedAt")
			VALUES ($1, 'patch-owner', $1, 'main', '', false, $2::jsonb, now(), now())`, repoID, profile)
		require.NoError(t, err)
	}
	readProfile := func(repoID string) string {
		var profile []byte
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT "repoProfile"::text FROM "Repository" WHERE id = $1`, repoID).Scan(&profile))
		return string(profile)
	}
	newProfile := map[string]any{"ingestMode": "code", "codeClusters": []any{}}

	t.Run("已有 bookAudit：整行刷新画像后原样保留", func(t *testing.T) {
		repoID := "repo-patch-audit-keep"
		seedRepo(repoID, `{"ingestMode":"doc","bookAudit":{"status":"done","attempts":1,"scopeHash":"scope-x"}}`)

		require.NoError(t, store.PatchRepo(ctx, RepoPatchInput{ID: repoID, RepoProfile: newProfile}))

		assert.JSONEq(t, `{"ingestMode":"code","codeClusters":[],"bookAudit":{"status":"done","attempts":1,"scopeHash":"scope-x"}}`, readProfile(repoID))
	})

	t.Run("无 bookAudit：不凭空造键", func(t *testing.T) {
		repoID := "repo-patch-audit-fresh"
		seedRepo(repoID, `{"ingestMode":"doc"}`)

		require.NoError(t, store.PatchRepo(ctx, RepoPatchInput{ID: repoID, RepoProfile: newProfile}))

		assert.JSONEq(t, `{"ingestMode":"code","codeClusters":[]}`, readProfile(repoID))
	})
}
