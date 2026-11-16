package ingest

// 章节映射链 / 作用域过滤 / customOutline 格式化单元测试（Node 管线收刀移植回归钉）。

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func chapterMapPatterns(t *testing.T) *IngestPatterns {
	t.Helper()
	return DefaultPatterns()
}

func TestFilterNodesByScope(t *testing.T) {
	tests := []struct {
		name         string
		paths        []string
		prefixFilter string
		want         []string
	}{
		{
			name:         "single prefix keeps subtree and root readme",
			paths:        []string{"docs/a.md", "docs/sub/b.md", "src/main.go", "README.md", "docs-x/c.md"},
			prefixFilter: "docs",
			want:         []string{"docs/a.md", "docs/sub/b.md", "README.md"},
		},
		{
			name:         "comma separated multi prefix",
			paths:        []string{"docs/a.md", "src/b.go", "tests/c.ts", "README.md"},
			prefixFilter: "docs/, src",
			want:         []string{"docs/a.md", "src/b.go", "README.md"},
		},
		{
			name:         "empty segments dropped",
			paths:        []string{"docs/a.md", "other/b.md"},
			prefixFilter: " , docs , ",
			want:         []string{"docs/a.md"},
		},
		{
			name:         "exact file match counts as scope",
			paths:        []string{"docs", "docs/a.md", "other/b.md"},
			prefixFilter: "docs",
			want:         []string{"docs", "docs/a.md"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			nodes := make([]GitNode, len(tt.paths))
			for i, p := range tt.paths {
				nodes[i] = GitNode{Path: p, Type: "blob"}
			}
			got := filterNodesByScope(nodes, tt.prefixFilter)
			gotPaths := make([]string, 0, len(got))
			for _, n := range got {
				gotPaths = append(gotPaths, n.Path)
			}
			assert.Equal(t, tt.want, gotPaths)
		})
	}
}

func TestResolveTranslationScopeConflict(t *testing.T) {
	tests := []struct {
		name   string
		roots  []string
		prefix string
		want   []string
	}{
		{
			name:   "selected language dir drops its ancestor container",
			roots:  []string{"translations/", "other/"},
			prefix: "translations/zh-CN",
			want:   []string{"other/"},
		},
		{
			name:   "selected container drops nested roots",
			roots:  []string{"translations/zh-CN/", "i18n/ja/"},
			prefix: "translations",
			want:   []string{"i18n/ja/"},
		},
		{
			name:   "disjoint roots kept untouched",
			roots:  []string{"i18n/ja/"},
			prefix: "translations/zh-CN",
			want:   []string{"i18n/ja/"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, resolveTranslationScopeConflict(tt.roots, tt.prefix))
		})
	}
}

func TestBuildChaptersFromCustomOutline(t *testing.T) {
	cats := []CustomOutlineCategory{
		{Name: "Basics", PartTitle: "Part 1: Foundations", Files: []CustomOutlineFile{
			{Path: "docs/getting-started.md"},
			{Path: "docs/advanced-notes.md", ShortTitle: "Advanced"},
		}},
		{Name: "Empty", Files: []CustomOutlineFile{{Path: "outside/x.md"}}},
		{Name: "Third", PartTitle: "Part 2: Advanced", Files: []CustomOutlineFile{{Path: "docs/c.md"}}},
	}

	chapters := buildChaptersFromCustomOutline(cats, "docs")

	require.Len(t, chapters, 2, "prefix-filtered empty category must be dropped")
	assert.Equal(t, "Basics", chapters[0].Title)
	assert.Equal(t, "Part 1: Foundations", chapters[0].PartTitle)
	assert.Equal(t, "Getting Started", chapters[0].Files[0].ShortTitle, "filename must format to title case")
	assert.Equal(t, "Advanced", chapters[0].Files[1].ShortTitle, "shortTitle wins over derived title")
	assert.Equal(t, "Third", chapters[1].Title)
	assert.Equal(t, "Part 2: Advanced", chapters[1].PartTitle)
}

func TestRunChapterMapChainNumericSignal(t *testing.T) {
	nodes := []GitNode{
		{Path: "01-intro.md", Type: "blob"},
		{Path: "02-syntax.md", Type: "blob"},
		{Path: "03-advanced.md", Type: "blob"},
	}
	// LLM 缺席也必须产出：数字前缀强命名是确定性零 LLM 分支
	deps := IngestBodyDeps{}
	entries := runChapterMapChain(context.Background(), deps, chapterMapPatterns(t), nodes, "", chapterMapChainDeps{
		Owner: "o", Repo: "r", Sha: "s",
	})
	require.Len(t, entries, 3)
	assert.Equal(t, 1, entries[0].Order)
	assert.Equal(t, "01-intro.md", entries[0].MainPath)
	assert.Equal(t, "01 intro", entries[0].Title, "title derives deterministically from filename")
}

