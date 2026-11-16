-- 网关安全中心（Gateway Security Center）数据层：
-- 1) GatewayPolicyConfig 单行策略表（紧急只读熔断 / Web 全局 RPM / 扫描器与空 UA 开关），
--    admin 热配置，client 网关与任务层经 lib/gateway/policy 读取器（TTL 微缓存）消费；
-- 2) GatewayBlockedIp IP 黑名单（proxy.ts 全站 API 生效）；
-- 3) GatewaySecurityEvent 拦截事件流水（admin「网关拦截流水」真实数据源，保留期清理）。
CREATE TABLE "GatewayPolicyConfig" (
    "id" TEXT NOT NULL,
    "emergencyReadOnly" BOOLEAN NOT NULL DEFAULT false,
    "webApiRpm" INTEGER NOT NULL DEFAULT 120,
    "scannerBlockEnabled" BOOLEAN NOT NULL DEFAULT true,
    "blockEmptyUserAgent" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayPolicyConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GatewayBlockedIp" (
    "ipAddress" TEXT NOT NULL,
    "reason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GatewayBlockedIp_pkey" PRIMARY KEY ("ipAddress")
);

CREATE TABLE "GatewaySecurityEvent" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ipAddress" TEXT,
    "path" TEXT NOT NULL,
    "userAgent" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GatewaySecurityEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GatewaySecurityEvent_createdAt_idx" ON "GatewaySecurityEvent"("createdAt");
CREATE INDEX "GatewaySecurityEvent_kind_createdAt_idx" ON "GatewaySecurityEvent"("kind", "createdAt");
