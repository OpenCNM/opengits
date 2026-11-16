package userinteraction

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/fingerprint"
	cachestore "github.com/opengits/worker-sidecar/internal/platform/cache"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

// ReadingProgressSyncResult contains computed chapter scores and overall progress for a repository.
type ReadingProgressSyncResult struct {
	ChapterScores   map[string]float64 `json:"chapterScores"`
	OverallProgress float64            `json:"overallProgress"`
	ViewedCount     int                `json:"viewedCount"`
	LastReadPath    *string            `json:"lastReadPath,omitempty"`
	LastReadAt      *string            `json:"lastReadAt,omitempty"`
}

// TelemetryEventInput represents a single telemetry event payload.
type TelemetryEventInput struct {
	EventType    string         `json:"eventType"`
	PageURL      string         `json:"pageUrl"`
	TargetID     *string        `json:"targetId,omitempty"`
	Duration     *int           `json:"duration,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	RepositoryID *string        `json:"repositoryId,omitempty"`
}

// SavedRepositoryOverview represents a saved tutorial's transcription progress overview.
type SavedRepositoryOverview struct {
	ID            string `json:"id"`
	Owner         string `json:"owner"`
	Repo          string `json:"repo"`
	McpStatus     string `json:"mcpStatus"`
	TotalDocs     int    `json:"totalDocs"`
	ProcessedDocs int    `json:"processedDocs"`
	IsProcessed   bool   `json:"isProcessed"`
	Progress      int    `json:"progress"`
}

// UserPreferencesResult represents the full preferences and shelf overview of a user.
type UserPreferencesResult struct {
	HasPreferencesSet  bool                      `json:"hasPreferencesSet"`
	PreferredLang1     *string                   `json:"preferredLang1"`
	PreferredLang2     *string                   `json:"preferredLang2"`
	PreferredLang3     *string                   `json:"preferredLang3"`
	Industry           *string                   `json:"industry"`
	PrimaryProgLang    *string                   `json:"primaryProgLang"`
	SecondaryProgLang  *string                   `json:"secondaryProgLang"`
	FontSize           string                    `json:"fontSize"`
	DisabledMcpRepoIds []string                  `json:"disabledMcpRepoIds"`
	SavedRepositories  []SavedRepositoryOverview `json:"savedRepositories"`
}

// UsageSummaryResult represents the quota and usage summary of a user.
type UsageSummaryResult struct {
	Tier          string `json:"tier"`
	IsAdmin       bool   `json:"isAdmin"`
	ReposUsed     int    `json:"reposUsed"`
	MaxRepos      int    `json:"maxRepos"`
	McpCallsToday int    `json:"mcpCallsToday"`
	DailyMcpCalls int    `json:"dailyMcpCalls"`
	Tokens30d     int64  `json:"tokens30d"`
}

// UserPreferencesSetInput represents the input for saving user import preferences.
type UserPreferencesSetInput struct {
	UserID             string   `json:"userId"`
	PreferredLang1     *string  `json:"preferredLang1"`
	PreferredLang2     *string  `json:"preferredLang2"`
	PreferredLang3     *string  `json:"preferredLang3"`
	Industry           *string  `json:"industry"`
	PrimaryProgLang    *string  `json:"primaryProgLang"`
	SecondaryProgLang  *string  `json:"secondaryProgLang"`
	FontSize           *string  `json:"fontSize"`
	DisabledMcpRepoIds []string `json:"disabledMcpRepoIds,omitempty"`
	HasDisabledRepos   bool     `json:"hasDisabledRepos"`
}

// UserPreferencesRecord represents the database record of a user with preferences fields after upsert.
type UserPreferencesRecord struct {
	ID                 string   `json:"id"`
	Name               *string  `json:"name"`
	Email              *string  `json:"email"`
	Image              *string  `json:"image"`
	Role               string   `json:"role"`
	Tier               string   `json:"tier"`
	PreferredLang1     *string  `json:"preferredLang1"`
	PreferredLang2     *string  `json:"preferredLang2"`
	PreferredLang3     *string  `json:"preferredLang3"`
	Industry           *string  `json:"industry"`
	PrimaryProgLang    *string  `json:"primaryProgLang"`
	SecondaryProgLang  *string  `json:"secondaryProgLang"`
	FontSize           string   `json:"fontSize"`
	HasPreferencesSet  bool     `json:"hasPreferencesSet"`
	DisabledMcpRepoIds []string `json:"disabledMcpRepoIds"`
}

var telemetryRepoRegex = regexp.MustCompile(`^/docs/(?:personal/)?([^/]+)/([^/]+)`)

var allowedTelemetryEventTypes = map[string]struct{}{
	"PAGE_VIEW":                 {},
	"SECTION_FOCUS":             {},
	"TEXT_HIGHLIGHT":            {},
	"CODE_COPY":                 {},
	"RAGE_CLICK":                {},
	"IDLE_ZONEOUT":              {},
	"CONTENT_SKIP":              {},
	"QUIZ_INTERACTION":          {},
	"SCROLL_PROGRESS":           {},
	"IMPORT_INITIATED":          {},
	"IMPORT_SCOUT_COMPLETED":    {},
	"IMPORT_INGEST_STARTED":     {},
	"IMPORT_INGEST_COMPLETED":   {},
	"IMPORT_ABANDONED":          {},
	"OUTLINE_TREE_GENERATED":    {},
	"FIRST_CHAPTER_READ":        {},
	"AI_CHAT_ENGAGED":           {},
	"REPO_SAVED":                {},
	"MCP_TOOL_CALL":             {},
	"CLIENT_ERROR":              {},
	"UPSTREAM_TOAST_IMPRESSION": {},
	"UPSTREAM_TOAST_DISMISSED":  {},
	"UPSTREAM_TOAST_VIEW_PLAN":  {},
	"UPSTREAM_UPDATE_APPLIED":   {},
}

func buildPageURL(owner, repo, docPath string) string {
	slug := docPath
	if strings.HasSuffix(strings.ToLower(slug), ".mdx") {
		slug = slug[:len(slug)-4]
	} else if strings.HasSuffix(strings.ToLower(slug), ".md") {
		slug = slug[:len(slug)-3]
	}
	lowerSlug := strings.ToLower(slug)
	if lowerSlug == "readme" {
		slug = ""
	} else if strings.HasSuffix(lowerSlug, "/readme") {
		slug = slug[:len(slug)-7]
	}
	base := fmt.Sprintf("/docs/%s/%s", owner, repo)
	if slug != "" {
		if !strings.HasPrefix(slug, "/") {
			base += "/" + slug
		} else {
			base += slug
		}
	}
	return strings.ToLower(base)
}

// IncrementRepoViews atomically increments repository views by 1.
// If repoID does not exist, operation gracefully succeeds (fire-and-forget contract).
func (s *PgxStore) IncrementRepoViews(ctx context.Context, repoID string) error {
	if s == nil || s.pool == nil {
		return nil
	}
	return db.New(s.pool).IncrementRepoViews(ctx, repoID)
}

// UpdatePinnedRepos updates user pinnedRepoIds array atomically.
func (s *PgxStore) UpdatePinnedRepos(ctx context.Context, userID, repoID string, isPinned bool) ([]string, error) {
	if s == nil || s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	qtx := s.getQueries().WithTx(tx)
	currentPins, err := qtx.GetUserPinnedReposForUpdate(ctx, userID)
	if err != nil {
		return nil, err
	}

	newPins := make([]string, 0, len(currentPins)+1)
	seen := make(map[string]struct{}, len(currentPins)+1)
	for _, p := range currentPins {
		if !isPinned && p == repoID {
			continue
		}
		if _, exists := seen[p]; !exists {
			seen[p] = struct{}{}
			newPins = append(newPins, p)
		}
	}
	if isPinned {
		if _, exists := seen[repoID]; !exists {
			newPins = append(newPins, repoID)
		}
	}

	if err := qtx.UpdateUserPinnedRepos(ctx, db.UpdateUserPinnedReposParams{
		PinnedRepoIds: newPins,
		ID:            userID,
	}); err != nil {
		return nil, fmt.Errorf("failed to update pinnedRepoIds: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit transaction: %w", err)
	}
	return newPins, nil
}

// GetReadingProgressSync aggregates and computes chapter scores and overall progress for a repository.
// readingProgressCache 阅读进度结果缓存：全量事件回放（≤1 万条）+ 指纹
// 计算每次同步重跑是重度读者热路径；计算体受浮点 golden 契约保护
//（fingerprint/engine.go 头注：禁止为性能重排浮点运算）——本缓存是
// 「同样计算的结果复用」，计算一字不动，契约天然保住。
// 失效：RecordTelemetryEvents（本服务唯一 EpisodicEvent 写入方，market
// 事件被读取谓词排除）；文档变更与 90 天窗口滚动由 TTL 兜底。
var readingProgressCache = cachestore.New[*ReadingProgressSyncResult](1024, 60*time.Second, nil)

func (s *PgxStore) GetReadingProgressSync(ctx context.Context, userID, owner, repo string, edition *string) (*ReadingProgressSyncResult, error) {
	if userID == "" {
		return &ReadingProgressSyncResult{
			ChapterScores:   map[string]float64{},
			OverallProgress: 0,
			ViewedCount:     0,
		}, nil
	}

	q := s.getQueries()

	// 1. Locate repository
	var repoID, realOwner, realRepo string
	var err error
	if edition != nil && *edition != "" {
		rRow, rErr := q.GetRepoForReadingProgressWithEdition(ctx, db.GetRepoForReadingProgressWithEditionParams{
			Lower:   owner,
			Lower_2: repo,
			Edition: *edition,
		})
		if rErr == nil {
			repoID, realOwner, realRepo = rRow.ID, rRow.Owner, rRow.Repo
		}
		err = rErr
	} else {
		rRow, rErr := q.GetRepoForReadingProgress(ctx, db.GetRepoForReadingProgressParams{
			Lower:   owner,
			Lower_2: repo,
		})
		if rErr == nil {
			repoID, realOwner, realRepo = rRow.ID, rRow.Owner, rRow.Repo
		}
		err = rErr
	}

	if errors.Is(err, pgx.ErrNoRows) {
		return &ReadingProgressSyncResult{
			ChapterScores:   map[string]float64{},
			OverallProgress: 0,
			ViewedCount:     0,
		}, nil
	} else if err != nil {
		return nil, fmt.Errorf("failed to query repository: %w", err)
	}

	// 结果缓存命中（key=userId:repoId，天然合并 edition 别名）
	if cached, cerr := readingProgressCache.Get(userID + ":" + repoID); cerr == nil && cached != nil {
		return cached, nil
	}

	// 2. Fetch documents
	docRows, err := q.GetRepoDocumentsForProgress(ctx, repoID)
	if err != nil {
		return nil, fmt.Errorf("failed to query documents: %w", err)
	}

	var chapters []fingerprint.FingerprintChapterMeta
	for _, dr := range docRows {
		chapters = append(chapters, fingerprint.FingerprintChapterMeta{
			Path:           dr.Path,
			WordCount:      500,
			CodeBlockCount: 2,
			HeadingCount:   3,
			PageURL:        buildPageURL(realOwner, realRepo, dr.Path),
		})
	}

	if len(chapters) == 0 {
		return &ReadingProgressSyncResult{
			ChapterScores:   map[string]float64{},
			OverallProgress: 0,
			ViewedCount:     0,
		}, nil
	}

	// 3. Query last read path
	var lastReadPath *string
	var lastReadAtStr *string
	progRow, err := q.GetUserReadingProgressByRepo(ctx, db.GetUserReadingProgressByRepoParams{
		UserId:       userID,
		RepositoryId: repoID,
	})
	if err == nil {
		if progRow.LastReadPath.Valid {
			s := progRow.LastReadPath.String
			lastReadPath = &s
		}
		if progRow.UpdatedAt.Valid {
			str := progRow.UpdatedAt.Time.Format(time.RFC3339)
			lastReadAtStr = &str
		}
	}

	// 4. Fetch episodic events (last 90 days, up to 10,000 events) via composite index lookup
	ninetyDaysAgo := time.Now().Add(-90 * 24 * time.Hour)
	eventRows, err := q.GetEpisodicEventsForUserRepo(ctx, db.GetEpisodicEventsForUserRepoParams{
		UserId:       userID,
		RepositoryId: pgtype.Text{String: repoID, Valid: true},
		CreatedAt:    pgtype.Timestamp{Time: ninetyDaysAgo, Valid: true},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to query episodic events: %w", err)
	}

	var rawEvents []fingerprint.FingerprintRawEvent
	for _, er := range eventRows {
		pURL := er.PageUrl
		lowerPURL := strings.ToLower(pURL)
		if strings.HasPrefix(lowerPURL, "/docs/personal/") {
			pURL = "/docs/" + pURL[len("/docs/personal/"):]
		}
		var durFloat *float64
		if er.Duration.Valid {
			f := float64(er.Duration.Int32)
			durFloat = &f
		}
		var metaMap map[string]any
		if len(er.Metadata) > 0 {
			_ = json.Unmarshal(er.Metadata, &metaMap)
		}
		rawEvents = append(rawEvents, fingerprint.FingerprintRawEvent{
			EventType: er.EventType,
			PageURL:   pURL,
			Duration:  durFloat,
			Metadata:  metaMap,
		})
	}

	// 5. Compute reading fingerprint directly in Go memory
	fp := fingerprint.ComputeFingerprint(chapters, rawEvents, nil)

	chapterScores := make(map[string]float64, len(fp.ChapterScores))
	for _, cs := range fp.ChapterScores {
		chapterScores[cs.Path] = cs.Score
	}

	result := &ReadingProgressSyncResult{
		ChapterScores:   chapterScores,
		OverallProgress: fp.OverallProgress,
		ViewedCount:     fp.EffectivelyRead,
		LastReadPath:    lastReadPath,
		LastReadAt:      lastReadAtStr,
	}
	readingProgressCache.Put(userID+":"+repoID, result)
	return result, nil
}

// RecordTelemetryEvents batch-inserts valid telemetry events into "EpisodicEvent" with repository attribution.
func (s *PgxStore) RecordTelemetryEvents(ctx context.Context, userID string, events []TelemetryEventInput) (int, error) {
	if len(events) == 0 || userID == "" {
		return 0, nil
	}

	// 1. Cap to max 50 events and filter by allowed types
	const maxBatch = 50
	if len(events) > maxBatch {
		events = events[:maxBatch]
	}

	var validEvents []TelemetryEventInput
	for _, ev := range events {
		if ev.EventType == "" {
			continue
		}
		if _, ok := allowedTelemetryEventTypes[ev.EventType]; ok {
			validEvents = append(validEvents, ev)
		}
	}
	if len(validEvents) == 0 {
		return 0, nil
	}

	// 2. Resolve missing repository IDs from pageUrl (or targetId if pageUrl is not a doc url)
	needLookup := make(map[string]struct{})
	for _, ev := range validEvents {
		if ev.RepositoryID == nil || *ev.RepositoryID == "" {
			urlToInspect := ev.PageURL
			if !strings.HasPrefix(urlToInspect, "/docs/") && ev.TargetID != nil && strings.HasPrefix(*ev.TargetID, "/docs/") {
				urlToInspect = *ev.TargetID
			}
			m := telemetryRepoRegex.FindStringSubmatch(urlToInspect)
			if len(m) >= 3 {
				ref := fmt.Sprintf("%s/%s", strings.ToLower(m[1]), strings.ToLower(m[2]))
				needLookup[ref] = struct{}{}
			}
		}
	}

	idMap := make(map[string]string, len(needLookup))
	if len(needLookup) > 0 {
		owners := make([]string, 0, len(needLookup))
		for ref := range needLookup {
			parts := strings.Split(ref, "/")
			owners = append(owners, parts[0])
		}
		rows, err := db.New(s.pool).GetRepoIDsByOwnerList(ctx, owners)
		if err == nil {
			for _, r := range rows {
				idMap[fmt.Sprintf("%s/%s", r.Owner, r.Repo)] = r.ID
			}
		}
	}

	// 3. Batch insert using sqlc InsertEpisodicEvent
	params := make([]db.InsertEpisodicEventParams, 0, len(validEvents))
	for _, ev := range validEvents {
		id := uuid.New().String()
		repoID := ev.RepositoryID
		if repoID == nil || *repoID == "" {
			urlToInspect := ev.PageURL
			if !strings.HasPrefix(urlToInspect, "/docs/") && ev.TargetID != nil && strings.HasPrefix(*ev.TargetID, "/docs/") {
				urlToInspect = *ev.TargetID
			}
			m := telemetryRepoRegex.FindStringSubmatch(urlToInspect)
			if len(m) >= 3 {
				ref := fmt.Sprintf("%s/%s", strings.ToLower(m[1]), strings.ToLower(m[2]))
				if foundID, ok := idMap[ref]; ok {
					repoID = &foundID
				}
			}
		}

		pageURL := ev.PageURL
		if (!strings.HasPrefix(pageURL, "/docs/") || pageURL == "/") && ev.TargetID != nil && strings.HasPrefix(*ev.TargetID, "/docs/") {
			pageURL = *ev.TargetID
		} else if pageURL == "" {
			pageURL = "unknown"
		}

		var metaJSON []byte
		if ev.Metadata != nil {
			metaJSON, _ = json.Marshal(ev.Metadata)
		}

		var targetIDText pgtype.Text
		if ev.TargetID != nil {
			targetIDText = pgtype.Text{String: *ev.TargetID, Valid: true}
		}
		var durInt pgtype.Int4
		if ev.Duration != nil {
			durInt = pgtype.Int4{Int32: int32(*ev.Duration), Valid: true}
		}
		var repoIDText pgtype.Text
		if repoID != nil {
			repoIDText = pgtype.Text{String: *repoID, Valid: true}
		}

		params = append(params, db.InsertEpisodicEventParams{
			ID:           id,
			UserId:       userID,
			PageUrl:      pageURL,
			EventType:    ev.EventType,
			TargetId:     targetIDText,
			Duration:     durInt,
			Metadata:     metaJSON,
			RepositoryId: repoIDText,
		})
	}

	q := db.New(s.pool)
	// 批量单语句写入（一次往返替代 ≤50 次串行往返）；整语句失败时回退
	// 逐行重放，保留「单行失败只丢单行」的容错计数语义。
	ids := make([]string, len(params))
	pageURLs := make([]string, len(params))
	eventTypes := make([]string, len(params))
	targetIDs := make([]string, len(params))
	durations := make([]string, len(params))
	metas := make([][]byte, len(params))
	repoIDs := make([]string, len(params))
	for i, p := range params {
		ids[i] = p.ID
		pageURLs[i] = p.PageUrl
		eventTypes[i] = p.EventType
		if p.TargetId.Valid {
			targetIDs[i] = p.TargetId.String
		}
		if p.Duration.Valid {
			durations[i] = strconv.FormatInt(int64(p.Duration.Int32), 10)
		}
		metas[i] = p.Metadata
		if p.RepositoryId.Valid {
			repoIDs[i] = p.RepositoryId.String
		}
	}
	invalidateProgressCache := func() {
		for _, rid := range repoIDs {
			if rid != "" {
				readingProgressCache.Invalidate(userID + ":" + rid)
			}
		}
	}
	if err := q.InsertEpisodicEvents(ctx, db.InsertEpisodicEventsParams{
		UserID: userID, Ids: ids, PageUrls: pageURLs, EventTypes: eventTypes,
		TargetIds: targetIDs, Durations: durations, Metas: metas, RepositoryIds: repoIDs,
	}); err == nil {
		invalidateProgressCache()
		return len(params), nil
	}

	insertedCount := 0
	for _, p := range params {
		if err := q.InsertEpisodicEvent(ctx, p); err == nil {
			insertedCount++
		}
	}
	if insertedCount > 0 {
		invalidateProgressCache()
	}

	return insertedCount, nil
}

// GetUserPreferences queries user profile preferences and saved shelf repository transcription progress.
func (s *PgxStore) GetUserPreferences(ctx context.Context, userID string) (*UserPreferencesResult, error) {
	if userID == "" {
		return &UserPreferencesResult{
			HasPreferencesSet:  false,
			FontSize:           "small",
			DisabledMcpRepoIds: []string{},
			SavedRepositories:  []SavedRepositoryOverview{},
		}, nil
	}

	q := s.getQueries()
	userRow, err := q.GetUserPreferences(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return &UserPreferencesResult{
			HasPreferencesSet:  false,
			FontSize:           "small",
			DisabledMcpRepoIds: []string{},
			SavedRepositories:  []SavedRepositoryOverview{},
		}, nil
	} else if err != nil {
		return nil, fmt.Errorf("failed to query user preferences: %w", err)
	}

	var lang1, lang2, lang3, industry, primaryLang, secondaryLang *string
	if userRow.PreferredLang1.Valid {
		s := userRow.PreferredLang1.String
		lang1 = &s
	}
	if userRow.PreferredLang2.Valid {
		s := userRow.PreferredLang2.String
		lang2 = &s
	}
	if userRow.PreferredLang3.Valid {
		s := userRow.PreferredLang3.String
		lang3 = &s
	}
	if userRow.Industry.Valid {
		s := userRow.Industry.String
		industry = &s
	}
	if userRow.PrimaryProgLang.Valid {
		s := userRow.PrimaryProgLang.String
		primaryLang = &s
	}
	if userRow.SecondaryProgLang.Valid {
		s := userRow.SecondaryProgLang.String
		secondaryLang = &s
	}
	activeFontSize := "small"
	if userRow.FontSize != "" {
		activeFontSize = userRow.FontSize
	}
	disabledMcpRepoIds := userRow.DisabledMcpRepoIds
	if disabledMcpRepoIds == nil {
		disabledMcpRepoIds = []string{}
	}

	// 2. Query saved repos with document processing progress
	savedRows, err := q.GetSavedRepositoriesOverview(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to query saved repositories overview: %w", err)
	}

	savedRepositories := make([]SavedRepositoryOverview, 0, len(savedRows))
	for _, sr := range savedRows {
		progress := 0
		if sr.TotalDocs > 0 {
			progress = int(math.Round(float64(sr.ProcessedDocs) / float64(sr.TotalDocs) * 100))
		}
		savedRepositories = append(savedRepositories, SavedRepositoryOverview{
			ID:            sr.ID,
			Owner:         sr.Owner,
			Repo:          sr.Repo,
			McpStatus:     sr.McpStatus,
			TotalDocs:     int(sr.TotalDocs),
			ProcessedDocs: int(sr.ProcessedDocs),
			IsProcessed:   sr.TotalDocs > 0 && sr.ProcessedDocs == sr.TotalDocs,
			Progress:      progress,
		})
	}

	return &UserPreferencesResult{
		HasPreferencesSet:  userRow.HasPreferencesSet,
		PreferredLang1:     lang1,
		PreferredLang2:     lang2,
		PreferredLang3:     lang3,
		Industry:           industry,
		PrimaryProgLang:    primaryLang,
		SecondaryProgLang:  secondaryLang,
		FontSize:           activeFontSize,
		DisabledMcpRepoIds: disabledMcpRepoIds,
		SavedRepositories:  savedRepositories,
	}, nil
}

// GetUsageSummary returns the quota limits and usage aggregated for a user.
func (s *PgxStore) GetUsageSummary(ctx context.Context, userID string) (*UsageSummaryResult, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	q := s.getQueries()

	// 1. Query User tier, role, dailyMcpQuota
	userRow, err := q.GetUserUsageSummary(ctx, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("failed to query user for usage summary: %w", err)
	}

	// 2. Count savedRepos in SavedRepo table
	reposUsed, err := q.CountUserSavedRepos(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to count saved repos: %w", err)
	}

	// 3. Query McpUsageLedger for today's calls
	day := time.Now().UTC().Format("2006-01-02")
	mcpCallsToday, err := q.GetUserMcpCallsToday(ctx, db.GetUserMcpCallsTodayParams{
		UserId: userID,
		Day:    day,
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("failed to query mcp usage ledger: %w", err)
	}

	// 4. Query TokenUsageLog for past 30 days
	since30d := time.Now().UTC().AddDate(0, 0, -30)
	tokens30d, err := q.GetUserTokens30d(ctx, db.GetUserTokens30dParams{
		UserId:    userID,
		CreatedAt: pgtype.Timestamp{Time: since30d, Valid: true},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to aggregate 30d tokens: %w", err)
	}

	// 5. Tier limits and Admin computation
	isAdmin := userRow.Role == "ADMIN" || userRow.Role == "SUPER_ADMIN"
	defaultDailyMcpCalls := 100
	switch userRow.Tier {
	case "PRO":
		defaultDailyMcpCalls = 3000
	case "ENTERPRISE":
		defaultDailyMcpCalls = 0
	default:
		defaultDailyMcpCalls = 100
	}

	dailyMcpCalls := defaultDailyMcpCalls
	// 显式值 >0 才生效（对齐 mcp.resolveDailyMcpQuota 装载口径）：
	// !=0 旧写法会把负数配额原样上报，且与 limiter 的 0=无限语义漂移。
	if userRow.DailyMcpQuota > 0 {
		dailyMcpCalls = int(userRow.DailyMcpQuota)
	}

	return &UsageSummaryResult{
		Tier:          userRow.Tier,
		IsAdmin:       isAdmin,
		ReposUsed:     int(reposUsed),
		MaxRepos:      0,
		McpCallsToday: int(mcpCallsToday),
		DailyMcpCalls: dailyMcpCalls,
		Tokens30d:     tokens30d,
	}, nil
}

// SetUserPreferences atomically updates user import preferences and returns the updated user record.
func (s *PgxStore) SetUserPreferences(ctx context.Context, input UserPreferencesSetInput) (*UserPreferencesRecord, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}
	if input.UserID == "" {
		return nil, errors.New("userId cannot be empty")
	}

	fontSize := "small"
	if input.FontSize != nil && *input.FontSize != "" {
		fontSize = *input.FontSize
	}

	disabledRepos := input.DisabledMcpRepoIds
	if disabledRepos == nil {
		disabledRepos = []string{}
	}

	q := s.getQueries()

	var p1, p2, p3, ind, prog1, prog2 pgtype.Text
	if input.PreferredLang1 != nil {
		p1 = pgtype.Text{String: *input.PreferredLang1, Valid: true}
	}
	if input.PreferredLang2 != nil {
		p2 = pgtype.Text{String: *input.PreferredLang2, Valid: true}
	}
	if input.PreferredLang3 != nil {
		p3 = pgtype.Text{String: *input.PreferredLang3, Valid: true}
	}
	if input.Industry != nil {
		ind = pgtype.Text{String: *input.Industry, Valid: true}
	}
	if input.PrimaryProgLang != nil {
		prog1 = pgtype.Text{String: *input.PrimaryProgLang, Valid: true}
	}
	if input.SecondaryProgLang != nil {
		prog2 = pgtype.Text{String: *input.SecondaryProgLang, Valid: true}
	}

	row, err := q.SetUserPreferences(ctx, db.SetUserPreferencesParams{
		ID:                 input.UserID,
		PreferredLang1:     p1,
		PreferredLang2:     p2,
		PreferredLang3:     p3,
		Industry:           ind,
		PrimaryProgLang:    prog1,
		SecondaryProgLang:  prog2,
		FontSize:           fontSize,
		DisabledMcpRepoIds: disabledRepos,
		Column10:           input.HasDisabledRepos,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to set user preferences: %w", err)
	}

	var name, email, image *string
	if row.Name.Valid {
		s := row.Name.String
		name = &s
	}
	if row.Email.Valid {
		s := row.Email.String
		email = &s
	}
	if row.Image.Valid {
		s := row.Image.String
		image = &s
	}
	roleStr := row.Role

	var l1, l2, l3, rInd, pp1, pp2 *string
	if row.PreferredLang1.Valid {
		s := row.PreferredLang1.String
		l1 = &s
	}
	if row.PreferredLang2.Valid {
		s := row.PreferredLang2.String
		l2 = &s
	}
	if row.PreferredLang3.Valid {
		s := row.PreferredLang3.String
		l3 = &s
	}
	if row.Industry.Valid {
		s := row.Industry.String
		rInd = &s
	}
	if row.PrimaryProgLang.Valid {
		s := row.PrimaryProgLang.String
		pp1 = &s
	}
	if row.SecondaryProgLang.Valid {
		s := row.SecondaryProgLang.String
		pp2 = &s
	}

	outDisabled := row.DisabledMcpRepoIds
	if outDisabled == nil {
		outDisabled = []string{}
	}

	return &UserPreferencesRecord{
		ID:                 row.ID,
		Name:               name,
		Email:              email,
		Image:              image,
		Role:               roleStr,
		Tier:               row.Tier,
		PreferredLang1:     l1,
		PreferredLang2:     l2,
		PreferredLang3:     l3,
		Industry:           rInd,
		PrimaryProgLang:    pp1,
		SecondaryProgLang:  pp2,
		FontSize:           row.FontSize,
		HasPreferencesSet:  row.HasPreferencesSet,
		DisabledMcpRepoIds: outDisabled,
	}, nil
}

// UnsaveRepo removes a repository from user's saved shelf.
func (s *PgxStore) UnsaveRepo(ctx context.Context, userID, repositoryID string) error {
	if s == nil || s.pool == nil {
		return fmt.Errorf("database pool is not initialized")
	}
	if userID == "" || repositoryID == "" {
		return errors.New("userId and repositoryId cannot be empty")
	}

	q := s.getQueries()
	_, err := q.UnsaveRepo(ctx, db.UnsaveRepoParams{
		UserId:       userID,
		RepositoryId: repositoryID,
	})
	if err != nil {
		return fmt.Errorf("failed to unsave repository: %w", err)
	}
	return nil
}

// SetSavedRepoFollow updates autoFollow setting for a saved repository.
func (s *PgxStore) SetSavedRepoFollow(ctx context.Context, userID, repositoryID string, autoFollow bool) (bool, error) {
	if s == nil || s.pool == nil {
		return false, fmt.Errorf("database pool is not initialized")
	}
	if userID == "" || repositoryID == "" {
		return false, errors.New("userId and repositoryId cannot be empty")
	}

	q := s.getQueries()
	n, err := q.SetSavedRepoFollow(ctx, db.SetSavedRepoFollowParams{
		UserId:       userID,
		RepositoryId: repositoryID,
		AutoFollow:   autoFollow,
	})
	if err != nil {
		return false, fmt.Errorf("failed to update saved repo follow: %w", err)
	}
	return n > 0, nil
}
