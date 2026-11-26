package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

type ImportRewardAPI interface {
	GrantImportReward(context.Context, string) error
}

type settlementDB interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type settleCreditsDefaults struct {
	defaultDailyCredits   int
	resetIntervalHours    int
	maxCreditsPerImport   int
	codePedagogyMulti     float64
	standardChunkCharSize int
	publishGiftEnabled    bool
}

var creditsConfigDefaults = settleCreditsDefaults{
	defaultDailyCredits:   1000,
	resetIntervalHours:    24,
	maxCreditsPerImport:   300,
	codePedagogyMulti:     2.0,
	standardChunkCharSize: 1500,
	publishGiftEnabled:    false,
}

type dynamicCreditsConfig struct{ settleCreditsDefaults }

type tierLimitRow struct {
	dailyImportCredits     int
	maxImportCreditsPerJob int
}

var tierLimitsRegistry = map[string]tierLimitRow{
	"FREE":       {dailyImportCredits: 1000, maxImportCreditsPerJob: 300},
	"PRO":        {dailyImportCredits: 3000, maxImportCreditsPerJob: 600},
	"ENTERPRISE": {dailyImportCredits: 0, maxImportCreditsPerJob: 0},
}

func tierLimitsOf(tier string) tierLimitRow {
	if row, ok := tierLimitsRegistry[tier]; ok {
		return row
	}
	return tierLimitsRegistry["FREE"]
}

func isAdminRole(role string) bool {
	return role == "ADMIN" || role == "SUPER_ADMIN"
}

func (s *PgxStore) loadCreditsConfig(ctx context.Context) dynamicCreditsConfig {
	cfg := dynamicCreditsConfig{creditsConfigDefaults}
	var (
		defaultDaily    *int
		resetHours      *int
		maxPerImport    *int
		pedagogyMulti   *float64
		chunkCharSize   *int
		publishGiftFlag *bool
	)
	row, err := db.New(s.pool).LoadCreditsConfig(ctx)
	if err == nil {
		{
			v := int(row.DefaultDailyCredits)
			defaultDaily = &v
		}
		{
			v := int(row.ResetIntervalHours)
			resetHours = &v
		}
		{
			v := int(row.MaxCreditsPerImport)
			maxPerImport = &v
		}
		{
			v := row.CodePedagogyMultiplier
			pedagogyMulti = &v
		}
		{
			v := int(row.StandardChunkCharSize)
			chunkCharSize = &v
		}
		{
			v := row.PublishGiftEnabled
			publishGiftFlag = &v
		}
	}
	if err != nil {
		return cfg
	}
	if defaultDaily != nil {
		cfg.defaultDailyCredits = *defaultDaily
	}
	if resetHours != nil && *resetHours > 0 {
		cfg.resetIntervalHours = *resetHours
	}
	if maxPerImport != nil && *maxPerImport > 0 {
		cfg.maxCreditsPerImport = *maxPerImport
	}
	if pedagogyMulti != nil {
		cfg.codePedagogyMulti = *pedagogyMulti
	}
	if chunkCharSize != nil {
		cfg.standardChunkCharSize = *chunkCharSize
	}
	if publishGiftFlag != nil {
		cfg.publishGiftEnabled = *publishGiftFlag
	}
	return cfg
}

func estimateRequiredCredits(totalChars, docCount int, isPublic, isCodePedagogy bool, cfg dynamicCreditsConfig) (estimatedChunks, baseCredits, finalCredits, rewardCredits int) {
	if docCount < 1 {
		docCount = 1
	}
	if totalChars < 0 {
		totalChars = 0
	}
	chunkSize := cfg.standardChunkCharSize
	if chunkSize == 0 {
		chunkSize = 1500
	}
	charBasedChunks := int(math.Ceil(float64(totalChars) / float64(chunkSize)))
	estimatedChunks = docCount
	if charBasedChunks > estimatedChunks {
		estimatedChunks = charBasedChunks
	}
	multiplier := 1.0
	if isCodePedagogy {
		multiplier = cfg.codePedagogyMulti
	}
	baseCredits = int(math.Ceil(float64(estimatedChunks) * multiplier))

	finalCredits = 0

	rewardLimit := cfg.maxCreditsPerImport
	if isPublic {
		rewardCredits = baseCredits
		if rewardCredits > rewardLimit {
			rewardCredits = rewardLimit
		}
	} else {
		rewardCredits = 0
	}
	return
}

func isCodePedagogyBilling(teachingDepth, ingestMode string) bool {
	return (teachingDepth != "" && teachingDepth != "overview") || ingestMode == "code_only"
}

