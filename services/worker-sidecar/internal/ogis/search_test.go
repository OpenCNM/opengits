package ogis

import (
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func createTestSearchIndex(t *testing.T) *Index {
	t.Helper()
	chunks := []ChunkRecord{
		{
			ID:          "chunk-react-hooks",
			DocPath:     "reference/hooks/use-state.mdx",
			Title:       "React Hooks Reference",
			Heading:     "useState Hook",
			HeadingPath: "Hooks > useState",
			Content:     "useState is a React Hook that lets you add a state variable to your component.",
			Tokens:      []string{"react", "hooks", "reference", "usestate", "hook", "state", "variable", "component"},
		},
		{
			ID:          "chunk-react-effects",
			DocPath:     "reference/hooks/use-effect.mdx",
			Title:       "React Hooks Reference",
			Heading:     "useEffect Hook",
			HeadingPath: "Hooks > useEffect",
			Content:     "useEffect is a React Hook that lets you synchronize a component with an external system.",
			Tokens:      []string{"react", "hooks", "reference", "useeffect", "hook", "synchronize", "component", "external", "system"},
		},
		{
			ID:          "chunk-minio-config",
			DocPath:     "deploy/minio.mdx",
			Title:       "MinIO Storage Deployment",
			Heading:     "Object Storage Setup",
			HeadingPath: "Deploy > MinIO > Setup",
			Content:     "Configure MinIO object storage credentials to persist binary search indexes.",
			Tokens:      []string{"minio", "storage", "deployment", "object", "setup", "configure", "credentials", "persist", "binary", "search", "indexes"},
		},
		{
			ID:          "chunk-chinese-wasm",
			DocPath:     "guide/wasm.mdx",
			Title:       "WebAssembly 架构导读",
			Heading:     "线性内存与零开销分词",
			HeadingPath: "架构 > WebAssembly",
			Content:     "通过 WASM 线性内存实现微秒级倒排索引检索与高亮结果直出。",
			Tokens:      TokenizeSearchText("WebAssembly 架构导读 线性内存与零开销分词 通过 WASM 线性内存实现微秒级倒排索引检索与高亮结果直出。"),
		},
	}

	packed := PackIndex(PackInput{
		Owner:  "facebook",
		Repo:   "react",
		GitSha: "9f8e7d6c5b4a32101234567890abcdef12345678",
		Chunks: chunks,
	}, true, 1)

	idx, err := ReadIndex(packed)
	require.NoError(t, err)
	return idx
}

func TestOGISSearch_TableDriven(t *testing.T) {
	idx := createTestSearchIndex(t)

	tests := []struct {
		name         string
		query        string
		limit        int
		wantTopID    string
		wantURLSub   string
		wantMinHits  int
		wantZeroHits bool
	}{
		{
			name:        "精确匹配 useState",
			query:       "useState",
			limit:       10,
			wantTopID:   "chunk-react-hooks",
			wantURLSub:  "/docs/facebook/react/reference/hooks/use-state#usestate-hook",
			wantMinHits: 1,
		},
		{
			name:        "前缀匹配 min -> minio",
			query:       "min",
			limit:       10,
			wantTopID:   "chunk-minio-config",
			wantURLSub:  "/docs/facebook/react/deploy/minio#object-storage-setup",
			wantMinHits: 1,
		},
		{
			name:        "中文 CJK 查询 线性内存",
			query:       "线性内存",
			limit:       10,
			wantTopID:   "chunk-chinese-wasm",
			wantURLSub:  "/docs/facebook/react/guide/wasm",
			wantMinHits: 1,
		},
		{
			name:        "标题语义提权 deployment",
			query:       "deployment",
			limit:       10,
			wantTopID:   "chunk-minio-config",
			wantMinHits: 1,
		},
		{
			name:         "空字符串检索返回空",
			query:        "",
			limit:        10,
			wantZeroHits: true,
		},
		{
			name:         "仅空白与标点符号返回空",
			query:        "   !@#$%   ",
			limit:        10,
			wantZeroHits: true,
		},
		{
			name:         "不存在的生僻词",
			query:        "nonexistenttermxyz",
			limit:        10,
			wantZeroHits: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hits := idx.Search(tt.query, tt.limit)
			if tt.wantZeroHits {
				assert.Empty(t, hits)
				return
			}
			require.GreaterOrEqual(t, len(hits), tt.wantMinHits)
			if tt.wantTopID != "" {
				assert.Equal(t, tt.wantTopID, hits[0].ID)
			}
			if tt.wantURLSub != "" {
				assert.Contains(t, hits[0].URL, tt.wantURLSub)
			}
			assert.Equal(t, "document", hits[0].Type)
			assert.Equal(t, "facebook", hits[0].Owner)
			assert.Equal(t, "react", hits[0].Repo)
			assert.Greater(t, hits[0].Score, 0.0)
		})
	}
}

