package ogis

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"math"
	"sort"
)

// OGIS v1 layout (LE): 'OGIS'|u16 ver=1|u16 flags(1=gzip)|40B sha|len+owner|len+repo|u32 chunks|u32 terms|f32 avgdl|pool|chunks(40B)|postings.
// Preserve first-seen term insertion order and ascending chunkIndex postings for deterministic binary output.

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

type ChunkRecord struct {
	ID          string
	DocPath     string
	Title       string
	Heading     string
	HeadingPath string
	Content     string
	Tokens      []string
}

type PackInput struct {
	Owner  string
	Repo   string
	GitSha string
	Chunks []ChunkRecord
}

type stringPool struct {
	index map[string]strRef
	buf   bytes.Buffer
}

type strRef struct{ offset, length uint32 }

func newStringPool() *stringPool {
	p := &stringPool{index: make(map[string]strRef)}
	p.intern("") // Intern empty string first at offset 0 so zero-value StringRef decodes to "".
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

func PackIndex(input PackInput, compress bool, gzipLevel int) []byte {
	pool := newStringPool()
	n := len(input.Chunks)
	totalTokenCount := 0

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
