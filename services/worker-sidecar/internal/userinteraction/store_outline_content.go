package userinteraction

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/platform/db"
	"github.com/opengits/worker-sidecar/internal/platform/outlineloader"
)

// OutlineNodeView represents a single outline leaf pointing to a document.
type OutlineNodeView struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	NodeType    string  `json:"nodeType"`
	HeadingPath *string `json:"headingPath"`
	DocumentID  *string `json:"documentId"`
	DocPath     *string `json:"docPath"`
	DocStatus   *string `json:"docStatus"`
}

// OutlineChapterView represents a pedagogical unit (chapter).
type OutlineChapterView struct {
	ID            string            `json:"id"`
	Title         string            `json:"title"`
	Summary       *string           `json:"summary"`
	ChapterType   string            `json:"chapterType"`
	ModuleName    *string           `json:"moduleName"`
	TeachingOrder int               `json:"teachingOrder"`
	Nodes         []OutlineNodeView `json:"nodes"`
}

// OutlinePartView represents a top-level grouping part.
type OutlinePartView struct {
	ID            string               `json:"id"`
	Title         string               `json:"title"`
	Summary       *string              `json:"summary"`
	TeachingOrder int                  `json:"teachingOrder"`
	Chapters      []OutlineChapterView `json:"chapters"`
}

// ActiveOutlineView represents the active outline view contract.
type ActiveOutlineView struct {
	OutlineID string               `json:"outlineId"`
	Version   int                  `json:"version"`
	Mode      string               `json:"mode"`
	Parts     []OutlinePartView    `json:"parts"`
	Chapters  []OutlineChapterView `json:"chapters"`
}

// DocumentStatusResult contains document processing progress and step details.
type DocumentStatusResult struct {
	Found        bool           `json:"found"`
	Status       string         `json:"status"`
	ErrorMessage *string        `json:"errorMessage"`
	Progress     int            `json:"progress"`
	Step         string         `json:"step"`
	ProgressInfo map[string]any `json:"progressInfo"`
}

// IngestStatusRepo contains the minimal repository fields needed for ingest status.
type IngestStatusRepo struct {
	ID                         string          `json:"id"`
	Owner                      string          `json:"owner"`
	Repo                       string          `json:"repo"`
	Branch                     string          `json:"branch"`
	Edition                    string          `json:"edition"`
	IsPublic                   bool            `json:"isPublic"`
	OwnerUserID                *string         `json:"ownerUserId"`
	TranscriptionPaused        bool            `json:"transcriptionPaused"`
	ReviewStatus               string          `json:"reviewStatus"`
	PublishedAt                *time.Time      `json:"publishedAt"`
	TranscriptionCreditsEarned int             `json:"transcriptionCreditsEarned"`
	TranscriptionTokens        int             `json:"transcriptionTokens"`
	RepoProfile                json.RawMessage `json:"repoProfile"`
	NavTree                    json.RawMessage `json:"navTree"`
}

// IngestStatusTJ contains transcription job progress counters.
type IngestStatusTJ struct {
	Status        string     `json:"status"`
	SavedChunks   int        `json:"savedChunks"`
	TotalChunks   *int       `json:"totalChunks"`
	// QueuePosition 全局排队位置（1 起，仅 QUEUED 且仓未暂停时有值）：按认领同款
	// 有效优先级（priority + 等待分钟数）排序得出，供前端展示「前面还有几个任务」。
	QueuePosition *int       `json:"queuePosition,omitempty"`
	ClaimedAt     *time.Time `json:"claimedAt,omitempty"`
	CreatedAt     *time.Time `json:"createdAt,omitempty"`
	StartedAtMs   *int64     `json:"startedAtMs,omitempty"`
}

// IngestStatusDoc contains document-level status and transcription job.
type IngestStatusDoc struct {
	ID               string          `json:"id"`
	Path             string          `json:"path"`
	Title            *string         `json:"title"`
	Status           string          `json:"status"`
	ErrorMessage     *string         `json:"errorMessage"`
	TranscriptionJob *IngestStatusTJ `json:"transcriptionJob"`
}