func TestOGISSearch_LimitTruncation(t *testing.T) {
	idx := createTestSearchIndex(t)
	// Query "react" matches both hook chunks
	hits1 := idx.Search("react", 1)
	assert.Len(t, hits1, 1)

	hitsAll := idx.Search("react", 10)
	assert.GreaterOrEqual(t, len(hitsAll), 2)
}

func TestOGISSearch_BenchmarkScaleSLA(t *testing.T) {
	// 500 个虚拟章节压力测试
	largeChunks := make([]ChunkRecord, 0, 500)
	for i := 0; i < 500; i++ {
		largeChunks = append(largeChunks, ChunkRecord{
			ID:          fmt.Sprintf("chunk-bench-%d", i),
			DocPath:     fmt.Sprintf("docs/api/module-%d.mdx", i%20),
			Title:       fmt.Sprintf("API Module %d", i%20),
			Heading:     fmt.Sprintf("Function %d", i),
			HeadingPath: fmt.Sprintf("API > Module %d > Function %d", i%20, i),
			Content:     fmt.Sprintf("This is synthetic function %d handling token authentication and WASM acceleration.", i),
			Tokens:      []string{"api", "module", fmt.Sprintf("fn%d", i), "function", "synthetic", "token", "authentication", "wasm", "acceleration"},
		})
	}

	packed := PackIndex(PackInput{
		Owner:  "perf",
		Repo:   "benchmark",
		GitSha: "bench-sha",
		Chunks: largeChunks,
	}, false, 1)

	idx, err := ReadIndex(packed)
	require.NoError(t, err)

	start := time.Now()
	hits := idx.Search("authentication", 20)
	elapsed := time.Since(start)

	assert.NotEmpty(t, hits)
	// 微秒级响应断言：即便包含排序与 Top-20 字符串抽取，单次执行应显著低于 5ms
	assert.Less(t, elapsed, 5*time.Millisecond, "500 章节检索耗时应该在 5ms 以内，实际耗时: %v", elapsed)
}

func TestOGISSearch_DeterministicTieBreaking(t *testing.T) {
	// 两个 chunk 得分完全相同时，确定性按 chunkIndex 升序 tiebreak
	chunks := []ChunkRecord{
		{
			ID:      "chunk-a",
			DocPath: "docs/a.md",
			Title:   "Same Title",
			Heading: "Same Heading",
			Content: "Identical unique keyword matchable content",
			Tokens:  []string{"same", "unique_key"},
		},
		{
			ID:      "chunk-b",
			DocPath: "docs/b.md",
			Title:   "Same Title",
			Heading: "Same Heading",
			Content: "Identical unique keyword matchable content",
			Tokens:  []string{"same", "unique_key"},
		},
	}

	packed := PackIndex(PackInput{
		Owner:  "tie",
		Repo:   "breaker",
		GitSha: "sha-1",
		Chunks: chunks,
	}, false, 1)

	idx, err := ReadIndex(packed)
	require.NoError(t, err)

	hits := idx.Search("unique_key", 10)
	require.Len(t, hits, 2)
	assert.Equal(t, hits[0].Score, hits[1].Score)
	assert.Equal(t, "chunk-a", hits[0].ID)
	assert.Equal(t, "chunk-b", hits[1].ID)
}

func TestOGISSearch_EmptyTitleWithHeading(t *testing.T) {
	chunks := []ChunkRecord{
		{
			ID:      "chunk-no-title",
			DocPath: "docs/isolated.md",
			Title:   "",
			Heading: "Solo Heading",
			Content: "Body content about isolated topic",
			Tokens:  []string{"isolated", "topic"},
		},
	}

	packed := PackIndex(PackInput{
		Owner:  "o",
		Repo:   "r",
		GitSha: "sha",
		Chunks: chunks,
	}, false, 1)

	idx, err := ReadIndex(packed)
	require.NoError(t, err)

	hits := idx.Search("isolated", 10)
	require.Len(t, hits, 1)
	assert.Equal(t, "Solo Heading", hits[0].Title)
	assert.NotContains(t, hits[0].Title, "›")
}

