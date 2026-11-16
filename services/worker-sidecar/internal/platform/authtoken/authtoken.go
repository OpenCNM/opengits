// Package authtoken 内部令牌契约 SSOT（镜像 apps/client/src/lib/internal-auth.ts）。
package authtoken

// InsecureDefaultToken docker-compose.yml 的 INTERNAL_API_TOKEN 默认值——
// 生产部署必须覆盖；与 Node 侧 INSECURE_DEFAULT_TOKEN 逐字一致。
const InsecureDefaultToken = "dev-internal-token-change-me"

// IsProductionEnv 环境判定：APP_ENV（回退 NODE_ENV）为 production 即生产。
func IsProductionEnv(appEnv string) bool {
	return appEnv == "production"
}

// RefuseInsecureDefault 生产环境携带 compose 默认令牌时必须拒绝
// （对齐 Node internal-auth：production + 默认令牌 → 403 internal endpoint disabled）。
func RefuseInsecureDefault(internalToken, appEnv string) bool {
	return IsProductionEnv(appEnv) && internalToken == InsecureDefaultToken
}