// IngestStatusResult contains the aggregated repository ingest status.
type IngestStatusResult struct {
	Found            bool              `json:"found"`
	Forbidden        bool              `json:"forbidden"`
	Repository       *IngestStatusRepo `json:"repository"`
	Documents        []IngestStatusDoc `json:"documents"`
	PublishRequested bool              `json:"publishRequested"`
	// AvgJobSeconds 最近 DONE 任务的平均执行耗时（秒）；无历史为 nil（ETA 计算的
	// 输入事实，由 Node 侧换算为 etaSeconds 后不再透传前端）。
	AvgJobSeconds *float64 `json:"avgJobSeconds,omitempty"`
}

// FeaturedRepo represents a public featured repository for search recommendations.
type FeaturedRepo struct {
	ID    string `json:"id"`
	Owner string `json:"owner"`
	Repo  string `json:"repo"`
}

// PauseRepoResult contains the result of toggling repository transcription pause state.
type PauseRepoResult struct {
	Found     bool `json:"found"`
	Forbidden bool `json:"forbidden"`
	Paused    bool `json:"paused"`
}

// DocumentContentResult represents the retrieved document and its resolved content.
type DocumentContentResult struct {
	Found   bool   `json:"found"`
	ID      string `json:"id"`
	Path    string `json:"path"`
	Title   string `json:"title"`
	Status  string `json:"status"`
	Content string `json:"content"`
}

// GetActiveOutline loads active TutorialOutline with parts, chapters, and nodes joined with Document.
func (s *PgxStore) GetActiveOutline(ctx context.Context, repoID string) (*ActiveOutlineView, error) {
	if s == nil || s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	tree, err := outlineloader.LoadActiveOutlineTree(ctx, s.pool, repoID)
	if err != nil {
		return nil, fmt.Errorf("failed to query active outline: %w", err)
	}
	if tree == nil {
		return nil, nil
	}

	parts := make([]OutlinePartView, len(tree.Parts))
	for i, p := range tree.Parts {
		chaps := make([]OutlineChapterView, len(p.Chapters))
		for j, c := range p.Chapters {
			nds := make([]OutlineNodeView, len(c.Nodes))
			for k, n := range c.Nodes {
				nds[k] = OutlineNodeView{
					ID:          n.ID,
					Title:       n.Title,
					NodeType:    n.NodeType,
					HeadingPath: n.HeadingPath,
					DocumentID:  n.DocumentID,
					DocPath:     n.DocPath,
					DocStatus:   n.DocStatus,
				}
			}
			chaps[j] = OutlineChapterView{
				ID:            c.ID,
				Title:         c.Title,
				Summary:       c.Summary,
				ChapterType:   c.ChapterType,
				ModuleName:    c.ModuleName,
				TeachingOrder: c.TeachingOrder,
				Nodes:         nds,
			}
		}
		parts[i] = OutlinePartView{
			ID:            p.ID,
			Title:         p.Title,
			Summary:       p.Summary,
			TeachingOrder: p.TeachingOrder,
			Chapters:      chaps,
		}
	}

	topChapters := make([]OutlineChapterView, len(tree.TopLevelChapters))
	for j, c := range tree.TopLevelChapters {
		nds := make([]OutlineNodeView, len(c.Nodes))
		for k, n := range c.Nodes {
			nds[k] = OutlineNodeView{
				ID:          n.ID,
				Title:       n.Title,
				NodeType:    n.NodeType,
				HeadingPath: n.HeadingPath,
				DocumentID:  n.DocumentID,
				DocPath:     n.DocPath,
				DocStatus:   n.DocStatus,
			}
		}
		topChapters[j] = OutlineChapterView{
			ID:            c.ID,
			Title:         c.Title,
			Summary:       c.Summary,
			ChapterType:   c.ChapterType,
			ModuleName:    c.ModuleName,
			TeachingOrder: c.TeachingOrder,
			Nodes:         nds,
		}
	}

	return &ActiveOutlineView{
		OutlineID: tree.OutlineID,
		Version:   tree.Version,
		Mode:      tree.Mode,
		Parts:     parts,
		Chapters:  topChapters,
	}, nil
}

