-- 退役拆除：JIT/客户端队列首译发酬开关（发酬体系已全面退役，恒 false 无行为消费方）
ALTER TABLE "PlatformCreditsConfig" DROP COLUMN "jitTranscriptionEarnEnabled";
