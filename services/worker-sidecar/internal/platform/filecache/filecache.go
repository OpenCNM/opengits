package filecache

import (
	"container/list"
	"os"
	"sync"
)

type ObjectCache[V any] struct {
	mu       sync.Mutex
	capacity int
	ll       *list.List
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
		c.ll.Remove(el)
		delete(c.elems, file)
		var zero V
		return zero, false
	}
	c.ll.MoveToFront(el)
	return e.value, true
}

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

func (c *ObjectCache[V]) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ll.Len()
}
