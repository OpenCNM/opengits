package doc

import (
	"net/url"

	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/opengits/worker-sidecar/internal/platform/db"
)

var DocTier0Patterns = []string{"upgrade", "breaking", "history", "v15", "migration", "gotcha"}

var DocTier2Patterns = []string{"api", "reference"}

var newlineRegex = regexp.MustCompile(`[\r\n]+`)

type LlmsTxtRequest struct {
	RepositoryID string  `json:"repositoryId"`
	Owner        string  `json:"owner"`
	Repo         string  `json:"repo"`
	Version      *string `json:"version,omitempty"`
	BaseURL      string  `json:"baseUrl"`
	Full         bool    `json:"full"`
	Budget       *int    `json:"budget,omitempty"`
	Topic        *string `json:"topic,omitempty"`
	Mode         *string `json:"mode,omitempty"`
	UserID       *string `json:"userId,omitempty"`
}

type LlmsTxtResponse struct {
	Content         string `json:"content"`
	EstimatedTokens int    `json:"estimatedTokens"`
	DowngradedCount int    `json:"downgradedCount"`
	TargetVersion   string `json:"targetVersion"`
}

type LlmsTxtRepoInfo struct {
	Owner       string
	Repo        string
	Branch      string
	Category    *string
	NavTree     []byte
	SemVerLabel *string
}

type LlmsTxtDoc struct {
	ID          string  `json:"id"`
	Title       *string `json:"title"`
	Path        string  `json:"path"`
	Summary     *string `json:"summary"`
	Content     string  `json:"content"`
	OwnerUserID *string `json:"ownerUserId,omitempty"`
}

// Escape path segments individually so "/" is preserved while spaces/# stay safely encoded in Markdown links.
func escapePathSegments(p string) string {
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return strings.Join(segs, "/")
}

func (s *PgxStore) GetLlmsTxtData(ctx context.Context, repoID string, userID *string) (*LlmsTxtRepoInfo, []LlmsTxtDoc, error) {
	if s == nil || s.pool == nil {
		return nil, nil, fmt.Errorf("db pool not configured")
	}
	querier := db.New(s.pool)
	repoRow, err := querier.GetLlmsTxtRepository(ctx, repoID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil, fmt.Errorf("repository not found: %s", repoID)
		}
		return nil, nil, fmt.Errorf("query repository failed: %w", err)
	}
	var repoInfo LlmsTxtRepoInfo
	repoInfo.Owner = repoRow.Owner
	repoInfo.Repo = repoRow.Repo
	repoInfo.Branch = repoRow.Branch
	if repoRow.Category.Valid {
		c := repoRow.Category.String
		repoInfo.Category = &c
	}
	if repoRow.SemVerLabel.Valid {
		s := repoRow.SemVerLabel.String
		repoInfo.SemVerLabel = &s
	}
	repoInfo.NavTree = repoRow.NavTree

	argUserID := pgtype.Text{}
	if userID != nil {
		argUserID = pgtype.Text{String: *userID, Valid: true}
	}

	docRows, err := querier.GetLlmsTxtDocuments(ctx, db.GetLlmsTxtDocumentsParams{
		RepositoryId: repoID,
		OwnerUserId:  argUserID,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("query documents failed: %w", err)
	}

	var rawDocs []LlmsTxtDoc
	for _, doc := range docRows {
		d := LlmsTxtDoc{
			ID:      doc.ID,
			Path:    doc.Path,
			Content: doc.Content,
		}
		if doc.Title.Valid {
			title := doc.Title.String
			d.Title = &title
		}
		if doc.Summary.Valid {
			summary := doc.Summary.String
			d.Summary = &summary
		}
		if doc.OwnerUserId.Valid {
			oid := doc.OwnerUserId.String
			d.OwnerUserID = &oid
		}
		rawDocs = append(rawDocs, d)
	}

	return &repoInfo, deduplicateDocuments(rawDocs), nil
}

// Prefer user-owned docs over shared null-owner docs at identical paths to enforce freeze isolation.
func deduplicateDocuments(documents []LlmsTxtDoc) []LlmsTxtDoc {
	docMap := make(map[string]LlmsTxtDoc, len(documents))
	var orderedPaths []string
	for _, doc := range documents {
		existing, found := docMap[doc.Path]
		if !found {
			docMap[doc.Path] = doc
			orderedPaths = append(orderedPaths, doc.Path)
		} else if doc.OwnerUserID != nil && existing.OwnerUserID == nil {
			docMap[doc.Path] = doc
		}
	}

	deduped := make([]LlmsTxtDoc, 0, len(orderedPaths))
	for _, p := range orderedPaths {
		deduped = append(deduped, docMap[p])
	}
	return deduped
}

type llmsNavNode struct {
	Title    string        `json:"title,omitempty"`
	Path     string        `json:"path,omitempty"`
	Children []llmsNavNode `json:"children,omitempty"`
}

