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
	doctypes "github.com/opengits/worker-sidecar/internal/doc"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

// ChapterVersionAuthor represents the author profile for a chapter version.
type ChapterVersionAuthor struct {
	Name  *string `json:"name"`
	Image *string `json:"image"`
}

// ChapterVersionItem represents a chapter translation version with social voting stats.
type ChapterVersionItem struct {
	ID             string               `json:"id"`
	AuthorID       string               `json:"authorId"`
	VoteCount      int                  `json:"voteCount"`
	IsCanonical    bool                 `json:"isCanonical"`
	Visibility     string               `json:"visibility"`
	Source         string               `json:"source"`
	CreatedAt      string               `json:"createdAt"`
	ContentID      *string              `json:"contentId"`
	Author         ChapterVersionAuthor `json:"author"`
	HasVoted       bool                 `json:"hasVoted"`
	IsContentValid bool                 `json:"isContentValid"`
	Content        *string              `json:"content,omitempty"`
}

// ChapterVersionVoteResult represents the result of a vote toggle.
type ChapterVersionVoteResult struct {
	Found        bool   `json:"found"`
	Voted        bool   `json:"voted"`
	VoteCount    int    `json:"voteCount"`
	SelfVote     bool   `json:"selfVote"`
	Forbidden    bool   `json:"forbidden"`
	InvalidState bool   `json:"invalidState"`
	DocumentID   string `json:"documentId"`
}

// ChapterVersionCreateInput defines input for creating a chapter version row.
type ChapterVersionCreateInput struct {
	DocumentID   string `json:"documentId"`
	RepositoryID string `json:"repositoryId"`
	AuthorID     string `json:"authorId"`
	ContentID    string `json:"contentId"`
	Source       string `json:"source"`
	Visibility   string `json:"visibility"`
}

// ChapterVersionCreateResult contains the newly created version ID.
type ChapterVersionCreateResult struct {
	VersionID string `json:"versionId"`
}

// ChapterVersionPublishResult represents result of publishing a private version.
type ChapterVersionPublishResult struct {
	Found        bool `json:"found"`
	Forbidden    bool `json:"forbidden"`
	InvalidState bool `json:"invalidState"`
	Base         int  `json:"base"`
}

// ChapterVersionDeleteResult represents result of deleting a private version.
type ChapterVersionDeleteResult struct {
	Found        bool `json:"found"`
	Forbidden    bool `json:"forbidden"`
	InvalidState bool `json:"invalidState"`
}

// ChapterVersionPinInput defines input for a maintainer/admin pinning a version.
// 管理员身份只认 DB 角色（查询内联返回 Role）：旧版信任请求体 isAdmin 布尔，
// 任何持有 internal token 的调用方可直接 OR 掉角色校验，正典可被任意 pin。
type ChapterVersionPinInput struct {
	VersionID string `json:"versionId"`
	UserID    string `json:"userId"`
}

// ChapterVersionPinResult represents result of pinning a version as canonical.
type ChapterVersionPinResult struct {
	Found           bool             `json:"found"`
	Forbidden       bool             `json:"forbidden"`
	Success         bool             `json:"success"`
	Flipped         bool             `json:"flipped"`
	Reason          string           `json:"reason,omitempty"`
	DocumentID      string           `json:"documentId,omitempty"`
	PostSwapPayload *PostSwapPayload `json:"postSwapPayload,omitempty"`
}

// CanonicalPromotionInput represents the single-writer canonical promotion input.
type CanonicalPromotionInput struct {
	DocumentID      string  `json:"documentId"`
	TargetVersionID *string `json:"targetVersionId,omitempty"`
	IsPinOperation  bool    `json:"isPinOperation"`
	OperatorUserID  *string `json:"operatorUserId,omitempty"`
	FlipMargin      int     `json:"flipMargin"`
}

// CanonicalPromotionResult represents the result of canonical promotion arbitration.
type CanonicalPromotionResult struct {
	Flipped            bool             `json:"flipped"`
	CanonicalVersionID *string          `json:"canonicalVersionId,omitempty"`
	PreviousVersionID  *string          `json:"previousVersionId,omitempty"`
	Reason             string           `json:"reason,omitempty"`
	PostSwapPayload    *PostSwapPayload `json:"postSwapPayload,omitempty"`
}

// PostSwapPayload carries information needed for post-swap re-indexing outside the tx lock.
type PostSwapPayload struct {
	RepositoryID string `json:"repositoryId"`
	DocumentID   string `json:"documentId"`
	Path         string `json:"path"`
	ContentID    string `json:"contentId"`
	Content      string `json:"content"`
}