// ToggleHelpfulVote toggles user helpful vote for repository in an atomic transaction.
func (s *PgxStore) ToggleHelpfulVote(ctx context.Context, repoID, userID string) (voted bool, helpfulCount int, err error) {
	if s == nil || s.pool == nil {
		return false, 0, fmt.Errorf("database pool is not initialized")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, 0, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	txQueries := db.New(tx)

	_, err = txQueries.GetRepositoryHelpfulCount(ctx, repoID)
	if err != nil {
		return false, 0, err
	}

	existingID, voteErr := txQueries.GetHelpfulVote(ctx, db.GetHelpfulVoteParams{
		RepositoryId: repoID,
		UserId:       userID,
	})

	if voteErr == nil {
		// Already voted -> Remove vote & decrement
		if err := txQueries.DeleteHelpfulVote(ctx, existingID); err != nil {
			return false, 0, fmt.Errorf("failed to delete helpful vote: %w", err)
		}

		newCount, err := txQueries.DecrementRepositoryHelpfulCount(ctx, repoID)
		if err != nil {
			return false, 0, fmt.Errorf("failed to decrement helpfulCount: %w", err)
		}

		if err := tx.Commit(ctx); err != nil {
			return false, 0, err
		}
		return false, int(newCount), nil
	} else if errors.Is(voteErr, pgx.ErrNoRows) {
		// Not voted -> Add vote & increment
		newVoteID := uuid.NewString()
		if err := txQueries.InsertHelpfulVote(ctx, db.InsertHelpfulVoteParams{
			ID:           newVoteID,
			RepositoryId: repoID,
			UserId:       userID,
			CreatedAt:    pgtype.Timestamp{Time: time.Now(), Valid: true},
		}); err != nil {
			return false, 0, fmt.Errorf("failed to insert helpful vote: %w", err)
		}

		newCount, err := txQueries.IncrementRepositoryHelpfulCount(ctx, repoID)
		if err != nil {
			return false, 0, fmt.Errorf("failed to increment helpfulCount: %w", err)
		}

		if err := tx.Commit(ctx); err != nil {
			return false, 0, err
		}
		return true, int(newCount), nil
	}

	return false, 0, voteErr
}

// GetDocumentStatus returns current document transcription progress and step details.
func (s *PgxStore) GetDocumentStatus(ctx context.Context, docID string) (*DocumentStatusResult, error) {
	if s == nil || s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	row, err := db.New(s.pool).GetDocumentStatusWithJob(ctx, docID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &DocumentStatusResult{Found: false}, nil
		}
		return nil, fmt.Errorf("failed to query document status: %w", err)
	}

	status := string(row.Status)
	var errMsg *string
	if row.ErrorMessage.Valid {
		errMsg = &row.ErrorMessage.String
	}
	optionsRaw := row.Options

	progress := 0
	step := ""
	var progressInfo map[string]any

	switch status {
	case "PROCESSED":
		progress = 100
		step = "编纂完成"
	case "ERROR":
		progress = 100
		if errMsg != nil && *errMsg != "" {
			// rune 截断：按字节切会把中文错误切成非法 UTF-8（JSON 编码成 U+FFFD）
			msg := []rune(*errMsg)
			if len(msg) > 100 {
				msg = msg[:100]
			}
			step = "编纂失败: " + string(msg)
		} else {
			step = "编纂失败"
		}
	case "PROCESSING":
		if len(optionsRaw) > 0 {
			var opts struct {
				ProgressInfo map[string]any `json:"progressInfo"`
			}
			if err := json.Unmarshal(optionsRaw, &opts); err == nil && opts.ProgressInfo != nil {
				if p, ok := opts.ProgressInfo["progress"].(float64); ok {
					progress = int(p)
				}
				if st, ok := opts.ProgressInfo["step"].(string); ok {
					step = st
				}
				progressInfo = opts.ProgressInfo
			}
		}
		if step == "" {
			progress = 50
			step = "正在转录中…"
			progressInfo = map[string]any{
				"progress": progress,
				"step":     step,
			}
		}
	default:
		// UNPROCESSED
		progress = 5
		step = "排队等待编纂..."
	}

	return &DocumentStatusResult{
		Found:        true,
		Status:       status,
		ErrorMessage: errMsg,
		Progress:     progress,
		Step:         step,
		ProgressInfo: progressInfo,
	}, nil
}

