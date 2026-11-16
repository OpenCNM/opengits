// Package filecache 提供按「绝对路径 + mtime/size 时效校验」的进程内
// 对象 LRU：适用于内容寻址（按 sha 命名、原则不可变）的大 JSON 产物
// 免去每请求全量读盘 + 反序列化。文件被覆写（伪 sha 场景）时条目经
// stat 校验自动失效。Put 前无法 stat 的条目不入缓存（保守）。
package filecache

import (
	"container/list"
	"os"
	"sync"
)

// ObjectCache 泛型对象 LRU（front = 最近使用）。容量 ≤0 时按 1 处理。
type ObjectCache[V any] struct {
	mu       sync.Mutex
	capacity int
	ll       *list.List // element.Value = *entry[V]
	elems    map[string]*list.Element
}

type entry[V any] struct {
	path    string
	value   V
	modTime int64
	size    int64
}

func New[V any](capacity int) *ObjectCache[V] {
	if capacity < 1 {
		capacity = 1
	}
	return &ObjectCache[V]{
		capacity: capacity,
		ll:       list.New(),
		elems:    make(map[string]*list.Element),
	}
}

// Get 命中且 stat 校验通过（mtime+size 与入缓存时一致）才返回。
func (c *ObjectCache[V]) Get(file string) (V, bool) {
	st, err := os.Stat(file)
	if err != nil {
		var zero V
		return zero, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.elems[file]
	if !ok {
		var zero V
		return zero, false
	}
	e := el.Value.(*entry[V])
	if e.modTime != st.ModTime().UnixNano() || e.size != st.Size() {
		// 文件已被覆写：条目失效（自愈，下次 Put 重建）
		c.ll.Remove(el)
		delete(c.elems, file)
		var zero V
		return zero, false
	}
	c.ll.MoveToFront(el)
	return e.value, true
}

// Put 写入/更新条目（取当下 stat 作时效锚点；stat 失败静默跳过）。
func (c *ObjectCache[V]) Put(file string, value V) {
	st, err := os.Stat(file)
	if err != nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.elems[file]; ok {
		e := el.Value.(*entry[V])
		e.value = value
		e.modTime = st.ModTime().UnixNano()
		e.size = st.Size()
		c.ll.MoveToFront(el)
		return
	}
	el := c.ll.PushFront(&entry[V]{
		path:    file,
		value:   value,
		modTime: st.ModTime().UnixNano(),
		size:    st.Size(),
	})
	c.elems[file] = el
	for c.ll.Len() > c.capacity {
		back := c.ll.Back()
		if back == nil {
			break
		}
		c.ll.Remove(back)
		delete(c.elems, back.Value.(*entry[V]).path)
	}
}

// Len 当前条目数（测试用）。
func (c *ObjectCache[V]) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ll.Len()
}
