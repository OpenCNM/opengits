package ogis

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"sort"
	"strings"
	"sync"
)

// ─────────────────────────────────────────────────────────────
// OGIS v1 (OpenGits Index Stream) 原生读取器。
// 字节级对齐 apps/client/src/lib/search/binary-index-packer.ts
// 架构特性：
//   - 自动检测 Gzip 魔数解压；
//   - 严格 Magic ('OGIS')、Version (1)、边界与 StringPool 越界校验；
//   - 保持 StringPool 原始切片视图，支持零拷贝与按需延迟解码；
//   - 提供 GetChunk(idx) 按需解码 ChunkRecord。
// ─────────────────────────────────────────────────────────────

// StringRef 表示 StringPool 内的偏移与长度（字节单位）。
type StringRef struct {
	Offset uint32
	Length uint16
}

// ChunkEntry 存储二进制中 Chunk 的原始元数据与 StringPool 引用（40B）。
type ChunkEntry struct {
	ID          StringRef
	DocPath     StringRef
	Title       StringRef
	Heading     StringRef
	HeadingPath StringRef
	Snippet     StringRef
	TokenCount  uint32
}

// PostingEntry 倒排拉链项：chunk 索引与词频（6B）。
type PostingEntry struct {
	ChunkIndex uint32
	Freq       uint16
}

// TermEntry 单个词条的倒排拉链与 IDF。
type TermEntry struct {
	Term     string
	IDF      float32
	Postings []PostingEntry
}

// Index 解析后的内存紧凑索引结构。
type Index struct {
	Magic      string
	Version    uint16
	Flags      uint16
	GitSha     string
	Owner      string
	Repo       string
	ChunkCount uint32
	TermCount  uint32
	AvgDocLen  float32
	StringPool []byte

	Chunks   []ChunkEntry
	Terms    map[string]*TermEntry
	TermList []string // 按原始首现序排列的 term 列表，支持快速前缀扩展

	// 前缀扩展辅助有序索引（惰性构建；Index 读入后不可变）：prefixSorted
	// 为 Terms 命中的字典序词表副本，prefixSeq 记录 TermList 首现序——
	// 前缀扩展二分定位区间后按首现序取前 8，与全表线性扫的选中集与
	// 调用序逐位一致（accumulateTermScore 浮点累加序敏感）。绝不改写
	// TermList 本身（其二进制首现序是与 TS unpacker 的格式对拍契约）。
	prefixOnce   sync.Once
	prefixSorted []string
	prefixSeq    map[string]int
}

// ensurePrefixIndex 惰性构建前缀扩展辅助索引（并发安全，构建一次）。
func (idx *Index) ensurePrefixIndex() {
	idx.prefixOnce.Do(func() {
		seq := make(map[string]int, len(idx.TermList))
		sorted := make([]string, 0, len(idx.TermList))
		for i, t := range idx.TermList {
			if _, ok := idx.Terms[t]; !ok {
				continue // 无 postings 的 term 从不参与累加
			}
			seq[t] = i
			sorted = append(sorted, t)
		}
		sort.Strings(sorted)
		idx.prefixSorted = sorted
		idx.prefixSeq = seq
	})
}

const maxOGISDecompressedBytes = 256 * 1024 * 1024 // 256MB 防御 Gzip 炸弹

