package update

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/cluster"
)

func TestPlanChapters(t *testing.T) {
	title := "认证模块"
	docs := []UpdateDocumentMeta{
		{Path: "docs/intro.md", Title: strPtr("介绍"), Summary: strPtr("旧摘要")},
	}
	clusters := []ModuleSnapshot{
		{Title: title, ChapterNo: 1, TeachingOrder: 1, Files: []string{"src/auth/a.go", "src/auth/b.go"}},
	}

	t.Run("cluster 命中文件变更 → 内容章", func(t *testing.T) {
		diff := &UpdateArchiveDiff{Modified: []string{"src/auth/a.go"}}
		chapters, unmatched, _, _, metas, metaMap := planChapters(diff, clusters, nil, nil, docs, "")
		require.Len(t, chapters, 1)
		assert.Equal(t, "chapters/01.mdx", chapters[0].Path)
		assert.Equal(t, "content", chapters[0].Change)
		assert.Empty(t, unmatched)
		require.Len(t, metas, 2)
		assert.Contains(t, metaMap, "chapters/01.mdx")
		assert.Contains(t, metaMap, "docs/intro.md")
	})

	t.Run("非 cluster 文档修改 → 独立内容章", func(t *testing.T) {
		diff := &UpdateArchiveDiff{Modified: []string{"docs/intro.md"}}
		chapters, unmatched, _, _, _, _ := planChapters(diff, clusters, nil, nil, docs, "")
		require.Len(t, chapters, 1)
		assert.Equal(t, "docs/intro.md", chapters[0].Path)
		assert.Equal(t, strPtr("介绍"), chapters[0].Title)
		assert.Equal(t, strPtr("旧摘要"), chapters[0].OldSummary)
		assert.Empty(t, unmatched)
	})

	t.Run("确定性重命名 → renamed 章，双路径命中", func(t *testing.T) {
		diff := &UpdateArchiveDiff{
			Renamed: []ChapterRename{{From: "docs/intro.md", To: "docs/intro-new.md"}},
		}
		chapters, _, _, _, _, _ := planChapters(diff, clusters, nil, nil, docs, "")
		require.Len(t, chapters, 1)
		assert.Equal(t, "renamed", chapters[0].AffectedFiles[0].Change)
		require.NotNil(t, chapters[0].Rename)
		assert.Equal(t, "docs/intro-new.md", chapters[0].Rename.To)
	})

	t.Run("无主文件 → unmatched；clusterDiff 新增 → structural", func(t *testing.T) {
		diff := &UpdateArchiveDiff{Added: []string{"orphan/new.go"}}
		cd := &cluster.ClusterDiffResult{
			Added: []ModuleSnapshot{{Title: "支付", ChapterNo: 2, TeachingOrder: 2, Files: []string{"src/pay/x.go"}}},
		}
		chapters, unmatched, adds, _, _, _ := planChapters(diff, clusters, []ModuleSnapshot{{Title: "支付", ChapterNo: 2, TeachingOrder: 2, Files: []string{"src/pay/x.go"}}}, cd, docs, "")
		require.Len(t, adds, 1)
		assert.Equal(t, "chapters/02.mdx", adds[0].Path)
		assert.Equal(t, "structural", adds[0].Change)
		require.Len(t, unmatched, 1)
		assert.Empty(t, chapters)
	})

}

func strPtr(s string) *string { return &s }

func TestPlanChaptersSubtreeScoping(t *testing.T) {
	pkgDocs := []UpdateDocumentMeta{
		{Path: "pkg/a.go", Title: strPtr("A")},
		{Path: "pkg/b.go", Title: strPtr("B")},
	}
	pkgClusters := []ModuleSnapshot{
		{Title: "pkg 核心", ChapterNo: 1, TeachingOrder: 1, Files: []string{"pkg/a.go", "pkg/b.go"}},
	}
	diff := &UpdateArchiveDiff{
		Modified: []string{"pkg/a.go", "staging/src/x.go", "cmd/y.go"},
		Added:    []string{"plugin/z.go"},
	}
	chapters, unmatched, _, _, _, _ := planChapters(diff, pkgClusters, nil, nil, pkgDocs, "")
	require.NotEmpty(t, chapters)
	for _, ch := range chapters {
		for _, f := range ch.AffectedFiles {
			assert.True(t, strings.HasPrefix(f.Path, "pkg/"),
				"子课章节不得引用分区外文件: %s", f.Path)
		}
	}
	paths := []string{}
	for _, u := range unmatched {
		paths = append(paths, u.Path)
	}
	assert.Contains(t, paths, "staging/src/x.go")
	assert.Contains(t, paths, "cmd/y.go")
	assert.Contains(t, paths, "plugin/z.go")
}
