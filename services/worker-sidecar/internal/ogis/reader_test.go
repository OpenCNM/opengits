package ogis

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUnpackOGISIndex_GoldenFixture(t *testing.T) {
	bin, err := os.ReadFile(findFixturePath("ogis-fixture.bin"))
	require.NoError(t, err)
	js, err := os.ReadFile(findFixturePath("ogis-fixture.json"))
	require.NoError(t, err)

	var fx fixtureJSON
	require.NoError(t, json.Unmarshal(js, &fx))

	idx, err := ReadIndex(bin)
	require.NoError(t, err)

	assert.Equal(t, ogisMagic, idx.Magic)
	assert.EqualValues(t, 1, idx.Version)
	assert.Equal(t, fx.Owner, idx.Owner)
	assert.Equal(t, fx.Repo, idx.Repo)
	assert.Equal(t, fx.GitSha, idx.GitSha)
	assert.EqualValues(t, len(fx.Chunks), idx.ChunkCount)
	assert.Greater(t, idx.TermCount, uint32(0))
	assert.Greater(t, idx.AvgDocLen, float32(0))

	for i, expected := range fx.Chunks {
		chunk, ok := idx.GetChunk(i)
		require.True(t, ok, "chunk index %d should exist", i)
		assert.Equal(t, expected.ID, chunk.ID)
		assert.Equal(t, expected.DocPath, chunk.DocPath)
		assert.Equal(t, expected.Title, chunk.Title)
		assert.Equal(t, expected.Heading, chunk.Heading)
		assert.Equal(t, expected.HeadingPath, chunk.HeadingPath)
		assert.Equal(t, expected.Snippet, chunk.Content)
	}

	_, ok := idx.GetChunk(-1)
	assert.False(t, ok)
	_, ok = idx.GetChunk(int(idx.ChunkCount))
	assert.False(t, ok)
}

func TestUnpackOGISIndex_TableDriven(t *testing.T) {
	tests := []struct {
		name     string
		input    PackInput
		compress bool
	}{
		{
			name: "空索引无损解包",
			input: PackInput{
				Owner:  "acme",
				Repo:   "empty-repo",
				GitSha: "deadbeef00000000000000000000000000000000",
				Chunks: nil,
			},
			compress: false,
		},
		{
			name: "空索引 Gzip 包装解包",
			input: PackInput{
				Owner:  "acme",
				Repo:   "empty-repo-gzip",
				GitSha: "1234567890123456789012345678901234567890",
				Chunks: nil,
			},
			compress: true,
		},
		{
			name: "中英混排与 CJK 词条索引解包",
			input: PackInput{
				Owner:  "facebook",
				Repo:   "react",
				GitSha: "abcdef0123456789abcdef0123456789abcdef01",
				Chunks: []ChunkRecord{
					{
						ID:          "chunk-1",
						DocPath:     "docs/intro.mdx",
						Title:       "React 快速上手",
						Heading:     "什么是 Hook",
						HeadingPath: "快速上手 > Hook",
						Content:     "useState 是最基础的状态管理 Hook，支持原子化更新。",
						Tokens:      TokenizeSearchText("useState 是最基础的状态管理 Hook，支持原子化更新。"),
					},
					{
						ID:          "chunk-2",
						DocPath:     "docs/advanced.mdx",
						Title:       "架构深度解析",
						Heading:     "Fiber 协调器",
						HeadingPath: "高级 > Fiber",
						Content:     "双缓冲工作树（workInProgress tree）实现高优先级中断调度。",
						Tokens:      TokenizeSearchText("双缓冲工作树 workInProgress tree 实现高优先级中断调度。"),
					},
				},
			},
			compress: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			packed := PackIndex(tt.input, tt.compress, 1)
			idx, err := ReadIndex(packed)
			require.NoError(t, err)

			assert.Equal(t, ogisMagic, idx.Magic)
			assert.EqualValues(t, 1, idx.Version)
			assert.Equal(t, tt.input.Owner, idx.Owner)
			assert.Equal(t, tt.input.Repo, idx.Repo)
			assert.Equal(t, tt.input.GitSha, idx.GitSha)
			assert.EqualValues(t, len(tt.input.Chunks), idx.ChunkCount)

			for i, exp := range tt.input.Chunks {
				chunk, ok := idx.GetChunk(i)
				require.True(t, ok)
				assert.Equal(t, exp.ID, chunk.ID)
				assert.Equal(t, exp.DocPath, chunk.DocPath)
				assert.Equal(t, exp.Title, chunk.Title)
				assert.Equal(t, exp.Heading, chunk.Heading)
				assert.Equal(t, exp.HeadingPath, chunk.HeadingPath)
				assert.Equal(t, cleanSnippetForIndex(exp.Content), chunk.Content)
			}
		})
	}
}

func TestUnpackOGISIndex_Malformed(t *testing.T) {

	validRaw := PackIndex(PackInput{
		Owner:  "o",
		Repo:   "r",
		GitSha: "sha123",
		Chunks: []ChunkRecord{
			{ID: "c1", DocPath: "a.md", Title: "T", Content: "hello", Tokens: []string{"hello"}},
		},
	}, false, 1)

	tests := []struct {
		name        string
		corrupt     func(orig []byte) []byte
		errContains string
	}{
		{
			name: "数据长度不足 50 字节",
			corrupt: func(orig []byte) []byte {
				return orig[:40]
			},
			errContains: "data too short",
		},
		{
			name: "非法 Magic Header",
			corrupt: func(orig []byte) []byte {
				b := append([]byte(nil), orig...)
				copy(b[0:4], []byte("WASM"))
				return b
			},
			errContains: "invalid ogis magic",
		},
		{
			name: "不支持的版本号 (Version 2)",
			corrupt: func(orig []byte) []byte {
				b := append([]byte(nil), orig...)
				binary.LittleEndian.PutUint16(b[4:6], 2)
				return b
			},
			errContains: "unsupported ogis version",
		},
		{
			name: "末尾携带未解析的畸变脏数据",
			corrupt: func(orig []byte) []byte {
				return append(orig, []byte("extra-trailing-bytes")...)
			},
			errContains: "trailing unread bytes",
		},
		{
			name: "Chunks 数组字节被截断",
			corrupt: func(orig []byte) []byte {
				return orig[:len(orig)-10]
			},
			errContains: "truncated",
		},
		{
			name: "非法的 Gzip 头部报文",
			corrupt: func(orig []byte) []byte {
				return []byte{0x1f, 0x8b, 0x00, 0x00}
			},
			errContains: "gzip",
		},
		{
			name: "截断的 Gzip 数据体",
			corrupt: func(orig []byte) []byte {
				packedGzip := PackIndex(PackInput{
					Owner:  "o",
					Repo:   "r",
					GitSha: "sha",
					Chunks: nil,
				}, true, 1)
				return packedGzip[:15]
			},
			errContains: "gzip",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			corrupted := tt.corrupt(validRaw)
			_, err := ReadIndex(corrupted)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.errContains)
		})
	}
}
