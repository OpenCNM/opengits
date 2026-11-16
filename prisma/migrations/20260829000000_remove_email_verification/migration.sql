-- 邮箱验证功能整体下线（登录只保留 GitHub OAuth）：
-- VerificationToken / EmailLog 两表与 User.emailVerified 列已无任何消费方，一并清除。
-- 注意：DocumentChunk.searchVector 为带外 DDL，不属于本 schema 演进，勿在此触碰。
DROP TABLE "EmailLog";
DROP TABLE "VerificationToken";

ALTER TABLE "User" DROP COLUMN "emailVerified";
