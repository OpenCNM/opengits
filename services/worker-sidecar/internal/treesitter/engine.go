package treesitter

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/tetratelabs/wazero"
	"runtime"
	"strconv"
	"sync"
)

const (
	defaultMinPoolSize = 2
	defaultMaxPoolSize = 8
)

func defaultPoolSize() int {
	// WORKER_TS_POOL_SIZE：显式覆盖共享引擎池上限（<=0 或非法值用默认
	// clamp(GOMAXPROCS, 2, 8)），供内存紧张部署收缩 worker 数。
	if v := os.Getenv("WORKER_TS_POOL_SIZE"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			if n > defaultMaxPoolSize*8 {
				n = defaultMaxPoolSize * 8
			}
			return n
		}
	}
	procs := runtime.GOMAXPROCS(0)
	if procs < defaultMinPoolSize {
		return defaultMinPoolSize
	}
	if procs > defaultMaxPoolSize {
		return defaultMaxPoolSize
	}
	return procs
}

// Engine executes Tree-sitter parsers and queries across a concurrency-safe pool of
// isolated Wazero WebAssembly runtime workers in pure Go.
type Engine struct {
	ctx        context.Context
	cancel     context.CancelFunc
	mu         sync.Mutex
	pool       chan *worker
	maxWorkers int
	created    int
	closed     bool
	coreWasm   []byte
	// compileCache 跨 worker 共享的 wasm 编译产物缓存（编译与实例化
	// 分离：退役重建只重新实例化，不再重编 core/语法）
	compileCache wazero.CompilationCache
}

// NewEngine creates and initializes a pure-Go Tree-sitter runtime engine with an adaptive worker pool.
func NewEngine(ctx context.Context) (*Engine, error) {
	return NewEngineWithPoolSize(ctx, defaultPoolSize())
}

// NewEngineWithPoolSize creates a Tree-sitter engine with a fixed worker pool capacity.
func NewEngineWithPoolSize(ctx context.Context, maxWorkers int) (*Engine, error) {
	if maxWorkers < 1 {
		maxWorkers = 1
	}

	rawCore, err := loadCoreWasm()
	if err != nil {
		return nil, fmt.Errorf("failed to load core wasm: %w", err)
	}

	patchedCore, err := PatchTsCore(rawCore)
	if err != nil {
		return nil, fmt.Errorf("failed to patch core wasm: %w", err)
	}

	engineCtx, cancel := context.WithCancel(ctx)

	// Eagerly instantiate Frame-1 initial worker to validate compilation and runtime health
	compileCache := wazero.NewCompilationCache()

	initialWorker, err := newWorker(engineCtx, patchedCore, compileCache)
	if err != nil {
		cancel()
		return nil, err
	}

	pool := make(chan *worker, maxWorkers)
	pool <- initialWorker

	return &Engine{
		ctx:          engineCtx,
		cancel:       cancel,
		pool:         pool,
		maxWorkers:   maxWorkers,
		created:      1,
		coreWasm:     patchedCore,
		compileCache: compileCache,
	}, nil
}

// PoolCapacity returns the maximum number of concurrent workers configured for this engine.
func (e *Engine) PoolCapacity() int {
	return e.maxWorkers
}

// ActiveWorkers returns the total number of worker instances currently created.
func (e *Engine) ActiveWorkers() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.created
}

// acquireWorker retrieves an idle worker from the pool or spins up a new instance if capacity permits.
func (e *Engine) acquireWorker(ctx context.Context) (*worker, error) {
	for {
		e.mu.Lock()
		if e.closed {
			e.mu.Unlock()
			return nil, errors.New("treesitter engine is closed")
		}
		e.mu.Unlock()

		// 1. Fast path: Non-blocking borrow from idle pool
		select {
		case w, ok := <-e.pool:
			if !ok || w == nil {
				return nil, errors.New("treesitter engine is closed")
			}
			return w, nil
		default:
		}

		// 2. Slow path: Check if we can expand the pool up to maxWorkers
		e.mu.Lock()
		if e.closed {
			e.mu.Unlock()
			return nil, errors.New("treesitter engine is closed")
		}
		if e.created < e.maxWorkers {
			e.created++
			e.mu.Unlock()

			w, err := newWorker(e.ctx, e.coreWasm, e.compileCache)
			if err != nil {
				e.mu.Lock()
				e.created--
				e.mu.Unlock()
				return nil, err
			}
			return w, nil
		}
		e.mu.Unlock()

		// 3. Blocking path: Wait for an available worker, request context done, or engine close
		select {
		case w, ok := <-e.pool:
			if !ok || w == nil {
				return nil, errors.New("treesitter engine is closed")
			}
			return w, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-e.ctx.Done():
			return nil, errors.New("treesitter engine is closed")
		}
	}
}

func (e *Engine) releaseWorker(w *worker) {
	if w == nil {
		return
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		_ = w.close()
		return
	}
	// Epoch retirement check: if worker parsed too many times or exceeded memory threshold,
	// retire worker to reclaim Wazero WebAssembly linear memory back to the OS.
	if w.shouldRetire() {
		_ = w.close()
		// Eagerly replace the retired worker so waiting callers get a fresh worker immediately
		newW, err := newWorker(e.ctx, e.coreWasm, e.compileCache)
		if err == nil {
			w = newW
		} else {
			e.created--
			return
		}
	}
	// 归还必须与 closed 检查同锁原子：解锁后发送会与 Close() 的 close(pool)
	// 竞态，send-on-closed channel 直接 panic（缓冲通道非阻塞发送持锁无死锁）。
	select {
	case e.pool <- w:
	default:
		// Pool overflow fallback (defensive guard against unexpected extra workers)
		_ = w.close()
		e.created--
	}
}

// ParseAndExtract parses source code and extracts declaration symbols and call sites.
// It acquires an isolated worker from the pool, enabling lock-free parallel execution across goroutines.
func (e *Engine) ParseAndExtract(ctx context.Context, lang string, source []byte) (*ExtractionResult, error) {
	w, err := e.acquireWorker(ctx)
	if err != nil {
		return nil, err
	}
	defer e.releaseWorker(w)

	return w.parseAndExtract(ctx, lang, source)
}

// DebugAST parses source code and returns the S-expression representation of the AST.
func (e *Engine) DebugAST(lang string, source []byte) (string, error) {
	w, err := e.acquireWorker(e.ctx)
	if err != nil {
		return "", err
	}
	defer e.releaseWorker(w)

	return w.debugAST(e.ctx, lang, source)
}

// Close gracefully shuts down the engine, drains the worker pool, and closes all WASM runtimes.
func (e *Engine) Close() error {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return nil
	}
	e.closed = true
	e.cancel()
	close(e.pool)
	e.mu.Unlock()

	var firstErr error
	for w := range e.pool {
		if err := w.close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
