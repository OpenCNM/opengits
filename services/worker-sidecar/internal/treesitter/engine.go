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

type Engine struct {
	ctx        context.Context
	cancel     context.CancelFunc
	mu         sync.Mutex
	pool       chan *worker
	maxWorkers int
	created    int
	closed     bool
	coreWasm   []byte

	// Share CompilationCache across workers so retired instances re-instantiate without recompiling WASM.
	compileCache wazero.CompilationCache
}

func NewEngine(ctx context.Context) (*Engine, error) {
	return NewEngineWithPoolSize(ctx, defaultPoolSize())
}

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

func (e *Engine) PoolCapacity() int {
	return e.maxWorkers
}

func (e *Engine) ActiveWorkers() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.created
}

func (e *Engine) acquireWorker(ctx context.Context) (*worker, error) {
	for {
		e.mu.Lock()
		if e.closed {
			e.mu.Unlock()
			return nil, errors.New("treesitter engine is closed")
		}
		e.mu.Unlock()

		select {
		case w, ok := <-e.pool:
			if !ok || w == nil {
				return nil, errors.New("treesitter engine is closed")
			}
			return w, nil
		default:
		}

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

	// Retire workers past parse or memory thresholds to return Wazero linear memory to the OS.
	if w.shouldRetire() {
		_ = w.close()

		newW, err := newWorker(e.ctx, e.coreWasm, e.compileCache)
		if err == nil {
			w = newW
		} else {
			e.created--
			return
		}
	}

	// Return worker under mu atomically with closed check to prevent send-on-closed-channel panic.
	select {
	case e.pool <- w:
	default:

		_ = w.close()
		e.created--
	}
}

func (e *Engine) ParseAndExtract(ctx context.Context, lang string, source []byte) (*ExtractionResult, error) {
	w, err := e.acquireWorker(ctx)
	if err != nil {
		return nil, err
	}
	defer e.releaseWorker(w)

	return w.parseAndExtract(ctx, lang, source)
}

func (e *Engine) DebugAST(lang string, source []byte) (string, error) {
	w, err := e.acquireWorker(e.ctx)
	if err != nil {
		return "", err
	}
	defer e.releaseWorker(w)

	return w.debugAST(e.ctx, lang, source)
}

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
