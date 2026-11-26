package jobs

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockEventStore struct {
	mu         sync.Mutex
	events     []JobEventEntry
	heartbeats []string
	batches    [][]JobEventEntry
	insertErr  error
}

func (m *mockEventStore) ClaimNextQueuedJobs(_ context.Context, _ int, _ []string) ([]string, error) {
	return nil, nil
}

func (m *mockEventStore) GetImportJob(_ context.Context, _ string) (*JobRow, error) {
	return nil, nil
}

func (m *mockEventStore) ReapStaleImportJobs(_ context.Context, _ time.Time) (int64, error) {
	return 0, nil
}

func (m *mockEventStore) GcFinishedImportJobs(_ context.Context, _ time.Time) (int64, error) {
	return 0, nil
}

func (m *mockEventStore) FailImportJob(_ context.Context, _, _ string) (bool, error) {
	return true, nil
}

func (m *mockEventStore) HeartbeatImportJob(_ context.Context, jobId string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.heartbeats = append(m.heartbeats, jobId)
	return nil
}

func (m *mockEventStore) UpdateImportJobProgress(_ context.Context, _ string, _ string, _ int) error {
	return nil
}

func (m *mockEventStore) InsertJobEvents(_ context.Context, _ string, events []JobEventEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.insertErr != nil {
		return m.insertErr
	}
	copied := make([]JobEventEntry, len(events))
	copy(copied, events)
	m.batches = append(m.batches, copied)
	m.events = append(m.events, events...)
	return nil
}

func (m *mockEventStore) EmergencyReadOnly(_ context.Context) (bool, error) {
	return false, nil
}

func (m *mockEventStore) CreateImportJob(_ context.Context, _ CreateJobParams) (CreateJobResult, error) {
	return CreateJobResult{ID: "mock-job-id", Deduped: false}, nil
}

func (m *mockEventStore) ClaimSpecificJob(_ context.Context, _ string) (bool, error) {
	return true, nil
}

func (m *mockEventStore) CompleteImportJob(_ context.Context, _ string, _ any) (bool, error) {
	return true, nil
}

func (m *mockEventStore) RequestImportPublication(_ context.Context, _, _ string) error {
	return nil
}

func (m *mockEventStore) getEvents() []JobEventEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	res := make([]JobEventEntry, len(m.events))
	copy(res, m.events)
	return res
}

func (m *mockEventStore) getBatches() [][]JobEventEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	res := make([][]JobEventEntry, len(m.batches))
	copy(res, m.batches)
	return res
}

func newMockEventStore(t *testing.T) *mockEventStore {
	t.Helper()
	return &mockEventStore{}
}

func TestJobEventWriterBatchFlushing(t *testing.T) {
	tests := []struct {
		name          string
		flushCount    int
		flushMs       int
		pushEvents    []string
		sleepDuration time.Duration
		callFlush     bool
		callClose     bool
		wantMinEvents int
		wantSeqStarts int
	}{
		{
			name:          "flush by count threshold",
			flushCount:    3,
			flushMs:       500,
			pushEvents:    []string{"log1", "log2", "log3"},
			sleepDuration: 50 * time.Millisecond,
			wantMinEvents: 3,
			wantSeqStarts: 0,
		},
		{
			name:          "flush by timer expiry",
			flushCount:    10,
			flushMs:       30,
			pushEvents:    []string{"log1", "log2"},
			sleepDuration: 80 * time.Millisecond,
			wantMinEvents: 2,
			wantSeqStarts: 0,
		},
		{
			name:          "explicit flush call",
			flushCount:    10,
			flushMs:       1000,
			pushEvents:    []string{"log1"},
			callFlush:     true,
			wantMinEvents: 1,
			wantSeqStarts: 0,
		},
		{
			name:          "close flushes remaining buffer",
			flushCount:    10,
			flushMs:       1000,
			pushEvents:    []string{"log1", "log2", "log3"},
			callClose:     true,
			wantMinEvents: 3,
			wantSeqStarts: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newMockEventStore(t)
			cfg := Config{
				EventFlushCount: tt.flushCount,
				EventFlushMs:    tt.flushMs,
				MaxEventsPerJob: 100,
			}
			writer := newEventWriter("job-123", store, cfg)

			for _, p := range tt.pushEvents {
				writer.Push("log", map[string]any{"msg": p})
			}

			if tt.sleepDuration > 0 {
				time.Sleep(tt.sleepDuration)
			}
			if tt.callFlush {
				err := writer.Flush(context.Background())
				require.NoError(t, err)
			}
			if tt.callClose {
				err := writer.Close(context.Background())
				require.NoError(t, err)
			}

			_ = writer.Close(context.Background())

			events := store.getEvents()
			assert.GreaterOrEqual(t, len(events), tt.wantMinEvents)
			for i, ev := range events {
				assert.Equal(t, tt.wantSeqStarts+i, ev.Seq, "event seq must be monotonic")
				assert.Equal(t, "log", ev.Type)
			}
		})
	}
}

