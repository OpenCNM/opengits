package mcp

import (
	"fmt"
	"sync"
	"time"
)

// ttlCache 对齐 Node TtlCache 语义：TTL 过期 + 容量上限（最旧条目驱逐）+ null 值缓存 +
// 单飞（同 key 并发只触发一次 loader）。loader 错误不缓存（下次重试）。
type ttlCache struct {
	mu       sync.Mutex
	ttl      time.Duration
	maxKeys  int
	entries  map[string]*cacheEntry
	inflight map[string]*cacheCall
}

type cacheEntry struct {
	value   any
	expires time.Time
}

type cacheCall struct {
	done  chan struct{}
	value any
	err   error
}

func newTTLCache(ttl time.Duration, maxKeys int) *ttlCache {
	return &ttlCache{ttl: ttl, maxKeys: maxKeys, entries: make(map[string]*cacheEntry)}
}

// getOrLoad 缓存命中（含 null 值，防扫描）直接返回；未命中或过期时单飞加载。
func (c *ttlCache) getOrLoad(key string, load func() (any, error)) (any, error) {
	return c.getOrLoadWithCustomTTL(key, func() (any, time.Duration, error) {
		val, err := load()
		return val, c.ttl, err
	})
}

// set 直接写入或更新指定 key 的缓存项，支持独立 TTL 与容量驱逐。
// getOrLoadWithCustomTTL 允许 loader 动态返回该条目的专属 TTL（如 10s 负缓存，5m 正向缓存）。
func (c *ttlCache) getOrLoadWithCustomTTL(key string, load func() (any, time.Duration, error)) (any, error) {
	c.mu.Lock()
	if c.inflight == nil {
		c.inflight = make(map[string]*cacheCall)
	}
	if e, ok := c.entries[key]; ok && time.Now().Before(e.expires) {
		c.mu.Unlock()
		return e.value, nil
	}
	if call, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		<-call.done
		return call.value, call.err
	}
	call := &cacheCall{done: make(chan struct{})}
	c.inflight[key] = call
	c.mu.Unlock()

	var (
		value   any
		itemTTL time.Duration
		err     error
		paniced = true
	)
	defer func() {
		if paniced {
			c.mu.Lock()
			delete(c.inflight, key)
			call.err = fmt.Errorf("cache loader panicked")
			c.mu.Unlock()
			close(call.done)
		}
	}()

	value, itemTTL, err = load()
	paniced = false

	c.mu.Lock()
	delete(c.inflight, key)
	if err == nil {
		if itemTTL <= 0 {
			itemTTL = c.ttl
		}
		c.entries[key] = &cacheEntry{value: value, expires: time.Now().Add(itemTTL)}
		// 容量驱逐：过期优先，其次最旧到期时间（近似 FIFO；热点缓存条目数小，遍历足够）
		if len(c.entries) > c.maxKeys {
			var oldestKey string
			var oldest time.Time
			first := true
			for k, v := range c.entries {
				if first || v.expires.Before(oldest) {
					oldestKey, oldest, first = k, v.expires, false
				}
			}
			if oldestKey != "" {
				delete(c.entries, oldestKey)
			}
		}
	}
	call.value, call.err = value, err
	c.mu.Unlock()
	close(call.done)
	return value, err
}
