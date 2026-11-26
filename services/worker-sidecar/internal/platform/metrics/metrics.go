package metrics

import (
	"sort"
	"sync"
	"sync/atomic"
)

var (
	mu       sync.RWMutex
	counters = make(map[string]*atomic.Uint64)
)

func Inc(name string) {
	c := lookup(name)
	c.Add(1)
}

func Add(name string, n uint64) {
	c := lookup(name)
	c.Add(n)
}

func IncLabel(name, label string) {
	Inc(name + "{" + label + "}")
}

func Get(name string) uint64 {
	mu.RLock()
	c, ok := counters[name]
	mu.RUnlock()
	if !ok {
		return 0
	}
	return c.Load()
}

func Snapshot() map[string]uint64 {
	mu.RLock()
	names := make([]string, 0, len(counters))
	refs := make([]*atomic.Uint64, 0, len(counters))
	for n, c := range counters {
		names = append(names, n)
		refs = append(refs, c)
	}
	mu.RUnlock()
	sort.Strings(names)
	out := make(map[string]uint64, len(names))
	for i, n := range names {
		out[n] = refs[i].Load()
	}
	return out
}

func lookup(name string) *atomic.Uint64 {
	mu.RLock()
	c, ok := counters[name]
	mu.RUnlock()
	if ok {
		return c
	}
	mu.Lock()
	defer mu.Unlock()
	if c, ok := counters[name]; ok {
		return c
	}
	c = &atomic.Uint64{}
	counters[name] = c
	return c
}
