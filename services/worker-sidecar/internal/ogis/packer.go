package ogis

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"math"
	"sort"
)

// ─────────────────────────────────────────────────────────────
// OGIS v1 (OpenGits Index Stream) 二进制打包器。
// 字节级布局与 apps/client/src/lib/search/binary-index-packer.ts
// 逐字对齐（浏览器端 unpackSearchIndex 是唯一消费方，靠 magic 自动
// 探测 gzip，Go 与 Node 的 deflate 字节差异无影响）：
//
//	Magic 'OGIS'(4B) | Version uint16=1 | Flags uint16(1=gzip)
//	gitSha 40B 空格右填充 | ownerLen uint16 + str | repoLen uint16 + str
//	chunkCount uint32 | termCount uint32 | avgDocLen float32
//	StringPool: size uint32 + UTF-8 拼接（空串第一个 intern）
//	Chunks 表：每条 40B（6 个字符串引用 [offset uint32 + len uint16] + tokenCount uint32）
//	Postings 表：每条 termRef(6B) + idf float32 + count uint32，
//	  每条 posting = chunkIndex uint32 + freq uint16
//
// 确定性：term 顺序复刻 JS Map 插入序（chunk 遍历中的首现序）——
// 用「切片 + map 索引」显式保序，postings 按 chunkIndex 升序。
// ─────────────────────────────────────────────────────────────

const (
	Magic              = "OGIS"
	Version     uint16 = 1
	GitShaWidth        = 40
	FreqMax            = 65535

	ogisMagic              = Magic
	ogisVersion     uint16 = Version
	ogisGitShaWidth        = GitShaWidth
	ogisFreqMax            = FreqMax
)

// ChunkRecord 与 Node RawChunkRecord 对齐（content 为原始 chunk 正文，
// 打包时经 cleanSnippetForIndex 两级清洗后入池）。
type ChunkRecord struct {
	ID          string
	DocPath     string
	Title       string
	Heading     string
	HeadingPath string
	Content     string
	Tokens      []string
}

// PackInput 与 Node IndexPackInput 对齐。
type PackInput struct {
	Owner  string
	Repo   string
	GitSha string
	Chunks []ChunkRecord
}

// stringPool 字典池：intern 去重 + 首现序拼接（offset/len 均为字节单位）。
type stringPool struct {
	index map[string]strRef
	buf   bytes.Buffer
}

type strRef struct{ offset, length uint32 }

func newStringPool() *stringPool {
	p := &stringPool{index: make(map[string]strRef)}
	p.intern("") // 空串第一个 intern（offset 0, len 0）
	return p
}

func (p *stringPool) intern(s string) strRef {
	if ref, ok := p.index[s]; ok {
		return ref
	}
	ref := strRef{offset: uint32(p.buf.Len()), length: uint32(len(s))}
	p.index[s] = ref
	p.buf.WriteString(s)
	return ref
}

type ogisPosting struct {
	chunkIndex uint32
	freq       uint16
}

type ogisTermEntry struct {
	term     string
	ref      strRef
	idf      float32
	postings []ogisPosting
}

