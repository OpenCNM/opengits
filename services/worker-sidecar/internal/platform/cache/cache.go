// Package cache 进程内统一读缓存组件：严格 LRU + 每条目可选 TTL +
// singleflight 回填 + 前缀式失效钩子。
//
// 收口边界（346·盖尔定律——只统一确有重复的形态，不过度抽象）：
//   - 适用于本组件：键→值读缓存、miss 时昂贵回填（读盘/查询）、
//     容量淘汰、按前缀批量失效；
//   - 不适用于本组件（保留各自实现并在原地头注说明）：
//     mcp/ttlcache（null 值缓存 + 每条目差异化 TTL + panic 安全）、
//     platform/filecache（mtime/size 内容寻址时效校验）、
//     mcp/ProjectionStore（租约 + repoID 二级索引失效——语义是投影
//     生命周期而非缓存）。
package cache

import (
	"container/list"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// Store 泛型读缓存。零值不可用，须 New 构造。
type Store[V any] struct {
	mu       sync.Mutex
	capacity int
	ll       *list.List // front = 最近使用；element.Value = *entry[V]
	elems    map[string]*list.Element

	sf           singleflight.Group
	loader       func(key string) (V, error)
	ttl          time.Duration // ≤0 = 永不过期（仅 LRU 淘汰）
	onInvalidate func(key string) // 可空：失效回调（版本协议挂钩点）
	now          func() time.Time // 可注入（测试）
}

type entry[V any] struct {
	key     string
	value   V
	expires time.Time // 零值 = 永不过期
}

// New 创建缓存。capacity ≤0 按 1 处理；ttl ≤0 表示仅 LRU 淘汰；
// loader 为 miss 回填函数（nil 则 Get 仅命中）。
func New[V any](capacity int, ttl time.Duration, loader func(key string) (V, error)) *Store[V] {
	if capacity < 1 {
		capacity = 1
	}
	return &Store[V]{
		capacity: capacity,
		ll:       list.New(),
		elems:    make(map[string]*list.Element),
		loader:   loader,
		ttl:      ttl,
		now:      time.Now,
	}
}

// SetOnInvalidate 注册失效回调（每次 Invalidate/InvalidatePrefix 命中触发；
// 用于产物版本协议的级联清退）。须在启动期注册，不保证并发注册安全。
func (s *Store[V]) SetOnInvalidate(fn func(key string)) {
	s.mu.Lock()
	s.onInvalidate = fn
	s.mu.Unlock()
}

// Get 命中且未过期返回值；miss 且有 loader 时 singleflight 回填。
// loader 返回 error 不缓存（下次重试）。
func (s *Store[V]) Get(key string) (V, error) {
	if v, ok := s.lookup(key); ok {
		return v, nil
	}
	if s.loader == nil {
		var zero V
		return zero, nil
	}
	v, err, _ := s.sf.Do(key, func() (any, error) {
		loaded, lerr := s.loader(key)
		if lerr != nil {
			return nil, lerr
		}
		s.put(key, loaded)
		return loaded, nil
	})
	if err != nil {
		var zero V
		return zero, err
	}
	return v.(V), nil
}

// GetOrLoad 带自定义回填（覆盖构造期 loader；同键并发合并）。
func (s *Store[V]) GetOrLoad(key string, load func(key string) (V, error)) (V, error) {
	if v, ok := s.lookup(key); ok {
		return v, nil
	}
	v, err, _ := s.sf.Do(key, func() (any, error) {
		loaded, lerr := load(key)
		if lerr != nil {
			return nil, lerr
		}
		s.put(key, loaded)
		return loaded, nil
	})
	if err != nil {
		var zero V
		return zero, err
	}
	return v.(V), nil
}

// Put 直写（不经 loader）。
func (s *Store[V]) Put(key string, value V) {
	s.put(key, value)
}

func (s *Store[V]) put(key string, value V) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if el, ok := s.elems[key]; ok {
		e := el.Value.(*entry[V])
		e.value = value
		e.expires = s.expiryLocked()
		s.ll.MoveToFront(el)
		return
	}
	el := s.ll.PushFront(&entry[V]{key: key, value: value, expires: s.expiryLocked()})
	s.elems[key] = el
	for s.ll.Len() > s.capacity {
		s.evictLocked(s.ll.Back())
	}
}

func (s *Store[V]) expiryLocked() time.Time {
	if s.ttl <= 0 {
		return time.Time{}
	}
	return s.now().Add(s.ttl)
}

func (s *Store[V]) lookup(key string) (V, bool) {
	s.mu.Lock()
	el, ok := s.elems[key]
	if !ok {
		s.mu.Unlock()
		var zero V
		return zero, false
	}
	e := el.Value.(*entry[V])
	if !e.expires.IsZero() && !s.now().Before(e.expires) {
		s.evictLocked(el)
		s.mu.Unlock()
		var zero V
		return zero, false
	}
	s.ll.MoveToFront(el)
	v := e.value
	s.mu.Unlock()
	return v, true
}

func (s *Store[V]) evictLocked(el *list.Element) {
	if el == nil {
		return
	}
	e := s.ll.Remove(el).(*entry[V])
	delete(s.elems, e.key)
}

// Invalidate 失效单键（触发 onInvalidate 回调）。
func (s *Store[V]) Invalidate(key string) {
	s.mu.Lock()
	el, ok := s.elems[key]
	if ok {
		s.evictLocked(el)
	}
	hook := s.onInvalidate
	s.mu.Unlock()
	if ok && hook != nil {
		hook(key)
	}
}

// InvalidatePrefix 前缀批量失效（版本协议：key 形如 "repoId:..."）。
// 返回失效条数。
func (s *Store[V]) InvalidatePrefix(prefix string) int {
	s.mu.Lock()
	var keys []string
	for k, el := range s.elems {
		if strings.HasPrefix(k, prefix) {
			keys = append(keys, k)
			s.evictLocked(el)
		}
	}
	hook := s.onInvalidate
	s.mu.Unlock()
	if hook != nil {
		for _, k := range keys {
			hook(k)
		}
	}
	return len(keys)
}

// Len 当前条目数（含未过期；测试用）。
func (s *Store[V]) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ll.Len()
}
