package sse

import (
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
)

var (
	// ErrTooManyPerUser 已登录用户并发长连接超过配额
	ErrTooManyPerUser = errors.New("too many concurrent SSE connections for this user")
	// ErrTooManyPerIP 匿名访客单 IP 并发长连接超过配额
	ErrTooManyPerIP = errors.New("too many concurrent SSE connections from this IP")
	// ErrTooManyGlobal 全站总并发长连接超过硬上限
	ErrTooManyGlobal = errors.New("global SSE connection limit reached")
)

// ConnLimiter 内存级双层并发连接防耗尽管理器
type ConnLimiter struct {
	mu          sync.Mutex
	maxPerUser  int
	maxPerIP    int
	maxGlobal   int
	userConns   map[string]int
	ipConns     map[string]int
	globalCount int64
}

// NewConnLimiter 创建并发长连接限制器
func NewConnLimiter(maxPerUser, maxPerIP, maxGlobal int) *ConnLimiter {
	if maxPerUser <= 0 {
		maxPerUser = 10
	}
	if maxPerIP <= 0 {
		maxPerIP = 30
	}
	if maxGlobal <= 0 {
		maxGlobal = 2048
	}
	return &ConnLimiter{
		maxPerUser: maxPerUser,
		maxPerIP:   maxPerIP,
		maxGlobal:  maxGlobal,
		userConns:  make(map[string]int),
		ipConns:    make(map[string]int),
	}
}

// ExtractClientIP 从 HTTP 请求中提取穿透反代的真实客户端 IP（支持 CF/X-Real-IP/X-Forwarded-For）
func ExtractClientIP(r *http.Request) string {
	if r == nil {
		return "unknown"
	}

	// 1. Cloudflare 真实 IP
	if cf := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); cf != "" {
		if ip := cleanIP(cf); ip != "" {
			return ip
		}
	}

	// 2. Nginx/Caddy X-Real-IP
	if xr := strings.TrimSpace(r.Header.Get("X-Real-IP")); xr != "" {
		if ip := cleanIP(xr); ip != "" {
			return ip
		}
	}

	// 3. X-Forwarded-For (多级反代逗号分隔，取首个客户端 IP)
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		for _, part := range parts {
			if ip := cleanIP(strings.TrimSpace(part)); ip != "" {
				return ip
			}
		}
	}

	// 4. 回退检查 RemoteAddr
	if r.RemoteAddr != "" {
		if ip := cleanIP(r.RemoteAddr); ip != "" {
			return ip
		}
	}

	return "unknown"
}

func cleanIP(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}

	// 剥离方括号或端口 (如 192.168.1.1:8080 或 [::1]:8080)
	if host, _, err := net.SplitHostPort(raw); err == nil {
		raw = host
	}
	raw = strings.TrimPrefix(raw, "[")
	raw = strings.TrimSuffix(raw, "]")
	raw = strings.TrimSpace(raw)

	if parsed := net.ParseIP(raw); parsed != nil {
		return parsed.String()
	}
	return ""
}

// Acquire 尝试获取长连接并发配额：
// - 若 userId != ""，按用户维度控制配额（防御同一公司/高校 NAT 共享出口互锁）；
// - 若 userId == ""，按客户端 IP 维度控制配额（防御恶意未登录攻击者）；
// - 同时受全站全局连接硬上限约束。
func (l *ConnLimiter) Acquire(userId, ip string) (func(), error) {
	if l == nil {
		return func() {}, nil
	}

	// 快速无锁预检全局上限
	if atomic.LoadInt64(&l.globalCount) >= int64(l.maxGlobal) {
		return nil, ErrTooManyGlobal
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	// 锁内确认全局上限
	if l.globalCount >= int64(l.maxGlobal) {
		return nil, ErrTooManyGlobal
	}

	if userId != "" {
		if l.userConns[userId] >= l.maxPerUser {
			return nil, ErrTooManyPerUser
		}
		l.userConns[userId]++
	} else {
		if ip == "" {
			ip = "unknown"
		}
		if l.ipConns[ip] >= l.maxPerIP {
			return nil, ErrTooManyPerIP
		}
		l.ipConns[ip]++
	}

	l.globalCount++

	var once sync.Once
	release := func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()

			l.globalCount--
			if l.globalCount < 0 {
				l.globalCount = 0
			}

			if userId != "" {
				l.userConns[userId]--
				if l.userConns[userId] <= 0 {
					delete(l.userConns, userId) // 立即清理，零冷键内存累积
				}
			} else {
				l.ipConns[ip]--
				if l.ipConns[ip] <= 0 {
					delete(l.ipConns, ip) // 立即清理，零冷键内存累积
				}
			}
		})
	}

	return release, nil
}


// UserCount 查询指定用户的当前活跃长连接数
func (l *ConnLimiter) UserCount(userId string) int {
	if l == nil || userId == "" {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.userConns[userId]
}

// GlobalCount 查询全局当前活跃长连接数
func (l *ConnLimiter) GlobalCount() int64 {
	if l == nil {
		return 0
	}
	return atomic.LoadInt64(&l.globalCount)
}
