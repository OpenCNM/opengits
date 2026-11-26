package cache

import (
	"container/list"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

type Store[V any] struct {
	mu       sync.Mutex
	capacity int
	ll       *list.List
	elems    map[string]*list.Element

	sf           singleflight.Group
	loader       func(key string) (V, error)
	ttl          time.Duration
	onInvalidate func(key string)
	now          func() time.Time
}

type entry[V any] struct {
	key     string
	value   V
	expires time.Time
}

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

func (s *Store[V]) SetOnInvalidate(fn func(key string)) {
	s.mu.Lock()
	s.onInvalidate = fn
	s.mu.Unlock()
}

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

func (s *Store[V]) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ll.Len()
}
