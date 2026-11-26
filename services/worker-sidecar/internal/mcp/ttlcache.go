package mcp

import (
	"fmt"
	"sync"
	"time"
)

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

func (c *ttlCache) getOrLoad(key string, load func() (any, error)) (any, error) {
	return c.getOrLoadWithCustomTTL(key, func() (any, time.Duration, error) {
		val, err := load()
		return val, c.ttl, err
	})
}

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
