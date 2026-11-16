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

// ─────────────────────────────────────────────────────────────
// ImportJob 成功终态结算 Go 单实现（D组端点5：/api/internal/job/settle 下沉）。
//
// 资金面（行锁/封顶/CAS/四表/publish-gift）自 Node import-job-settle.ts
// 逐字移植为 pgx 直写——原「资金面永不移植」决策随 Zero-Web 终局反转：
// 单写者收口到 Go，事务/锁语义不变。幂等：job 非 RUNNING 直接吞（僵尸/
// 重复结算 CAS 语义不变）。
// ─────────────────────────────────────────────────────────────

// ImportRewardAPI delegates reward eligibility and review callback to Node.
type ImportRewardAPI interface {
	GrantImportReward(context.Context, string) error
}

type settlementDB interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

// settleCreditsDefaults 对齐 credits-config.ts CREDITS_CONFIG（DB 缺省兜底）。
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

// dynamicCreditsConfig 结算所需动态配置（PlatformCreditsConfig singleton 读，
// 缺列/缺行回落默认——与 Node getDynamicCreditsConfig 降级语义一致）。
type dynamicCreditsConfig struct{ settleCreditsDefaults }

// tierLimitRow 配额注册表行（对齐 tier-limits.ts TIER_LIMITS 结算相关列）。
type tierLimitRow struct {
	dailyImportCredits     int // 0 = 不限
	maxImportCreditsPerJob int // 0 = 不限
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

// loadCreditsConfig 读 singleton 行（任意失败回落默认，不阻断结算）。
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
		return cfg // 数据库未就绪优雅降级（对齐 Node catch 分支）
	}
	if defaultDaily != nil {
		cfg.defaultDailyCredits = *defaultDaily
	}
	if resetHours != nil && *resetHours > 0 {
		cfg.resetIntervalHours = *resetHours
	}
	// 0/负数 = 未配置：回落默认 300（与 credits/reward_policy.go 装载语义
	// 单点对齐）。旧实现 0 原样透传，导致 estimate 段当"封顶 0"吞掉全部
	// 奖励、grant 段又当"不限"——同配置两种语义。
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

// estimateRequiredCredits 预估/结算共用计费内核（逐字对齐 credits-config.ts：
// 字符折 Chunk + 篇数保底 + 教学倍率；导入转录全面 0 消耗；公开按篇幅全额奖励，封顶防爆）。
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

	// 导入转录全面 0 消耗
	finalCredits = 0

	// 公开导入按篇幅/字符全额奖励，私有为 0。
	// maxCreditsPerImport 已在装载处保证 >0（未配置回落默认 300）。
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

// isCodePedagogyBilling 判定唯一口径（对齐 import-billing.ts：估算与结算共用）。
func isCodePedagogyBilling(teachingDepth, ingestMode string) bool {
	return (teachingDepth != "" && teachingDepth != "overview") || ingestMode == "code_only"
}

// settleBillingParams 结算参数透传（repoProfile.ingestMode 提取）。
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

// resetWindowStart 对齐 credits-ledger.ts getResetWindowBounds：按间隔整除对齐。
// resetWindowStart 窗口起点（对齐 Prisma timestamp(3) without time zone 的
// UTC 纯字面量语义）。D3-3：time.UnixMilli 默认返回 time.Local——CST 环境
// 下窗口整体漂移 8 小时（配额穿透/重复赠款），此处强制 .UTC()。
func resetWindowStart(now time.Time, intervalHours int) time.Time {
	safeHours := intervalHours
	if safeHours < 1 {
		safeHours = 24
	}
	interval := time.Duration(safeHours) * time.Hour
	startMs := now.UTC().UnixMilli() / interval.Milliseconds() * interval.Milliseconds()
	return time.UnixMilli(startMs).UTC()
}

// dailyEarnCapRatio 对齐 Node 历史默认值（TS 侧配置键已退役，env UPDATE_EARN_CAP_RATIO 同源）。
// 未设置/非法值默认 1（对齐 Node `Number(env ?? 1)`——默认 0 会把普通用户的
// 日封顶清零，结算直发奖励被整体吞掉）；负值钳 0。
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

