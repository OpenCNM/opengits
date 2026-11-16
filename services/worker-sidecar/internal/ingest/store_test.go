package ingest

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ── 3c 纯函数与 SQL 语义断言（DB 行为由 3d 容器冒烟覆盖）──

func TestDocOwnerIdFor(t *testing.T) {
	tests := []struct {
		name      string
		isPublic  bool
		userId    string
		wantNil   bool
		wantValue string
	}{
		{
			name:      "public import is shared (nil)",
			isPublic:  true,
			userId:    "u1",
			wantNil:   true,
			wantValue: "",
		},
		{
			name:      "private import owned by user",
			isPublic:  false,
			userId:    "u1",
			wantNil:   false,
			wantValue: "u1",
		},
		{
			name:      "private import without user falls back to shared",
			isPublic:  false,
			userId:    "",
			wantNil:   true,
			wantValue: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := DocOwnerIdFor(tt.isPublic, tt.userId)
			if tt.wantNil {
				assert.Nil(t, got)
			} else {
				require.NotNil(t, got)
				assert.Equal(t, tt.wantValue, *got)
			}
		})
	}
}

func TestOutlineFromNavTree(t *testing.T) {
	tests := []struct {
		name         string
		nav          []*NavNode
		wantParts    int
		wantChapters int
		verify       func(t *testing.T, draft *OutlineDraft)
	}{
		{
			name: "nested directories and top-level files",
			nav: []*NavNode{
				{Name: "README.md", Title: "README", Type: "file", Path: "README.md"},
				{Name: "docs", Title: "Docs", Type: "directory", Path: "docs", Children: []*NavNode{
					{Name: "01_a.md", Title: "Intro", Type: "file", Path: "docs/01_a.md"},
					{Name: "sub", Title: "Sub", Type: "directory", Path: "docs/sub", Children: []*NavNode{
						{Name: "b.md", Title: "B", Type: "file", Path: "docs/sub/b.md"},
					}},
				}},
			},
			wantParts:    1,
			wantChapters: 3,
			verify: func(t *testing.T, draft *OutlineDraft) {
				assert.Equal(t, "Docs", draft.Parts[0].Title)
				assert.Equal(t, 1, draft.Parts[0].TeachingOrder)

				assert.Equal(t, 1, draft.Chapters[0].TeachingOrder)
				assert.Equal(t, 2, draft.Chapters[1].TeachingOrder)
				assert.Equal(t, 3, draft.Chapters[2].TeachingOrder)

				require.Len(t, draft.Chapters[2].Nodes, 1)
				assert.Equal(t, "docs/sub/b.md", draft.Chapters[2].Nodes[0].SourcePath)
			},
		},
		{
			name:         "empty directory produces no chapters",
			nav:          []*NavNode{{Name: "e", Title: "E", Type: "directory", Path: "e"}},
			wantParts:    1,
			wantChapters: 0,
			verify: func(t *testing.T, draft *OutlineDraft) {
				assert.Empty(t, draft.Chapters)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			draft := OutlineFromNavTree(tt.nav)
			assert.Len(t, draft.Parts, tt.wantParts)
			assert.Len(t, draft.Chapters, tt.wantChapters)
			if tt.verify != nil {
				tt.verify(t, &draft)
			}
		})
	}
}