// GetIngestStatus queries repository, documents with transcription progress, and latest import job state.
func (s *PgxStore) GetIngestStatus(ctx context.Context, owner, repo, branch string, edition *string, userID *string) (*IngestStatusResult, error) {
	if s == nil || s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	edVal := ""
	if edition != nil {
		edVal = *edition
	}

	q := db.New(s.pool)

	// 1. Query Repository
	repoRow, err := q.GetRepositoryForIngestStatus(ctx, db.GetRepositoryForIngestStatusParams{
		Owner:   owner,
		Repo:    repo,
		Branch:  branch,
		Edition: edVal,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &IngestStatusResult{Found: false}, nil
		}
		return nil, fmt.Errorf("failed to query repository for ingest status: %w", err)
	}

	var ownerUserID *string
	if repoRow.OwnerUserId.Valid {
		ownerUserID = &repoRow.OwnerUserId.String
	}
	var publishedAt *time.Time
	if repoRow.PublishedAt.Valid {
		publishedAt = &repoRow.PublishedAt.Time
	}

	r := IngestStatusRepo{
		ID:                         repoRow.ID,
		Owner:                      repoRow.Owner,
		Repo:                       repoRow.Repo,
		Branch:                     repoRow.Branch,
		Edition:                    repoRow.Edition,
		IsPublic:                   repoRow.IsPublic,
		OwnerUserID:                ownerUserID,
		TranscriptionPaused:        repoRow.TranscriptionPaused,
		ReviewStatus:               repoRow.ReviewStatus,
		PublishedAt:                publishedAt,
		TranscriptionCreditsEarned: int(repoRow.TranscriptionCreditsEarned),
		TranscriptionTokens:        int(repoRow.TranscriptionTokens),
		RepoProfile:                repoRow.RepoProfile,
		NavTree:                    repoRow.NavTree,
	}

	// 2. Permission check:
	// Public repository -> allow.
	// Private repository:
	// - Anonymous -> forbidden.
	// - Authenticated -> check SavedRepo.
	if !r.IsPublic {
		if userID == nil || *userID == "" {
			return &IngestStatusResult{Found: true, Forbidden: true}, nil
		}
		if r.OwnerUserID == nil || *r.OwnerUserID != *userID {
			_, err := q.CheckSavedRepoAccess(ctx, db.CheckSavedRepoAccessParams{
				RepositoryId: r.ID,
				UserId:       *userID,
			})
			if err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return &IngestStatusResult{Found: true, Forbidden: true}, nil
				}
				return nil, fmt.Errorf("failed to check saved repo access: %w", err)
			}
		}
	}

	// 3. Query Documents with TranscriptionJob
	var uidText pgtype.Text
	if userID != nil && *userID != "" {
		uidText = pgtype.Text{String: *userID, Valid: true}
	}

	docRows, err := q.GetDocumentsWithTranscriptionJob(ctx, db.GetDocumentsWithTranscriptionJobParams{
		RepositoryId: r.ID,
		UserId:       uidText,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to query documents for ingest status: %w", err)
	}

	var documents []IngestStatusDoc
	hasActiveJob := false
	for _, row := range docRows {
		var doc IngestStatusDoc
		doc.ID = row.ID
		doc.Path = row.Path
		if row.Title.Valid {
			doc.Title = &row.Title.String
		}
		doc.Status = string(row.Status)
		if row.ErrorMessage.Valid {
			doc.ErrorMessage = &row.ErrorMessage.String
		}

		if row.JobStatus.Valid {
			savedCount := 0
			if len(row.CheckpointChunks) > 0 {
				var chunksMap map[string]any
				if err := json.Unmarshal(row.CheckpointChunks, &chunksMap); err == nil {
					savedCount = len(chunksMap)
				}
			}
			var totalChunks *int
			if row.CheckpointTotal.Valid {
				tot := int(row.CheckpointTotal.Int32)
				totalChunks = &tot
			}
			var claimedAt *time.Time
			var startedAtMs *int64
			if row.JobClaimedAt.Valid {
				t := row.JobClaimedAt.Time
				claimedAt = &t
				ms := t.UnixMilli()
				startedAtMs = &ms
			}
			var createdAt *time.Time
			if row.JobCreatedAt.Valid {
				t := row.JobCreatedAt.Time
				createdAt = &t
				if startedAtMs == nil {
					ms := t.UnixMilli()
					startedAtMs = &ms
				}
			}
			doc.TranscriptionJob = &IngestStatusTJ{
				Status:        row.JobStatus.String,
				SavedChunks:   savedCount,
				TotalChunks:   totalChunks,
				ClaimedAt:     claimedAt,
				CreatedAt:     createdAt,
				StartedAtMs:   startedAtMs,
			}
			// 投影状态：当任务执行中时对外展示 PROCESSING；排队中保持 UNPROCESSED，严防侧边栏状态漂移
			if row.JobStatus.String == "RUNNING" {
				doc.Status = "PROCESSING"
				hasActiveJob = true
			} else if row.JobStatus.String == "QUEUED" {
				doc.Status = "UNPROCESSED"
				hasActiveJob = true
			}
		}

		documents = append(documents, doc)
	}
	if documents == nil {
		documents = []IngestStatusDoc{}
	}

	// 排队透明化：存在在途任务时附带排队快照与平均耗时（空闲仓状态请求不额外查询）
	avgSeconds, positionByDoc, err := s.transcriptionQueueFacts(ctx, q, hasActiveJob)
	if err != nil {
		return nil, err
	}
	if positionByDoc != nil {
		for i := range documents {
			tj := documents[i].TranscriptionJob
			if tj == nil || tj.Status != "QUEUED" {
				continue
			}
			if pos, ok := positionByDoc[documents[i].ID]; ok {
				p := pos
				documents[i].TranscriptionJob.QueuePosition = &p
			}
		}
	}

	// 4. Query latest ImportJob publishRequested (if authenticated)
	publishRequested := false
	if userID != nil && *userID != "" {
		paramsRaw, err := q.GetLatestImportJobParams(ctx, db.GetLatestImportJobParamsParams{
			UserId:  *userID,
			Owner:   owner,
			Repo:    repo,
			Edition: edVal,
		})
		if err == nil && len(paramsRaw) > 0 {
			var p map[string]any
			if err := json.Unmarshal(paramsRaw, &p); err == nil {
				if req, ok := p["publishRequested"].(bool); ok {
					publishRequested = req
				}
			}
		} else if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			// Non-fatal, just continue
		}
	}

	return &IngestStatusResult{
		Found:            true,
		Forbidden:        false,
		Repository:       &r,
		Documents:        documents,
		PublishRequested: publishRequested,
		AvgJobSeconds:    avgSeconds,
	}, nil
}

