-- name: GetPlatformBudgetConfigRow :one
SELECT "perUserDailyTokens", "platformDailyTokens", "breakerEnabled", "sourceQuotas"
FROM "PlatformBudgetConfig" WHERE id = 'singleton';

-- name: SumPlatformTokensSince :one
-- 预算首帧闸聚合（镜像 lib/llm-budget.ts spentTokens）：
-- keyOrigin='platform' 当日（dayStart 由调用方按进程本地时区零点计算传入，
-- 与 TS dayStart setHours 语义逐字对齐）；userId/source 空串 = 不过滤。
SELECT COALESCE(SUM("totalTokens"), 0)::bigint AS spent
FROM "TokenUsageLog"
WHERE "keyOrigin" = 'platform'
  AND "createdAt" >= @day_start::timestamp
  AND (@user_id::text = '' OR "userId" = @user_id::text)
  AND (@source::text = '' OR "source" = @source::text);
