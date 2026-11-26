package credits

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

type Store interface {
	GetCreditsLedger(ctx context.Context, input CreditsLedgerInput) (*CreditsLedgerResult, error)
	ChargeShelfFeeAndSave(ctx context.Context, input ShelfFeeChargeInput) (*ShelfFeeChargeResult, error)
	GrantImportReward(ctx context.Context, input ImportRewardGrantInput) (*ImportRewardGrantResult, error)
	UnlockDuePendingCredits(ctx context.Context) (*VestingUnlockResult, error)
}

type PgxStore struct {
	pool    *pgxpool.Pool
	queries *db.Queries
}

func NewPgxStore(pool *pgxpool.Pool) *PgxStore {
	var queries *db.Queries
	if pool != nil {
		queries = db.New(pool)
	}
	return &PgxStore{
		pool:    pool,
		queries: queries,
	}
}

func (s *PgxStore) GetCreditsLedger(ctx context.Context, input CreditsLedgerInput) (*CreditsLedgerResult, error) {
	if s == nil || s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	page := input.Page
	if page < 1 {
		page = 1
	}
	pageSize := input.PageSize
	if pageSize < 1 {
		pageSize = 20
	} else if pageSize > 100 {
		pageSize = 100
	}

	targetLimit := page * pageSize
	if targetLimit < 50 {
		targetLimit = 50
	}

	var entries []LedgerEntry

	if s.queries == nil {
		s.queries = db.New(s.pool)
	}
	grants, err := s.queries.GetCreditGrantsByUserID(ctx, db.GetCreditGrantsByUserIDParams{
		UserId: input.UserID,
		Limit:  int32(targetLimit),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to query CreditGrantLedger: %w", err)
	}
	for _, g := range grants {
		var repoID, path *string
		if g.RepositoryId.Valid {
			sVal := g.RepositoryId.String
			repoID = &sVal
		}
		if g.Path.Valid {
			pVal := g.Path.String
			path = &pVal
		}
		var atStr string
		if g.CreatedAt.Valid {
			atStr = g.CreatedAt.Time.UTC().Format(time.RFC3339Nano)
		}
		entries = append(entries, LedgerEntry{
			ID:           "grant-" + g.ID,
			Amount:       int(g.Amount),
			Source:       g.Source,
			RepositoryID: repoID,
			Detail:       path,
			At:           atStr,
		})
	}

	jobStatuses := []string{"TRIAL", "SWAPPED", "REJECTED"}
	jobRows, err := s.queries.ListChapterUpdateJobsByClaimed(ctx, db.ListChapterUpdateJobsByClaimedParams{
		ClaimedBy: pgtype.Text{String: input.UserID, Valid: true},
		Column2:   jobStatuses,
		Limit:     int32(targetLimit),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to query ChapterUpdateJob: %w", err)
	}

	for _, job := range jobRows {
		base := int(job.BaseCredits)
		bonus := 0
		if job.Status == "SWAPPED" && job.ActualCredits.Valid {
			bonus = int(job.ActualCredits.Int32)
		}
		pathCopy := job.Path
		var repoID *string
		if job.RepositoryId != "" {
			repoID = &job.RepositoryId
		}

		if base > 0 {
			entries = append(entries, LedgerEntry{
				ID:           "market-base-" + job.ID,
				Amount:       base,
				Source:       "MARKET_BASE",
				RepositoryID: repoID,
				Detail:       &pathCopy,
				At:           job.UpdatedAt.Time.UTC().Format(time.RFC3339Nano),
			})
		}
		if bonus > 0 {
			entries = append(entries, LedgerEntry{
				ID:           "market-bonus-" + job.ID,
				Amount:       bonus,
				Source:       "MARKET_BONUS",
				RepositoryID: repoID,
				Detail:       &pathCopy,
				At:           job.UpdatedAt.Time.UTC().Format(time.RFC3339Nano),
			})
		}
	}

	importRows, err := s.queries.ListImportJobsByUserId(ctx, db.ListImportJobsByUserIdParams{
		UserId: input.UserID,
		Limit:  int32(targetLimit),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to query ImportJob: %w", err)
	}

	for _, imp := range importRows {
		actual := 0
		if len(imp.Result) > 0 {
			var resMap map[string]any
			if err := json.Unmarshal(imp.Result, &resMap); err == nil {
				if act, ok := resMap["actualCredits"].(float64); ok {
					actual = int(act)
				}
			}
		}

		if actual > 0 {
			var detail *string
			if len(imp.Params) > 0 {
				var pMap map[string]any
				if err := json.Unmarshal(imp.Params, &pMap); err == nil {
					if u, ok := pMap["url"].(string); ok && u != "" {
						detail = &u
					}
				}
			}
			entries = append(entries, LedgerEntry{
				ID:           "import-" + imp.ID,
				Amount:       -actual,
				Source:       "IMPORT",
				RepositoryID: nil,
				Detail:       detail,
				At:           imp.CreatedAt.Time.UTC().Format(time.RFC3339Nano),
			})
		}
	}

	savedRows, err := s.queries.ListPaidSavedReposByUserId(ctx, db.ListPaidSavedReposByUserIdParams{
		UserId: input.UserID,
		Limit:  int32(targetLimit),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to query SavedRepo: %w", err)
	}

	for _, sr := range savedRows {
		repoIDCopy := sr.RepositoryId
		entries = append(entries, LedgerEntry{
			ID:           "shelf-" + sr.ID,
			Amount:       -int(sr.PaidCredits),
			Source:       "SHELF_FEE",
			RepositoryID: &repoIDCopy,
			Detail:       nil,
			At:           sr.CreatedAt.Time.UTC().Format(time.RFC3339Nano),
		})
	}

	userRow, err := s.queries.GetUserBalanceAndSignupGift(ctx, input.UserID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("failed to query User: %w", err)
	}

	creditBalance := 0
	if err == nil {
		creditBalance = int(userRow.CreditBalance)
	}

	if err == nil && userRow.SignupGiftAt.Valid {
		entries = append(entries, LedgerEntry{
			ID:           "signup-gift",
			Amount:       30,
			Source:       "SIGNUP_GIFT",
			RepositoryID: nil,
			Detail:       nil,
			At:           userRow.SignupGiftAt.Time.UTC().Format(time.RFC3339Nano),
		})
	}

	savedReposCount64, err := s.queries.CountSavedReposByUserId(ctx, input.UserID)
	if err != nil {
		return nil, fmt.Errorf("failed to count SavedRepo: %w", err)
	}
	savedReposCount := int(savedReposCount64)

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].At > entries[j].At
	})

	total := len(entries)
	startIdx := (page - 1) * pageSize
	endIdx := page * pageSize

	var pagedEntries []LedgerEntry
	if startIdx < total {
		if endIdx > total {
			endIdx = total
		}
		pagedEntries = entries[startIdx:endIdx]
	} else {
		pagedEntries = []LedgerEntry{}
	}

	repoIDSet := make(map[string]struct{})
	for _, e := range pagedEntries {
		if e.RepositoryID != nil && *e.RepositoryID != "" {
			repoIDSet[*e.RepositoryID] = struct{}{}
		}
	}

	if len(repoIDSet) > 0 {
		repoIDs := make([]string, 0, len(repoIDSet))
		for rid := range repoIDSet {
			repoIDs = append(repoIDs, rid)
		}
		repos, err := s.queries.ListRepositoriesByIds(ctx, repoIDs)
		if err == nil {
			repoMap := make(map[string]string, len(repos))
			for _, r := range repos {
				repoMap[r.ID] = r.Owner + "/" + r.Repo
			}
			for i := range pagedEntries {
				if pagedEntries[i].RepositoryID != nil {
					if label, ok := repoMap[*pagedEntries[i].RepositoryID]; ok {
						pagedEntries[i].RepoLabel = &label
					}
				}
			}
		}
	}

	totalPages := 1
	if total > 0 {
		totalPages = int(math.Ceil(float64(total) / float64(pageSize)))
	}

	return &CreditsLedgerResult{
		Entries: pagedEntries,
		Pagination: PaginationInfo{
			Total:      total,
			Page:       page,
			PageSize:   pageSize,
			TotalPages: totalPages,
		},
		Balance:    creditBalance,
		SavedRepos: savedReposCount,
	}, nil
}

func (s *PgxStore) ChargeShelfFeeAndSave(ctx context.Context, input ShelfFeeChargeInput) (*ShelfFeeChargeResult, error) {
	if s == nil || s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	if s.queries == nil {
		s.queries = db.New(s.pool)
	}

	if input.Fee <= 0 {
		newID := uuid.NewString()
		affected, err := s.queries.UpsertFreeSavedRepo(ctx, db.UpsertFreeSavedRepoParams{
			ID:           newID,
			UserId:       input.UserID,
			RepositoryId: input.RepositoryID,
			AutoFollow:   input.AutoFollow,
		})
		if err != nil {
			return nil, fmt.Errorf("failed to upsert free saved repo: %w", err)
		}

		alreadySaved := affected == 0
		return &ShelfFeeChargeResult{
			OK:           true,
			Fee:          0,
			SignupGift:   0,
			AlreadySaved: alreadySaved,
		}, nil
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	txQueries := s.queries.WithTx(tx)

	_, err = txQueries.GetSavedRepoID(ctx, db.GetSavedRepoIDParams{
		UserId:       input.UserID,
		RepositoryId: input.RepositoryID,
	})
	if err == nil {
		_ = tx.Commit(ctx)
		return &ShelfFeeChargeResult{
			OK:           true,
			Fee:          0,
			SignupGift:   0,
			AlreadySaved: true,
		}, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("failed to check saved repo: %w", err)
	}

	// Lock user row FOR UPDATE before reading balance and deducting to prevent concurrent overspend.
	currentBalance32, err := txQueries.LockUserBalance(ctx, input.UserID)
	if err != nil {
		return nil, fmt.Errorf("failed to lock user row: %w", err)
	}
	currentBalance := int(currentBalance32)

	if currentBalance < input.Fee {
		insufficientCode := "INSUFFICIENT_BALANCE"
		return &ShelfFeeChargeResult{
			OK:           false,
			Code:         &insufficientCode,
			Fee:          input.Fee,
			Balance:      currentBalance,
			SignupGift:   0,
			AlreadySaved: false,
		}, nil
	}

	burnAffected, err := txQueries.DeductUserBalance(ctx, db.DeductUserBalanceParams{
		CreditBalance: int32(input.Fee),
		ID:            input.UserID,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to deduct balance: %w", err)
	}
	if burnAffected == 0 {
		insufficientCode := "INSUFFICIENT_BALANCE"
		return &ShelfFeeChargeResult{
			OK:           false,
			Code:         &insufficientCode,
			Fee:          input.Fee,
			Balance:      currentBalance,
			SignupGift:   0,
			AlreadySaved: false,
		}, nil
	}

	newID := uuid.NewString()
	if err := txQueries.CreatePaidSavedRepo(ctx, db.CreatePaidSavedRepoParams{
		ID:           newID,
		UserId:       input.UserID,
		RepositoryId: input.RepositoryID,
		AutoFollow:   input.AutoFollow,
		PaidCredits:  int32(input.Fee),
	}); err != nil {
		return nil, fmt.Errorf("failed to create paid saved repo: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit shelf fee charge: %w", err)
	}

	return &ShelfFeeChargeResult{
		OK:           true,
		Fee:          input.Fee,
		Balance:      currentBalance - input.Fee,
		SignupGift:   0,
		AlreadySaved: false,
	}, nil
}

func (s *PgxStore) GrantImportReward(ctx context.Context, input ImportRewardGrantInput) (*ImportRewardGrantResult, error) {
	if s == nil || s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	if input.Amount <= 0 {
		return &ImportRewardGrantResult{Granted: true, Amount: 0}, nil
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	if s.queries == nil {
		s.queries = db.New(s.pool)
	}
	txQueries := s.queries.WithTx(tx)

	// Serialize per-repo writers with an advisory xact lock before ledger/pending deduplication checks.
	if err := txQueries.LockImportRewardAdvisory(ctx, input.RepositoryID); err != nil {
		return nil, fmt.Errorf("failed to acquire advisory lock: %w", err)
	}

	repoIDText := pgtype.Text{String: input.RepositoryID, Valid: true}
	_, err = txQueries.CheckImportRewardGranted(ctx, repoIDText)
	if err == nil {
		_ = tx.Commit(ctx)
		return &ImportRewardGrantResult{Granted: false, Amount: 0, Reason: "ALREADY_GRANTED"}, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("failed to check existing import reward: %w", err)
	}

	_, err = txQueries.CheckPendingCreditGrantExists(ctx, input.RepositoryID)
	if err == nil {
		_ = tx.Commit(ctx)
		return &ImportRewardGrantResult{Granted: false, Amount: 0, Reason: "ALREADY_GRANTED"}, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("failed to check existing pending credit grant: %w", err)
	}

	grantedAmount := input.Amount
	// Lock user row FOR UPDATE because daily earn caps are per-user while the advisory lock is per-repo.
	urow, err := txQueries.GetUserTierRoleForUpdate(ctx, input.UserID)
	if err != nil {
		return nil, fmt.Errorf("reward lock+load: %w", err)
	}
	cfg := s.loadRewardPolicyConfig(ctx)
	if !isAdminCreditRole(urow.Role) && urow.Tier != "ENTERPRISE" {
		if cfg.maxCreditsPerImport > 0 && grantedAmount > cfg.maxCreditsPerImport {
			grantedAmount = cfg.maxCreditsPerImport
		}
		grantedAmount, err = s.capDailyImportRewardTx(ctx, tx, input.UserID, grantedAmount, urow.Tier, cfg)
		if err != nil {
			return nil, fmt.Errorf("daily cap: %w", err)
		}
	}
	if grantedAmount <= 0 {
		_ = tx.Commit(ctx)
		return &ImportRewardGrantResult{Granted: false, Amount: 0, Reason: "DAILY_CAP_REACHED"}, nil
	}

	ratio := cfg.initialPublishRewardRatio
	if ratio < 0 {
		ratio = 0
	} else if ratio > 1 {
		ratio = 1
	}
	immediateAmount := int(math.Floor(float64(grantedAmount) * ratio))
	pendingAmount := grantedAmount - immediateAmount
	vestingDays := cfg.contributionVestingDays
	if vestingDays <= 0 {
		vestingDays = 30
	}

	if immediateAmount > 0 {
		if _, err := txQueries.IncrementUserBalance(ctx, db.IncrementUserBalanceParams{
			CreditBalance: int32(immediateAmount),
			ID:            input.UserID,
		}); err != nil {
			return nil, fmt.Errorf("failed to update user credit balance: %w", err)
		}

		ledgerID := uuid.NewString()
		if err := txQueries.InsertCreditGrantLedger(ctx, db.InsertCreditGrantLedgerParams{
			ID:           ledgerID,
			UserId:       input.UserID,
			RepositoryId: repoIDText,
			Source:       "IMPORT_REWARD",
			Amount:       int32(immediateAmount),
		}); err != nil {
			return nil, fmt.Errorf("failed to insert CreditGrantLedger: %w", err)
		}
	}

	if pendingAmount > 0 {
		unlockAt := time.Now().UTC().Add(time.Duration(vestingDays) * 24 * time.Hour)
		pendingID := uuid.NewString()
		if err := txQueries.InsertPendingCreditGrant(ctx, db.InsertPendingCreditGrantParams{
			ID:           pendingID,
			UserId:       input.UserID,
			RepositoryId: input.RepositoryID,
			Amount:       int32(pendingAmount),
			Source:       "IMPORT_CONTRIBUTION",
			UnlockAt:     pgtype.Timestamp{Time: unlockAt, Valid: true},
		}); err != nil {
			return nil, fmt.Errorf("failed to insert PendingCreditGrant: %w", err)
		}
	}

	if _, err := txQueries.UpdateRepoTranscriptionCreditsEarned(ctx, db.UpdateRepoTranscriptionCreditsEarnedParams{
		TranscriptionCreditsEarned: int32(grantedAmount),
		ID:                         input.RepositoryID,
	}); err != nil {
		return nil, fmt.Errorf("failed to update repository credits: %w", err)
	}

	var notifBody string
	if pendingAmount > 0 && immediateAmount > 0 {
		notifBody = fmt.Sprintf("《%s/%s》已通过审核并在公共广场上线，总计获得 %d 积分（%d 积分即时到账，%d 待解冻贡献积分将在 %d 天后解锁）",
			input.Owner, input.Repo, grantedAmount, immediateAmount, pendingAmount, vestingDays)
	} else if pendingAmount > 0 {
		notifBody = fmt.Sprintf("《%s/%s》已通过审核并在公共广场上线，获得 %d 待解冻贡献积分（将在 %d 天后解锁）",
			input.Owner, input.Repo, grantedAmount, vestingDays)
	} else {
		notifBody = fmt.Sprintf("《%s/%s》已通过审核并在公共广场上线，获得 %d 积分",
			input.Owner, input.Repo, grantedAmount)
	}
	payloadBytes, _ := json.Marshal(map[string]any{
		"repoId":          input.RepositoryID,
		"owner":           input.Owner,
		"repo":            input.Repo,
		"amount":          input.Amount,
		"grantedAmount":   grantedAmount,
		"immediateAmount": immediateAmount,
		"pendingAmount":   pendingAmount,
		"vestingDays":     vestingDays,
	})
	notifID := uuid.NewString()
	if err := txQueries.InsertNotification(ctx, db.InsertNotificationParams{
		ID:      notifID,
		UserId:  input.UserID,
		Type:    "tutorial_published",
		Title:   "教程已公开上线",
		Body:    pgtype.Text{String: notifBody, Valid: true},
		Payload: payloadBytes,
	}); err != nil {
		return nil, fmt.Errorf("failed to insert notification: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit import reward grant: %w", err)
	}

	return &ImportRewardGrantResult{
		Granted:         true,
		Amount:          grantedAmount,
		ImmediateAmount: immediateAmount,
		PendingAmount:   pendingAmount,
		VestingDays:     vestingDays,
	}, nil
}

func (s *PgxStore) UnlockDuePendingCredits(ctx context.Context) (*VestingUnlockResult, error) {
	if s == nil || s.pool == nil {
		return nil, fmt.Errorf("database pool is not initialized")
	}

	if s.queries == nil {
		s.queries = db.New(s.pool)
	}

	dueGrants, err := s.queries.ListDuePendingCreditGrants(ctx, 100)
	if err != nil {
		return nil, fmt.Errorf("failed to list due pending credit grants: %w", err)
	}

	if len(dueGrants) == 0 {
		return &VestingUnlockResult{OK: true, UnlockedCount: 0, TotalCredits: 0}, nil
	}

	unlockedCount := 0
	totalCredits := 0

	for _, grant := range dueGrants {
		err := func() error {
			tx, err := s.pool.Begin(ctx)
			if err != nil {
				return err
			}
			defer tx.Rollback(ctx)

			txQueries := s.queries.WithTx(tx)

			rowsUpdated, err := txQueries.UnlockPendingCreditGrant(ctx, grant.ID)
			if err != nil {
				return err
			}
			if rowsUpdated == 0 {
				return nil
			}

			if _, err := txQueries.IncrementUserBalance(ctx, db.IncrementUserBalanceParams{
				CreditBalance: grant.Amount,
				ID:            grant.UserId,
			}); err != nil {
				return err
			}

			ledgerID := uuid.NewString()
			repoIDText := pgtype.Text{String: grant.RepositoryId, Valid: true}
			if err := txQueries.InsertCreditGrantLedger(ctx, db.InsertCreditGrantLedgerParams{
				ID:           ledgerID,
				UserId:       grant.UserId,
				RepositoryId: repoIDText,
				Source:       "IMPORT_REWARD",
				Amount:       grant.Amount,
			}); err != nil {
				return err
			}

			notifID := uuid.NewString()
			notifBody := fmt.Sprintf("教程创作激励已满期解锁：%d 积分已成功划入个人钱包", grant.Amount)
			payloadBytes, _ := json.Marshal(map[string]any{
				"repositoryId": grant.RepositoryId,
				"amount":       grant.Amount,
				"grantId":      grant.ID,
			})
			_ = txQueries.InsertNotification(ctx, db.InsertNotificationParams{
				ID:      notifID,
				UserId:  grant.UserId,
				Type:    "transcription_reward",
				Title:   "创作者激励已解锁入账",
				Body:    pgtype.Text{String: notifBody, Valid: true},
				Payload: payloadBytes,
			})

			if err := tx.Commit(ctx); err != nil {
				return err
			}

			unlockedCount++
			totalCredits += int(grant.Amount)
			return nil
		}()

		if err != nil {
			continue
		}
	}

	return &VestingUnlockResult{
		OK:            true,
		UnlockedCount: unlockedCount,
		TotalCredits:  totalCredits,
	}, nil
}