// transcriptionQueueFacts 拉取排队透明化事实：全局 QUEUED 快照（按认领同款有效优先级
// 排序 → documentId → 1 起排队位置）与最近 DONE 平均耗时。仅在 active=true（本仓存在
// QUEUED/RUNNING 任务）时查询；平均耗时无历史（哨兵 -1）时返回 nil。
func (s *PgxStore) transcriptionQueueFacts(ctx context.Context, q *db.Queries, active bool) (*float64, map[string]int, error) {
	if !active {
		return nil, nil, nil
	}

	avg, err := q.TranscriptionRecentAvgJobSeconds(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to query transcription avg duration: %w", err)
	}
	var avgPtr *float64
	if avg > 0 {
		avgPtr = &avg
	}

	rows, err := q.TranscriptionListActiveQueue(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to query transcription queue snapshot: %w", err)
	}
	positionByDoc := make(map[string]int, len(rows))
	for i, row := range rows {
		positionByDoc[row.DocumentId] = i + 1
	}
	return avgPtr, positionByDoc, nil
}

// GetFeaturedRepos returns public repositories with processed shared documents, sorted by views and starCount.
func (s *PgxStore) GetFeaturedRepos(ctx context.Context, limit int) ([]FeaturedRepo, error) {
	if s == nil || s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}
	if limit <= 0 {
		limit = 6
	}

	rows, err := db.New(s.pool).GetFeaturedRepos(ctx, int32(limit))
	if err != nil {
		return nil, fmt.Errorf("failed to query featured repos: %w", err)
	}

	repos := make([]FeaturedRepo, 0, len(rows))
	for _, r := range rows {
		repos = append(repos, FeaturedRepo{
			ID:    r.ID,
			Owner: r.Owner,
			Repo:  r.Repo,
		})
	}
	return repos, nil
}

