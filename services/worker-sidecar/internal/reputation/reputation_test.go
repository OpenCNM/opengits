package reputation

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestEvaluateRepoReputation(t *testing.T) {
	now := time.Now().UTC()
	recentCreated := now.Add(-10 * 24 * time.Hour) // 10 days ago
	oldCreated := now.Add(-365 * 24 * time.Hour)   // 1 year ago

	tests := []struct {
		name         string
		meta         RepoMeta
		wantTier     Tier
		wantClassic  bool
		wantRejected bool
	}{
		{
			name: "Classic repo by star count (e.g. React/Vue)",
			meta: RepoMeta{
				Owner: "someuser",
				Repo:  "hot-project",
				Stars: 15000,
				Forks: 1200,
			},
			wantTier:     TierA,
			wantClassic:  true,
			wantRejected: false,
		},
		{
			name: "Classic repo by known authority org (e.g. vercel/ai)",
			meta: RepoMeta{
				Owner: "Vercel", // case-insensitive
				Repo:  "ai",
				Stars: 200, // even if stars are lower, org is whitelisted
			},
			wantTier:     TierA,
			wantClassic:  true,
			wantRejected: false,
		},
		{
			name: "Classic repo by forks count",
			meta: RepoMeta{
				Owner: "independent",
				Repo:  "widely-forked",
				Stars: 300,
				Forks: 250,
			},
			wantTier:     TierA,
			wantClassic:  true,
			wantRejected: false,
		},
		{
			name: "Standard normal personal repo",
			meta: RepoMeta{
				Owner:     "alice",
				Repo:      "my-blog",
				Stars:     45,
				Forks:     5,
				CreatedAt: &oldCreated,
				NodeCount: 300,
			},
			wantTier:     TierB,
			wantClassic:  false,
			wantRejected: false,
		},
		{
			name: "Suspicious resource bomb: new repo with 0 stars and huge files",
			meta: RepoMeta{
				Owner:     "bot-attacker",
				Repo:      "bomb-repo",
				Stars:     0,
				Forks:     0,
				CreatedAt: &recentCreated,
				NodeCount: 3500,
			},
			wantTier:     TierC,
			wantClassic:  false,
			wantRejected: true,
		},
		{
			name: "Suspicious resource bomb: 2 stars with oversized sizeHint (>60MB)",
			meta: RepoMeta{
				Owner:     "shady-user",
				Repo:      "heavy-payload",
				Stars:     2,
				Forks:     0,
				SizeHint:  70 * 1024 * 1024,
				NodeCount: 500,
			},
			wantTier:     TierC,
			wantClassic:  false,
			wantRejected: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := EvaluateRepoReputation(tt.meta)
			assert.Equal(t, tt.wantTier, res.Tier)
			assert.Equal(t, tt.wantClassic, res.IsClassic)
			assert.Equal(t, tt.wantRejected, res.IsRejected)
			assert.NotEmpty(t, res.Reason)
			assert.True(t, res.Quotas.MaxUnpackCapBytes > 0)
			assert.True(t, res.Quotas.MaxFiles > 0)
		})
	}
}

func TestIsKnownAuthorityOrg(t *testing.T) {
	assert.True(t, IsKnownAuthorityOrg("facebook"))
	assert.True(t, IsKnownAuthorityOrg("Facebook"))
	assert.True(t, IsKnownAuthorityOrg("vercel"))
	assert.True(t, IsKnownAuthorityOrg("golang"))
	assert.True(t, IsKnownAuthorityOrg("kubernetes"))
	assert.False(t, IsKnownAuthorityOrg("unknown-org-12345"))
	assert.False(t, IsKnownAuthorityOrg(""))
}
