package pipelineb

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/cognitive"
)

func TestChunkFilesIntoOutlineChaptersDocQuota(t *testing.T) {
	t.Helper()

	docSet := func(files []FileMap) map[string]bool {
		s := map[string]bool{}
		for _, f := range files {
			if f.IsDoc {
				s[f.Path] = true
			}
		}
		return s
	}

	t.Run("文档聚簇被打散：每章至多 1 个文档，超出章槽者让位", func(t *testing.T) {
		files := []FileMap{}
		for i := 0; i < 6; i++ {
			files = append(files, FileMap{Path: fmt.Sprintf("pkg/readme-%d.md", i), IsDoc: true, LOC: 100})
		}
		for i := 0; i < 20; i++ {
			files = append(files, FileMap{Path: fmt.Sprintf("pkg/src/code%02d.ts", i), LOC: 100, Exports: []string{"X"}})
		}
		docs := docSet(files)
		chunks := chunkFilesIntoOutlineChapters(files, 8)
		require.NotEmpty(t, chunks)

		totalDocs := 0
		for _, ch := range chunks {
			chunkDocs := 0
			for _, f := range ch.Files {
				if docs[f.Path] {
					chunkDocs++
				}
			}
			totalDocs += chunkDocs
			assert.LessOrEqual(t, chunkDocs, 1, "每章 chunk 最多 1 个文档，聚簇必须打散")
		}
		assert.Equal(t, 3, totalDocs, "每章 1 文档，超出章槽的文档让位")
		assert.Len(t, chunks[0].Files, 8, "章容量恒为 chunkSize")
	})

	t.Run("文档只后移不提前：尾部低分 README 不得进首章", func(t *testing.T) {
		files := []FileMap{}
		for i := 0; i < 10; i++ {
			files = append(files, FileMap{Path: fmt.Sprintf("core/impl_%02d.go", i), LOC: 120, Exports: []string{fmt.Sprintf("Sym%d", i)}, Hotness: 50})
		}
		files = append(files, FileMap{Path: "core/README.md", IsDoc: true, LOC: 200})
		chunks := chunkFilesIntoOutlineChapters(files, 8)
		require.GreaterOrEqual(t, len(chunks), 2)
		for _, f := range chunks[0].Files {
			assert.NotEqual(t, "core/README.md", f.Path, "排序末尾的 README 不得被提权进首章")
		}
	})

	t.Run("纯代码与纯文档子树退化顺序切片", func(t *testing.T) {
		code := []FileMap{{Path: "a.ts"}, {Path: "b.ts"}, {Path: "c.ts"}}
		chunks := chunkFilesIntoOutlineChapters(code, 2)
		require.Len(t, chunks, 2)
		assert.Len(t, chunks[0].Files, 2)

		docs := []FileMap{{Path: "x.md", IsDoc: true}, {Path: "y.md", IsDoc: true}}
		chunks = chunkFilesIntoOutlineChapters(docs, 8)
		require.Len(t, chunks, 1)
		assert.Len(t, chunks[0].Files, 2)
	})
}

func TestCapFilesDocGuaranteeBounded(t *testing.T) {
	t.Helper()
	files := []FileMap{
		{Path: "main/README.md", IsDoc: true, LOC: 100},
		{Path: "main/other/README.md", IsDoc: true, LOC: 100},
		{Path: "main/src/a.ts", LOC: 100},
		{Path: "main/src/b.ts", LOC: 100},
	}
	sorted := []FileMap{files[0], files[1], files[2], files[3]}
	out := capFiles(sorted, 2, false)
	require.Len(t, out, 2)
	docCount := 0
	for _, f := range out {
		if f.IsDoc {
			docCount++
		}
	}
	assert.Equal(t, 1, docCount, "保底至多 1 个文档")
	assert.Equal(t, "main/README.md", out[0].Path, "子树密度最高的主模块 README 优先")
}

type chunkShapePart struct {
	n       int
	pattern string
	doc     bool
}

func chunkShapeFiles(parts []chunkShapePart) []FileMap {
	files := []FileMap{}
	for _, part := range parts {
		for i := 0; i < part.n; i++ {
			files = append(files, FileMap{Path: fmt.Sprintf(part.pattern, i), IsDoc: part.doc, LOC: 100})
		}
	}
	return files
}

func chunkShape(chunks []cognitive.OutlineChapter, isDoc map[string]bool) []string {
	shapes := make([]string, 0, len(chunks))
	for _, ch := range chunks {
		code, docs := 0, 0
		for _, f := range ch.Files {
			if isDoc[f.Path] {
				docs++
			} else {
				code++
			}
		}
		shapes = append(shapes, fmt.Sprintf("%dc+%dd", code, docs))
	}
	return shapes
}