// PackIndex 打包为 OGIS v1 二进制；compress 时 gzip 包装（级别由调用方定）。
func PackIndex(input PackInput, compress bool, gzipLevel int) []byte {
	pool := newStringPool()
	n := len(input.Chunks)
	totalTokenCount := 0

	// term 首现序：切片 + map 索引复刻 JS Map 插入序；
	// freq 累加复刻 Node 语义（tokens 去重 ⇒ 实际恒为 1，仍按通用逻辑实现）
	var termOrder []string
	termIdx := make(map[string]int)
	termPostings := make([]map[int]int, 0)
	for i, chunk := range input.Chunks {
		totalTokenCount += len(chunk.Tokens)
		for _, token := range chunk.Tokens {
			idx, ok := termIdx[token]
			if !ok {
				idx = len(termOrder)
				termIdx[token] = idx
				termOrder = append(termOrder, token)
				termPostings = append(termPostings, make(map[int]int))
			}
			termPostings[idx][i]++
		}
	}

	avgDocLen := 0.0
	if n > 0 {
		avgDocLen = float64(totalTokenCount) / float64(n)
	}

	// chunk 字符串 intern（顺序：id, docPath, title, heading, headingPath, snippet）
	type chunkMeta struct {
		id, path, title, heading, hPath, snippet strRef
		tokenCount                               uint32
	}
	chunkEntries := make([]chunkMeta, 0, n)
	for _, c := range input.Chunks {
		chunkEntries = append(chunkEntries, chunkMeta{
			id:         pool.intern(c.ID),
			path:       pool.intern(c.DocPath),
			title:      pool.intern(c.Title),
			heading:    pool.intern(c.Heading),
			hPath:      pool.intern(c.HeadingPath),
			snippet:    pool.intern(cleanSnippetForIndex(c.Content)),
			tokenCount: uint32(len(c.Tokens)),
		})
	}
	// term 打包条目：IDF float64 计算后截 float32（对齐 Node writeFloatLE）
	termEntries := make([]ogisTermEntry, 0, len(termOrder))
	for _, term := range termOrder {
		postingsMap := termPostings[termIdx[term]]
		docs := make([]int, 0, len(postingsMap))
		for ci := range postingsMap {
			docs = append(docs, ci)
		}
		sort.Ints(docs)
		idf := math.Log(1 + (float64(n)-float64(len(docs))+0.5)/(float64(len(docs))+0.5))
		entry := ogisTermEntry{term: term, idf: float32(idf)}
		for _, ci := range docs {
			freq := postingsMap[ci]
			if freq > ogisFreqMax {
				freq = ogisFreqMax
			}
			entry.postings = append(entry.postings, ogisPosting{chunkIndex: uint32(ci), freq: uint16(freq)})
		}
		entry.ref = pool.intern(term)
		termEntries = append(termEntries, entry)
	}

	// ── 组装字节流（全小端）──
	var raw bytes.Buffer
	wu16 := func(v uint16) { var b [2]byte; binary.LittleEndian.PutUint16(b[:], v); raw.Write(b[:]) }
	wu32 := func(v uint32) { var b [4]byte; binary.LittleEndian.PutUint32(b[:], v); raw.Write(b[:]) }
	wf32 := func(v float32) {
		var b [4]byte
		binary.LittleEndian.PutUint32(b[:], math.Float32bits(v))
		raw.Write(b[:])
	}

	raw.WriteString(ogisMagic)
	wu16(ogisVersion)
	if compress {
		wu16(1)
	} else {
		wu16(0)
	}

	sha := input.GitSha
	if len(sha) > ogisGitShaWidth {
		sha = sha[:ogisGitShaWidth]
	}
	shaPadded := bytes.Repeat([]byte{0x20}, ogisGitShaWidth)
	copy(shaPadded, []byte(sha))
	raw.Write(shaPadded)

	owner := []byte(input.Owner)
	repo := []byte(input.Repo)
	wu16(uint16(len(owner)))
	raw.Write(owner)
	wu16(uint16(len(repo)))
	raw.Write(repo)

	wu32(uint32(n))
	wu32(uint32(len(termEntries)))
	wf32(float32(avgDocLen))

	wu32(uint32(pool.buf.Len()))
	raw.Write(pool.buf.Bytes())

	for _, c := range chunkEntries {
		for _, ref := range []strRef{c.id, c.path, c.title, c.heading, c.hPath, c.snippet} {
			wu32(ref.offset)
			wu16(uint16(ref.length))
		}
		wu32(c.tokenCount)
	}

	for _, t := range termEntries {
		wu32(t.ref.offset)
		wu16(uint16(t.ref.length))
		wf32(t.idf)
		wu32(uint32(len(t.postings)))
		for _, p := range t.postings {
			wu32(p.chunkIndex)
			wu16(p.freq)
		}
	}

	if !compress {
		return raw.Bytes()
	}

	var out bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&out, gzipLevel)
	zw.Write(raw.Bytes())
	zw.Close()
	return out.Bytes()
}