type canonicalVersionCandidate struct {
	ID          string
	VoteCount   int
	IsCanonical bool
	PinnedAt    *time.Time
	ContentID   string
	AuthorID    string
	Visibility  string
}

// ToggleChapterVersionVote atomically toggles a chapter version vote.
func (s *PgxStore) ToggleChapterVersionVote(ctx context.Context, versionID, userID string) (*ChapterVersionVoteResult, error) {
	if s == nil || s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	q := s.getQueries()

	// 1. Fetch version info without locking
	vInfo, err := q.GetChapterVersionForVote(ctx, versionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &ChapterVersionVoteResult{Found: false}, nil
		}
		return nil, fmt.Errorf("failed to fetch chapter version: %w", err)
	}

	// 2. Permission check on repository
	if !vInfo.IsPublic {
		_, err := q.CheckSavedRepoAccess(ctx, db.CheckSavedRepoAccessParams{
			RepositoryId: vInfo.RepoID,
			UserId:       userID,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return &ChapterVersionVoteResult{Found: true, Forbidden: true}, nil
			}
			return nil, fmt.Errorf("failed to check saved repo access: %w", err)
		}
	}

	if vInfo.Visibility != "PUBLIC" {
		return &ChapterVersionVoteResult{Found: true, InvalidState: true}, nil
	}
	if vInfo.AuthorId == userID {
		return &ChapterVersionVoteResult{Found: true, SelfVote: true}, nil
	}

	// 3. Atomically toggle vote
	res, err := q.ToggleChapterVersionVoteAtomic(ctx, db.ToggleChapterVersionVoteAtomicParams{
		VersionId: versionID,
		UserId:    userID,
		VoteId:    uuid.New().String(),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to toggle vote: %w", err)
	}

	return &ChapterVersionVoteResult{
		Found:      true,
		Voted:      res.Voted,
		VoteCount:  int(res.VoteCount),
		DocumentID: vInfo.DocumentId,
	}, nil
}