type settleEnvelope struct {
	Kind    string         `json:"kind"`
	UserId  string         `json:"userId"`
	Options map[string]any `json:"options"`
}

func envelopeProfileStr(env settleEnvelope, key string) string {
	if env.Options == nil {
		return ""
	}
	profile, _ := env.Options["repoProfile"].(map[string]any)
	if profile == nil {
		return ""
	}
	s, _ := profile[key].(string)
	return s
}

// Compute window bounds in UTC to match Prisma timestamp without time zone.
func resetWindowStart(now time.Time, intervalHours int) time.Time {
	safeHours := intervalHours
	if safeHours < 1 {
		safeHours = 24
	}
	interval := time.Duration(safeHours) * time.Hour
	startMs := now.UTC().UnixMilli() / interval.Milliseconds() * interval.Milliseconds()
	return time.UnixMilli(startMs).UTC()
}

// Default to 1 rather than 0 when unset so missing env config does not zero out rewards.
func dailyEarnCapRatio() float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv("UPDATE_EARN_CAP_RATIO")), 64)
	if err != nil {
		return 1
	}
	if v < 0 {
		return 0
	}
	return v
}

type ImportSettleResult struct {
	RepositoryId         string `json:"repoId,omitempty"`
	QueuedDocumentsCount int    `json:"queuedDocumentsCount,omitempty"`
	GitSha               string `json:"gitSha,omitempty"`
}

func (s *PgxStore) SettleImportJob(ctx context.Context, jobId string, result ImportSettleResult) error {
	var (
		userId string
		status string
		params []byte
	)
	row, err := db.New(s.pool).GetSettleJob(ctx, jobId)
	if err == nil {
		userId = row.UserId
		status = row.Status
		params = []byte(row.Params)
	}
	if err != nil {
		return fmt.Errorf("settle load job: %w", err)
	}
	if status != "RUNNING" {
		return nil
	}
	var env settleEnvelope
	_ = json.Unmarshal(params, &env)

	cfg := s.loadCreditsConfig(ctx)
	actualProcessedDocs := result.QueuedDocumentsCount
	optionsForBilling := env.Options
	isPublic := false
	if optionsForBilling != nil {
		isPublic, _ = optionsForBilling["isPublic"].(bool)
	}
	teachingDepth := ""
	if v, ok := optionsForBilling["teachingDepth"].(string); ok {
		teachingDepth = v
	}

	var actualCredits, rewardCredits int
	if env.Kind == "web-sync" && actualProcessedDocs == 0 {
		actualCredits, rewardCredits = 0, 0
	} else {
		_, _, actualCredits, rewardCredits = estimateRequiredCredits(
			actualProcessedDocs*cfg.standardChunkCharSize, actualProcessedDocs,
			isPublic, isCodePedagogyBilling(teachingDepth, envelopeProfileStr(env, "ingestMode")), cfg)
	}

	settledCredits := actualCredits
	var tier, role string
	hasUser := userId != ""
	if hasUser {
		urow, _ := db.New(s.pool).GetUserTierRole(ctx, userId)
		tier = urow.Tier
		role = urow.Role
		if !isAdminRole(role) && tier != "ENTERPRISE" {
			limits := tierLimitsOf(tier)
			cap := limits.maxImportCreditsPerJob
			if cap == 0 {
				cap = cfg.maxCreditsPerImport
			}
			if cap > 0 && settledCredits > cap {
				settledCredits = cap
			}
		}
	}

	rewardEligible := isPublic && rewardCredits > 0 && actualProcessedDocs > 0 && hasUser
	grantedReward := 0

	txErr := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if rewardEligible {
			urow, err := db.New(tx).GetUserTierRoleForUpdate(ctx, userId)
			if err != nil {
				return fmt.Errorf("reward lock+load: %w", err)
			}
			rTier := urow.Tier
			rRole := urow.Role
			if isAdminRole(rRole) || rTier == "ENTERPRISE" {
				grantedReward = rewardCredits
			} else {
				perJobCeiling := cfg.maxCreditsPerImport
				if perJobCeiling > rewardCredits {
					perJobCeiling = rewardCredits
				}
				claimed := perJobCeiling
				if claimed > rewardCredits {
					claimed = rewardCredits
				}
				g, err := s.capDailyTranscriptionRewardTx(ctx, tx, userId, claimed, rTier, cfg)
				if err != nil {
					return err
				}
				grantedReward = g
			}
		}

		resultJSON, _ := json.Marshal(map[string]any{
			"repositoryId":         nullIfEmpty(result.RepositoryId),
			"queuedDocumentsCount": result.QueuedDocumentsCount,
			"gitSha":               nullIfEmpty(result.GitSha),
			"actualCredits":        settledCredits,
			"rewardCredits":        grantedReward,
			"importRewardPending":  rewardEligible && grantedReward > 0,
		})
		affected, err := db.New(tx).CompleteImportJob(ctx, db.CompleteImportJobParams{
			Column1: resultJSON,
			ID:      jobId,
		})
		if err != nil {
			return fmt.Errorf("settle complete: %w", err)
		}
		if affected != 1 {
			return nil
		}

		return nil
	})
	if txErr != nil {
		return fmt.Errorf("settle tx: %w", txErr)
	}

	shelfUserId := env.UserId
	if shelfUserId == "" {
		shelfUserId = userId
	}
	skipBookmark := false
	if env.Options != nil {
		if sb, ok := env.Options["skipBookmark"].(bool); ok {
			skipBookmark = sb
		}
	}
	// Never add personal bookmarks for system service accounts or explicit skipBookmark opt-outs.
	if !skipBookmark && shelfUserId != "" && shelfUserId != "system-batch-transcriber" && result.RepositoryId != "" {
		if err := db.New(s.pool).UpsertSavedRepo(ctx, db.UpsertSavedRepoParams{
			UserId:       shelfUserId,
			RepositoryId: result.RepositoryId,
			PaidCredits:  int32(settledCredits),
		}); err != nil {
			log.Printf("[settle] savedRepo upsert degraded for job %s: %v", jobId, err)
		}
	}

	if isPublic && result.RepositoryId != "" {
		s.grantPublishGift(ctx, result.RepositoryId, cfg)
	}

	if s.importReward != nil && rewardEligible && grantedReward > 0 {
		if err := retryImportReward(ctx, s.pool, s.importReward, jobId); err != nil {
			log.Printf("[settle] import reward callback pending for %s: %v", jobId, err)
		}
	}
	return nil
}

