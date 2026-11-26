package search

import (
	"math"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/opengits/worker-sidecar/internal/ogis"
)

type rawRepoChunkRow struct {
	ChunkID     string
	DocID       string
	Heading     *string
	HeadingPath *string
	Content     string
	Title       *string
	Path        string
	RepoEdition string
	RepoProfile []byte
	FtsRank     *float64
	MatchCount  *int
	Stage       int
}

type rawGlobalChunkRow struct {
	ChunkID      string
	DocID        string
	Heading      *string
	HeadingPath  *string
	Content      string
	Title        *string
	Path         string
	RepositoryID string
	RepoOwner    string
	RepoName     string
	RepoEdition  string
	RepoProfile  []byte
	FtsRank      *float64
	MatchCount   *int
	Stage        int
}

func appendRepoChunkRows(rows pgx.Rows, stage int, defaultRank *float64, seenChunkIDs map[string]bool, rawRows *[]rawRepoChunkRow) {
	for rows.Next() {
		var r rawRepoChunkRow
		var rankVal float64
		if err := rows.Scan(&r.ChunkID, &r.DocID, &r.Heading, &r.HeadingPath, &r.Content, &r.Title, &r.Path, &r.RepoEdition, &r.RepoProfile, &rankVal); err != nil {
			continue
		}
		if seenChunkIDs[r.ChunkID] {
			continue
		}
		seenChunkIDs[r.ChunkID] = true
		if defaultRank != nil {
			r.FtsRank = defaultRank
		} else {
			v := rankVal
			r.FtsRank = &v
		}
		r.Stage = stage
		*rawRows = append(*rawRows, r)
	}
}

func appendGlobalChunkRows(rows pgx.Rows, stage int, defaultRank *float64, seenChunkIDs map[string]bool, rawRows *[]rawGlobalChunkRow) {
	for rows.Next() {
		var r rawGlobalChunkRow
		var rankVal float64
		if err := rows.Scan(&r.ChunkID, &r.DocID, &r.Heading, &r.HeadingPath, &r.Content, &r.Title, &r.Path, &r.RepoOwner, &r.RepoName, &r.RepoEdition, &r.RepoProfile, &rankVal); err != nil {
			continue
		}
		if seenChunkIDs[r.ChunkID] {
			continue
		}
		seenChunkIDs[r.ChunkID] = true
		if defaultRank != nil {
			r.FtsRank = defaultRank
		} else {
			v := rankVal
			r.FtsRank = &v
		}
		r.Stage = stage
		*rawRows = append(*rawRows, r)
	}
}

func appendScopedChunkRows(rows pgx.Rows, stage int, defaultRank *float64, seenChunkIDs map[string]bool, rawRows *[]rawGlobalChunkRow) {
	for rows.Next() {
		var r rawGlobalChunkRow
		var rankVal float64
		if err := rows.Scan(&r.ChunkID, &r.DocID, &r.Heading, &r.HeadingPath, &r.Content, &r.Title, &r.Path, &r.RepositoryID, &r.RepoOwner, &r.RepoName, &r.RepoEdition, &r.RepoProfile, &rankVal); err != nil {
			continue
		}
		if seenChunkIDs[r.ChunkID] {
			continue
		}
		seenChunkIDs[r.ChunkID] = true
		if defaultRank != nil {
			r.FtsRank = defaultRank
		} else {
			v := rankVal
			r.FtsRank = &v
		}
		r.Stage = stage
		*rawRows = append(*rawRows, r)
	}
}

func appendScopedMultiTokenRows(rows pgx.Rows, tokens []string, seenChunkIDs map[string]bool, rawRows *[]rawGlobalChunkRow) {
	for rows.Next() {
		var r rawGlobalChunkRow
		var rankVal float64
		if err := rows.Scan(&r.ChunkID, &r.DocID, &r.Heading, &r.HeadingPath, &r.Content, &r.Title, &r.Path, &r.RepositoryID, &r.RepoOwner, &r.RepoName, &r.RepoEdition, &r.RepoProfile, &rankVal); err != nil {
			continue
		}
		if seenChunkIDs[r.ChunkID] {
			continue
		}
		seenChunkIDs[r.ChunkID] = true
		v := rankVal
		r.FtsRank = &v
		r.Stage = 3
		mVal := countTokenMatches(r.Content, r.Heading, r.Title, tokens)
		r.MatchCount = &mVal
		*rawRows = append(*rawRows, r)
	}
}