// ReadIndex 将 OGIS v1 二进制流（支持 Gzip 压缩或未压缩）解析为内存索引结构。
func ReadIndex(data []byte) (*Index, error) {
	if len(data) >= 2 && data[0] == 0x1f && data[1] == 0x8b {
		zr, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, fmt.Errorf("ogis gzip reader: %w", err)
		}
		defer zr.Close()
		decompressed, err := io.ReadAll(io.LimitReader(zr, maxOGISDecompressedBytes+1))
		if err != nil {
			return nil, fmt.Errorf("ogis gzip decompress: %w", err)
		}
		if len(decompressed) > maxOGISDecompressedBytes {
			return nil, fmt.Errorf("ogis index decompressed size exceeds limit of %d bytes", maxOGISDecompressedBytes)
		}
		data = decompressed
	}

	if len(data) < 50 {
		return nil, fmt.Errorf("ogis index data too short: %d bytes (minimum 50 required)", len(data))
	}

	magic := string(data[0:4])
	if magic != ogisMagic {
		return nil, fmt.Errorf("invalid ogis magic: expected %q, got %q", ogisMagic, magic)
	}

	version := binary.LittleEndian.Uint16(data[4:6])
	if version != ogisVersion {
		return nil, fmt.Errorf("unsupported ogis version: %d (expected %d)", version, ogisVersion)
	}

	flags := binary.LittleEndian.Uint16(data[6:8])
	gitSha := strings.TrimRight(string(data[8:48]), " ")
	offset := 48

	// Owner
	if offset+2 > len(data) {
		return nil, fmt.Errorf("ogis index truncated at owner length")
	}
	ownerLen := int(binary.LittleEndian.Uint16(data[offset : offset+2]))
	offset += 2
	if offset+ownerLen > len(data) {
		return nil, fmt.Errorf("ogis index truncated at owner string")
	}
	owner := string(data[offset : offset+ownerLen])
	offset += ownerLen

	// Repo
	if offset+2 > len(data) {
		return nil, fmt.Errorf("ogis index truncated at repo length")
	}
	repoLen := int(binary.LittleEndian.Uint16(data[offset : offset+2]))
	offset += 2
	if offset+repoLen > len(data) {
		return nil, fmt.Errorf("ogis index truncated at repo string")
	}
	repo := string(data[offset : offset+repoLen])
	offset += repoLen

	// Counts & AvgDocLen
	if offset+12 > len(data) {
		return nil, fmt.Errorf("ogis index truncated at counts header")
	}
	chunkCount := binary.LittleEndian.Uint32(data[offset : offset+4])
	offset += 4
	termCount := binary.LittleEndian.Uint32(data[offset : offset+4])
	offset += 4
	avgDocLen := math.Float32frombits(binary.LittleEndian.Uint32(data[offset : offset+4]))
	offset += 4

	// StringPool
	if offset+4 > len(data) {
		return nil, fmt.Errorf("ogis index truncated at string pool size")
	}
	poolSize := binary.LittleEndian.Uint32(data[offset : offset+4])
	offset += 4
	if uint64(offset)+uint64(poolSize) > uint64(len(data)) {
		return nil, fmt.Errorf("ogis index truncated at string pool content: poolSize=%d, remaining=%d", poolSize, len(data)-offset)
	}
	pool := data[offset : offset+int(poolSize)]
	offset += int(poolSize)

	// Chunks Table
	if uint64(offset)+uint64(chunkCount)*40 > uint64(len(data)) {
		return nil, fmt.Errorf("ogis index truncated at chunks table: expected %d bytes, remaining=%d", uint64(chunkCount)*40, len(data)-offset)
	}

	readRef := func() (StringRef, error) {
		off := binary.LittleEndian.Uint32(data[offset : offset+4])
		offset += 4
		l := binary.LittleEndian.Uint16(data[offset : offset+2])
		offset += 2
		if uint64(off)+uint64(l) > uint64(poolSize) {
			return StringRef{}, fmt.Errorf("string ref [%d:%d] out of pool bounds (%d)", off, off+uint32(l), poolSize)
		}
		return StringRef{Offset: off, Length: l}, nil
	}

	chunks := make([]ChunkEntry, chunkCount)
	for i := uint32(0); i < chunkCount; i++ {
		idRef, err := readRef()
		if err != nil {
			return nil, fmt.Errorf("chunk[%d].id: %w", i, err)
		}
		pathRef, err := readRef()
		if err != nil {
			return nil, fmt.Errorf("chunk[%d].docPath: %w", i, err)
		}
		titleRef, err := readRef()
		if err != nil {
			return nil, fmt.Errorf("chunk[%d].title: %w", i, err)
		}
		headingRef, err := readRef()
		if err != nil {
			return nil, fmt.Errorf("chunk[%d].heading: %w", i, err)
		}
		hPathRef, err := readRef()
		if err != nil {
			return nil, fmt.Errorf("chunk[%d].headingPath: %w", i, err)
		}
		snippetRef, err := readRef()
		if err != nil {
			return nil, fmt.Errorf("chunk[%d].snippet: %w", i, err)
		}
		tokenCount := binary.LittleEndian.Uint32(data[offset : offset+4])
		offset += 4

		chunks[i] = ChunkEntry{
			ID:          idRef,
			DocPath:     pathRef,
			Title:       titleRef,
			Heading:     headingRef,
			HeadingPath: hPathRef,
			Snippet:     snippetRef,
			TokenCount:  tokenCount,
		}
	}

	// Postings Table
	terms := make(map[string]*TermEntry, termCount)
	termList := make([]string, 0, termCount)

	for i := uint32(0); i < termCount; i++ {
		if offset+14 > len(data) {
			return nil, fmt.Errorf("ogis index truncated at term[%d] header", i)
		}
		termRef, err := readRef()
		if err != nil {
			return nil, fmt.Errorf("term[%d].termRef: %w", i, err)
		}
		idf := math.Float32frombits(binary.LittleEndian.Uint32(data[offset : offset+4]))
		offset += 4
		postingsCount := binary.LittleEndian.Uint32(data[offset : offset+4])
		offset += 4

		if uint64(offset)+uint64(postingsCount)*6 > uint64(len(data)) {
			return nil, fmt.Errorf("ogis index truncated at term[%d] postings: expected %d bytes, remaining=%d", i, uint64(postingsCount)*6, len(data)-offset)
		}

		postings := make([]PostingEntry, postingsCount)
		for p := uint32(0); p < postingsCount; p++ {
			ci := binary.LittleEndian.Uint32(data[offset : offset+4])
			offset += 4
			freq := binary.LittleEndian.Uint16(data[offset : offset+2])
			offset += 2
			if ci >= chunkCount {
				return nil, fmt.Errorf("posting chunkIndex %d out of chunkCount range %d", ci, chunkCount)
			}
			postings[p] = PostingEntry{ChunkIndex: ci, Freq: freq}
		}

		termStr := string(pool[termRef.Offset : termRef.Offset+uint32(termRef.Length)])
		entry := &TermEntry{
			Term:     termStr,
			IDF:      idf,
			Postings: postings,
		}
		if _, exists := terms[termStr]; !exists {
			termList = append(termList, termStr)
		}
		terms[termStr] = entry
	}

	if offset != len(data) {
		return nil, fmt.Errorf("ogis index has %d trailing unread bytes", len(data)-offset)
	}

	return &Index{
		Magic:      magic,
		Version:    version,
		Flags:      flags,
		GitSha:     gitSha,
		Owner:      owner,
		Repo:       repo,
		ChunkCount: chunkCount,
		TermCount:  termCount,
		AvgDocLen:  avgDocLen,
		StringPool: pool,
		Chunks:     chunks,
		Terms:      terms,
		TermList:   termList,
	}, nil
}