func traverseNavTree(nodes []llmsNavNode, docMap map[string]LlmsTxtDoc, visited map[string]bool, ordered *[]LlmsTxtDoc, depth int) {
	if depth > 50 {
		return
	}
	for _, node := range nodes {
		if node.Path != "" {
			if doc, ok := docMap[node.Path]; ok && !visited[node.Path] {
				visited[node.Path] = true
				*ordered = append(*ordered, doc)
			}
		}
		if len(node.Children) > 0 {
			traverseNavTree(node.Children, docMap, visited, ordered, depth+1)
		}
	}
}

// Tokenize non-alphanumeric boundaries before matching so words like rapid/upgrades do not trigger api/upgrade.
func containsWordToken(combined, token string) bool {
	start := 0
	for start <= len(combined) {
		end := start
		for end < len(combined) && isWordByte(combined[end]) {
			end++
		}
		if end > start && combined[start:end] == token {
			return true
		}
		start = end + 1
	}
	return false
}

func isWordByte(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}

func getDocTier(doc LlmsTxtDoc) int {
	title := ""
	if doc.Title != nil {
		title = *doc.Title
	}
	combined := strings.ToLower(title + " " + doc.Path)
	for _, p := range DocTier0Patterns {
		if containsWordToken(combined, p) {
			return 0
		}
	}
	for _, p := range DocTier2Patterns {
		if containsWordToken(combined, p) {
			return 2
		}
	}
	return 1
}

func docMatchesTopic(doc LlmsTxtDoc, topicLower string) bool {
	name := doc.Path
	if doc.Title != nil && *doc.Title != "" {
		name = *doc.Title
	}
	if strings.Contains(strings.ToLower(name), topicLower) {
		return true
	}
	if doc.Summary != nil && strings.Contains(strings.ToLower(*doc.Summary), topicLower) {
		return true
	}
	if strings.Contains(strings.ToLower(doc.Content), topicLower) {
		return true
	}
	return false
}