// ImportSettleResult ingest 结果载荷（对齐原端点 result 契约）。
type ImportSettleResult struct {
	RepositoryId         string `json:"repoId,omitempty"`
	QueuedDocumentsCount int    `json:"queuedDocumentsCount,omitempty"`
	GitSha               string `json:"gitSha,omitempty"`
}

// SettleImportJob ImportJob 成功终态结算（幂等：非 RUNNING 直接成功）。
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
		return nil // 幂等：非 RUNNING 直接成功（CAS 语义不变）
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

	// 单任务封顶（admin/ENTERPRISE 不限）
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
			// D3-5：行锁与读取合并为单条原子语句（原两步加锁多一次网络往返）
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
			return nil // 并发结算输家：零支付退出
		}

		// 奖励全链路收口单一写者：结算事务内严禁直发可用余额或写入 CreditGrantLedger。
		// 所有公开教程奖励发放统一收口至 GrantImportReward 领域服务（走冷静期质押与满期归属模型）。
		return nil
	})
	if txErr != nil {
		return fmt.Errorf("settle tx: %w", txErr)
	}

	// 书架关联：自导入门类默认跟随公共副本同步（失败不阻断结算）。
	// 系统批量服务账号（如 system-batch-transcriber）或显式指定 skipBookmark 时严禁生成个人书架收藏。
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
	if !skipBookmark && shelfUserId != "" && shelfUserId != "system-batch-transcriber" && result.RepositoryId != "" {
		if err := db.New(s.pool).UpsertSavedRepo(ctx, db.UpsertSavedRepoParams{
			UserId:       shelfUserId,
			RepositoryId: result.RepositoryId,
			PaidCredits:  int32(settledCredits),
		}); err != nil {
			log.Printf("[settle] savedRepo upsert degraded for job %s: %v", jobId, err)
		}
	}

	// 结算钩子：余额垫付已正式退役；发布赠送保持 fire-and-forget
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

// RetryImportReward attempts to invoke the node-side import reward callback for a completed job.
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
	// COMPLETED reentry must also remain retryable after a previous acknowledgement.
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

// capDailyTranscriptionRewardTx 日获赠封顶（对齐 reward-cap.ts：双源合流
// 聚合 + 行锁临界区；聚合失败 fail-closed 按 +∞ 处理绝不盲发）。
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
		chapterBase = math.Inf(1) // fail-closed：额度视为耗尽
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
	// D3-1：事务持有中必须走 tx 而非全局池——池满时 tx 等空闲连接、空闲
	// 连接等 tx 提交，形成确定性连接池饥饿死锁（pool starvation deadlock）。
	// 直接通过 PostgreSQL JSONB 聚合提取 rewardCredits，严禁拉取完整 JSON 结果至内存反序列化。
	importAmount, err = db.New(tx).GetImportAmountSince(ctx, db.GetImportAmountSinceParams{
		UserId:    userId,
		UpdatedAt: pgtype.Timestamp{Time: start, Valid: true},
	})
	if err != nil {
		// fail-closed 对齐另两源（+∞ 视为额度耗尽）：置 0 会低估今日已发
		// 放，越过日封顶盲发。注释宣称"聚合失败绝不盲发"，实现补齐口径。
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

// settleCreditBalanceBurn 结算溢出扣减贡献余额（已正式退役保留 no-op，对齐 Fail-Closed 原则；
// 业务已确立"下架不追讨、未到期只撤单"，余额垫付物理清零）。
func (s *PgxStore) settleCreditBalanceBurn(_ context.Context, _ string) {
	// Retired: no-op fail-safe
}

const creditBalanceBurnSQL = `
		UPDATE "User" SET "creditBalance" = "creditBalance" - $1
		WHERE id = $2 AND "creditBalance" >= $1`

// calculateCreditBalanceBurn 计算超出当日配额由余额垫付的数额（受限于用户可用余额）
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

// grantPublishGift 发布赠送（fire-and-forget，对齐 publish-gift.ts：config
// 门控默认退役 + CAS 一次性标记与支付同事务；失败整体可重试）。
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
			return errNoop // 并发输家/已赠过：零支付
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
