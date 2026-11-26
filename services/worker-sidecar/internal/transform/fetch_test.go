package transform

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCodeWrapGoldenParity(t *testing.T) {
	raw := loadTestFixture(t, "code-wrap.golden.json")

	var fixture struct {
		Cases []struct {
			Name     string `json:"name"`
			FilePath string `json:"filePath"`
			Raw      string `json:"raw"`
			Expected string `json:"expected"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Cases)

	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			assert.Equal(t, tc.Expected, wrapCodeAsMdx(tc.FilePath, tc.Raw))
		})
	}
}

func TestReadLocalArchiveFileSafe(t *testing.T) {
	t.Helper()
	tmp := t.TempDir()
	owner, repo, sha := "testowner", "testrepo", "abcd1234ef5678"
	repoDir := filepath.Join(tmp, owner, repo, sha)
	require.NoError(t, os.MkdirAll(filepath.Join(repoDir, "docs"), 0755))

	secretFile := filepath.Join(tmp, "secret.txt")
	require.NoError(t, os.WriteFile(secretFile, []byte("sensitive-data"), 0644))

	docFile := filepath.Join(repoDir, "docs", "intro.md")
	require.NoError(t, os.WriteFile(docFile, []byte("# Intro Content"), 0644))

	content := readLocalArchiveFile(tmp, owner, repo, sha, "docs/intro.md")
	assert.Equal(t, "# Intro Content", content)

	traversal := readLocalArchiveFile(tmp, owner, repo, sha, "../../../../secret.txt")
	assert.Empty(t, traversal, "path traversal must be blocked and return empty string")

	assert.Empty(t, readLocalArchiveFile("", owner, repo, sha, "docs/intro.md"))
	assert.Empty(t, readLocalArchiveFile(tmp, "", repo, sha, "docs/intro.md"))
	assert.Empty(t, readLocalArchiveFile(tmp, owner, repo, sha, ""))
}