func GenerateLlmsTxt(req LlmsTxtRequest, repoInfo *LlmsTxtRepoInfo, documents []LlmsTxtDoc) (LlmsTxtResponse, error) {
	documents = deduplicateDocuments(documents)

	targetVersion := repoInfo.Branch
	if repoInfo.SemVerLabel != nil && *repoInfo.SemVerLabel != "" {
		targetVersion = *repoInfo.SemVerLabel
	}
	if req.Version != nil && *req.Version != "" {
		targetVersion = *req.Version
	}

	repoTitle := fmt.Sprintf("%s/%s", req.Owner, req.Repo)
	if targetVersion != "" {
		repoTitle = fmt.Sprintf("%s/%s (%s)", req.Owner, req.Repo, targetVersion)
	}

	var repoDescription string
	if repoInfo.Category != nil && strings.TrimSpace(*repoInfo.Category) != "" {
		repoDescription = fmt.Sprintf("AI-ready documentation and knowledge hub for %s (%s).", repoTitle, *repoInfo.Category)
	} else {
		repoDescription = fmt.Sprintf("AI-ready documentation and knowledge hub for %s.", repoTitle)
	}

	docMap := make(map[string]LlmsTxtDoc, len(documents))
	for _, doc := range documents {
		docMap[doc.Path] = doc
	}

	var orderedDocs []LlmsTxtDoc
	visitedPaths := make(map[string]bool, len(documents))

	if len(repoInfo.NavTree) > 0 {
		var navNodes []llmsNavNode
		if err := json.Unmarshal(repoInfo.NavTree, &navNodes); err == nil {
			traverseNavTree(navNodes, docMap, visitedPaths, &orderedDocs, 0)
		}
	}

	for _, doc := range documents {
		if !visitedPaths[doc.Path] {
			visitedPaths[doc.Path] = true
			orderedDocs = append(orderedDocs, doc)
		}
	}

	topicLower := ""
	if req.Topic != nil {
		topicLower = strings.ToLower(strings.TrimSpace(*req.Topic))
	}

	// Precompute sort keys once (DSU) to avoid O(n log n * docSize) lowercasing inside comparator.
	type docSortKey struct {
		doc        LlmsTxtDoc
		tier       int
		topicMatch bool
	}
	keys := make([]docSortKey, len(orderedDocs))
	for i, doc := range orderedDocs {
		keys[i] = docSortKey{
			doc:        doc,
			tier:       getDocTier(doc),
			topicMatch: topicLower != "" && docMatchesTopic(doc, topicLower),
		}
	}
	sort.SliceStable(keys, func(i, j int) bool {
		if keys[i].tier != keys[j].tier {
			return keys[i].tier < keys[j].tier
		}
		if topicLower != "" {
			aMatch, bMatch := keys[i].topicMatch, keys[j].topicMatch
			if aMatch && !bMatch {
				return true
			}
			if !aMatch && bMatch {
				return false
			}
		}
		return false
	})
	for i := range orderedDocs {
		orderedDocs[i] = keys[i].doc
	}

	mode := "balanced"
	if req.Mode != nil && *req.Mode == "strict" {
		mode = "strict"
	}

	budget := math.MaxInt
	hasBudget := false
	if req.Budget != nil && *req.Budget > 0 {
		budget = *req.Budget
		hasBudget = true
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("# %s Documentation\n", repoTitle))
	sb.WriteString(fmt.Sprintf("> %s\n", repoDescription))
	if hasBudget || (req.Topic != nil && strings.TrimSpace(*req.Topic) != "") {
		budgetStr := "Unlimited"
		if hasBudget {
			budgetStr = strconv.Itoa(budget)
		}
		topicStr := "All"
		if req.Topic != nil && strings.TrimSpace(*req.Topic) != "" {
			topicStr = strings.TrimSpace(*req.Topic)
		}
		sb.WriteString(fmt.Sprintf("> Token Budget: %s | Mode: %s | Topic: %s\n", budgetStr, mode, topicStr))
	}
	sb.WriteString("\n## Docs\n")

	baseURL := strings.TrimRight(req.BaseURL, "/")

	for _, doc := range orderedDocs {
		title := doc.Path
		if doc.Title != nil && *doc.Title != "" {
			title = *doc.Title
		}
		url := fmt.Sprintf("%s/api/docs-content/%s/%s/%s",
			baseURL, url.PathEscape(req.Owner), url.PathEscape(req.Repo), escapePathSegments(doc.Path))
		summaryText := ""
		if doc.Summary != nil && *doc.Summary != "" {
			cleanedSummary := newlineRegex.ReplaceAllString(*doc.Summary, " ")
			summaryText = fmt.Sprintf(": %s", cleanedSummary)
		}
		sb.WriteString(fmt.Sprintf("- [%s](%s)%s\n", title, url, summaryText))
	}

	baseOutput := sb.String()
	baseTokens := EstimateTokens(baseOutput)
	currentTokens := baseTokens
	downgradedCount := 0

	var chunks []string
	chunks = append(chunks, baseOutput)

	if req.Full {
		fullHeader := "\n---\n\n## Full Documentation Content\n\n"
		chunks = append(chunks, fullHeader)
		currentTokens += EstimateTokens(fullHeader)

		for i := 0; i < len(orderedDocs); i++ {
			doc := orderedDocs[i]
			title := doc.Path
			if doc.Title != nil && *doc.Title != "" {
				title = *doc.Title
			}
			docHeader := fmt.Sprintf("# %s\n> Source Path: %s\n\n", title, doc.Path)
			contentStr := strings.TrimSpace(doc.Content)
			docBody := "*(Content currently unavailable or processing)*\n\n"
			if contentStr != "" {
				docBody = contentStr + "\n\n"
			}
			docSection := docHeader + docBody + "---\n\n"
			sectionTokens := EstimateTokens(docSection)

			if currentTokens+sectionTokens <= budget {
				chunks = append(chunks, docSection)
				currentTokens += sectionTokens
				continue
			}

			if mode == "strict" {
				appends, added := handleStrictBudgetOverflow(docSection, budget, currentTokens, len(orderedDocs)-i)
				chunks = append(chunks, appends...)
				currentTokens += added
				break
			}

			chunk, added, downgraded, stop := handleBalancedBudgetDowngrade(doc, title, budget, currentTokens, len(orderedDocs)-i)
			chunks = append(chunks, chunk)
			currentTokens += added
			if downgraded {
				downgradedCount++
			}
			if stop {
				break
			}
		}
	}

	finalContent := strings.Join(chunks, "")
	return LlmsTxtResponse{
		Content:         finalContent,
		EstimatedTokens: currentTokens,
		DowngradedCount: downgradedCount,
		TargetVersion:   targetVersion,
	}, nil
}

func handleStrictBudgetOverflow(docSection string, budget, currentTokens, remainingDocs int) (appends []string, addedTokens int) {
	rem := budget - currentTokens
	if rem > 150 {
		trunc := TruncateToTokenBudget(docSection, rem, DefaultTruncateSuffix)
		appends = append(appends, trunc)
		addedTokens += EstimateTokens(trunc)
	}
	notice := fmt.Sprintf("\n\n> ⚠️ [Budget Strict Mode] Token budget of %d reached. Omitted remaining %d documents.\n", budget, remainingDocs)
	appends = append(appends, notice)
	addedTokens += EstimateTokens(notice)
	return appends, addedTokens
}

func handleBalancedBudgetDowngrade(doc LlmsTxtDoc, title string, budget, currentTokens, remainingDocs int) (chunk string, addedTokens int, downgraded, stop bool) {
	summary := "Refer to link above or increase budget param."
	if doc.Summary != nil && *doc.Summary != "" {
		summary = *doc.Summary
	}
	summaryFallback := fmt.Sprintf("# %s [Auto-Downgraded to Summary]\n> Source Path: %s\n> 💡 *Full text omitted to stay within token budget (%d).*\n> Summary: %s\n\n---\n\n", title, doc.Path, budget, summary)
	summaryTokens := EstimateTokens(summaryFallback)
	if currentTokens+summaryTokens <= budget {
		return summaryFallback, summaryTokens, true, false
	}
	notice := fmt.Sprintf("\n\n> ⚠️ [Budget Balanced Mode] Token budget of %d reached even with summaries. Omitted remaining %d documents.\n", budget, remainingDocs)
	return notice, EstimateTokens(notice), false, true
}
