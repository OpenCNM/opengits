package ogis

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/json"
	"io"
	"math"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ── 测试侧 OGIS 解析器（只用于断言，不参与生产读路径——读在 Node）──

type parsedOGIS struct {
	magic      string
	version    uint16
	flags      uint16
	gitSha     string
	owner      string
	repo       string
	chunkCount uint32
	termCount  uint32
	avgDocLen  float32
	pool       []byte
	chunks     []parsedChunk
	terms      []parsedTerm
}

type parsedChunk struct {
	id, docPath, title, heading, headingPath, snippet string
	tokenCount                                        uint32
}

type parsedTerm struct {
	term     string
	idf      float32
	postings []parsedPosting
}

type parsedPosting struct {
	chunkIndex uint32
	freq       uint16
}

type ogisReader struct {
	data []byte
	off  int
}

func (r *ogisReader) u16() uint16 {
	v := binary.LittleEndian.Uint16(r.data[r.off:])
	r.off += 2
	return v
}

func (r *ogisReader) u32() uint32 {
	v := binary.LittleEndian.Uint32(r.data[r.off:])
	r.off += 4
	return v
}

func (r *ogisReader) f32() float32 {
	return math.Float32frombits(r.u32())
}

func (r *ogisReader) str(max int) string {
	s := string(r.data[r.off : r.off+max])
	r.off += max
	return s
}

func (r *ogisReader) poolStr(pool []byte, off, length uint32) string {
	return string(pool[off : off+length])
}

func unpackOGISForTest(t *testing.T, data []byte) parsedOGIS {
	t.Helper()
	require.GreaterOrEqual(t, len(data), 2)
	if data[0] == 0x1f && data[1] == 0x8b {
		zr, err := gzip.NewReader(bytes.NewReader(data))
		require.NoError(t, err)
		raw, err := io.ReadAll(zr)
		require.NoError(t, err)
		data = raw
	}
	r := &ogisReader{data: data}
	out := parsedOGIS{}
	out.magic = r.str(4)
	out.version = r.u16()
	out.flags = r.u16()
	out.gitSha = string(bytes.TrimRight([]byte(r.str(ogisGitShaWidth)), " "))
	ownerLen := int(r.u16())
	owner := string(data[r.off : r.off+ownerLen])
	r.off += ownerLen
	repoLen := int(r.u16())
	repo := string(data[r.off : r.off+repoLen])
	r.off += repoLen
	out.owner, out.repo = owner, repo
	out.chunkCount = r.u32()
	out.termCount = r.u32()
	out.avgDocLen = r.f32()
	poolSize := r.u32()
	out.pool = data[r.off : r.off+int(poolSize)]
	r.off += int(poolSize)

	poolRef := func() (uint32, uint16) { return r.u32(), r.u16() }
	for i := 0; i < int(out.chunkCount); i++ {
		var c parsedChunk
		refs := make([][2]any, 6)
		_ = refs
		idOff, idLen := poolRef()
		pOff, pLen := poolRef()
		tOff, tLen := poolRef()
		hOff, hLen := poolRef()
		hpOff, hpLen := poolRef()
		sOff, sLen := poolRef()
		c.id = r.poolStr(out.pool, idOff, uint32(idLen))
		c.docPath = r.poolStr(out.pool, pOff, uint32(pLen))
		c.title = r.poolStr(out.pool, tOff, uint32(tLen))
		c.heading = r.poolStr(out.pool, hOff, uint32(hLen))
		c.headingPath = r.poolStr(out.pool, hpOff, uint32(hpLen))
		c.snippet = r.poolStr(out.pool, sOff, uint32(sLen))
		c.tokenCount = r.u32()
		out.chunks = append(out.chunks, c)
	}

	for i := 0; i < int(out.termCount); i++ {
		tOff, tLen := poolRef()
		term := parsedTerm{
			term: r.poolStr(out.pool, tOff, uint32(tLen)),
			idf:  r.f32(),
		}
		count := r.u32()
		for j := 0; j < int(count); j++ {
			ci := r.u32()
			freq := r.u16()
			term.postings = append(term.postings, parsedPosting{chunkIndex: ci, freq: freq})
		}
		out.terms = append(out.terms, term)
	}
	require.Equal(t, len(data), r.off, "解析应恰好消费全部字节")
	return out
}

