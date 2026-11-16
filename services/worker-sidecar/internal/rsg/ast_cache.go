package rsg

import (
	"crypto/sha1"
	"encoding/hex"
	"sync"
)

// DefaultMaxAstCacheEntries is the default maximum number of cached file AST entries (~100-200MB memory ceiling).
const DefaultMaxAstCacheEntries = 50000

// AstCacheStats captures observability metrics for AST cache efficiency.
type AstCacheStats struct {
	Hits      int64 `json:"hits"`
	Misses    int64 `json:"misses"`
	Evictions int64 `json:"evictions"`
	Entries   int   `json:"entries"`
}

type astCacheNode struct {
	key   string
	value *FileAstExtraction
	prev  *astCacheNode
	next  *astCacheNode
}

// AstCache is a thread-safe in-memory LRU cache storing extracted AST symbols keyed by (blobSha, lang).
type AstCache struct {
	mu         sync.Mutex
	maxEntries int
	entries    map[string]*astCacheNode
	head       *astCacheNode
	tail       *astCacheNode
	hits       int64
	misses     int64
	evictions  int64
}

// DefaultAstCache is the singleton AST cache shared across RSG builds and incremental update diffs.
var (
	defaultCacheMu  sync.RWMutex
	DefaultAstCache = NewAstCache(DefaultMaxAstCacheEntries)
)

// GetDefaultAstCache returns the global default AstCache instance.
func GetDefaultAstCache() *AstCache {
	defaultCacheMu.RLock()
	defer defaultCacheMu.RUnlock()
	return DefaultAstCache
}

// SetDefaultAstCache overrides the global default AstCache (used for tests or custom sizing).
func SetDefaultAstCache(cache *AstCache) {
	defaultCacheMu.Lock()
	defer defaultCacheMu.Unlock()
	DefaultAstCache = cache
}

// NewAstCache constructs an AstCache with the given capacity limit.
func NewAstCache(maxEntries int) *AstCache {
	if maxEntries <= 0 {
		maxEntries = DefaultMaxAstCacheEntries
	}
	return &AstCache{
		maxEntries: maxEntries,
		entries:    make(map[string]*astCacheNode),
	}
}

// MakeAstCacheKey generates a deterministic cache key from a Git blob SHA and language identifier.
func MakeAstCacheKey(blobSha, lang string) string {
	if blobSha == "" {
		return ""
	}
	if lang == "" {
		lang = "unknown"
	}
	return lang + ":" + blobSha
}

// ComputeContentSha calculates the SHA-1 hex digest of file content as a deterministic blob OID fallback.
func ComputeContentSha(content string) string {
	h := sha1.Sum([]byte(content))
	return hex.EncodeToString(h[:])
}

// Get looks up a cached AST extraction by key, promotes it to the front of LRU, and returns a cloned copy.
func (c *AstCache) Get(key string) (*FileAstExtraction, bool) {
	if c == nil || key == "" {
		return nil, false
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	node, exists := c.entries[key]
	if !exists {
		c.misses++
		return nil, false
	}

	c.hits++
	c.moveToFront(node)
	return node.value.Clone(), true
}

// Put stores an AST extraction in the cache, evicting the oldest entry if capacity is exceeded.
func (c *AstCache) Put(key string, val *FileAstExtraction) {
	if c == nil || key == "" || val == nil {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	cloned := val.Clone()

	if node, exists := c.entries[key]; exists {
		node.value = cloned
		c.moveToFront(node)
		return
	}

	newNode := &astCacheNode{
		key:   key,
		value: cloned,
	}

	if len(c.entries) >= c.maxEntries {
		c.evictTail()
	}

	c.addToFront(newNode)
	c.entries[key] = newNode
}

// Len returns the current number of cached items.
func (c *AstCache) Len() int {
	if c == nil {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

// Stats returns a snapshot of cache performance metrics.
func (c *AstCache) Stats() AstCacheStats {
	if c == nil {
		return AstCacheStats{}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return AstCacheStats{
		Hits:      c.hits,
		Misses:    c.misses,
		Evictions: c.evictions,
		Entries:   len(c.entries),
	}
}

// Reset clears all entries and resets metric counters.
func (c *AstCache) Reset() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	c.entries = make(map[string]*astCacheNode)
	c.head = nil
	c.tail = nil
	c.hits = 0
	c.misses = 0
	c.evictions = 0
}

func (c *AstCache) moveToFront(node *astCacheNode) {
	if c.head == node {
		return
	}
	c.removeNode(node)
	c.addToFront(node)
}

func (c *AstCache) addToFront(node *astCacheNode) {
	node.prev = nil
	node.next = c.head
	if c.head != nil {
		c.head.prev = node
	}
	c.head = node
	if c.tail == nil {
		c.tail = node
	}
}

func (c *AstCache) removeNode(node *astCacheNode) {
	if node.prev != nil {
		node.prev.next = node.next
	} else {
		c.head = node.next
	}

	if node.next != nil {
		node.next.prev = node.prev
	} else {
		c.tail = node.prev
	}

	node.prev = nil
	node.next = nil
}

func (c *AstCache) evictTail() {
	if c.tail == nil {
		return
	}
	tailNode := c.tail
	c.removeNode(tailNode)
	delete(c.entries, tailNode.key)
	c.evictions++
}