func TestOGISSearch_TopologicalReranking(t *testing.T) {
	// chunk-test: test file with 2x occurrences of keyword "auth"
	// chunk-core: core contract with 1x occurrence of keyword "auth"
	chunks := []ChunkRecord{
		{
			ID:      "chunk-test",
			DocPath: "internal/auth/auth_test.go",
			Title:   "Auth Tests",
			Heading: "TestAuthSuite",
			Content: "auth auth token verification mock test",
			Tokens:  []string{"auth", "token", "verification", "mock", "test"},
		},
		{
			ID:      "chunk-core",
			DocPath: "internal/auth/contract.go",
			Title:   "Auth Contract",
			Heading: "Authenticator Interface",
			Content: "auth token verification service interface",
			Tokens:  []string{"auth", "token", "verification", "service", "interface"},
		},
	}

	packed := PackIndex(PackInput{
		Owner:  "security",
		Repo:   "guard",
		GitSha: "sha-1",
		Chunks: chunks,
	}, false, 1)

	idx, err := ReadIndex(packed)
	require.NoError(t, err)

	nodes := []TopologicalNodeMeta{
		{
			Path:       "internal/auth/contract.go",
			Role:       "core_contract",
			IsBackbone: true,
			InDegree:   5,
		},
	}
	scorer := NewTopologicalScorer(nodes)

	hits := idx.SearchWithTopology("auth", 10, scorer)
	require.Len(t, hits, 2)
	// Even though chunk-test is a test file, chunk-core is boosted and chunk-test is penalized
	assert.Equal(t, "chunk-core", hits[0].ID)
	assert.Equal(t, "chunk-test", hits[1].ID)
	assert.Greater(t, hits[0].Score, hits[1].Score)
}


// TestPrefixExpansionEquivalence 前缀扩展二分版 vs 线性扫参照实现的
// 等价锁：选中集与累加序一致（浮点累加序敏感，分数必须逐位相等）。
func TestPrefixExpansionEquivalence(t *testing.T) {
	idx := &Index{
		Terms: map[string]*TermEntry{},
	}
	// 词表：字典序与首现序刻意交错（验证选中集按首现序截断前 8）
	terms := []string{
		"react", "reaction", "reactor", "read", "reader", "reading",
		"realign", "realm", "reap", "rearch", "rebase", "recent",
		"recipe", "recite", "reckon", "record", "recourse", "recover",
		"zebra", "alpha",
	}
	for i, t := range terms {
		idx.TermList = append(idx.TermList, t)
		idx.Terms[t] = &TermEntry{Term: t, Postings: []PostingEntry{{ChunkIndex: uint32(i % 3), Freq: 1}}}
	}
	idx.Chunks = make([]ChunkEntry, 3)

	linearScores := func(token string) map[uint32]float64 {
		scores := map[uint32]float64{}
		matches := 0
		for _, candidate := range idx.TermList {
			if candidate == token || !strings.HasPrefix(candidate, token) {
				continue
			}
			term, ok := idx.Terms[candidate]
			if !ok {
				continue
			}
			idx.accumulateTermScore(term, 0.7, 1.2, 0.75, 3.0, scores)
			matches++
			if matches >= 8 {
				break
			}
		}
		return scores
	}

	for _, token := range []string{"re", "rec", "react", "rea", "z", "nonexistent"} {
		t.Run("token_"+token, func(t *testing.T) {
			want := linearScores(token)
			// 二分路径（经 SearchWithTopology 的前缀段；scorer=nil 免拓扑乘子）
			got := map[uint32]float64{}
			idx.ensurePrefixIndex()
			lo := sort.SearchStrings(idx.prefixSorted, token)
			type seqTerm struct {
				seq  int
				term string
			}
			var inRange []seqTerm
			for i := lo; i < len(idx.prefixSorted) && strings.HasPrefix(idx.prefixSorted[i], token); i++ {
				if idx.prefixSorted[i] == token {
					continue
				}
				inRange = append(inRange, seqTerm{seq: idx.prefixSeq[idx.prefixSorted[i]], term: idx.prefixSorted[i]})
			}
			sort.Slice(inRange, func(a, b int) bool { return inRange[a].seq < inRange[b].seq })
			if len(inRange) > 8 {
				inRange = inRange[:8]
			}
			for _, st := range inRange {
				idx.accumulateTermScore(idx.Terms[st.term], 0.7, 1.2, 0.75, 3.0, got)
			}
			require.Equal(t, len(want), len(got), "token=%s", token)
			for ci, sc := range want {
				require.Equal(t, sc, got[ci], "token=%s chunk=%d 分数必须逐位一致", token, ci)
			}
		})
	}
}
