package mcp

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type countingFakeStore struct {
	mu           sync.Mutex
	tokens       map[string]*TokenRecord
	quotas       map[string]UserQuota
	tokenLookups atomic.Int64
	quotaLookups atomic.Int64
	tokenErr     error
	quotaErr     error
	lookupDelay  time.Duration
}

func newCountingFakeStore(t *testing.T) *countingFakeStore {
	t.Helper()
	return &countingFakeStore{
		tokens: make(map[string]*TokenRecord),
		quotas: make(map[string]UserQuota),
	}
}

func (s *countingFakeStore) LookupToken(_ context.Context, tokenHash string) (*TokenRecord, error) {
	s.tokenLookups.Add(1)
	if s.lookupDelay > 0 {
		time.Sleep(s.lookupDelay)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tokenErr != nil {
		return nil, s.tokenErr
	}
	return s.tokens[tokenHash], nil
}

func (s *countingFakeStore) GetUserQuota(_ context.Context, userID string) (UserQuota, error) {
	s.quotaLookups.Add(1)
	if s.lookupDelay > 0 {
		time.Sleep(s.lookupDelay)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.quotaErr != nil {
		return UserQuota{}, s.quotaErr
	}
	if q, ok := s.quotas[userID]; ok {
		return q, nil
	}
	return UserQuota{Role: "USER", RpmLimit: 30, DailyLimit: 100, TokenCap: 4000}, nil
}

func (s *countingFakeStore) LedgerCount(_ context.Context, _, _ string) (int, error) {
	return 0, nil
}

func (s *countingFakeStore) LedgerIncrement(_ context.Context, _, _ string) error {
	return nil
}

func (s *countingFakeStore) TouchTokenLastUsed(_ context.Context, _ string) error {
	return nil
}

func (s *countingFakeStore) UpsertPresence(_ context.Context, _, _, _, _ string) error {
	return nil
}

func (s *countingFakeStore) LookupBundle(_ context.Context, _ string) (*BundleMeta, error) {
	return nil, nil
}

func (s *countingFakeStore) IncrementBundleUseCount(_ context.Context, _ string) error {
	return nil
}

func newTestServerWithStore(t *testing.T, store Store) *server {
	t.Helper()
	cfg := Config{
		Addr:           ":8081",
		ProxyTimeoutMs: 5000,
	}
	return newServer(cfg, store)
}

func TestCachedLookupToken_TableDriven(t *testing.T) {
	tests := []struct {
		name          string
		tokenHash     string
		setupStore    func(*countingFakeStore)
		calls         int
		wantRec       *TokenRecord
		wantErr       bool
		expectedCalls int64
	}{
		{
			name:      "positive cache hit on subsequent calls",
			tokenHash: "valid_hash_1",
			setupStore: func(s *countingFakeStore) {
				s.tokens["valid_hash_1"] = &TokenRecord{TokenID: "tok_1", UserID: "usr_1"}
			},
			calls:         5,
			wantRec:       &TokenRecord{TokenID: "tok_1", UserID: "usr_1"},
			wantErr:       false,
			expectedCalls: 1,
		},
		{
			name:          "negative cache on nonexistent token",
			tokenHash:     "invalid_hash_missing",
			setupStore:    func(s *countingFakeStore) {},
			calls:         4,
			wantRec:       nil,
			wantErr:       false,
			expectedCalls: 1,
		},
		{
			name:      "db error not cached allowing retry",
			tokenHash: "error_hash",
			setupStore: func(s *countingFakeStore) {
				s.tokenErr = errors.New("connection failed")
			},
			calls:         3,
			wantRec:       nil,
			wantErr:       true,
			expectedCalls: 3,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newCountingFakeStore(t)
			tt.setupStore(store)
			srv := newTestServerWithStore(t, store)

			ctx := context.Background()
			for i := 0; i < tt.calls; i++ {
				rec, err := srv.cachedLookupToken(ctx, tt.tokenHash)
				if tt.wantErr {
					assert.Error(t, err)
					assert.Nil(t, rec)
				} else {
					assert.NoError(t, err)
					assert.Equal(t, tt.wantRec, rec)
				}
			}

			assert.Equal(t, tt.expectedCalls, store.tokenLookups.Load())
		})
	}
}

func TestCachedLookupToken_Singleflight(t *testing.T) {
	store := newCountingFakeStore(t)
	store.tokens["concurrent_token_hash"] = &TokenRecord{TokenID: "tok_conc", UserID: "usr_conc"}
	store.lookupDelay = 20 * time.Millisecond

	srv := newTestServerWithStore(t, store)
	ctx := context.Background()

	const concurrentGoroutines = 20
	var wg sync.WaitGroup
	wg.Add(concurrentGoroutines)

	results := make([]*TokenRecord, concurrentGoroutines)
	errorsList := make([]error, concurrentGoroutines)

	for i := 0; i < concurrentGoroutines; i++ {
		idx := i
		go func() {
			defer wg.Done()
			rec, err := srv.cachedLookupToken(ctx, "concurrent_token_hash")
			results[idx] = rec
			errorsList[idx] = err
		}()
	}

	wg.Wait()

	for i := 0; i < concurrentGoroutines; i++ {
		require.NoError(t, errorsList[i])
		require.NotNil(t, results[i])
		assert.Equal(t, "tok_conc", results[i].TokenID)
		assert.Equal(t, "usr_conc", results[i].UserID)
	}

	assert.Equal(t, int64(1), store.tokenLookups.Load())
}

func TestCachedGetUserQuota_TableDriven(t *testing.T) {
	tests := []struct {
		name          string
		userID        string
		setupStore    func(*countingFakeStore)
		calls         int
		wantQuota     UserQuota
		wantErr       bool
		expectedCalls int64
	}{
		{
			name:   "quota positive cache hit",
			userID: "user_pro",
			setupStore: func(s *countingFakeStore) {
				s.quotas["user_pro"] = UserQuota{
					Role:       "PRO",
					Tier:       "pro",
					IsBanned:   false,
					RpmLimit:   120,
					DailyLimit: 1000,
					TokenCap:   16000,
				}
			},
			calls: 4,
			wantQuota: UserQuota{
				Role:       "PRO",
				Tier:       "pro",
				IsBanned:   false,
				RpmLimit:   120,
				DailyLimit: 1000,
				TokenCap:   16000,
			},
			wantErr:       false,
			expectedCalls: 1,
		},
		{
			name:   "quota default fallback on missing user",
			userID: "user_default",
			setupStore: func(s *countingFakeStore) {

			},
			calls: 3,
			wantQuota: UserQuota{
				Role:       "USER",
				RpmLimit:   30,
				DailyLimit: 100,
				TokenCap:   4000,
			},
			wantErr:       false,
			expectedCalls: 1,
		},
		{
			name:   "quota db error not cached",
			userID: "user_err",
			setupStore: func(s *countingFakeStore) {
				s.quotaErr = errors.New("db timeout")
			},
			calls:         2,
			wantQuota:     UserQuota{},
			wantErr:       true,
			expectedCalls: 2,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newCountingFakeStore(t)
			tt.setupStore(store)
			srv := newTestServerWithStore(t, store)

			ctx := context.Background()
			for i := 0; i < tt.calls; i++ {
				q, err := srv.cachedGetUserQuota(ctx, tt.userID)
				if tt.wantErr {
					assert.Error(t, err)
				} else {
					assert.NoError(t, err)
					assert.Equal(t, tt.wantQuota, q)
				}
			}

			assert.Equal(t, tt.expectedCalls, store.quotaLookups.Load())
		})
	}
}