func (s *PgxStore) RetryImportReward(ctx context.Context, jobId string) error {
	return retryImportReward(ctx, s.pool, s.importReward, jobId)
}

func retryImportReward(ctx context.Context, db settlementDB, api ImportRewardAPI, jobId string) error {
	var status string
	if err := db.QueryRow(ctx, `SELECT status FROM "ImportJob" WHERE id = $1`, jobId).Scan(&status); err != nil {
		return fmt.Errorf("settle load status: %w", err)
	}
	if status != "COMPLETED" {
		return nil
	}
	if _, err := db.Exec(ctx, markImportRewardPendingSQL, jobId); err != nil {
		return err
	}
	if api == nil {
		return fmt.Errorf("import reward callback not configured")
	}
	ctx, cancel := context.WithTimeout(ctx, rewardCallbackTimeout)
	defer cancel()
	if err := api.GrantImportReward(ctx, jobId); err != nil {
		return fmt.Errorf("import reward callback: %w", err)
	}
	_, err := db.Exec(ctx, clearImportRewardPendingSQL, jobId)
	return err
}

const rewardCallbackTimeout = 30 * time.Second

const markImportRewardPendingSQL = `
 UPDATE "ImportJob" SET result = jsonb_set(COALESCE(result,'{}'::jsonb), '{importRewardPending}', 'true'::jsonb, true), "updatedAt" = now()
 WHERE id = $1 AND status = 'COMPLETED'`

const clearImportRewardPendingSQL = `
 UPDATE "ImportJob" SET result = jsonb_set(result, '{importRewardPending}', 'false'::jsonb, true), "updatedAt" = now()
 WHERE id = $1 AND status = 'COMPLETED'`

// Query via tx (never s.pool) inside SettleImportJob to avoid pool starvation deadlock; fail closed to +Inf on errors.
func (s *PgxStore) capDailyTranscriptionRewardTx(ctx context.Context, tx pgx.Tx, userId string, reward int, tier string, cfg dynamicCreditsConfig) (int, error) {
	if reward <= 0 {
		return 0, nil
	}
	start := resetWindowStart(time.Now().UTC(), cfg.resetIntervalHours)

	var chapterBase float64
	var err error
	chapterBase, err = db.New(tx).GetChapterBaseCreditsSince(ctx, db.GetChapterBaseCreditsSinceParams{
		ClaimedBy: pgtype.Text{String: userId, Valid: userId != ""},
		UpdatedAt: pgtype.Timestamp{Time: start, Valid: true},
	})
	if err != nil {
		chapterBase = math.Inf(1)
	}
	var ledgerAmount float64
	ledgerAmount, err = db.New(tx).GetLedgerAmountSince(ctx, db.GetLedgerAmountSinceParams{
		UserId:    userId,
		CreatedAt: pgtype.Timestamp{Time: start, Valid: true},
	})
	if err != nil {
		ledgerAmount = math.Inf(1)
	}
	importAmount := 0.0
	importAmount, err = db.New(tx).GetImportAmountSince(ctx, db.GetImportAmountSinceParams{
		UserId:    userId,
		UpdatedAt: pgtype.Timestamp{Time: start, Valid: true},
	})
	if err != nil {
		importAmount = math.Inf(1)
	}
	nonMarket := ledgerAmount
	if importAmount > nonMarket {
		nonMarket = importAmount
	}
	grantedToday := chapterBase + nonMarket

	limits := tierLimitsOf(tier)
	dailyLimit := limits.dailyImportCredits
	if dailyLimit == 0 {
		dailyLimit = cfg.defaultDailyCredits
	}
	cap := math.Floor(float64(dailyLimit) * dailyEarnCapRatio())
	allowance := cap - grantedToday
	if allowance < 0 {
		allowance = 0
	}
	if float64(reward) < allowance {
		allowance = float64(reward)
	}
	return int(allowance), nil
}

