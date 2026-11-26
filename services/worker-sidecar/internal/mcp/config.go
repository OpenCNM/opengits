package mcp

import (
	"crypto/sha256"
	"crypto/subtle"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Addr string

	DatabaseURL string

	UpstreamURL string

	InternalToken string

	UpstreamSkipHeader string

	// Default PoolMax=16 stays under PG max_connections=100 while preventing queuing bottlenecks at c=32.
	PoolMax int

	ProxyTimeoutMs int

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