func findFixturePath(name string) string {
	candidates := []string{
		"testdata/" + name,
		"../../testdata/" + name,
		"services/worker-sidecar/testdata/" + name,
		"/src/services/worker-sidecar/testdata/" + name,
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "testdata/" + name
}

func TestPackOGISIndexLayout(t *testing.T) {
	tests := []struct {
		name  string
		input PackInput
	}{
		{
			name:  "空 chunk 集产出空索引（pool 仅空串）",
			input: PackInput{Owner: "o", Repo: "r", GitSha: "abc", Chunks: nil},
		},
		{
			name: "超长 gitSha 截断到 40B",
			input: PackInput{
				Owner: "o", Repo: "r", GitSha: string(bytes.Repeat([]byte{'x'}, 80)),
				Chunks: []ChunkRecord{{
					ID: "c1", DocPath: "a.md", Title: "T", Heading: "H", HeadingPath: "hp",
					Content: "hello world", Tokens: []string{"hello", "world"},
				}},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw := PackIndex(tt.input, false, 1)
			p := unpackOGISForTest(t, raw)
			assert.Equal(t, "OGIS", p.magic)
			assert.EqualValues(t, 1, p.version)
			assert.EqualValues(t, 0, p.flags)
			assert.Equal(t, tt.input.Owner, p.owner)
			assert.Equal(t, tt.input.Repo, p.repo)
			wantSha := tt.input.GitSha
			if len(wantSha) > 40 {
				wantSha = wantSha[:40]
			}
			assert.Equal(t, wantSha, p.gitSha)
			assert.Len(t, p.chunks, len(tt.input.Chunks))
			if len(tt.input.Chunks) == 0 {
				assert.Empty(t, p.pool, "空索引 pool 只含空串（size=0）")
				assert.Zero(t, p.avgDocLen)
			}
		})
	}
}

func TestPackOGISIndexGzipWrapping(t *testing.T) {
	input := PackInput{
		Owner: "o", Repo: "r", GitSha: "deadbeef",
		Chunks: []ChunkRecord{{ID: "c1", DocPath: "a.md", Title: "T", Heading: "", HeadingPath: "", Content: "内容", Tokens: []string{"内", "内容"}}},
	}
	packed := PackIndex(input, true, 1)
	require.GreaterOrEqual(t, len(packed), 2)
	assert.Equal(t, byte(0x1f), packed[0], "gzip magic 高字节")
	assert.Equal(t, byte(0x8b), packed[1], "gzip magic 低字节")
	p := unpackOGISForTest(t, packed) // 自动 gunzip
	assert.EqualValues(t, 1, p.flags)
}

// ── 跨语言 golden：Node 原版 packer 的输出必须能被 Go 产出语义等价物 ──

type fixtureChunkJSON struct {
	ID          string   `json:"id"`
	DocPath     string   `json:"docPath"`
	Title       string   `json:"title"`
	Heading     string   `json:"heading"`
	HeadingPath string   `json:"headingPath"`
	Snippet     string   `json:"snippet"`
	Tokens      []string `json:"tokens"`
}

type fixtureJSON struct {
	Owner  string             `json:"owner"`
	Repo   string             `json:"repo"`
	GitSha string             `json:"gitSha"`
	Chunks []fixtureChunkJSON `json:"chunks"`
}

func TestOGISCrossLanguageGolden(t *testing.T) {
	bin, err := os.ReadFile(findFixturePath("ogis-fixture.bin"))
	require.NoError(t, err)
	js, err := os.ReadFile(findFixturePath("ogis-fixture.json"))
	require.NoError(t, err)
	var fx fixtureJSON
	require.NoError(t, json.Unmarshal(js, &fx))

	nodeOut := unpackOGISForTest(t, bin)
	require.Equal(t, fx.Owner, nodeOut.owner)
	require.Equal(t, fx.Repo, nodeOut.repo)
	require.Equal(t, fx.GitSha, nodeOut.gitSha)
	require.Len(t, nodeOut.chunks, len(fx.Chunks))

	// Go 侧用同一输入打包，逐字段与 Node 输出等价
	goChunks := make([]ChunkRecord, 0, len(fx.Chunks))
	for i, c := range fx.Chunks {
		// 语义来源一致性：Node fixture 的 tokens/snippet 就是打包输入
		goChunks = append(goChunks, ChunkRecord{
			ID: c.ID, DocPath: c.DocPath, Title: c.Title,
			Heading: c.Heading, HeadingPath: c.HeadingPath,
			Content: restoreContentForFixture(c.Snippet), Tokens: c.Tokens,
		})
		// Node 输出逐字段断言
		assert.Equal(t, c.ID, nodeOut.chunks[i].id)
		assert.Equal(t, c.DocPath, nodeOut.chunks[i].docPath)
		assert.Equal(t, c.Title, nodeOut.chunks[i].title)
		assert.Equal(t, c.Heading, nodeOut.chunks[i].heading)
		assert.Equal(t, c.HeadingPath, nodeOut.chunks[i].headingPath)
		assert.Equal(t, c.Snippet, nodeOut.chunks[i].snippet)
	}

	goOut := unpackOGISForTest(t, PackIndex(PackInput{
		Owner: fx.Owner, Repo: fx.Repo, GitSha: fx.GitSha, Chunks: goChunks,
	}, false, 1))

	assert.EqualValues(t, nodeOut.chunkCount, goOut.chunkCount)
	assert.EqualValues(t, nodeOut.termCount, goOut.termCount)
	assert.InDelta(t, nodeOut.avgDocLen, goOut.avgDocLen, 1e-4)
	for i := range nodeOut.chunks {
		assert.Equal(t, nodeOut.chunks[i].id, goOut.chunks[i].id)
		assert.Equal(t, nodeOut.chunks[i].snippet, goOut.chunks[i].snippet)
		assert.Equal(t, nodeOut.chunks[i].tokenCount, goOut.chunks[i].tokenCount)
	}
	require.Len(t, goOut.terms, len(nodeOut.terms))
	for i := range nodeOut.terms {
		assert.Equal(t, nodeOut.terms[i].term, goOut.terms[i].term, "term 顺序（首现序）应一致")
		assert.InDelta(t, nodeOut.terms[i].idf, goOut.terms[i].idf, 1e-4)
		require.Len(t, goOut.terms[i].postings, len(nodeOut.terms[i].postings))
		for j := range nodeOut.terms[i].postings {
			assert.Equal(t, nodeOut.terms[i].postings[j].chunkIndex, goOut.terms[i].postings[j].chunkIndex)
			assert.Equal(t, nodeOut.terms[i].postings[j].freq, goOut.terms[i].postings[j].freq)
		}
	}
}

// restoreContentForFixture Go 打包器会对 Content 做两级清洗生成 snippet；
// fixture 只保留了清洗后的 snippet，故直接把 snippet 作为 Content 回灌
// （二级清洗幂等：已折叠/已截断的文本再清洗结果不变）。
func restoreContentForFixture(snippet string) string { return snippet }
