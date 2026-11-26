-- Token 安全收敛：明文不再落库（明文仅在创建响应中返回一次，hash 鉴权）
ALTER TABLE "McpApiToken" DROP COLUMN "plainToken";
