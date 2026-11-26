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

type StringRef struct {
	Offset uint32
	Length uint16
}

type ChunkEntry struct {
	ID          StringRef
	DocPath     StringRef
	Title       StringRef
	Heading     StringRef
	HeadingPath StringRef
	Snippet     StringRef
	TokenCount  uint32
}

type PostingEntry struct {
	ChunkIndex uint32
	Freq       uint16
}

type TermEntry struct {
	Term     string
	IDF      float32
	Postings []PostingEntry
}

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
	TermList []string

	// prefixSorted enables binary search while prefixSeq restores TermList order for bit-exact float accumulation.
	prefixOnce   sync.Once
	prefixSorted []string
	prefixSeq    map[string]int
}

func (idx *Index) ensurePrefixIndex() {
	idx.prefixOnce.Do(func() {
		seq := make(map[string]int, len(idx.TermList))
		sorted := make([]string, 0, len(idx.TermList))
		for i, t := range idx.TermList {
			if _, ok := idx.Terms[t]; !ok {
				continue
			}
			seq[t] = i
			sorted = append(sorted, t)
		}
		sort.Strings(sorted)
		idx.prefixSorted = sorted
		idx.prefixSeq = seq
	})
}

const maxOGISDecompressedBytes = 256 * 1024 * 1024 // Cap decompressed payload at 256MB to block gzip bombs.

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

	if offset+12 > len(data) {
		return nil, fmt.Errorf("ogis index truncated at counts header")
	}
	chunkCount := binary.LittleEndian.Uint32(data[offset : offset+4])
	offset += 4
	termCount := binary.LittleEndian.Uint32(data[offset : offset+4])
	offset += 4
	avgDocLen := math.Float32frombits(binary.LittleEndian.Uint32(data[offset : offset+4]))
	offset += 4

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
