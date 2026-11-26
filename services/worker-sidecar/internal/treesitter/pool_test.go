package treesitter

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestEngineConcurrentParsing(t *testing.T) {
	ctx := context.Background()
	engine, err := NewEngineWithPoolSize(ctx, 4)
	require.NoError(t, err)
	defer engine.Close()

	testSnippets := []struct {
		lang       string
		code       string
		expectSym  string
		expectKind string
	}{
		{
			lang:       "python",
			code:       "def compute_metrics():\n    pass\n",
			expectSym:  "compute_metrics",
			expectKind: "function",
		},
		{
			lang:       "go",
			code:       "package main\nfunc ExecuteTask() {}\n",
			expectSym:  "ExecuteTask",
			expectKind: "function",
		},
		{
			lang:       "tsx",
			code:       "export function RenderHeader(): JSX.Element { return null; }\n",
			expectSym:  "RenderHeader",
			expectKind: "function",
		},
		{
			lang:       "rust",
			code:       "pub fn process_stream() {}\n",
			expectSym:  "process_stream",
			expectKind: "function",
		},
		{
			lang:       "c",
			code:       "void initialize_buffer() {}\n",
			expectSym:  "initialize_buffer",
			expectKind: "function",
		},
	}

	const goroutinesCount = 20
	var wg sync.WaitGroup
	errCh := make(chan error, goroutinesCount)

	for i := 0; i < goroutinesCount; i++ {
		wg.Add(1)
		tc := testSnippets[i%len(testSnippets)]
		go func(lang, code, expectedSym, expectedKind string) {
			defer wg.Done()

			res, err := engine.ParseAndExtract(ctx, lang, []byte(code))
			if err != nil {
				errCh <- err
				return
			}
			found := false
			for _, s := range res.Symbols {
				if s.Name == expectedSym && s.Kind == expectedKind {
					found = true
					break
				}
			}
			if !found {
				errCh <- assert.AnError
			}
		}(tc.lang, tc.code, tc.expectSym, tc.expectKind)
	}

	wg.Wait()
	close(errCh)

	for err := range errCh {
		require.NoError(t, err)
	}

	assert.GreaterOrEqual(t, engine.ActiveWorkers(), 1)
	assert.LessOrEqual(t, engine.ActiveWorkers(), 4)
}

func TestEngineAcquireTimeout(t *testing.T) {
	ctx := context.Background()

	engine, err := NewEngineWithPoolSize(ctx, 1)
	require.NoError(t, err)
	defer engine.Close()

	worker1, err := engine.acquireWorker(ctx)
	require.NoError(t, err)
	require.NotNil(t, worker1)

	shortCtx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()

	worker2, err := engine.acquireWorker(shortCtx)
	assert.Error(t, err)
	assert.Nil(t, worker2)
	assert.Equal(t, context.DeadlineExceeded, err)

	engine.releaseWorker(worker1)

	worker3, err := engine.acquireWorker(ctx)
	assert.NoError(t, err)
	assert.NotNil(t, worker3)
	engine.releaseWorker(worker3)
}

func TestEngineCloseLifecycle(t *testing.T) {
	ctx := context.Background()
	engine, err := NewEngineWithPoolSize(ctx, 2)
	require.NoError(t, err)

	assert.Equal(t, 2, engine.PoolCapacity())

	err = engine.Close()
	assert.NoError(t, err)

	err = engine.Close()
	assert.NoError(t, err)

	w, err := engine.acquireWorker(ctx)
	assert.Error(t, err)
	assert.Nil(t, w)
}

func TestEngineConcurrentControlFlowAndJsx(t *testing.T) {
	ctx := context.Background()
	engine, err := NewEngineWithPoolSize(ctx, 3)
	require.NoError(t, err)
	defer engine.Close()

	var wg sync.WaitGroup
	errCh := make(chan error, 10)

	for i := 0; i < 5; i++ {
		wg.Add(2)

		go func() {
			defer wg.Done()
			code := `package main
func Process(x int) int {
	if x > 0 {
		return x
	}
	return -x
}`
			nodes, err := engine.ExtractControlFlow(ctx, "go", []byte(code))
			if err != nil {
				errCh <- err
				return
			}
			if len(nodes) == 0 {
				errCh <- assert.AnError
			}
		}()

		go func() {
			defer wg.Done()
			tsxCode := `
import React from 'react';
export function Notification() {
	return <Alert variant="warning">Important warning</Alert>;
}`
			ranges, err := engine.ExtractJsxRanges(ctx, []byte(tsxCode))
			if err != nil {
				errCh <- err
				return
			}
			if len(ranges) == 0 {
				errCh <- assert.AnError
			}
		}()
	}

	wg.Wait()
	close(errCh)

	for err := range errCh {
		require.NoError(t, err)
	}
}

func TestEngineCloseDuringReleaseNoPanic(t *testing.T) {
	engine, err := NewEngine(context.Background())
	if err != nil {
		t.Skipf("engine unavailable: %v", err)
	}
	defer engine.Close()

	const procs = 16
	var wg sync.WaitGroup
	done := make(chan struct{})
	for i := 0; i < procs; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				w, err := engine.acquireWorker(engine.ctx)
				if err != nil {
					return
				}
				engine.releaseWorker(w)
			}
		}()
	}
	go func() { wg.Wait(); close(done) }()

	time.Sleep(5 * time.Millisecond)
	_ = engine.Close()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("release workers hung after Close")
	}
}