func (s *PgxStore) settleCreditBalanceBurn(_ context.Context, _ string) {
}

const creditBalanceBurnSQL = `
		UPDATE "User" SET "creditBalance" = "creditBalance" - $1
		WHERE id = $2 AND "creditBalance" >= $1`

func calculateCreditBalanceBurn(actual, dailyLimit, used, frozen, creditBalance float64) float64 {
	if creditBalance <= 0 || actual <= 0 {
		return 0
	}
	headroom := dailyLimit - (used - actual) - frozen
	if headroom < 0 {
		headroom = 0
	}
	overflow := actual - headroom
	if overflow <= 0 {
		return 0
	}
	burn := overflow
	if burn > creditBalance {
		burn = creditBalance
	}
	return burn
}

func (s *PgxStore) grantPublishGift(ctx context.Context, repositoryId string, cfg dynamicCreditsConfig) {
	if !cfg.publishGiftEnabled {
		return
	}
	var isPublic bool
	var publishGiftAt *time.Time
	var owner, repo, branch, edition string
	repoRow, err := db.New(s.pool).GetRepoForPublishGift(ctx, repositoryId)
	if err == nil {
		isPublic = repoRow.IsPublic
		if repoRow.PublishGiftAt.Valid {
			t := repoRow.PublishGiftAt.Time
			publishGiftAt = &t
		}
		owner = repoRow.Owner
		repo = repoRow.Repo
		branch = repoRow.Branch
		edition = repoRow.Edition
	}
	if err != nil || !isPublic || publishGiftAt != nil {
		return
	}
	var recipient string
	recipient, err = db.New(s.pool).GetRecipientForPublishGift(ctx, repositoryId)
	if err != nil {
		return
	}

	amount, err := db.New(s.pool).GetPublishGiftAmount(ctx, db.GetPublishGiftAmountParams{
		UserId:  recipient,
		Owner:   owner,
		Repo:    repo,
		Branch:  branch,
		Edition: edition,
	})
	if err != nil {
		return
	}
	if amount <= 0 {
		return
	}
	amountInt := int(amount)

	txErr := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		affected, err := db.New(tx).MarkRepoPublishGiftAt(ctx, repositoryId)
		if err != nil {
			return err
		}
		if affected == 0 {
			return errNoop
		}
		if err := db.New(tx).AddUserCreditBalance(ctx, db.AddUserCreditBalanceParams{
			CreditBalance: int32(amountInt),
			ID:            recipient,
		}); err != nil {
			return err
		}
		if err := db.New(tx).InsertCreditGrantLedgerPublishGift(ctx, db.InsertCreditGrantLedgerPublishGiftParams{
			UserId:       recipient,
			Amount:       int32(amountInt),
			RepositoryId: pgtype.Text{String: repositoryId, Valid: repositoryId != ""},
		}); err != nil {
			return err
		}
		payload, _ := json.Marshal(map[string]any{"owner": owner, "repo": repo, "amount": amountInt})
		return db.New(tx).InsertNotificationPublishGift(ctx, db.InsertNotificationPublishGiftParams{
			UserID:  recipient,
			Title:   fmt.Sprintf("%s/%s 已加入公共库", owner, repo),
			Body:    pgtype.Text{String: fmt.Sprintf("教程已公开上线，导入消耗的 %d 积分已全额返还", amountInt), Valid: true},
			Payload: payload,
		})
	})
	if txErr != nil && txErr != errNoop {
		log.Printf("[settle] publish gift degraded for repo %s: %v", repositoryId, txErr)
	}
}

var errNoop = errors.New("noop")

func nullIfEmpty(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}
