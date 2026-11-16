package update

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/cluster"
)

// TestPlanChapters planner 纯函数核心路径锁定：零 I/O 直接对输入断言
// （planner/applier 分相的验证面——BUG-55/56 类映射缺漏在此显形）。
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
		// 章节元数据含 cluster 章与非代码文档章
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
		// 真实契约：structural adds 由响应面独立携带（StructuralAdds 字段），
		// 仅 structuralRemoves 会 append 进 chapters——锁定该不对称语义
		assert.Empty(t, chapters)
	})

}

func strPtr(s string) *string { return &s }

// TestPlanChaptersSubtreeScoping 子树隔离更新(P3b-3):子课=独立 edition=
// 独立 Repository 行,其文档集只含分区文件——planner 产出的章节只可能
// 引用该分区内的路径(更新天然按子课隔离,子系统变更不波及其他课程)。
func TestPlanChaptersSubtreeScoping(t *testing.T) {
	pkgDocs := []UpdateDocumentMeta{
		{Path: "pkg/a.go", Title: strPtr("A")},
		{Path: "pkg/b.go", Title: strPtr("B")},
	}
	pkgClusters := []ModuleSnapshot{
		{Title: "pkg 核心", ChapterNo: 1, TeachingOrder: 1, Files: []string{"pkg/a.go", "pkg/b.go"}},
	}
	// staging 分区的变更(不属于 pkg 子课的文档集)
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
	// 分区外变更全部落入 unmatched(不产生章节)——由该分区自己的子课承接
	paths := []string{}
	for _, u := range unmatched {
		paths = append(paths, u.Path)
	}
	assert.Contains(t, paths, "staging/src/x.go")
	assert.Contains(t, paths, "cmd/y.go")
	assert.Contains(t, paths, "plugin/z.go")
}
