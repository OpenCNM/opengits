package doc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func readFixtureFile(name string) ([]byte, error) {
	candidates := []string{
		filepath.Join("testdata", name),
		filepath.Join("../../testdata", name),
		filepath.Join("services/worker-sidecar/testdata", name),
		filepath.Join("/src/services/worker-sidecar/testdata", name),
	}
	for _, c := range candidates {
		if data, err := os.ReadFile(c); err == nil {
			return data, nil
		}
	}
	return os.ReadFile(filepath.Join("../../testdata", name))
}

func TestFingerprintGoldenParity(t *testing.T) {
	raw, err := readFixtureFile("mdx-fingerprint.golden.json")
	require.NoError(t, err, "mdx-fingerprint.golden.json missing")

	var fixture struct {
		Cases []struct {
			Name                string         `json:"name"`
			Doc                 FixtureDoc     `json:"doc"`
			Model               string         `json:"model"`
			Options             FixtureOptions `json:"options"`
			ExpectedInputs      map[string]any `json:"expectedInputs"`
			ExpectedFingerprint string         `json:"expectedFingerprint"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Cases)

	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			doc := tc.Doc.toPrepareDoc(t)
			opts := tc.Options.toPrepareOptions(t)
			in := fingerprintInputsFor(doc, tc.Model, opts)
			gotFp := computeRequestFingerprint(in)

			gotInputs := filteredFingerprintMap(in)
			assert.ElementsMatch(t, stringKeys(tc.ExpectedInputs), stringKeys(gotInputs), "input key set")
			for k, v := range tc.ExpectedInputs {
				assert.Equal(t, v, gotInputs[k], "input field %s", k)
			}
			assert.Equal(t, tc.ExpectedFingerprint, gotFp, "fingerprint hash")
		})
	}
}

type FixtureDoc struct {
	RepositoryID string         `json:"repositoryId"`
	Path         string         `json:"path"`
	GitSha       *string        `json:"gitSha"`
	RepoProfile  map[string]any `json:"repoProfile"`
}

type FixtureOptions struct {
	TargetLanguage      *string `json:"targetLanguage"`
	CustomPrompt        *string `json:"customPrompt"`
	TranscriptionPreset *string `json:"transcriptionPreset"`
	AICondensation      *string `json:"aiCondensation"`
	TeachingDepth       *string `json:"teachingDepth"`
}

func (d FixtureDoc) toPrepareDoc(t *testing.T) *PrepareDoc {
	t.Helper()
	gitSha := d.GitSha
	return &PrepareDoc{
		ID:           "doc-1",
		RepositoryID: d.RepositoryID,
		Path:         d.Path,
		GitSha:       gitSha,
		RepoProfile:  d.RepoProfile,
	}
}

func (o FixtureOptions) toPrepareOptions(t *testing.T) *PrepareOptions {
	t.Helper()
	return &PrepareOptions{
		TargetLanguage:      derefStrPtr(o.TargetLanguage),
		CustomPrompt:        derefStrPtr(o.CustomPrompt),
		TranscriptionPreset: derefStrPtr(o.TranscriptionPreset),
		AICondensation:      derefStrPtr(o.AICondensation),
		TeachingDepth:       derefStrPtr(o.TeachingDepth),
	}
}

func filteredFingerprintMap(in FingerprintInput) map[string]string {
	m := map[string]string{
		"aiCondensation": in.AICondensation,
		"customPrompt":   in.CustomPrompt,
		"gitSha":         in.GitSha,
		"lang":           in.Lang,
		"model":          in.Model,
		"path":           in.Path,
		"preset":         in.Preset,
		"repositoryId":   in.RepositoryId,
		"teachingDepth":  in.TeachingDepth,
	}
	for k, v := range m {
		if v == "" {
			delete(m, k)
		}
	}
	return m
}

func stringKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

func TestExtractParentTitleFromNavTree(t *testing.T) {
	tree := `[{"path":"docs","title":"文档","children":[{"path":"docs/guide","title":"指南","children":[{"path":"docs/guide/start","title":"开始"}]}]}]`
	tests := []struct {
		name       string
		navTree    string
		targetPath string
		want       string
	}{
		{name: "命中 md 扩展回退", navTree: tree, targetPath: "docs/guide/start.md", want: "指南"},
		{name: "命中 mdx 扩展回退", navTree: tree, targetPath: "docs/guide/start.mdx", want: "指南"},
		{name: "精确命中顶层", navTree: tree, targetPath: "docs/guide", want: "文档"},
		{name: "未命中返回空", navTree: tree, targetPath: "other", want: ""},
		{name: "空树", navTree: `null`, targetPath: "docs", want: ""},
		{name: "对象形态 parentTitle 直读", navTree: `{"parentTitle":"直挂标题"}`, targetPath: "x", want: "直挂标题"},
		{name: "无标题层级继承祖先", navTree: `[{"path":"a","title":"A","children":[{"path":"a/b","children":[{"path":"a/b/c"}]}]}]`, targetPath: "a/b/c.md", want: "A"},
		{name: "大纲纯函数投影大类与章节树提取", navTree: `[{"title":"核心概念","type":"directory","children":[{"title":"第一章 起步","type":"directory","children":[{"title":"安装指南","path":"guide/install.md"}]}]}]`, targetPath: "guide/install.md", want: "第一章 起步"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractParentTitleFromNavTree(json.RawMessage(tt.navTree), tt.targetPath)
			assert.Equal(t, tt.want, got)
		})
	}
}