func TestDocFallbackTitle(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "markdown file in subdir", in: "docs/01_intro.md", want: "01_intro"},
		{name: "uppercase extension", in: "a.MD", want: "a"},
		{name: "full markdown extension", in: "b.markdown", want: "b"},
		{name: "no extension", in: "noext", want: "noext"},
		{name: "trailing slash directory", in: "dir/", want: "dir/"},
		{name: "rst doc file", in: "docs/cli.rst", want: "cli"},
		{name: "adoc doc file", in: "manual/guide.adoc", want: "guide"},
		{name: "tex doc file", in: "paper.tex", want: "paper"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := docFallbackTitle(tt.in)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestUpsertOwnedDocumentNullSemanticsSQL(t *testing.T) {
	// 静态断言：禁 ON CONFLICT（NULL 互异会重复建公开行）；必须 IS NULL 双判
	assert.NotContains(t, upsertOwnedDocumentSQL, "ON CONFLICT", "upsertOwnedDocument must NOT use ON CONFLICT")
	assert.Contains(t, upsertOwnedDocumentSQL, `"ownerUserId" IS NULL AND $3::text IS NULL`, "ownership lookup must use explicit IS NULL pairing")
	// 公开仓库并发排他锁保护断言
	assert.Contains(t, lockCanonicalDocSQL, "pg_advisory_xact_lock", "lockCanonicalDocSQL must use advisory transaction lock")
	assert.Contains(t, lockCanonicalDocSQL, "hashtext", "lockCanonicalDocSQL must hash the repo and path key")
}

func TestUpsertContentLayerSQL(t *testing.T) {
	// 静态断言：规范表 DocumentContent 内容寻址与冲突原子更新
	assert.Contains(t, upsertContentLayerSQL, `"DocumentContent"`, "must target DocumentContent table")
	assert.Contains(t, upsertContentLayerSQL, `"contentHash"`, "must specify contentHash unique key")
	assert.Contains(t, upsertContentLayerSQL, `ON CONFLICT ("contentHash") DO UPDATE`, "must handle contentHash conflicts atomically")
	assert.Contains(t, upsertContentLayerSQL, `RETURNING id`, "must return id")
}

func TestUpsertRepositoryRowZeroMaterializationSQL(t *testing.T) {
	// 静态断言：零物化闭环，navTree 停写（恒写 NULL 且冲突更新中不再覆写 navTree，确立 TutorialOutline 为唯一写事实源）
	assert.Contains(t, upsertRepositoryRowSQL, `NULLIF($6,''), NULL, $7::jsonb`, "must write NULL to navTree column on insert")
	assert.NotContains(t, upsertRepositoryRowSQL, `"navTree" =`, "must not overwrite navTree on conflict update")
}

func TestRegisterSnapshotResetSemanticsSQL(t *testing.T) {
	// 全量回退重置 content 或 contentId 非空行（同步置空 contentId 根除读者端幽灵内容残留）
	assert.Contains(t, registerResetSQL, `SET content = NULL, "contentId" = NULL`, "reset must clear both content and contentId")
	assert.Contains(t, registerResetSQL, `"contentId" IS NOT NULL`, "full reset must touch rows with contentId")
	assert.Contains(t, registerResetSQL, `content IS NOT NULL`, "full reset must touch rows with legacy content")
	// 增量删除/重置都限定归属者
	assert.Contains(t, registerResetSQL, `"ownerUserId" = $2`, "reset/delete must be owner-scoped")
}

func TestNormalizeContentHash(t *testing.T) {
	tests := []struct {
		name    string
		content string
		lang    string
	}{
		{
			name:    "simple text",
			content: "hello world",
			lang:    "zh-CN",
		},
		{
			name:    "crlf normalized to lf",
			content: "hello\r\nworld",
			lang:    "",
		},
		{
			name:    "trimmed whitespace",
			content: "  hello world  \n\n",
			lang:    "en",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h1 := normalizeContentHash(tt.content, tt.lang)
			assert.NotEmpty(t, h1)
			assert.Len(t, h1, 64) // SHA-256 hex string

			// CRLF vs LF 等价性校验
			cleanLF := strings.ReplaceAll(tt.content, "\r\n", "\n")
			crlf := strings.ReplaceAll(cleanLF, "\n", "\r\n")
			assert.Equal(t, normalizeContentHash(cleanLF, tt.lang), normalizeContentHash(crlf, tt.lang))
		})
	}
}

func TestPgxStore_ContentDualWrite(t *testing.T) {
	// 默认未设置环境变量时必须为 false（零物化默认停写）
	t.Setenv("DOCUMENT_CONTENT_DUAL_WRITE", "")
	sDefault := NewPgxStore(nil)
	assert.False(t, sDefault.contentDualWrite, "default must be false for zero materialization")

	// 显式 DOCUMENT_CONTENT_DUAL_WRITE=1 时开启
	t.Setenv("DOCUMENT_CONTENT_DUAL_WRITE", "1")
	sDual := NewPgxStore(nil)
	assert.True(t, sDual.contentDualWrite, "DOCUMENT_CONTENT_DUAL_WRITE=1 must enable dual write")

	// 动态切换
	sDual.SetContentDualWrite(false)
	assert.False(t, sDual.contentDualWrite)
}