// PauseRepo updates repository transcriptionPaused state atomically with access checks.
func (s *PgxStore) PauseRepo(ctx context.Context, owner, repo, branch string, edition *string, userID *string, paused bool) (*PauseRepoResult, error) {
	if s == nil || s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	edVal := ""
	if edition != nil {
		edVal = *edition
	}

	q := db.New(s.pool)

	repoInfo, err := q.GetRepoPauseInfo(ctx, db.GetRepoPauseInfoParams{
		Owner:   owner,
		Repo:    repo,
		Branch:  branch,
		Edition: edVal,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &PauseRepoResult{Found: false}, nil
		}
		return nil, fmt.Errorf("failed to find repository: %w", err)
	}

	if !repoInfo.IsPublic {
		if userID == nil || *userID == "" {
			return &PauseRepoResult{Found: true, Forbidden: true}, nil
		}
		_, err := q.CheckSavedRepoAccess(ctx, db.CheckSavedRepoAccessParams{
			RepositoryId: repoInfo.ID,
			UserId:       *userID,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return &PauseRepoResult{Found: true, Forbidden: true}, nil
			}
			return nil, fmt.Errorf("failed to check saved repo access: %w", err)
		}
	} else if userID == nil || *userID == "" {
		// 公共仓同样要求登录（写操作）：web 路由契约即"匿名由 Go 端统一
		// 拒绝"，旧实现只对私仓查访问、公共仓匿名可暂停任意社区仓。
		return &PauseRepoResult{Found: true, Forbidden: true}, nil
	}

	if err := q.UpdateRepoTranscriptionPaused(ctx, db.UpdateRepoTranscriptionPausedParams{
		TranscriptionPaused: paused,
		ID:                  repoInfo.ID,
	}); err != nil {
		return nil, fmt.Errorf("failed to update transcriptionPaused: %w", err)
	}

	return &PauseRepoResult{
		Found:     true,
		Forbidden: false,
		Paused:    paused,
	}, nil
}

// GetDocumentContent retrieves the highest-priority matching document and resolves its content.
func (s *PgxStore) GetDocumentContent(ctx context.Context, repoID string, candidatePaths []string, userID *string) (*DocumentContentResult, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}
	if len(candidatePaths) == 0 {
		return nil, ErrDocumentNotFound
	}

	var uidText pgtype.Text
	if userID != nil && *userID != "" {
		uidText = pgtype.Text{String: *userID, Valid: true}
	}

	row, err := db.New(s.pool).GetDocumentContentForReading(ctx, db.GetDocumentContentForReadingParams{
		RepositoryId:   repoID,
		CandidatePaths: candidatePaths,
		UserId:         uidText,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrDocumentNotFound
		}
		return nil, fmt.Errorf("failed to query document content: %w", err)
	}

	if row.Content == "" {
		return nil, ErrDocumentContentEmpty
	}

	title := ""
	if row.Title.Valid {
		title = row.Title.String
	}

	return &DocumentContentResult{
		Found:   true,
		ID:      row.ID,
		Path:    row.Path,
		Title:   title,
		Status:  string(row.Status),
		Content: row.Content,
	}, nil
}