func TestChunkFilesIntoOutlineChaptersBackfillsCode(t *testing.T) {
	t.Helper()
	const chunkSize = 8
	tests := []struct {
		name  string
		parts []chunkShapePart
		want  []string
	}{
		{
			name:  "尾部单 README：预留槽回填代码，末章至少留 1 个代码",
			parts: []chunkShapePart{{n: 30, pattern: "core/impl_%02d.go"}, {n: 1, pattern: "core/README.md", doc: true}},
			want:  []string{"8c+0d", "8c+0d", "8c+0d", "5c+0d", "1c+1d"},
		},
		{
			name:  "文档聚簇在头部：每章 1 文档，超出章槽者让位",
			parts: []chunkShapePart{{n: 6, pattern: "pkg/doc-%d.md", doc: true}, {n: 20, pattern: "pkg/src/code%02d.ts"}},
			want:  []string{"7c+1d", "7c+1d", "6c+1d"},
		},
		{
			name:  "文档密集子树：不产出纯文档章",
			parts: []chunkShapePart{{n: 10, pattern: "docs/guide-%d.md", doc: true}, {n: 6, pattern: "docs/example%02d.ts"}},
			want:  []string{"6c+1d"},
		},
		{
			name:  "单个 README 在头部",
			parts: []chunkShapePart{{n: 1, pattern: "pkg/README.md", doc: true}, {n: 11, pattern: "pkg/c%02d.ts"}},
			want:  []string{"7c+1d", "4c+0d"},
		},
		{
			name:  "README 居中：其前的章不预留文档槽",
			parts: []chunkShapePart{{n: 8, pattern: "core/impl_%02d.go"}, {n: 1, pattern: "core/README.md", doc: true}, {n: 8, pattern: "core/deep_%02d.go"}},
			want:  []string{"8c+0d", "7c+1d", "1c+0d"},
		},
		{
			name:  "小包：README 与源码同章",
			parts: []chunkShapePart{{n: 1, pattern: "pkg/README.md", doc: true}, {n: 3, pattern: "pkg/c%d.ts"}},
			want:  []string{"3c+1d"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			files := chunkShapeFiles(tt.parts)
			isDoc := map[string]bool{}
			wantCode := []string{}
			docRank := map[string]int{}
			lastCode := -1
			for i, f := range files {
				isDoc[f.Path] = f.IsDoc
				if f.IsDoc {
					docRank[f.Path] = lastCode
				} else {
					lastCode = i
					wantCode = append(wantCode, f.Path)
				}
			}
			chunks := chunkFilesIntoOutlineChapters(files, chunkSize)
			if tt.want != nil {
				assert.Equal(t, tt.want, chunkShape(chunks, isDoc))
			}

			seen := map[string]int{}
			chunkOf := map[string]int{}
			gotCode := []string{}
			for ci, ch := range chunks {
				docs := 0
				for _, f := range ch.Files {
					seen[f.Path]++
					chunkOf[f.Path] = ci
					if isDoc[f.Path] {
						docs++
					} else {
						gotCode = append(gotCode, f.Path)
					}
				}
				assert.LessOrEqual(t, docs, 1, "第 %d 章至多 1 个文档", ci)
				assert.False(t, docs > 0 && len(ch.Files) == docs, "第 %d 章不得是纯文档章", ci)
				assert.LessOrEqual(t, len(ch.Files), chunkSize, "第 %d 章不得超章容量", ci)
			}
			assert.Equal(t, wantCode, gotCode, "代码全量保留且相对顺序不变")
			for path, n := range seen {
				assert.Equal(t, 1, n, "%s 不得重复出现", path)
			}
			for doc, prevCode := range docRank {
				if _, kept := chunkOf[doc]; kept && prevCode >= 0 {
					assert.GreaterOrEqual(t, chunkOf[doc], chunkOf[files[prevCode].Path], "文档 %s 只后移不提前", doc)
				}
			}
			for i := 0; i+1 < len(chunks); i++ {
				if len(chunks[i].Files) == chunkSize {
					continue
				}
				for j := i + 1; j < len(chunks); j++ {
					code := 0
					for _, f := range chunks[j].Files {
						if !isDoc[f.Path] {
							code++
						}
					}
					assert.LessOrEqual(t, code, 1, "第 %d 章未满时第 %d 章仍有 %d 个代码可让", i, j, code)
				}
			}
		})
	}
}

func TestCapFilesDocVacancies(t *testing.T) {
	t.Helper()
	tests := []struct {
		name     string
		docs     int
		code     int
		cap      int
		wantLen  int
		wantCode int
	}{
		{name: "代码充足：只留保底文档，其余文档让位", docs: 10, code: 10, cap: 8, wantLen: 8, wantCode: 7},
		{name: "代码稀少：代码全部入选，空位由让位的文档回填", docs: 10, code: 2, cap: 8, wantLen: 8, wantCode: 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			files := chunkShapeFiles([]chunkShapePart{
				{n: tt.docs, pattern: "pkg/guide-%d.md", doc: true},
				{n: tt.code, pattern: "pkg/c%d.ts"},
			})
			out := capFiles(files, tt.cap, false)
			require.Len(t, out, tt.wantLen)
			code := 0
			for _, f := range out {
				if !f.IsDoc {
					code++
				}
			}
			assert.Equal(t, tt.wantCode, code)
		})
	}
}