func TestCachedLookupToken_NegativeCacheExpiration(t *testing.T) {
	store := newCountingFakeStore(t)

	shortCache := newTTLCache(30*time.Millisecond, 100)
	srv := newTestServerWithStore(t, store)
	srv.tokenCache = shortCache

	ctx := context.Background()

	rec1, err1 := srv.cachedLookupToken(ctx, "temp_invalid")
	require.NoError(t, err1)
	assert.Nil(t, rec1)
	assert.Equal(t, int64(1), store.tokenLookups.Load())

	rec2, err2 := srv.cachedLookupToken(ctx, "temp_invalid")
	require.NoError(t, err2)
	assert.Nil(t, rec2)
	assert.Equal(t, int64(1), store.tokenLookups.Load())

	srv.tokenCache.mu.Lock()
	if e, ok := srv.tokenCache.entries["temp_invalid"]; ok {
		e.expires = time.Now().Add(-1 * time.Second)
	}
	srv.tokenCache.mu.Unlock()

	store.mu.Lock()
	store.tokens["temp_invalid"] = &TokenRecord{TokenID: "tok_new", UserID: "usr_new"}
	store.mu.Unlock()

	rec3, err3 := srv.cachedLookupToken(ctx, "temp_invalid")
	require.NoError(t, err3)
	require.NotNil(t, rec3)
	assert.Equal(t, "tok_new", rec3.TokenID)

	assert.Equal(t, int64(2), store.tokenLookups.Load())
}

func TestCachedLookupToken_ClientCancellationIsolation(t *testing.T) {
	store := newCountingFakeStore(t)
	store.tokens["canceling_token_hash"] = &TokenRecord{TokenID: "tok_cancel_iso", UserID: "usr_cancel_iso"}
	store.lookupDelay = 50 * time.Millisecond

	srv := newTestServerWithStore(t, store)

	ctx1, cancel1 := context.WithCancel(context.Background())
	ctx2 := context.Background()

	var wg sync.WaitGroup
	wg.Add(2)

	var res2 *TokenRecord
	var err2 error

	go func() {
		defer wg.Done()
		time.Sleep(10 * time.Millisecond)
		cancel1()
		_, _ = srv.cachedLookupToken(ctx1, "canceling_token_hash")
	}()

	go func() {
		defer wg.Done()
		time.Sleep(20 * time.Millisecond)
		res2, err2 = srv.cachedLookupToken(ctx2, "canceling_token_hash")
	}()

	wg.Wait()

	require.NoError(t, err2)
	require.NotNil(t, res2)
	assert.Equal(t, "tok_cancel_iso", res2.TokenID)
	assert.Equal(t, int64(1), store.tokenLookups.Load())
}

func TestTTLCache_LoaderPanicRecovery(t *testing.T) {
	cache := newTTLCache(5*time.Second, 100)

	var wg sync.WaitGroup
	wg.Add(2)

	var err2 error

	go func() {
		defer wg.Done()
		defer func() { _ = recover() }()
		_, _ = cache.getOrLoadWithCustomTTL("panic_key", func() (any, time.Duration, error) {
			time.Sleep(20 * time.Millisecond)
			panic("simulated DB driver crash")
		})
	}()

	go func() {
		defer wg.Done()
		time.Sleep(10 * time.Millisecond)
		_, err2 = cache.getOrLoadWithCustomTTL("panic_key", func() (any, time.Duration, error) {
			return "fallback", time.Minute, nil
		})
	}()

	wg.Wait()

	require.Error(t, err2)
	assert.Contains(t, err2.Error(), "panicked")
}
