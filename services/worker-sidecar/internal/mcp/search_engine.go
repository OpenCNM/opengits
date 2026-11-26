package mcp

import (
	"context"
	"regexp"
	"sort"
	"strings"
	"unicode"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

const (
	locatorSnippetRadius        = 120
	locatorCandidateLimit       = 30
	scopedLocatorCandidateLimit = 60
)

var tsStripRE = regexp.MustCompile(`[^\w` + mdpat.CJKScriptClass + `\s]`)
var pureUnderscoreRE = regexp.MustCompile(`^_+$`)
var hasWordCharRE = regexp.MustCompile(`[\w` + mdpat.CJKScriptClass + `]`)

func buildTsQuery(query string) string {
	if strings.TrimSpace(query) == "" {
		return ""
	}
	stripped := tsStripRE.ReplaceAllString(query, " ")
	var terms []string
	for _, w := range strings.Fields(stripped) {
		if len(w) >= 1 && hasWordCharRE.MatchString(w) && !pureUnderscoreRE.MatchString(w) {
			terms = append(terms, w)
		}
	}
	if len(terms) == 0 {
		return ""
	}
	prefixed := make([]string, len(terms))
	for i, t := range terms {
		prefixed[i] = t + ":*"
	}
	return strings.Join(prefixed, " & ")
}

// Lock query config to 'simple' because the generated tsvector column uses 'simple' and stemming causes silent misses.
func getFtsLanguageConfig(locale string) string {
	_ = locale
	return "simple"
}

type ChunkSearchResult struct {
	ID           string
	Heading      *string
	HeadingPath  *string
	Content      string
	Snippet      string
	Title        string
	Path         string
	Similarity   float64
	MatchCount   *float64
	FtsRank      *float64
	EditionLabel string
	RepositoryID string
	Owner        string
	Repo         string
}

type LocatorHit struct {
	ID           string
	Path         string
	Title        string
	Heading      *string
	HeadingPath  *string
	Snippet      string
	Similarity   float64
	EditionLabel string
	RepositoryID string
	Owner        string
	Repo         string
}

type rawChunkRow struct {
	ChunkID      string
	DocID        string
	RepositoryID string
	Owner        string
	Repo         string
	Heading      *string
	HeadingPath  *string
	Content      *string
	Title        *string
	Path         *string
	RepoEdition  *string
	RepoProfile  []byte
	FtsRank      *float64
	MatchCount   *float64
	FTSError     bool
	OwnerUserID  *string
}

type searchParams = SearchChunksRequest

func (s *readService) searchRepositoryDocs(ctx context.Context, req SearchChunksRequest) []ChunkSearchResult {
	if req.RepositoryID == "" && len(req.RepositoryIDs) == 0 && !req.IsGlobal {
		return nil
	}
	if strings.TrimSpace(req.Query) == "" && strings.TrimSpace(req.RawQuery) == "" {
		return nil
	}
	safeLimit := req.Limit
	if safeLimit < 1 {
		safeLimit = 5
	}
	if safeLimit > 100 {
		safeLimit = 100
	}
	req.Limit = safeLimit

	if req.TokenBudget <= 0 {
		req.TokenBudget = 4000
	}

	hits, err := s.store.SearchChunks(ctx, req)
	if err != nil || len(hits) == 0 {
		return nil
	}

	out := make([]ChunkSearchResult, 0, len(hits))
	for _, h := range hits {
		var mc *float64
		if h.MatchCount != nil {
			v := float64(*h.MatchCount)
			mc = &v
		}
		ed := ""
		if h.EditionLabel != nil {
			ed = *h.EditionLabel
		}
		out = append(out, ChunkSearchResult{
			ID:           h.ChunkID,
			Heading:      h.Heading,
			HeadingPath:  h.HeadingPath,
			Content:      h.Content,
			Snippet:      h.Snippet,
			Title:        h.Title,
			Path:         h.Path,
			Similarity:   clampF(h.Similarity, 0.1, 1.0),
			MatchCount:   mc,
			FtsRank:      h.FtsRank,
			EditionLabel: ed,
			RepositoryID: h.RepositoryID,
			Owner:        h.Owner,
			Repo:         h.Repo,
		})
	}
	return out
}

var queryTokenRE = regexp.MustCompile(`[\w.\-]+|[` + mdpat.CJKScriptClass + `]+`)
var tokenWordCharRE = regexp.MustCompile(`[a-zA-Z0-9` + mdpat.CJKScriptClass + `]`)

func locatorKeywords(rawQuery string) []string {
	var keywords []string
	seen := map[string]bool{}
	for _, token := range queryTokenRE.FindAllString(rawQuery, -1) {
		if tokenWordCharRE.MatchString(token) && !seen[token] {
			seen[token] = true
			keywords = append(keywords, token)
		}
	}
	return keywords
}

func locatorTokensOf(q string) []string { return queryTokenRE.FindAllString(q, -1) }

func buildLocatorSnippet(content string, keywords []string) string {
	if content == "" {
		return ""
	}
	lowered := strings.ToLower(content)

	// Fall back to case-sensitive matching when ToLower expands byte lengths (e.g. 'İ') to prevent out-of-bounds slicing.
	loweredAligned := len(lowered) == len(content)
	bestIndex, bestLength := -1, 0
	for _, kw := range keywords {
		idx := -1
		if loweredAligned {
			idx = strings.Index(lowered, strings.ToLower(kw))
		} else if i := strings.Index(content, kw); i >= 0 {
			idx = i
		}
		if idx >= 0 && len(kw) > bestLength {
			bestLength = len(kw)
			bestIndex = idx
		}
	}
	if bestIndex < 0 {
		bestIndex = 0
	}
	if bestIndex > len(content) {
		bestIndex = len(content)
	}
	runes := []rune(content)

	runeIndex := len([]rune(content[:bestIndex]))
	runeLength := len([]rune(kwOfLength(content, bestIndex, bestLength)))
	start := runeIndex - locatorSnippetRadius
	if start < 0 {
		start = 0
	}
	end := runeIndex + maxInt(runeLength, 1) + locatorSnippetRadius
	if end > len(runes) {
		end = len(runes)
	}
	prefix, suffix := "", ""
	if start > 0 {
		prefix = "..."
	}
	if end < len(runes) {
		suffix = "..."
	}
	window := strings.Join(strings.Fields(string(runes[start:end])), " ")
	return prefix + strings.TrimSpace(window) + suffix
}

func kwOfLength(content string, byteIndex, byteLength int) string {
	if byteIndex+byteLength > len(content) {
		byteLength = len(content) - byteIndex
	}
	if byteLength < 0 {
		return ""
	}
	return content[byteIndex : byteIndex+byteLength]
}

func locatorScore(r ChunkSearchResult, keywords []string, rawQuery string) float64 {
	score := 0.5
	if isFinite(r.Similarity) {
		score = r.Similarity
	}
	heading := strings.ToLower(deref(r.Heading))
	title := strings.ToLower(r.Title)
	content := strings.ToLower(r.Content)
	snippet := strings.ToLower(r.Snippet)
	raw := strings.ToLower(strings.TrimSpace(rawQuery))

	if raw != "" && (strings.Contains(heading, raw) || strings.Contains(title, raw)) {
		score += 0.3
	} else if raw != "" && (strings.Contains(content, raw) || strings.Contains(snippet, raw)) {
		score += 0.15
	}
	headingMatches := 0
	for _, kw := range keywords {
		if kw == "" {
			continue
		}
		kwLower := strings.ToLower(kw)
		if strings.Contains(heading, kwLower) || strings.Contains(title, kwLower) {
			headingMatches++
		}
	}
	if headingMatches > 0 {
		score += 0.1 * float64(minInt(2, headingMatches))
	}
	return score
}

func rerankChunkResults(results []ChunkSearchResult, rawQuery string) []ChunkSearchResult {
	if len(results) <= 1 || strings.TrimSpace(rawQuery) == "" {
		return results
	}
	keywords := locatorKeywords(rawQuery)
	if len(keywords) == 0 {
		return results
	}
	type scored struct {
		r     ChunkSearchResult
		score float64
	}
	ss := make([]scored, len(results))
	for i, r := range results {
		ss[i] = scored{r, locatorScore(r, keywords, rawQuery)}
	}
	sort.SliceStable(ss, func(i, j int) bool {
		if ss[i].score != ss[j].score {
			return ss[i].score > ss[j].score
		}
		return ss[i].r.Path < ss[j].r.Path
	})
	out := make([]ChunkSearchResult, len(ss))
	for i, s := range ss {
		out[i] = s.r
	}
	return out
}

func (s *readService) locateRepositorySections(ctx context.Context, p searchParams, limit int) []LocatorHit {
	if p.RepositoryID == "" || strings.TrimSpace(p.Query) == "" {
		return nil
	}
	return s.locateSectionsWithLimit(ctx, p, limit, locatorCandidateLimit)
}

func (s *readService) locateScopedSections(ctx context.Context, p searchParams, limit int) []LocatorHit {
	if len(p.RepositoryIDs) == 0 || strings.TrimSpace(p.Query) == "" {
		return nil
	}
	return s.locateSectionsWithLimit(ctx, p, limit, scopedLocatorCandidateLimit)
}

func (s *readService) locateSectionsWithLimit(ctx context.Context, p searchParams, limit, maxCandidates int) []LocatorHit {
	safeLimit := limit
	if safeLimit < 1 {
		safeLimit = 15
	}
	if safeLimit > maxCandidates {
		safeLimit = maxCandidates
	}
	candidateReq := p
	candidateReq.Limit = maxCandidates
	candidateReq.IncludeContent = false
	candidateReq.TokenBudget = 1_000_000

	candidates := s.searchRepositoryDocs(ctx, candidateReq)
	if len(candidates) == 0 {
		return nil
	}
	fallbackQuery := p.RawQuery
	if fallbackQuery == "" {
		fallbackQuery = p.Query
	}
	keywords := locatorKeywords(fallbackQuery)
	fallbackKeywords := keywords
	if len(fallbackKeywords) == 0 {
		fallbackKeywords = []string{fallbackQuery}
	}

	type scored struct {
		hit   ChunkSearchResult
		score float64
	}
	ss := make([]scored, len(candidates))
	for i, c := range candidates {
		ss[i] = scored{c, locatorScore(c, keywords, fallbackQuery)}
	}
	sort.SliceStable(ss, func(i, j int) bool {
		if ss[i].score != ss[j].score {
			return ss[i].score > ss[j].score
		}
		return ss[i].hit.Path < ss[j].hit.Path
	})

	seen := map[string]bool{}
	var hits []LocatorHit
	for _, sc := range ss {
		dedupeKey := sc.hit.ID
		if dedupeKey == "" {
			dedupeKey = sc.hit.RepositoryID + "::" + sc.hit.Path + "::" + derefOr(deref(sc.hit.HeadingPath), deref(sc.hit.Heading))
		}
		if seen[dedupeKey] {
			continue
		}
		seen[dedupeKey] = true

		snippet := sc.hit.Snippet
		if snippet == "" && sc.hit.Content != "" {
			snippet = buildLocatorSnippet(sc.hit.Content, fallbackKeywords)
		}

		hits = append(hits, LocatorHit{
			ID:           sc.hit.ID,
			Path:         sc.hit.Path,
			Title:        sc.hit.Title,
			Heading:      sc.hit.Heading,
			HeadingPath:  sc.hit.HeadingPath,
			Snippet:      snippet,
			Similarity:   clampF(sc.score, 0, 1),
			EditionLabel: sc.hit.EditionLabel,
			RepositoryID: sc.hit.RepositoryID,
			Owner:        sc.hit.Owner,
			Repo:         sc.hit.Repo,
		})
		if len(hits) >= safeLimit {
			break
		}
	}
	return hits
}

// Use a line state machine instead of regex because RE2 lacks backreferences to match paired fences.
func extractFencedCodeBlocks(content string, maxBlocks int) (blocks []string, narrative string) {
	var narr []string
	fenceChar := byte(0)
	var current []string
	inBlock := false
	flush := func() {
		if inBlock && len(blocks) < maxBlocks {
			blocks = append(blocks, strings.Join(current, "\n"))
		}
		current = nil
		inBlock = false
		fenceChar = 0
	}
	for _, line := range lines(content) {
		indent := len(line) - len(strings.TrimLeft(line, " \t"))
		lTrimmed := strings.TrimLeft(line, " \t")
		tick := strings.HasPrefix(lTrimmed, "```")
		tilde := strings.HasPrefix(lTrimmed, "~~~")
		if indent <= 3 && (tick || tilde) {
			fc := byte('`')
			if tilde {
				fc = '~'
			}
			if !inBlock {
				inBlock = true
				fenceChar = fc
				current = append(current, line)
				continue
			}
			if fc == fenceChar {
				current = append(current, line)
				flush()
				continue
			}
		}
		if inBlock {
			current = append(current, line)
		} else {
			narr = append(narr, line)
		}
	}
	flush()
	return blocks, strings.Join(narr, "\n")
}

func lines(s string) []string { return strings.Split(s, "\n") }

func summarizeDocChunk(content string) string {
	if content == "" {
		return ""
	}
	trimmed := strings.TrimSpace(content)
	if len([]rune(trimmed)) <= 150 {
		return trimmed
	}
	blocks, narrativeRaw := extractFencedCodeBlocks(trimmed, 2)
	narrativeOnly := strings.TrimSpace(narrativeRaw)
	runes := []rune(narrativeOnly)
	intro := string(runes[:minInt(150, len(runes))])
	introWithEllipsis := intro
	if len(runes) > 150 {
		introWithEllipsis = intro + "..."
	}
	if len(blocks) > 0 {
		return introWithEllipsis + "\n\n**Key Code Sample:**\n" + strings.Join(blocks, "\n\n")
	}
	return truncateToTokenBudgetWithSuffix(trimmed, 150, "\n\n...[Summary truncated]")
}

func minF(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func clampF(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func isFinite(v float64) bool {
	return !(v != v || v > 1e308 || v < -1e308)
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func derefOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

const BaseEditionLabel = "标准教程"

var transcriptionPresetNames = map[string]string{
	"standard":   "教学解读",
	"deep":       "深度剖析",
	"cheatsheet": "速查手册",
	"faithful":   "忠实原文",
	"analogy":    "类比桥接",
}

// Never render the default "standard" preset as a named edition label.
func deriveEditionLabel(rawProfile []byte) string {
	if len(rawProfile) == 0 {
		return BaseEditionLabel
	}
	var profile map[string]any
	if err := jsonUnmarshalStrict(rawProfile, &profile); err != nil || profile == nil {
		return BaseEditionLabel
	}
	if label, ok := profile["editionLabel"].(string); ok && strings.TrimSpace(label) != "" {
		trimmed := strings.TrimSpace(label)
		if trimmed != "标准教程" && trimmed != "默认" && trimmed != "教学解读版" && trimmed != "教学解读" && !strings.HasPrefix(trimmed, "讲法 ") {
			return trimmed
		}
	}
	if model, ok := profile["transcriptionModel"].(string); ok && strings.TrimSpace(model) != "" {
		return strings.TrimSpace(model)
	}
	if model, ok := profile["model"].(string); ok && strings.TrimSpace(model) != "" {
		return strings.TrimSpace(model)
	}
	var presetID string
	if ep, ok := profile["editionPreset"].(string); ok && strings.TrimSpace(ep) != "" {
		presetID = strings.TrimSpace(ep)
	} else if tp, ok := profile["transcriptionPreset"].(string); ok && strings.TrimSpace(tp) != "" {
		presetID = strings.TrimSpace(tp)
	}
	if presetID != "" {
		name, exists := transcriptionPresetNames[presetID]
		if !exists {
			presetID = "standard"
			name = transcriptionPresetNames["standard"]
		}
		if presetID != "standard" {
			return name + "版"
		}
	}
	return BaseEditionLabel
}

func deriveEditionLabelFromProfile(repoProfile []byte) string {
	lbl := deriveEditionLabel(repoProfile)
	if lbl == BaseEditionLabel {
		return ""
	}
	return lbl
}

var _ = unicode.IsLetter

func truncateToTokenBudgetWithSuffix(text string, maxTokens int, suffix string) string {
	return TruncateWithSuffix(text, maxTokens, suffix)
}