// 🧪 WP-D 文本大纲两级分组：显式 PartTitle 与导航树顶层目录两种派生路径。
func TestApplyOutlineParts(t *testing.T) {
	tests := []struct {
		name         string
		chapters     []ChapterInput
		navTree      []*NavNode
		providedTree bool
		wantParts    []string
		wantTitles   []string // 每章 PartTitle（顺序对应 draft.Chapters）
	}{
		{
			name: "explicit PartTitle builds distinct parts in order",
			chapters: []ChapterInput{
				{Title: "a", PartTitle: "基础", Files: []ChapterFile{{Path: "docs/a.md"}}},
				{Title: "b", PartTitle: "基础", Files: []ChapterFile{{Path: "docs/b.md"}}},
				{Title: "c", PartTitle: "进阶", Files: []ChapterFile{{Path: "docs/c.md"}}},
			},
			providedTree: false,
			wantParts:    []string{"基础", "进阶"},
			wantTitles:   []string{"基础", "基础", "进阶"},
		},
		{
			name: "provided curriculum tree derives parts from top-level directories",
			chapters: []ChapterInput{
				{Title: "ch1", Files: []ChapterFile{{Path: "course/part-1/01.md"}}},
				{Title: "ch2", Files: []ChapterFile{{Path: "course/part-2/02.md"}}},
			},
			navTree: []*NavNode{
				{Title: "Part 1", Type: "directory", Children: []*NavNode{{Title: "01", Type: "file", Path: "course/part-1/01.md"}}},
				{Title: "Part 2", Type: "directory", Children: []*NavNode{{Title: "02", Type: "file", Path: "course/part-2/02.md"}}},
			},
			providedTree: true,
			wantParts:    []string{"Part 1", "Part 2"},
			wantTitles:   []string{"Part 1", "Part 2"},
		},
		{
			name: "synthetic derived tree never produces parts",
			chapters: []ChapterInput{
				{Title: "a", Files: []ChapterFile{{Path: "docs/a.md"}}},
				{Title: "b", Files: []ChapterFile{{Path: "docs/b.md"}}},
			},
			providedTree: false,
			wantParts:    []string{},
			wantTitles:   []string{"", ""},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			draft := &OutlineDraft{Parts: []OutlinePart{}, Chapters: make([]StoredOutlineChapter, len(tt.chapters))}
			for i, ch := range tt.chapters {
				nodes := make([]OutlineNode, 0, len(ch.Files))
				for _, f := range ch.Files {
					nodes = append(nodes, OutlineNode{Title: f.ShortTitle, NodeType: "file", SourcePath: f.Path})
				}
				draft.Chapters[i] = StoredOutlineChapter{Title: ch.Title, TeachingOrder: i + 1, Nodes: nodes}
			}
			applyOutlineParts(draft, tt.chapters, tt.navTree, tt.providedTree)

			gotParts := make([]string, 0, len(draft.Parts))
			for _, p := range draft.Parts {
				gotParts = append(gotParts, p.Title)
			}
			assert.Equal(t, tt.wantParts, gotParts)
			gotTitles := make([]string, 0, len(draft.Chapters))
			for _, c := range draft.Chapters {
				gotTitles = append(gotTitles, c.PartTitle)
			}
			assert.Equal(t, tt.wantTitles, gotTitles)
		})
	}
}

func TestIsDocFileAndDocExtensions(t *testing.T) {
	p := &IngestPatterns{
		DocExtensions: map[string]bool{
			".md":       true,
			".mdx":      true,
			".markdown": true,
			".txt":      true,
			".rst":      true,
			".adoc":     true,
			".tex":      true,
		},
		CodeExtensions: map[string]bool{
			".go": true,
			".ts": true,
			".py": true,
		},
	}

	tests := []struct {
		path    string
		wantDoc bool
	}{
		{"docs/cli.rst", true},
		{"manual/guide.adoc", true},
		{"paper.tex", true},
		{"README.md", true},
		{"docs/intro.markdown", true},
		{"notes.txt", true},
		{"component.mdx", true},
		{"src/main.go", false},
		{"apps/client/src/index.ts", false},
		{"scripts/train.py", false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			assert.Equal(t, tt.wantDoc, p.IsDocFile(tt.path))
		})
	}
}