// ListChapterVersions lists the community competition and author versions for a chapter.
func (s *PgxStore) ListChapterVersions(ctx context.Context, docID string, userID *string) ([]ChapterVersionItem, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	q := s.getQueries()
	var uID pgtype.Text
	if userID != nil {
		uID = pgtype.Text{String: *userID, Valid: true}
	}

	rows, err := q.ListChapterVersions(ctx, db.ListChapterVersionsParams{
		DocumentId: docID,
		UserID:     uID,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to query chapter versions: %w", err)
	}

	items := make([]ChapterVersionItem, 0, len(rows))
	for _, row := range rows {
		var authorName, authorImage *string
		if row.AuthorName.Valid {
			authorName = &row.AuthorName.String
		}
		if row.AuthorImage.Valid {
			authorImage = &row.AuthorImage.String
		}
		var contentStr *string
		if row.IsContentValid && row.Content != "" {
			contentStr = &row.Content
		}
		items = append(items, ChapterVersionItem{
			ID:             row.ID,
			AuthorID:       row.AuthorId,
			VoteCount:      int(row.VoteCount),
			IsCanonical:    row.IsCanonical,
			Visibility:     row.Visibility,
			Source:         row.Source,
			CreatedAt:      row.CreatedAt.Time.UTC().Format(time.RFC3339),
			ContentID:      &row.ContentId,
			Author: ChapterVersionAuthor{
				Name:  authorName,
				Image: authorImage,
			},
			HasVoted:       row.HasVoted,
			IsContentValid: row.IsContentValid,
			Content:        contentStr,
		})
	}

	return items, nil
}

// CreateChapterVersion inserts a new ChapterVersion row (e.g. for RETRANSLATE PRIVATE draft).
func (s *PgxStore) CreateChapterVersion(ctx context.Context, input ChapterVersionCreateInput) (*ChapterVersionCreateResult, error) {
	if s == nil || s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	source := input.Source
	if source == "" {
		source = "RETRANSLATE"
	}
	visibility := input.Visibility
	if visibility == "" {
		visibility = "PRIVATE"
	}

	q := s.getQueries()
	versionID, err := q.CreateChapterVersion(ctx, db.CreateChapterVersionParams{
		DocumentId:   input.DocumentID,
		RepositoryId: input.RepositoryID,
		AuthorId:     input.AuthorID,
		ContentId:    input.ContentID,
		Source:       source,
		Visibility:   visibility,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create chapter version: %w", err)
	}

	return &ChapterVersionCreateResult{VersionID: versionID}, nil
}

// PublishChapterVersion marks a user's private chapter version as PUBLIC.
func (s *PgxStore) PublishChapterVersion(ctx context.Context, versionID, userID string) (*ChapterVersionPublishResult, error) {
	if s == nil || s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	q := s.getQueries()
	info, err := q.GetChapterVersionAuthorVisibility(ctx, versionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &ChapterVersionPublishResult{Found: false}, nil
		}
		return nil, fmt.Errorf("failed to query chapter version: %w", err)
	}

	if info.AuthorId != userID {
		return &ChapterVersionPublishResult{Found: true, Forbidden: true}, nil
	}

	if info.Visibility == "PUBLIC" {
		return &ChapterVersionPublishResult{Found: true, Base: 0}, nil
	}

	// SQL 内联守卫（authorId+visibility）：并发删除/转正后 affected=0，
	// 按无效状态处理而非误发布。
	affected, err := q.PublishChapterVersion(ctx, db.PublishChapterVersionParams{
		ID:       versionID,
		AuthorId: userID,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to publish chapter version: %w", err)
	}
	if affected == 0 {
		return &ChapterVersionPublishResult{Found: true, InvalidState: true}, nil
	}

	return &ChapterVersionPublishResult{Found: true, Base: 0}, nil
}

// DeleteChapterVersion deletes a private draft version owned by the user.
func (s *PgxStore) DeleteChapterVersion(ctx context.Context, versionID, userID string) (*ChapterVersionDeleteResult, error) {
	if s == nil || s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	q := s.getQueries()
	info, err := q.GetChapterVersionAuthorVisibility(ctx, versionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &ChapterVersionDeleteResult{Found: false}, nil
		}
		return nil, fmt.Errorf("failed to query chapter version for deletion: %w", err)
	}

	if info.AuthorId != userID {
		return &ChapterVersionDeleteResult{Found: true, Forbidden: true}, nil
	}

	if info.Visibility != "PRIVATE" {
		return &ChapterVersionDeleteResult{Found: true, InvalidState: true}, nil
	}

	affected, err := q.DeleteChapterVersion(ctx, db.DeleteChapterVersionParams{
		ID:       versionID,
		AuthorId: userID,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to delete chapter version: %w", err)
	}
	if affected == 0 {
		return &ChapterVersionDeleteResult{Found: true, InvalidState: true}, nil
	}

	return &ChapterVersionDeleteResult{Found: true}, nil
}

// PinChapterVersion verifies maintainer/admin permissions and promotes the version as canonical with pinnedAt timestamp.
func (s *PgxStore) PinChapterVersion(ctx context.Context, input ChapterVersionPinInput) (*ChapterVersionPinResult, error) {
	if s == nil || s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	q := s.getQueries()
	info, err := q.GetChapterVersionForPin(ctx, db.GetChapterVersionForPinParams{
		ID:   input.VersionID,
		ID_2: input.UserID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &ChapterVersionPinResult{Found: false}, nil
		}
		return nil, fmt.Errorf("failed to query version for pin: %w", err)
	}

	isMaintainer := info.OwnerUserId.Valid && info.OwnerUserId.String == input.UserID
	// DB 枚举是 SUPER_ADMIN（platform/db/models.go）；全仓其余 6 处角色判断
	// 均用 SUPER_ADMIN，旧版 SUPERADMIN 拼写使超级管理员被误判 Forbidden。
	isAdmin := info.Role.Valid && (info.Role.String == "ADMIN" || info.Role.String == "SUPER_ADMIN")
	if !isMaintainer && !isAdmin {
		return &ChapterVersionPinResult{Found: true, Forbidden: true}, nil
	}

	promoRes, err := s.PromoteCanonicalChapterVersion(ctx, CanonicalPromotionInput{
		DocumentID:      info.DocumentId,
		TargetVersionID: &input.VersionID,
		IsPinOperation:  true,
		OperatorUserID:  &input.UserID,
	})
	if err != nil {
		return nil, err
	}

	return &ChapterVersionPinResult{
		Found:           true,
		Success:         promoRes.Flipped || promoRes.Reason == "ALREADY_CANONICAL",
		Flipped:         promoRes.Flipped,
		Reason:          promoRes.Reason,
		DocumentID:      info.DocumentId,
		PostSwapPayload: promoRes.PostSwapPayload,
	}, nil
}

// PromoteCanonicalChapterVersion evaluates community votes or maintainer pins to promote a winner.
func (s *PgxStore) PromoteCanonicalChapterVersion(ctx context.Context, input CanonicalPromotionInput) (*CanonicalPromotionResult, error) {
	if s == nil || s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	q := s.getQueries().WithTx(tx)

	// 1. Per-document physical advisory lock to serialize concurrent flips
	if err := q.AcquireAdvisoryLockHashtext(ctx, "canonical-doc:"+input.DocumentID); err != nil {
		return nil, fmt.Errorf("failed to acquire advisory lock: %w", err)
	}

	// 2. Fetch fresh document under lock
	doc, err := q.GetDocumentForPromotion(ctx, input.DocumentID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &CanonicalPromotionResult{Flipped: false, Reason: "NOT_FOUND"}, nil
		}
		return nil, fmt.Errorf("failed to fetch document: %w", err)
	}

	// 3. Fetch candidate versions under lock
	var candidates []canonicalVersionCandidate
	if input.IsPinOperation && input.TargetVersionID != nil {
		rows, err := q.GetCandidatesForPin(ctx, db.GetCandidatesForPinParams{
			DocumentId: input.DocumentID,
			ID:         *input.TargetVersionID,
		})
		if err != nil {
			return nil, fmt.Errorf("failed to fetch candidate versions for pin: %w", err)
		}
		for _, r := range rows {
			var pAt *time.Time
			if r.PinnedAt.Valid {
				t := r.PinnedAt.Time
				pAt = &t
			}
			candidates = append(candidates, canonicalVersionCandidate{
				ID:          r.ID,
				VoteCount:   int(r.VoteCount),
				IsCanonical: r.IsCanonical,
				PinnedAt:    pAt,
				ContentID:   r.ContentId,
				AuthorID:    r.AuthorId,
				Visibility:  r.Visibility,
			})
		}
	} else {
		rows, err := q.GetCandidatesForVote(ctx, input.DocumentID)
		if err != nil {
			return nil, fmt.Errorf("failed to fetch candidate versions for vote: %w", err)
		}
		for _, r := range rows {
			var pAt *time.Time
			if r.PinnedAt.Valid {
				t := r.PinnedAt.Time
				pAt = &t
			}
			candidates = append(candidates, canonicalVersionCandidate{
				ID:          r.ID,
				VoteCount:   int(r.VoteCount),
				IsCanonical: r.IsCanonical,
				PinnedAt:    pAt,
				ContentID:   r.ContentId,
				AuthorID:    r.AuthorId,
				Visibility:  r.Visibility,
			})
		}
	}

	if len(candidates) == 0 && !input.IsPinOperation {
		return &CanonicalPromotionResult{Flipped: false, Reason: "NO_CANDIDATE"}, nil
	}

	var incumbent *canonicalVersionCandidate
	for i := range candidates {
		if candidates[i].IsCanonical {
			incumbent = &candidates[i]
			break
		}
	}

	var winner *canonicalVersionCandidate
	var exitReason string

	if input.IsPinOperation {
		if input.TargetVersionID == nil {
			return &CanonicalPromotionResult{Flipped: false, Reason: "NO_CANDIDATE"}, nil
		}
		for i := range candidates {
			if candidates[i].ID == *input.TargetVersionID {
				winner = &candidates[i]
				break
			}
		}
		if winner == nil {
			return &CanonicalPromotionResult{Flipped: false, Reason: "NO_CANDIDATE"}, nil
		}
		if incumbent != nil && incumbent.ID == winner.ID && incumbent.PinnedAt != nil {
			return &CanonicalPromotionResult{
				Flipped:            false,
				CanonicalVersionID: &incumbent.ID,
				Reason:             "ALREADY_CANONICAL",
			}, nil
		}
	} else {
		// Community voting evaluation
		if incumbent != nil && incumbent.PinnedAt != nil {
			return &CanonicalPromotionResult{
				Flipped:            false,
				CanonicalVersionID: &incumbent.ID,
				Reason:             "MAINTAINER_PINNED_IMMUNE",
			}, nil
		}

		flipMargin := input.FlipMargin
		if flipMargin <= 0 {
			flipMargin = 2
		}

		if incumbent != nil {
			for i := range candidates {
				if candidates[i].ID != incumbent.ID && candidates[i].VoteCount >= incumbent.VoteCount+flipMargin {
					winner = &candidates[i]
					break
				}
			}
		} else if len(candidates) > 0 {
			winner = &candidates[0]
		}

		if winner == nil || (incumbent != nil && winner.ID == incumbent.ID) {
			var incID *string
			if incumbent != nil {
				incID = &incumbent.ID
			}
			return &CanonicalPromotionResult{
				Flipped:            false,
				CanonicalVersionID: incID,
				Reason:             "MARGIN_NOT_MET",
			}, nil
		}
	}

	if winner == nil {
		if exitReason == "" {
			exitReason = "NO_CANDIDATE"
		}
		var incID *string
		if incumbent != nil {
			incID = &incumbent.ID
		}
		return &CanonicalPromotionResult{
			Flipped:            false,
			CanonicalVersionID: incID,
			Reason:             exitReason,
		}, nil
	}

	// 4. Fetch content for document pointer update
	contentRow, err := q.GetDocumentContentForPromotion(ctx, winner.ContentID)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch document content: %w", err)
	}
	content := ""
	if contentRow.Content.Valid {
		content = contentRow.Content.String
	}
	var generationModel *string
	if contentRow.GenerationModel.Valid {
		generationModel = &contentRow.GenerationModel.String
	}

	// 5. Atomic state update
	if input.IsPinOperation {
		// Maintainer Pin: reset old canonicals and their pinnedAt
		if err := q.DemoteOldCanonicals(ctx, input.DocumentID); err != nil {
			return nil, fmt.Errorf("failed to demote old canonicals: %w", err)
		}

		if err := q.PinNewCanonical(ctx, winner.ID); err != nil {
			return nil, fmt.Errorf("failed to pin new canonical: %w", err)
		}
	} else {
		// Community Vote Flip: CAS exchange
		if incumbent != nil {
			rowsAffected, err := q.DemoteIncumbent(ctx, incumbent.ID)
			if err != nil {
				return nil, fmt.Errorf("failed to demote incumbent: %w", err)
			}
			if rowsAffected == 0 {
				return &CanonicalPromotionResult{
					Flipped:            false,
					CanonicalVersionID: &incumbent.ID,
					Reason:             "ALREADY_CANONICAL",
				}, nil
			}
		}

		rowsAffected, err := q.PromoteWinner(ctx, winner.ID)
		if err != nil {
			return nil, fmt.Errorf("failed to promote winner: %w", err)
		}
		if rowsAffected == 0 {
			return &CanonicalPromotionResult{
				Flipped: false,
				Reason:  "ALREADY_CANONICAL",
			}, nil
		}
	}

	genModelStr := ""
	if generationModel != nil {
		genModelStr = *generationModel
	}
	// 内容等级为生成时确定性事实：社区译文晋升正典 → 该文档即译文（常量 SSOT
	// 见 internal/doc/types.go，与 Node 侧 GENERATION_LEVEL 注册表同值域）；
	// dualWrite 为构造时注入的部署开关，不在事务路径上读 env
	generationLevel := doctypes.GenerationLevelTranslated
	if err := q.UpdateDocumentPointer(ctx, db.UpdateDocumentPointerParams{
		ContentId:       pgtype.Text{String: winner.ContentID, Valid: true},
		DualWrite:       s.contentDualWrite,
		Content:         content,
		GenerationModel: genModelStr,
		GenerationLevel: generationLevel,
		ID:              input.DocumentID,
	}); err != nil {
		return nil, fmt.Errorf("failed to update document pointer: %w", err)
	}

	// 6. Dual notifications
	if incumbent != nil && incumbent.AuthorID != winner.AuthorID {
		repoPrefix := ""
		if doc.Owner != "" && doc.Repo != "" {
			repoPrefix = fmt.Sprintf("%s/%s ", doc.Owner, doc.Repo)
		}
		payloadBytes, _ := json.Marshal(map[string]string{
			"owner": doc.Owner,
			"repo":  doc.Repo,
			"path":  doc.Path,
		})

		// winner notification (正向荣誉激励)
		_ = q.ChapterVersionInsertNotification(ctx, db.ChapterVersionInsertNotificationParams{
			ID:      uuid.New().String(),
			UserId:  winner.AuthorID,
			Type:    "version_won",
			Title:   repoPrefix + "你的译本成为正典",
			Body:    pgtype.Text{String: doc.Path + " 的译本获得读者认可，已翻为默认版本", Valid: true},
			Payload: payloadBytes,
		})
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit canonical promotion transaction: %w", err)
	}

	var prevID *string
	if incumbent != nil {
		prevID = &incumbent.ID
	}

	return &CanonicalPromotionResult{
		Flipped:            true,
		CanonicalVersionID: &winner.ID,
		PreviousVersionID:  prevID,
		Reason:             "SUCCESS",
		PostSwapPayload: &PostSwapPayload{
			RepositoryID: doc.RepositoryId,
			DocumentID:   doc.ID,
			Path:         doc.Path,
			ContentID:    winner.ContentID,
			Content:      content,
		},
	}, nil
}