func TestJobEventWriterStormSuppression(t *testing.T) {
	tests := []struct {
		name             string
		maxEvents        int
		pushLogsCount    int
		pushTerminalType string
		wantTotalEvents  int
		terminalIncluded bool
	}{
		{
			name:             "suppresses logs beyond maxEvents",
			maxEvents:        5,
			pushLogsCount:    10,
			wantTotalEvents:  5,
			terminalIncluded: false,
		},
		{
			name:             "permits done terminal event beyond maxEvents",
			maxEvents:        3,
			pushLogsCount:    5,
			pushTerminalType: "done",
			wantTotalEvents:  4,
			terminalIncluded: true,
		},
		{
			name:             "permits error terminal event beyond maxEvents",
			maxEvents:        3,
			pushLogsCount:    5,
			pushTerminalType: "error",
			wantTotalEvents:  4,
			terminalIncluded: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newMockEventStore(t)
			cfg := Config{
				EventFlushCount: 50,
				EventFlushMs:    500,
				MaxEventsPerJob: tt.maxEvents,
			}
			writer := newEventWriter("job-storm", store, cfg)

			for i := 0; i < tt.pushLogsCount; i++ {
				writer.Push("log", map[string]any{"idx": i})
			}

			if tt.pushTerminalType != "" {
				writer.Push(tt.pushTerminalType, map[string]any{"reason": "finished"})
			}

			err := writer.Close(context.Background())
			require.NoError(t, err)

			events := store.getEvents()
			assert.Len(t, events, tt.wantTotalEvents)

			for i, ev := range events {
				assert.Equal(t, i, ev.Seq)
			}

			if tt.terminalIncluded {
				lastEv := events[len(events)-1]
				assert.Equal(t, tt.pushTerminalType, lastEv.Type)
			}
		})
	}
}

func TestJobEventWriterClosedWriterRejects(t *testing.T) {
	store := newMockEventStore(t)
	cfg := Config{EventFlushCount: 10, EventFlushMs: 500, MaxEventsPerJob: 10}
	writer := newEventWriter("job-closed", store, cfg)

	writer.Push("log", map[string]any{"step": "1"})
	err := writer.Close(context.Background())
	require.NoError(t, err)

	writer.Push("log", map[string]any{"step": "2"})
	writer.Push("done", map[string]any{"step": "3"})

	events := store.getEvents()
	assert.Len(t, events, 1)
	assert.Equal(t, 0, events[0].Seq)
}

func TestJobEventWriterConcurrentPushMonotonicity(t *testing.T) {
	tests := []struct {
		name          string
		goroutines    int
		pushesPerGo   int
		maxEvents     int
		wantMinEvents int
	}{
		{
			name:          "concurrent pushes maintain strict monotonicity",
			goroutines:    8,
			pushesPerGo:   20,
			maxEvents:     200,
			wantMinEvents: 160,
		},
		{
			name:          "concurrent storm with terminal done",
			goroutines:    10,
			pushesPerGo:   30,
			maxEvents:     50,
			wantMinEvents: 50,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newMockEventStore(t)
			cfg := Config{
				EventFlushCount: 15,
				EventFlushMs:    50,
				MaxEventsPerJob: tt.maxEvents,
			}
			writer := newEventWriter("job-concurrent", store, cfg)

			var wg sync.WaitGroup
			for g := 0; g < tt.goroutines; g++ {
				wg.Add(1)
				go func(gid int) {
					defer wg.Done()
					for p := 0; p < tt.pushesPerGo; p++ {
						writer.Push("log", map[string]any{"g": gid, "p": p})
					}
				}(g)
			}
			wg.Wait()

			writer.Push("done", map[string]any{"status": "ok"})
			err := writer.Close(context.Background())
			require.NoError(t, err)

			events := store.getEvents()
			assert.GreaterOrEqual(t, len(events), tt.wantMinEvents)

			for i, ev := range events {
				assert.Equal(t, i, ev.Seq, "event seq must be strictly monotonic without gaps")
			}
			assert.Equal(t, "done", events[len(events)-1].Type, "last event must be done")
		})
	}
}

func TestJobEventWriterFlushErrorPropagation(t *testing.T) {
	tests := []struct {
		name      string
		injectErr error
		wantErr   bool
	}{
		{
			name:      "successful flush returns nil error",
			injectErr: nil,
			wantErr:   false,
		},
		{
			name:      "failed flush propagates underlying store error",
			injectErr: assert.AnError,
			wantErr:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newMockEventStore(t)
			store.insertErr = tt.injectErr
			cfg := Config{EventFlushCount: 50, EventFlushMs: 500, MaxEventsPerJob: 100}
			writer := newEventWriter("job-flush-err", store, cfg)

			writer.Push("log", map[string]any{"action": "test"})
			err := writer.Flush(context.Background())
			if tt.wantErr {
				assert.ErrorIs(t, err, tt.injectErr)
			} else {
				assert.NoError(t, err)
			}
			_ = writer.Close(context.Background())
		})
	}
}