// ReadPoolString 根据 StringRef 安全读取 StringPool 中的 UTF-8 字符串。
func (idx *Index) ReadPoolString(ref StringRef) string {
	if ref.Length == 0 {
		return ""
	}
	start := int(ref.Offset)
	end := start + int(ref.Length)
	if start < 0 || end > len(idx.StringPool) || start > end {
		return ""
	}
	return string(idx.StringPool[start:end])
}

// ReadPoolBytes 根据 StringRef 返回 StringPool 中的字节切片视图（零拷贝）。
func (idx *Index) ReadPoolBytes(ref StringRef) []byte {
	if ref.Length == 0 {
		return nil
	}
	start := int(ref.Offset)
	end := start + int(ref.Length)
	if start < 0 || end > len(idx.StringPool) || start > end {
		return nil
	}
	return idx.StringPool[start:end]
}

// GetChunk 按索引提取 Chunk 的完整可读记录。
func (idx *Index) GetChunk(i int) (ChunkRecord, bool) {
	if i < 0 || i >= len(idx.Chunks) {
		return ChunkRecord{}, false
	}
	c := idx.Chunks[i]
	return ChunkRecord{
		ID:          idx.ReadPoolString(c.ID),
		DocPath:     idx.ReadPoolString(c.DocPath),
		Title:       idx.ReadPoolString(c.Title),
		Heading:     idx.ReadPoolString(c.Heading),
		HeadingPath: idx.ReadPoolString(c.HeadingPath),
		Content:     idx.ReadPoolString(c.Snippet),
	}, true
}
