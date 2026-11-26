package search

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestBuildScopedSearchSQLHelpers(t *testing.T) {
	tests := []struct {
		name          string
		userArgIdx    int
		wantSubstr    []string
		notWantSubstr []string
	}{
		{
			name:       "scoped search join with anonymous user",
			userArgIdx: 0,
			wantSubstr: []string{
				`d2."repositoryId" = ANY($1)`,
				`d2."ownerUserId" IS NULL`,
			},
			notWantSubstr: []string{
				`d2."repositoryId" = $1`,
			},
		},
		{
			name:       "scoped search join with authenticated user",
			userArgIdx: 2,
			wantSubstr: []string{
				`d2."repositoryId" = ANY($1)`,
				`(d2."ownerUserId" IS NULL OR d2."ownerUserId" = $2)`,
			},
			notWantSubstr: []string{
				`d2."repositoryId" = $1`,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			joinSQL := buildScopedSearchFromJoin(tt.userArgIdx)
			for _, w := range tt.wantSubstr {
				assert.Contains(t, joinSQL, w)
			}
			for _, nw := range tt.notWantSubstr {
				assert.NotContains(t, joinSQL, nw)
			}

			stage0SQL := buildScopedStage0ConceptSQL(joinSQL, []string{`"Document"."repositoryId" = ANY($1)`}, 3, 4, 5)
			assert.Contains(t, stage0SQL, `"Document"."repositoryId" AS repo_id`)
			assert.Contains(t, stage0SQL, `"Repository"."owner" AS repo_owner`)
			assert.Contains(t, stage0SQL, `"Repository"."repo" AS repo_name`)
			assert.Contains(t, stage0SQL, `TutorialConceptNode`)
		})
	}
}
