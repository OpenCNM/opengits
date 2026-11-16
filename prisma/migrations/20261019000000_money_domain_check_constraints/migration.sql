-- 钱域与状态机的存储层兜底约束（Defense in Depth）。
--
-- 背景：PendingCreditGrant 与 ChapterUpdateJob 由 Node(Prisma) 与 Go(sqlc) 两个独立
-- 写者直写，应用层守卫（Go market/states.go 迁移表、TS 镜像）只约束「守规矩的写者」；
-- DB CHECK 约束所有写者——一次手写 SQL、一次 sidecar bug 不再能写出
-- 「已入账又被取消」「认领中却无租约」的脏行。
--
-- 词汇锁：status CHECK 与 TS 词汇 SSOT / Go SQL 字面量三方对拍
-- （tests/unit/credit-grant-sync.test.ts、chapter-update-lifecycle.test.ts）互为犄角。
--
-- 上线策略：全部 NOT VALID——对存量行不回溯校验（迁移零风险落地），
-- 但对新写入/更新即刻强制。待人工核查存量后可执行：
--   ALTER TABLE ... VALIDATE CONSTRAINT <name>;（逐表推进，验证失败不阻塞读路径）
-- 注意：Prisma schema 无法表达 CHECK（与表达式索引同例），生产以
-- prisma migrate deploy 为权威（docker-entrypoint.sh），db push 不会创建本文件约束。

-- ── PendingCreditGrant（积分解冻台账：钱） ──────────────────────
ALTER TABLE "PendingCreditGrant"
  ADD CONSTRAINT "ck_pendingcreditgrant_status_vocab"
  CHECK ("status" IN ('PENDING', 'UNLOCKED', 'CANCELLED')) NOT VALID;

ALTER TABLE "PendingCreditGrant"
  ADD CONSTRAINT "ck_pendingcreditgrant_amount_positive"
  CHECK ("amount" > 0) NOT VALID;

-- 已解冻必有解锁时间（UNLOCKED 为吸收终态：入账事实不可抹除）
ALTER TABLE "PendingCreditGrant"
  ADD CONSTRAINT "ck_pendingcreditgrant_unlocked_has_ts"
  CHECK ("status" <> 'UNLOCKED' OR "unlockedAt" IS NOT NULL) NOT VALID;

-- 已作废必有作废时间（CANCELLED 非终态：重发布可复活，但作废事实必须留痕）
ALTER TABLE "PendingCreditGrant"
  ADD CONSTRAINT "ck_pendingcreditgrant_cancelled_has_ts"
  CHECK ("status" <> 'CANCELLED' OR "cancelledAt" IS NOT NULL) NOT VALID;

-- 排队中不得携带任何终局时间戳（PENDING 是唯一干净起点/复活点）
ALTER TABLE "PendingCreditGrant"
  ADD CONSTRAINT "ck_pendingcreditgrant_pending_clean"
  CHECK ("status" <> 'PENDING' OR ("unlockedAt" IS NULL AND "cancelledAt" IS NULL)) NOT VALID;

-- ── ChapterUpdateJob（章节更新市场：认领租约完整性） ─────────────
ALTER TABLE "ChapterUpdateJob"
  ADD CONSTRAINT "ck_chapterupdatejob_status_vocab"
  CHECK ("status" IN ('PENDING', 'CLAIMED', 'TRIAL', 'SWAPPED', 'REJECTED', 'FAILED', 'CANCELLED')) NOT VALID;

-- 认领中必有认领人与租约截止（租约是回池清扫 sweep 的物理依据，缺其一即幽灵占用）
ALTER TABLE "ChapterUpdateJob"
  ADD CONSTRAINT "ck_chapterupdatejob_claimed_has_lease"
  CHECK ("status" <> 'CLAIMED' OR ("claimedBy" IS NOT NULL AND "claimedUntil" IS NOT NULL)) NOT VALID;
