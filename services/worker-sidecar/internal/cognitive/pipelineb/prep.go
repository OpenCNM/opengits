package pipelineb

import (
	"context"
	"sync"
	"time"
)

// ─────────────────────────────────────────────────────────────
// 冷启动后台准备追踪器。
//
// 物理事实：巨仓（如 800MB 归档/6 万文件）的归档下载 + tree-sitter 建图
// 是确定性分钟级计算，任何同步请求预算都装不下，重试一万次结果相同。
// 契约：冷缓存请求立即 202 PREPARING 让位，准备在请求生命周期之外的
// 分离 ctx（30min 总闸）中完成并落 tree-map 缓存；后续轮询命中缓存
// 后走同步预算内生成（LLM 切片按剩余额度自适应）。
// ─────────────────────────────────────────────────────────────

const (
	PrepStatusRunning = "running"
	PrepStatusReady   = "ready"
	PrepStatusFailed  = "failed"
)

// PrepDefaultTimeout 单次后台准备总闸：超限置 failed，防无限占用与磁盘泄漏。
const PrepDefaultTimeout = 30 * time.Minute

// PrepPollIntervalMs 202 响应建议的客户端轮询间隔（秒级权衡：过密空转
// 轮询，过疏拖长可感知延迟；巨仓下载建图分钟级，8s 粒度足够）。
const PrepPollIntervalMs = 8000

type prepEntry struct {
	mu     sync.Mutex
	status string
	err    string
}

// PrepTracker 按 owner/repo@sha 追踪后台准备状态（进程级，无持久化：
// 进程重启即冷，重走准备——缓存命中由磁盘 tree-map 承担，状态仅防重复点火）。
type PrepTracker struct {
	mu      sync.Mutex
	entries map[string]*prepEntry
}

func NewPrepTracker() *PrepTracker {
	return &PrepTracker{entries: make(map[string]*prepEntry)}
}

// PrepKey 归一化准备键。
func PrepKey(owner, repo, sha string) string {
	return owner + "/" + repo + "@" + sha
}

// Start 幂等启动：同名 key running 中直接返回 false 不重复点火；
// 已终态（ready/failed）允许重新启动（手动重试语义）。
// fn 在分离 goroutine 中以独立 ctx 执行，与请求生命周期彻底解耦。
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

// Get 读取准备状态；未知 key 返回空串。
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

// ConsumeFailed 读取并清空失败状态；若当前为 PrepStatusFailed，返回 (true, errMsg)
// 并从追踪表中删除该 key，使客户端收到 502 错误后，后续发起的重试或重新开始请求
// 能够重新点火准备管线，避免永久锁死在 502 失败态。
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

// Reset 清空指定 key 的所有准备状态（支持显式重置/重试点火）。
func (t *PrepTracker) Reset(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.entries, key)
}
