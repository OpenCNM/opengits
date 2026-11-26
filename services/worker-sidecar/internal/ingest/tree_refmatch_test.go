package ingest

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestResolveViaGitRefMatching(t *testing.T) {
	tests := []struct {
		name string
		want string
	}{
		{name: "sha1 ref matched", want: strings.Repeat("a", 40)},
		{name: "sha256 object format supported", want: strings.Repeat("b", 64)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			other := strings.Repeat("c", 40)
			output := other + "\trefs/heads/other\n" + tt.want + "\trefs/heads/main\n"
			require.NoError(t, os.WriteFile(filepath.Join(dir, "git"),
				[]byte("#!/bin/sh\ncat <<'OUT'\n"+output+"OUT\n"), 0o755))
			t.Setenv("PATH", dir+":"+os.Getenv("PATH"))

			got, err := resolveViaGit(context.Background(), "o", "r", "main")
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}
