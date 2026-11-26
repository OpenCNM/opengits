package pipelineb

import (
	"context"
	"sync"
	"time"
)

const (
	PrepStatusRunning = "running"
	PrepStatusReady   = "ready"
	PrepStatusFailed  = "failed"
)

const PrepDefaultTimeout = 30 * time.Minute

const PrepPollIntervalMs = 8000

type prepEntry struct {
	mu     sync.Mutex
	status string
	err    string
}

// Process-local guard deduplicating cold-start background prep; on-disk tree-map cache handles cross-restart hits.
type PrepTracker struct {
	mu      sync.Mutex
	entries map[string]*prepEntry
}

func NewPrepTracker() *PrepTracker {
	return &PrepTracker{entries: make(map[string]*prepEntry)}
}

func PrepKey(owner, repo, sha string) string {
	return owner + "/" + repo + "@" + sha
}

// Runs fn on a detached context so client disconnects cannot abort background prep; ready/failed entries allow retry.
func (t *PrepTracker) Start(key string, fn func(ctx context.Context) error) bool {
	t.mu.Lock()
	if e, exists := t.entries[key]; exists {
		e.mu.Lock()
		running := e.status == PrepStatusRunning
		e.mu.Unlock()
		if running {
			t.mu.Unlock()
			return false
		}
	}
	e := &prepEntry{}
	e.mu.Lock()
	e.status = PrepStatusRunning
	e.mu.Unlock()
	t.entries[key] = e
	t.mu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), PrepDefaultTimeout)
		defer cancel()
		err := fn(ctx)
		e.mu.Lock()
		defer e.mu.Unlock()
		if err != nil {
			e.status = PrepStatusFailed
			e.err = err.Error()
			return
		}
		e.status = PrepStatusReady
	}()
	return true
}

func (t *PrepTracker) Get(key string) (status string, errMsg string) {
	t.mu.Lock()
	e, ok := t.entries[key]
	t.mu.Unlock()
	if !ok {
		return "", ""
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.status, e.err
}

// Atomically consumes and clears failed status so a subsequent request can re-trigger cold-start prep.
func (t *PrepTracker) ConsumeFailed(key string) (bool, string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	e, ok := t.entries[key]
	if !ok {
		return false, ""
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.status == PrepStatusFailed {
		err := e.err
		delete(t.entries, key)
		return true, err
	}
	return false, ""
}

func (t *PrepTracker) Reset(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.entries, key)
}