func countTokenMatches(content string, heading *string, title *string, tokens []string) int {
	mc := 0
	lowContent := strings.ToLower(content)

	var lowHeading, lowTitle string
	if heading != nil {
		lowHeading = strings.ToLower(*heading)
	}
	if title != nil {
		lowTitle = strings.ToLower(*title)
	}
	for _, tok := range tokens {
		lowTok := strings.ToLower(tok)
		if strings.Contains(lowContent, lowTok) ||
			(heading != nil && strings.Contains(lowHeading, lowTok)) ||
			(title != nil && strings.Contains(lowTitle, lowTok)) {
			mc++
		}
	}
	if mc == 0 {
		return 1
	}
	return mc
}

func appendMultiTokenRows(rows pgx.Rows, tokens []string, seenChunkIDs map[string]bool, rawRows *[]rawRepoChunkRow) {
	for rows.Next() {
		var r rawRepoChunkRow
		var rankVal float64
		if err := rows.Scan(&r.ChunkID, &r.DocID, &r.Heading, &r.HeadingPath, &r.Content, &r.Title, &r.Path, &r.RepoEdition, &r.RepoProfile, &rankVal); err != nil {
			continue
		}
		if seenChunkIDs[r.ChunkID] {
			continue
		}
		seenChunkIDs[r.ChunkID] = true
		v := rankVal
		r.FtsRank = &v
		r.Stage = 3
		mVal := countTokenMatches(r.Content, r.Heading, r.Title, tokens)
		r.MatchCount = &mVal
		*rawRows = append(*rawRows, r)
	}
}

func rerankRepoChunkRows(rows []rawRepoChunkRow, scorer *ogis.TopologicalScorer) []rawRepoChunkRow {
	if len(rows) <= 1 || scorer == nil {
		return rows
	}
	stage0 := make([]rawRepoChunkRow, 0, len(rows))
	others := make([]rawRepoChunkRow, 0, len(rows))
	for _, r := range rows {
		if r.Stage == 0 {
			stage0 = append(stage0, r)
		} else {
			others = append(others, r)
		}
	}
	if len(others) <= 1 {
		return rows
	}

	type scoredRow struct {
		row   rawRepoChunkRow
		score float64
	}
	scored := make([]scoredRow, 0, len(others))
	for _, r := range others {
		var baseSim float64
		switch {
		case r.MatchCount != nil:
			baseSim = math.Min(0.95, 0.5+float64(*r.MatchCount)*0.1)
		case r.FtsRank != nil:
			baseSim = *r.FtsRank
		default:
			baseSim = 0.5
		}
		mult := scorer.ScorePath(r.Path)
		scored = append(scored, scoredRow{row: r, score: baseSim * mult})
	}

	sort.SliceStable(scored, func(i, j int) bool {
		return scored[i].score > scored[j].score
	})

	out := make([]rawRepoChunkRow, 0, len(rows))
	out = append(out, stage0...)
	for _, s := range scored {
		out = append(out, s.row)
	}
	return out
}

func rerankGlobalChunkRows(rows []rawGlobalChunkRow, scorer *ogis.TopologicalScorer) []rawGlobalChunkRow {
	if len(rows) <= 1 || scorer == nil {
		return rows
	}
	stage0 := make([]rawGlobalChunkRow, 0, len(rows))
	others := make([]rawGlobalChunkRow, 0, len(rows))
	for _, r := range rows {
		if r.Stage == 0 {
			stage0 = append(stage0, r)
		} else {
			others = append(others, r)
		}
	}
	if len(others) <= 1 {
		return rows
	}

	type scoredRow struct {
		row   rawGlobalChunkRow
		score float64
	}
	scored := make([]scoredRow, 0, len(others))
	for _, r := range others {
		var baseSim float64
		switch {
		case r.MatchCount != nil:
			baseSim = math.Min(0.95, 0.5+float64(*r.MatchCount)*0.1)
		case r.FtsRank != nil:
			baseSim = *r.FtsRank
		default:
			baseSim = 0.4
		}
		mult := scorer.ScorePath(r.Path)
		scored = append(scored, scoredRow{row: r, score: baseSim * mult})
	}

	sort.SliceStable(scored, func(i, j int) bool {
		return scored[i].score > scored[j].score
	})

	out := make([]rawGlobalChunkRow, 0, len(rows))
	out = append(out, stage0...)
	for _, s := range scored {
		out = append(out, s.row)
	}
	return out
}
