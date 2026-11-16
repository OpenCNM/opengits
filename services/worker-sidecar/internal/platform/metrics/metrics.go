// Package metrics 进程内极简原子计数注册表（346·第一性原理：零外部
// 依赖的最小闭环——先让 fail-soft 降级频率可量化，消费端形态验证后再
// 考虑对接外部观测栈）。
//
// 设计约束：
//   - 全部计数器为单调递增 uint64（gauge 类状态由各组件经 SnapshotFunc
//     自带方法暴露，不混入计数注册表）；
//   - Inc 为熔断级热路径（map 命中 + atomic），注册在首次 Inc 时发生，
//     不需要预声明；
//   - Snapshot 输出稳定排序的 map（JSON 序列化确定性）。
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

// Inc 计数器自增（首次引用即注册）。
func Inc(name string) {
	c := lookup(name)
	c.Add(1)
}

// Add 计数器增加 n（首次引用即注册）。
func Add(name string, n uint64) {
	c := lookup(name)
	c.Add(n)
}

// IncLabel 带单标签维度的计数（name 按 "prefix{label=value}" 展开，
// 标签值须来自封闭集合——禁止把路径/ID 等高基数值当标签，防基数爆炸）。
func IncLabel(name, label string) {
	Inc(name + "{" + label + "}")
}

// Get 读当前值（未注册返回 0）。
func Get(name string) uint64 {
	mu.RLock()
	c, ok := counters[name]
	mu.RUnlock()
	if !ok {
		return 0
	}
	return c.Load()
}

// Snapshot 全部计数器当前值（键按字典序，输出确定）。
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

// lookup 取或注册计数器。计数器指针一旦发布永不删除（键集封闭于代码
// 常量），RWMutex 只保护 map 结构本身。
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
