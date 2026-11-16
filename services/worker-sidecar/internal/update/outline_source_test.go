package update

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/ingest"
)

// 🧪 [5.2.5.1] TestApplyOutlineSingleSource 增量 apply 的大纲派生与导入漏斗同一实现：
// ApplyUpdatePlanTx 的 V2 大纲落盘已收敛为 ingest.OutlineFromNavTree +
// ingest.StoreOutlineDraftTx 单一事实源，本用例锁定 update 链典型树形
// （code 虚拟章 + 文档附页 / part 目录）在漏斗派生下的契约形状。
func TestApplyOutlineSingleSource(t *testing.T) {
	tests := []struct {
		name   string
		tree   []*NavNode
		verify func(t *testing.T, draft ingest.OutlineDraft)
	}{
		{
			name: "code chapter tree projects flat chapters in teaching order",
			tree: []*NavNode{
				{Name: "chapter-1", Title: "Core Engine", Type: "file", Path: "chapters/01.mdx"},
				{Name: "chapter-2", Title: "Web UI", Type: "file", Path: "chapters/02.mdx"},
				{Name: "appendix-doc-0", Title: "Guide", Type: "file", Path: "docs/guide.md"},
			},
			verify: func(t *testing.T, draft ingest.OutlineDraft) {
				t.Helper()
				require.Len(t, draft.Chapters, 3)
				assert.Empty(t, draft.Parts, "flat code tree must not create parts")
				for i, ch := range draft.Chapters {
					assert.Equal(t, i+1, ch.TeachingOrder)
					assert.Equal(t, "doc", ch.ChapterType)
					require.Len(t, ch.Nodes, 1)
					assert.Equal(t, ch.Title, ch.Nodes[0].Title)
				}
				assert.Equal(t, "Core Engine", draft.Chapters[0].Title)
				assert.Equal(t, "chapters/01.mdx", draft.Chapters[0].Nodes[0].SourcePath)
				assert.Nil(t, draft.Chapters[0].Summary, "navTree-derived chapters carry no summary")
			},
		},
		{
			name: "part directory tree projects parts with part-titled chapters",
			tree: []*NavNode{
				{
					Name: "docs", Title: "Documentation", Type: "directory",
					Children: []*NavNode{
						{Name: "a", Title: "Getting Started", Type: "file", Path: "docs/a.md"},
						{Name: "b", Title: "Advanced", Type: "file", Path: "docs/b.md"},
					},
				},
			},
			verify: func(t *testing.T, draft ingest.OutlineDraft) {
				t.Helper()
				require.Len(t, draft.Parts, 1)
				assert.Equal(t, "Documentation", draft.Parts[0].Title)
				require.Len(t, draft.Chapters, 2)
				assert.Equal(t, "Documentation", draft.Chapters[0].PartTitle)
				assert.Equal(t, "Getting Started", draft.Chapters[0].Title)
			},
		},
		{
			name: "empty tree projects empty draft",
			tree: []*NavNode{},
			verify: func(t *testing.T, draft ingest.OutlineDraft) {
				t.Helper()
				assert.Empty(t, draft.Parts)
				assert.Empty(t, draft.Chapters)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			draft := ingest.OutlineFromNavTree(tt.tree)
			tt.verify(t, draft)
		})
	}
}
