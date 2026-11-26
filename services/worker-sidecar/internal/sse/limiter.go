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
	ErrTooManyPerUser = errors.New("too many concurrent SSE connections for this user")
	ErrTooManyPerIP   = errors.New("too many concurrent SSE connections from this IP")
	ErrTooManyGlobal  = errors.New("global SSE connection limit reached")
)

type ConnLimiter struct {
	mu          sync.Mutex
	maxPerUser  int
	maxPerIP    int
	maxGlobal   int
	userConns   map[string]int
	ipConns     map[string]int
	globalCount int64
}

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

func ExtractClientIP(r *http.Request) string {
	if r == nil {
		return "unknown"
	}

	if cf := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); cf != "" {
		if ip := cleanIP(cf); ip != "" {
			return ip
		}
	}

	if xr := strings.TrimSpace(r.Header.Get("X-Real-IP")); xr != "" {
		if ip := cleanIP(xr); ip != "" {
			return ip
		}
	}

	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		for _, part := range parts {
			if ip := cleanIP(strings.TrimSpace(part)); ip != "" {
				return ip
			}
		}
	}

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

// Track authenticated connections by userId (avoiding shared-NAT lockouts) and anonymous by client IP.
func (l *ConnLimiter) Acquire(userId, ip string) (func(), error) {
	if l == nil {
		return func() {}, nil
	}

	if atomic.LoadInt64(&l.globalCount) >= int64(l.maxGlobal) {
		return nil, ErrTooManyGlobal
	}

	l.mu.Lock()
	defer l.mu.Unlock()

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
					// Delete zeroed entries immediately to prevent unbounded key growth.
					delete(l.userConns, userId)
				}
			} else {
				l.ipConns[ip]--
				if l.ipConns[ip] <= 0 {
					delete(l.ipConns, ip)
				}
			}
		})
	}

	return release, nil
}

func (l *ConnLimiter) UserCount(userId string) int {
	if l == nil || userId == "" {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.userConns[userId]
}

func (l *ConnLimiter) GlobalCount() int64 {
	if l == nil {
		return 0
	}
	return atomic.LoadInt64(&l.globalCount)
}