func TestRunChapterMapChainNoSignalNoLLM(t *testing.T) {
	nodes := []GitNode{
		{Path: "readings/alpha.md", Type: "blob"},
		{Path: "readings/beta.md", Type: "blob"},
	}
	deps := IngestBodyDeps{}
	entries := runChapterMapChain(context.Background(), deps, chapterMapPatterns(t), nodes, "", chapterMapChainDeps{
		Owner: "o", Repo: "r", Sha: "s",
	})
	assert.Nil(t, entries, "no numeric signal and no LLM → nil, caller falls back to rule tree")
}

func TestBuildCurriculumTreeFromMap(t *testing.T) {
	entries := []ChapterMapEntry{
		{Order: 2, Title: "Second", MainPath: "ch/chapter-2.md"},
		{Order: 1, Title: "", MainPath: "ch/chapter-1.md", AssetPaths: []ChapterMapAsset{
			{Path: "labs/lab1/main.py", Kind: "exercise"},
			{Path: "answers/chapter-1.md", Kind: "answer"},
		}},
	}

	tree := buildCurriculumTreeFromMap(entries, "o", "r", "zh-CN")

	require.Len(t, tree, 2)
	assert.Equal(t, "第 1 章", tree[0].Title, "empty title falls back to numbered chapter title")
	require.Len(t, tree[0].Children, 2, "answer assets must be hidden (anti-spoiler)")
	assert.Equal(t, "正文", tree[0].Children[0].Title)
	assert.Equal(t, "text", tree[0].Children[0].PageType)
	assert.Equal(t, "实验 · main.py", tree[0].Children[1].Title)
	assert.Equal(t, "/docs/o/r/ch/chapter-1", tree[0].Children[0].Url)
	assert.Equal(t, "/docs/o/r/labs/lab1/main.py", tree[0].Children[1].Url, "only md extensions fold in doc urls")
}

func TestChaptersFromChapterMap(t *testing.T) {
	entries := []ChapterMapEntry{
		{Order: 1, Title: "One", MainPath: "ch/1.md", AssetPaths: []ChapterMapAsset{
			{Path: "labs/1.py", Kind: "exercise"},
			{Path: "ans/1.md", Kind: "answer"},
		}},
	}
	chapters := chaptersFromChapterMap(entries)
	require.Len(t, chapters, 1)
	assert.Equal(t, "One", chapters[0].Title)
	require.Len(t, chapters[0].Files, 2, "answer excluded, exercise kept")
	assert.Equal(t, "ch/1.md", chapters[0].Files[0].Path)
}

func TestToDocUrlPath(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{in: "docs/a.md", want: "docs/a"},
		{in: "docs/README.md", want: "docs"},
		{in: "README.md", want: ""},
		{in: "x.MARKDOWN", want: "x"},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			assert.Equal(t, tt.want, toDocUrlPath(tt.in))
		})
	}
}

// 导航标签按用户选定的目标语言出（封闭 13 语种表，SSOT 对齐
// constants.ts SUPPORTED_LANGUAGES）；'none'/未知码回落产品默认 zh-CN。
// 旧实现非 en 即中文——选日语/韩语的用户拿到的是中文"正文/实验/第 N 章"。
func TestCurriculumLabelsFollowSelectedLanguage(t *testing.T) {
	tests := []struct {
		lang     string
		wantMain string
		wantChap string
	}{
		{lang: "zh-CN", wantMain: "正文", wantChap: "第 3 章"},
		{lang: "zh-TW", wantMain: "正文", wantChap: "第 3 章"},
		{lang: "zh-HK", wantMain: "正文", wantChap: "第 3 章"},
		{lang: "en", wantMain: "Main Text", wantChap: "Chapter 3"},
		{lang: "en-US", wantMain: "Main Text", wantChap: "Chapter 3"},
		{lang: "ja", wantMain: "本文", wantChap: "第 3 章"},
		{lang: "ko", wantMain: "본문", wantChap: "제 3 장"},
		{lang: "fr", wantMain: "Texte principal", wantChap: "Chapitre 3"},
		{lang: "de", wantMain: "Haupttext", wantChap: "Kapitel 3"},
		{lang: "es", wantMain: "Texto principal", wantChap: "Capítulo 3"},
		{lang: "ru", wantMain: "Основной текст", wantChap: "Глава 3"},
		{lang: "ar", wantMain: "النص الرئيسي", wantChap: "الفصل 3"},
		{lang: "da", wantMain: "Hovedtekst", wantChap: "Kapitel 3"},
		{lang: "none", wantMain: "正文", wantChap: "第 3 章"},
		{lang: "", wantMain: "正文", wantChap: "第 3 章"},
	}
	for _, tt := range tests {
		t.Run(tt.lang, func(t *testing.T) {
			l := curriculumLabelsFor(tt.lang)
			assert.Equal(t, tt.wantMain, l.MainText)
			assert.Equal(t, tt.wantChap, l.ChapterTitle(3))
		})
	}
}
