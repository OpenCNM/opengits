package ogis

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

type SearchResult struct {
	ID          string  `json:"id"`
	Type        string  `json:"type"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	URL         string  `json:"url"`
	Owner       string  `json:"owner"`
	Repo        string  `json:"repo"`
	Score       float64 `json:"score"`
}

var (
	ogisCleanExtRe = mdpat.MdExtRe
)

func ogisSlugify(text string) string {
	return mdpat.Slugify(text)
}

func (idx *Index) Search(query string, limit int) []SearchResult {
	return idx.SearchWithTopology(query, limit, nil)
}

func (idx *Index) SearchWithTopology(query string, limit int, scorer *TopologicalScorer) []SearchResult {
	if limit <= 0 {
		limit = 20
	}

	rawTokens := tokenizeSearchText(query)
	if len(rawTokens) == 0 {
		return []SearchResult{}
	}

	const (
		k1 = 1.2
		b  = 0.75
	)
	avgdl := float64(idx.AvgDocLen)
	if avgdl <= 0 {
		avgdl = 1.0
	}

	scores := make(map[uint32]float64)

	for _, token := range rawTokens {

		if exactTerm, ok := idx.Terms[token]; ok {
			idx.accumulateTermScore(exactTerm, 1.0, k1, b, avgdl, scores)
		}

		if len([]rune(token)) >= 2 {

			// Cap prefix expansion to the first 8 terms in TermList order to bound latency and preserve float sum order.
			idx.ensurePrefixIndex()
			lo := sort.SearchStrings(idx.prefixSorted, token)
			type seqTerm struct {
				seq  int
				term string
			}
			var inRange []seqTerm
			for i := lo; i < len(idx.prefixSorted) && strings.HasPrefix(idx.prefixSorted[i], token); i++ {
				candidate := idx.prefixSorted[i]
				if candidate == token {
					continue
				}
				inRange = append(inRange, seqTerm{seq: idx.prefixSeq[candidate], term: candidate})
			}
			if len(inRange) > 8 {
				sort.Slice(inRange, func(a, b int) bool { return inRange[a].seq < inRange[b].seq })
				inRange = inRange[:8]
			} else if len(inRange) > 1 {
				sort.Slice(inRange, func(a, b int) bool { return inRange[a].seq < inRange[b].seq })
			}
			for _, st := range inRange {
				idx.accumulateTermScore(idx.Terms[st.term], 0.7, k1, b, avgdl, scores)
			}
		}
	}

	if len(scores) == 0 {
		return []SearchResult{}
	}

	if scorer == nil {
		scorer = DefaultTopologicalScorer
	}
	if scorer != nil {
		for ci, sc := range scores {
			if int(ci) < len(idx.Chunks) {
				docPath := idx.ReadPoolString(idx.Chunks[ci].DocPath)
				mult := scorer.ScorePath(docPath)
				scores[ci] = sc * mult
			}
		}
	}

	type rankedItem struct {
		chunkIndex uint32
		score      float64
	}
	ranked := make([]rankedItem, 0, len(scores))
	for ci, sc := range scores {
		ranked = append(ranked, rankedItem{chunkIndex: ci, score: sc})
	}
	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].score != ranked[j].score {
			return ranked[i].score > ranked[j].score
		}
		return ranked[i].chunkIndex < ranked[j].chunkIndex
	})

	if len(ranked) > limit {
		ranked = ranked[:limit]
	}

	results := make([]SearchResult, 0, len(ranked))
	for _, item := range ranked {
		chunk, ok := idx.GetChunk(int(item.chunkIndex))
		if !ok {
			continue
		}

		title := chunk.Title
		if chunk.Heading != "" {
			if title != "" {
				title = title + " › " + chunk.Heading
			} else {
				title = chunk.Heading
			}
		}

		hashFragment := ""
		if chunk.Heading != "" {
			hashFragment = "#" + ogisSlugify(chunk.Heading)
		}
		cleanDocPath := strings.TrimPrefix(chunk.DocPath, "/")
		cleanDocPath = ogisCleanExtRe.ReplaceAllString(cleanDocPath, "")
		url := fmt.Sprintf("/docs/%s/%s/%s%s", idx.Owner, idx.Repo, cleanDocPath, hashFragment)

		results = append(results, SearchResult{
			ID:          chunk.ID,
			Type:        "document",
			Title:       title,
			Description: chunk.Content,
			URL:         url,
			Owner:       idx.Owner,
			Repo:        idx.Repo,
			Score:       math.Round(item.score*100) / 100,
		})
	}

	return results
}

func (idx *Index) accumulateTermScore(
	termEntry *TermEntry,
	weightMultiplier float64,
	k1, b, avgdl float64,
	scores map[uint32]float64,
) {
	idf := float64(termEntry.IDF)
	termBytes := []byte(strings.ToLower(termEntry.Term))

	for _, p := range termEntry.Postings {
		ci := p.ChunkIndex
		if int(ci) >= len(idx.Chunks) {
			continue
		}
		chunk := idx.Chunks[ci]

		f := float64(p.Freq)
		docLen := float64(chunk.TokenCount)
		if docLen < 1 {
			docLen = 1
		}

		tf := (f * (k1 + 1.0)) / (f + k1*(1.0-b+b*(docLen/avgdl)))
		termScore := idf * tf * weightMultiplier

		if idx.chunkContainsTerm(chunk, termBytes) {
			termScore *= 1.2
		}

		scores[ci] += termScore
	}
}

func bytesContainsFold(haystack, needle []byte) bool {
	nLen := len(needle)
	if nLen == 0 {
		return true
	}
	hLen := len(haystack)
	if hLen < nLen {
		return false
	}
	limit := hLen - nLen
	for i := 0; i <= limit; i++ {
		match := true
		for j := 0; j < nLen; j++ {
			b := haystack[i+j]
			if b >= 'A' && b <= 'Z' {
				b += 32
			}
			if b != needle[j] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

func (idx *Index) chunkContainsTerm(chunk ChunkEntry, termBytes []byte) bool {
	if len(termBytes) == 0 {
		return false
	}

	if chunk.Title.Length > 0 {
		if bytesContainsFold(idx.ReadPoolBytes(chunk.Title), termBytes) {
			return true
		}
	}
	if chunk.Heading.Length > 0 {
		if bytesContainsFold(idx.ReadPoolBytes(chunk.Heading), termBytes) {
			return true
		}
	}
	return false
}
