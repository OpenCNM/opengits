// Package main — MCP 控制面 sidecar：接管 /api/mcp 机器协议边缘的
// 鉴权 / 限流配额 / 心跳 presence / ping·notifications 原生应答；
// 工具执行（tools/call、resources/*）透传给 Node mcp 容器（Phase 2a 绞杀者切片）。
// 语义对齐 apps/client/src/lib/mcp/{token-auth,request-guard,rate-limiter,mcp-heartbeat}.ts。
package mcp

import (
	"crypto/sha256"
	"crypto/subtle"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	// Addr 监听地址（compose 内网，Caddy 分流进入）
	Addr string
	// DatabaseURL Postgres 连接串（pgx 池）
	DatabaseURL string
	// UpstreamURL Node mcp 容器基址（透传目标）
	UpstreamURL string
	// InternalToken 内部令牌（透传时的 quota-skip 头签名）
	InternalToken string
	// UpstreamSkipHeader 通知 Node 跳过重复计量的头名（与 request-guard.ts 约定一致）
	UpstreamSkipHeader string
	// PoolMax pgx 连接池上限。历史默认 4 是"仅协议面"时代的小池设定；
	// 自 Go 原生执行 9 工具 + FTS 检索后，每调用在途占用连接数十毫秒，
	// 4 连接成为排队瓶颈（实测 c=32 即饱和）。16 在 PG max_connections=100
	// 预算内（web Prisma 池 + 本池 + 运维连接）。
	PoolMax int
	// ProxyTimeoutMs 透传超时（覆盖 tools/call 长响应）
	ProxyTimeoutMs int
	// WorkerSidecarURL Go worker-sidecar 检索引擎基址（/v1/search/chunks）
	WorkerSidecarURL string
}

func loadConfigFromEnv() Config {
	return Config{
		Addr:               envOr("MCP_SIDECAR_ADDR", ":8081"),
		DatabaseURL:        os.Getenv("DATABASE_URL"),
		UpstreamURL:        envOr("MCP_UPSTREAM_URL", "http://web:3000"),
		InternalToken:      os.Getenv("INTERNAL_API_TOKEN"),
		UpstreamSkipHeader: "x-mcp-quota-checked",
		PoolMax:            envIntOr("MCP_SIDECAR_POOL_MAX", 16),
		ProxyTimeoutMs:     envIntOr("MCP_PROXY_TIMEOUT_MS", 120*1000),
		WorkerSidecarURL:   normalizeWorkerURL(envOr("WORKER_SIDECAR_URL", envOr("WORKER_SIDECAR_ADDR", "http://127.0.0.1:8082"))),
	}
}

// LoadConfigFromEnv 从系统环境变量读取 MCP 服务完整配置。
func LoadConfigFromEnv() Config {
	return loadConfigFromEnv()
}

func normalizeWorkerURL(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "http://127.0.0.1:8082"
	}
	if strings.HasPrefix(s, ":") {
		return "http://127.0.0.1" + s
	}
	if !strings.HasPrefix(s, "http://") && !strings.HasPrefix(s, "https://") {
		return "http://" + s
	}
	return s
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envIntOr(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

// tokenEquals sha256 摘要后常量时间比对（与 api/internal/revalidate 的 tokenEquals 同语义）。
func tokenEquals(provided, expected string) bool {
	if expected == "" || provided == "" {
		return false
	}
	ph := sha256.Sum256([]byte(provided))
	eh := sha256.Sum256([]byte(expected))
	return subtle.ConstantTimeCompare(ph[:], eh[:]) == 1
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hexEncode(h[:])
}
