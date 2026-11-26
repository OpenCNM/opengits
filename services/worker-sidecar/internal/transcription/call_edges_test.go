package transcription

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoadChapterCallEdges(t *testing.T) {
	want := []cognitive.CallEdge{
		{CallerFile: "a.ts", CallerSymbol: "run", CalleeFile: "a.ts", CalleeSymbol: "work", Line: 3},
	}

	tests := []struct {
		name   string
		setup  func(t *testing.T) (graphDir, owner, repo, sha string)
		want   []cognitive.CallEdge
		wantOK bool
	}{
		{
			name: "v3 分段产物：返回调用边",
			setup: func(t *testing.T) (string, string, string, string) {
				t.Helper()
				dir := t.TempDir()
				_, err := cognitive.SaveSemanticGraphArtifact(dir, "o", "r", "sha1", &cognitive.SemanticGraphArtifact{
					Version:       2,
					GitSha:        "sha1",
					CallEdges:     want,
					SymbolsByFile: map[string][]cognitive.SymbolEntry{"a.ts": {{Name: "run", Kind: "function"}}},
				})
				require.NoError(t, err)
				return dir, "o", "r", "sha1"
			},
			want:   want,
			wantOK: true,
		},
		{
			name: "图谱缺失：返回 nil",
			setup: func(t *testing.T) (string, string, string, string) {
				t.Helper()
				return t.TempDir(), "o", "r", "absent"
			},
		},
		{
			name: "v2 老产物（无段索引）：返回 nil",
			setup: func(t *testing.T) (string, string, string, string) {
				t.Helper()
				dir := t.TempDir()
				path := filepath.Join(dir, "o", "r", "legacy.json")
				require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
				raw, err := json.Marshal(&cognitive.SemanticGraphArtifact{
					Version: 2, GitSha: "legacy", CallEdges: want,
					SymbolsByFile: map[string][]cognitive.SymbolEntry{"a.ts": {{Name: "run"}}},
				})
				require.NoError(t, err)
				require.NoError(t, os.WriteFile(path, raw, 0o644))
				return dir, "o", "r", "legacy"
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			graphDir, owner, repo, sha := tt.setup(t)
			got := loadChapterCallEdges(graphDir, owner, repo, sha)
			if !tt.wantOK {
				assert.Nil(t, got)
				return
			}
			assert.Equal(t, tt.want, got)
		})
	}

	t.Run("任一定位参数为空：不触碰文件系统", func(t *testing.T) {
		for _, args := range [][4]string{{"", "o", "r", "s"}, {"d", "", "r", "s"}, {"d", "o", "", "s"}, {"d", "o", "r", ""}} {
			assert.Nil(t, loadChapterCallEdges(args[0], args[1], args[2], args[3]))
		}
	})
}
