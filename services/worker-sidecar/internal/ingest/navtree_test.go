package ingest

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func assertNavTreeEqual(t *testing.T, got, want []*NavNode, ctx string) {
	t.Helper()
	require.Equal(t, len(want), len(got), "%s: children count mismatch", ctx)
	for i := range got {
		g, w := got[i], want[i]
		assert.Equal(t, w.Name, g.Name, "%s[%d] Name mismatch", ctx, i)
		assert.Equal(t, w.Title, g.Title, "%s[%d] Title mismatch", ctx, i)
		assert.Equal(t, w.Path, g.Path, "%s[%d] Path mismatch", ctx, i)
		assert.Equal(t, w.Url, g.Url, "%s[%d] Url mismatch", ctx, i)

		if len(g.Children) > 0 || len(w.Children) > 0 {
			if g.Children == nil {
				g.Children = []*NavNode{}
			}
			if w.Children == nil {
				w.Children = []*NavNode{}
			}
			assertNavTreeEqual(t, g.Children, w.Children, ctx+"/"+g.Name)
		}
	}
}

func TestNavTreeGoldenParity(t *testing.T) {
	patterns := DefaultPatterns()
	raw, err := readTestDataFile("testdata/navtree.golden.json")
	if err != nil {
		t.Skip("golden fixture missing (frozen fixture, hand-maintained)")
	}
	var fixture struct {
		NavTree         []*NavNode `json:"navTree"`
		NavTreePrefixed []*NavNode `json:"navTreePrefixed"`
		Titles          []struct {
			Raw   string `json:"raw"`
			Title string `json:"title"`
		} `json:"titles"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))

	t.Run("human readable title formatting table", func(t *testing.T) {
		for _, tc := range fixture.Titles {
			t.Run(tc.Raw, func(t *testing.T) {
				got := patterns.FormatHumanReadableTitle(tc.Raw)
				assert.Equal(t, tc.Title, got)
			})
		}
	})

	var full struct {
		Nodes []gitNodeJSON `json:"nodes"`
	}
	_ = json.Unmarshal(raw, &full)
	fixtureNodes := full.Nodes
	if fixtureNodes == nil {
		t.Skip("golden lacks nodes field (frozen fixture, hand-maintained)")
	}
	nodes := make([]GitNode, len(fixtureNodes))
	for i, n := range fixtureNodes {
		nodes[i] = GitNode{Path: n.Path, Type: n.Type, Size: n.Size}
	}

	tests := []struct {
		name       string
		docRoot    string
		wantNav    []*NavNode
		contextTag string
	}{
		{
			name:       "root nav tree without prefix",
			docRoot:    "",
			wantNav:    fixture.NavTree,
			contextTag: "root",
		},
		{
			name:       "prefixed nav tree with book/",
			docRoot:    "book/",
			wantNav:    fixture.NavTreePrefixed,
			contextTag: "prefixed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := patterns.BuildNavTree(nodes, "o", "r", tt.docRoot)
			assertNavTreeEqual(t, got, tt.wantNav, tt.contextTag)
		})
	}
}

func TestStripNumericPrefixCJKSeparators(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "ideographic comma separator", in: "1、介绍", want: "介绍"},
		{name: "fullwidth right paren separator", in: "2）安装", want: "安装"},
		{name: "ascii hyphen keeps working", in: "03-getting-started", want: "getting-started"},
		{name: "fullwidth colon separator", in: "12：总结", want: "总结"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := &IngestPatterns{}
			assert.Equal(t, tt.want, p.stripNumericPrefix(tt.in))
		})
	}
}
