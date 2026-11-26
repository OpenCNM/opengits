package transcription

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/opengits/worker-sidecar/internal/doc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockTranscriptionStrategy struct {
	name        string
	matchResult bool
	outcome     BodyOutcome
	content     string
	err         error
	invoked     bool
}

func (m *mockTranscriptionStrategy) Name() string { return m.name }
func (m *mockTranscriptionStrategy) Match(_ TranscriptionExecutionContext) bool {
	return m.matchResult
}
func (m *mockTranscriptionStrategy) Execute(_ context.Context, _ TranscriptionExecutionContext) (BodyOutcome, string, error) {
	m.invoked = true
	return m.outcome, m.content, m.err
}

func TestTranscriptionStrategyDispatcher(t *testing.T) {
	tests := []struct {
		name            string
		strategies      []TranscriptionStrategy
		env             TranscriptionExecutionContext
		expectedOutcome BodyOutcome
		expectedContent string
		expectedErr     bool
	}{
		{
			name: "first matching strategy executes",
			strategies: []TranscriptionStrategy{
				&mockTranscriptionStrategy{name: "first", matchResult: false},
				&mockTranscriptionStrategy{name: "second", matchResult: true, outcome: BodyDone, content: "processed-by-second"},
				&mockTranscriptionStrategy{name: "third", matchResult: true, outcome: BodyDone, content: "processed-by-third"},
			},
			env:             TranscriptionExecutionContext{Content: "original"},
			expectedOutcome: BodyDone,
			expectedContent: "processed-by-second",
			expectedErr:     false,
		},
		{
			name: "no strategy matches falls back to original content",
			strategies: []TranscriptionStrategy{
				&mockTranscriptionStrategy{name: "s1", matchResult: false},
				&mockTranscriptionStrategy{name: "s2", matchResult: false},
			},
			env:             TranscriptionExecutionContext{Content: "original-fallback"},
			expectedOutcome: BodyDone,
			expectedContent: "original-fallback",
			expectedErr:     false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dispatcher := NewTranscriptionStrategyDispatcher(tc.strategies...)
			outcome, content, err := dispatcher.Dispatch(context.Background(), tc.env)
			assert.Equal(t, tc.expectedOutcome, outcome)
			assert.Equal(t, tc.expectedContent, content)
			if tc.expectedErr {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestDefaultStrategiesMatching(t *testing.T) {
	makePrep := func(virtual bool, forceEnhance bool) *PrepareResult {
		p := &PrepareResult{Outcome: "ready"}
		p.Doc.VirtualChapter = virtual
		p.Effective.ForceEnhance = forceEnhance
		return p
	}

	tests := []struct {
		name             string
		env              TranscriptionExecutionContext
		expectedStrategy string
	}{
		{
			name: "virtual chapter matches virtualCodeChapterStrategy",
			env: TranscriptionExecutionContext{
				Prep: makePrep(true, false),
			},
			expectedStrategy: "virtual_code_chapter",
		},
		{
			name: "had original and not force-enhance matches jitTranslateStrategy",
			env: TranscriptionExecutionContext{
				Prep:        makePrep(false, false),
				HadOriginal: true,
			},
			expectedStrategy: "jit_translate",
		},
		{
			name: "force-enhance with had original matches aiEnhanceStrategy",
			env: TranscriptionExecutionContext{
				Prep:        makePrep(false, true),
				HadOriginal: true,
			},
			expectedStrategy: "ai_enhance",
		},
		{
			name: "no original content matches aiEnhanceStrategy",
			env: TranscriptionExecutionContext{
				Prep:        makePrep(false, false),
				HadOriginal: false,
			},
			expectedStrategy: "ai_enhance",
		},
	}

	dispatcher := DefaultTranscriptionStrategyDispatcher()
	require.NotNil(t, dispatcher)

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var matched string
			for _, s := range dispatcher.strategies {
				if s.Match(tc.env) {
					matched = s.Name()
					break
				}
			}
			assert.Equal(t, tc.expectedStrategy, matched)
		})
	}
}

func TestTranscriptionCoordinatorLifecycle(t *testing.T) {
	t.Run("prepare not configured fails closed", func(t *testing.T) {
		coord := NewTranscriptionCoordinator(Config{}, BodyDeps{})
		outcome, errMsg := coord.Coordinate(context.Background(), "job-1", "doc-1", "user-1", "")
		assert.Equal(t, BodyFailed, outcome)
		assert.Contains(t, errMsg, "prepare executor not configured")
	})

	t.Run("fingerprint hit returns BodyDone directly", func(t *testing.T) {
		deps := BodyDeps{
			PrepareFunc: func(_ context.Context, _ string, _ string, _ doc.PrepareOptions) (*PrepareResult, error) {
				return &PrepareResult{Outcome: "fingerprint-hit"}, nil
			},
		}
		coord := NewTranscriptionCoordinator(Config{}, deps)
		outcome, errMsg := coord.Coordinate(context.Background(), "job-1", "doc-1", "user-1", "")
		assert.Equal(t, BodyDone, outcome)
		assert.Empty(t, errMsg)
	})

	t.Run("CAS lock contention returns skipped BodyDone", func(t *testing.T) {
		fakeStore := &fakeBodyStore{
			cas: false,
		}
		initialContent := "# Hello"
		deps := BodyDeps{
			Store: fakeStore,
			PrepareFunc: func(_ context.Context, _ string, _ string, _ doc.PrepareOptions) (*PrepareResult, error) {
				p := &PrepareResult{Outcome: "ready"}
				p.Doc.ID = "doc-1"
				p.Doc.Path = "readme.md"
				p.Doc.Content = &initialContent
				return p, nil
			},
		}
		coord := NewTranscriptionCoordinator(Config{}, deps)
		outcome, errMsg := coord.Coordinate(context.Background(), "job-1", "doc-1", "user-1", "")
		assert.Equal(t, BodyDone, outcome)
		assert.Empty(t, errMsg)
	})

	t.Run("finalize store unconfigured fails closed", func(t *testing.T) {
		fakeStore := &fakeBodyStore{
			cas: true,
		}
		initialContent := "# Hello"
		deps := BodyDeps{
			Store: fakeStore,
			PrepareFunc: func(_ context.Context, _ string, _ string, _ doc.PrepareOptions) (*PrepareResult, error) {
				p := &PrepareResult{Outcome: "ready"}
				p.Doc.ID = "doc-1"
				p.Doc.Path = "readme.md"
				p.Doc.Content = &initialContent
				p.Doc.IsMarkdown = false
				p.Doc.VirtualChapter = false
				return p, nil
			},
			FinalizeStore: nil,
		}
		coord := NewTranscriptionCoordinator(Config{}, deps)
		outcome, errMsg := coord.Coordinate(context.Background(), "job-1", "doc-1", "user-1", "")
		assert.Equal(t, BodyFailed, outcome)
		assert.Contains(t, errMsg, "finalize store not configured")
	})
}

func TestChunkConcurrencyFromEnv(t *testing.T) {
	tests := []struct {
		name     string
		envValue string
		expected int
		setEnv   bool
	}{
		{name: "默认值（未设置 env）", setEnv: false, expected: 3},
		{name: "合法下界 1", setEnv: true, envValue: "1", expected: 1},
		{name: "合法上界 16", setEnv: true, envValue: "16", expected: 16},
		{name: "中间值透传", setEnv: true, envValue: "6", expected: 6},
		{name: "零回退默认", setEnv: true, envValue: "0", expected: 3},
		{name: "负数回退默认", setEnv: true, envValue: "-4", expected: 3},
		{name: "超上界回退默认", setEnv: true, envValue: "32", expected: 3},
		{name: "非数字回退默认", setEnv: true, envValue: "abc", expected: 3},
		{name: "空串回退默认", setEnv: true, envValue: "", expected: 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("TRANSCRIPTION_CHUNK_CONCURRENCY", tt.envValue)
			if !tt.setEnv {
				t.Setenv("TRANSCRIPTION_CHUNK_CONCURRENCY", "")
				os.Unsetenv("TRANSCRIPTION_CHUNK_CONCURRENCY")
			}
			assert.Equal(t, tt.expected, chunkConcurrencyFromEnv())
		})
	}
}

func TestChunkConcurrencyResultOrderingDeterminism(t *testing.T) {
	const chunks = 8
	const concurrency = 3

	sem := make(chan struct{}, concurrency)
	results := make([]int, chunks)
	var wg sync.WaitGroup
	for i := 0; i < chunks; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if idx%2 == 0 {
				time.Sleep(2 * time.Millisecond)
			}
			results[idx] = idx
		}(i)
	}
	wg.Wait()

	expected := make([]int, chunks)
	for i := range expected {
		expected[i] = i
	}
	assert.Equal(t, expected, results, "并发完成顺序任意，结果必须按索引归位")
}
