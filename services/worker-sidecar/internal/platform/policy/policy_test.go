package policy

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockEmergencyStore struct {
	mu         sync.Mutex
	calls      int
	shouldErr  bool
	errToThrow error
	val        bool
}

func (m *mockEmergencyStore) EmergencyReadOnly(ctx context.Context) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls++
	if m.shouldErr {
		if m.errToThrow != nil {
			return false, m.errToThrow
		}
		return false, errors.New("db connection failure")
	}
	return m.val, nil
}

func (m *mockEmergencyStore) callCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.calls
}

func TestGatewayPolicy_IsEmergencyReadOnly(t *testing.T) {
	defer func() {
		DefaultGatewayPolicy.Reset()
	}()
	DefaultGatewayPolicy.Reset()
	tests := []struct {
		name         string
		storeVal     bool
		storeErr     error
		nilStore     bool
		setupCache   func()
		wantResult   bool
		wantCalls    int
		checkPostRun func(t *testing.T, store *mockEmergencyStore)
	}{
		{
			name:       "🧪 [11.1.1.1] [11.3.1.1] reads true from store and caches within TTL",
			storeVal:   true,
			setupCache: func() { DefaultGatewayPolicy.Reset() },
			wantResult: true,
			wantCalls:  1,
			checkPostRun: func(t *testing.T, store *mockEmergencyStore) {
				t.Helper()
				res2 := IsEmergencyReadOnly(context.Background(), store)
				assert.True(t, res2)
				assert.Equal(t, 1, store.callCount(), "cache hit within TTL must not query store")
			},
		},
		{
			name:       "🧪 [11.1.1.1] reads false from store and caches within TTL",
			storeVal:   false,
			setupCache: func() { DefaultGatewayPolicy.Reset() },
			wantResult: false,
			wantCalls:  1,
			checkPostRun: func(t *testing.T, store *mockEmergencyStore) {
				t.Helper()
				res2 := IsEmergencyReadOnly(context.Background(), store)
				assert.False(t, res2)
				assert.Equal(t, 1, store.callCount(), "cache hit within TTL must not query store")
			},
		},
		{
			name:       "🧪 [11.1.1.1] fail-open on DB error with 2s negative cache backoff",
			storeErr:   errors.New("postgres connection timeout"),
			setupCache: func() { DefaultGatewayPolicy.Reset() },
			wantResult: false,
			wantCalls:  1,
			checkPostRun: func(t *testing.T, store *mockEmergencyStore) {
				t.Helper()
				res2 := IsEmergencyReadOnly(context.Background(), store)
				assert.False(t, res2, "negative cache must return fail-open false")
				assert.Equal(t, 1, store.callCount(), "must not query DB during negative cache window")
			},
		},
		{
			name:       "🧪 [11.1.1.1] nil store returns fail-open false without panic",
			nilStore:   true,
			setupCache: func() { DefaultGatewayPolicy.Reset() },
			wantResult: false,
			wantCalls:  0,
		},
		{
			name:     "cache hit when already populated within 10s TTL",
			storeVal: false,
			setupCache: func() {
				DefaultGatewayPolicy.Reset()
				DefaultGatewayPolicy.mu.Lock()
				DefaultGatewayPolicy.value = true
				DefaultGatewayPolicy.at = time.Now()
				DefaultGatewayPolicy.mu.Unlock()
			},
			wantResult: true,
			wantCalls:  0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.setupCache()
			var store EmergencyReadOnlyReader
			var mockStore *mockEmergencyStore
			if !tt.nilStore {
				mockStore = &mockEmergencyStore{
					val:        tt.storeVal,
					shouldErr:  tt.storeErr != nil,
					errToThrow: tt.storeErr,
				}
				store = mockStore
			}

			got := IsEmergencyReadOnly(context.Background(), store)
			require.Equal(t, tt.wantResult, got)
			if mockStore != nil {
				assert.Equal(t, tt.wantCalls, mockStore.callCount())
			}

			if tt.checkPostRun != nil && mockStore != nil {
				tt.checkPostRun(t, mockStore)
			}
		})
	}
}

func TestGatewayPolicy_IsEmergencyReadOnly_Concurrent(t *testing.T) {
	defer func() {
		DefaultGatewayPolicy.Reset()
	}()
	DefaultGatewayPolicy.Reset()

	store := &mockEmergencyStore{
		val: true,
	}

	const concurrency = 50
	var wg sync.WaitGroup
	wg.Add(concurrency)
	results := make([]bool, concurrency)

	for i := 0; i < concurrency; i++ {
		idx := i
		go func() {
			defer wg.Done()
			results[idx] = IsEmergencyReadOnly(context.Background(), store)
		}()
	}

	wg.Wait()

	for i := 0; i < concurrency; i++ {
		assert.True(t, results[i], "concurrent read %d must be true", i)
	}
	assert.Equal(t, 1, store.callCount(), "50 concurrent reads on empty cache must coalesce to exactly 1 store call")
}
