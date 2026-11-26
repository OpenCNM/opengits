package credits

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

type mockCreditsStore struct {
	ledgerFunc    func(ctx context.Context, input CreditsLedgerInput) (*CreditsLedgerResult, error)
	shelfFunc     func(ctx context.Context, input ShelfFeeChargeInput) (*ShelfFeeChargeResult, error)
	importRewFunc func(ctx context.Context, input ImportRewardGrantInput) (*ImportRewardGrantResult, error)
	unlockDueFunc func(ctx context.Context) (*VestingUnlockResult, error)
}

func (m *mockCreditsStore) GetCreditsLedger(ctx context.Context, input CreditsLedgerInput) (*CreditsLedgerResult, error) {
	if m.ledgerFunc != nil {
		return m.ledgerFunc(ctx, input)
	}
	return &CreditsLedgerResult{}, nil
}

func (m *mockCreditsStore) ChargeShelfFeeAndSave(ctx context.Context, input ShelfFeeChargeInput) (*ShelfFeeChargeResult, error) {
	if m.shelfFunc != nil {
		return m.shelfFunc(ctx, input)
	}
	return &ShelfFeeChargeResult{OK: true, Fee: input.Fee}, nil
}

func (m *mockCreditsStore) GrantImportReward(ctx context.Context, input ImportRewardGrantInput) (*ImportRewardGrantResult, error) {
	if m.importRewFunc != nil {
		return m.importRewFunc(ctx, input)
	}
	return &ImportRewardGrantResult{Granted: true, Amount: input.Amount}, nil
}

func (m *mockCreditsStore) UnlockDuePendingCredits(ctx context.Context) (*VestingUnlockResult, error) {
	if m.unlockDueFunc != nil {
		return m.unlockDueFunc(ctx)
	}
	return &VestingUnlockResult{UnlockedCount: 0, TotalCredits: 0}, nil
}

func TestHandleLedger(t *testing.T) {
	tests := []struct {
		name       string
		body       any
		storeErr   error
		wantStatus int
	}{
		{
			name:       "missing userId returns 400",
			body:       map[string]any{"userId": ""},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "store error returns 500",
			body:       map[string]any{"userId": "user-1", "page": 1, "pageSize": 20},
			storeErr:   errors.New("db error"),
			wantStatus: http.StatusInternalServerError,
		},
		{
			name:       "success returns 200",
			body:       map[string]any{"userId": "user-1", "page": 1, "pageSize": 20},
			wantStatus: http.StatusOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &mockCreditsStore{
				ledgerFunc: func(ctx context.Context, input CreditsLedgerInput) (*CreditsLedgerResult, error) {
					if tt.storeErr != nil {
						return nil, tt.storeErr
					}
					return &CreditsLedgerResult{
						Entries:    []LedgerEntry{},
						Pagination: PaginationInfo{Total: 0, Page: 1, PageSize: 20, TotalPages: 1},
						Balance:    100,
						SavedRepos: 2,
					}, nil
				},
			}
			h := NewHandler(store)

			raw, _ := json.Marshal(tt.body)
			req := httptest.NewRequest(http.MethodPost, "/v1/credits/ledger", bytes.NewReader(raw))
			rec := httptest.NewRecorder()

			h.HandleLedger(rec, req)
			if rec.Code != tt.wantStatus {
				t.Fatalf("expected status %d, got %d", tt.wantStatus, rec.Code)
			}
		})
	}
}

func TestHandleShelfFeeCharge(t *testing.T) {
	tests := []struct {
		name       string
		body       any
		wantStatus int
	}{
		{
			name:       "missing fields returns 400",
			body:       map[string]any{"userId": ""},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "success returns 200",
			body:       map[string]any{"userId": "user-1", "repositoryId": "repo-1", "fee": 10},
			wantStatus: http.StatusOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &mockCreditsStore{}
			h := NewHandler(store)

			raw, _ := json.Marshal(tt.body)
			req := httptest.NewRequest(http.MethodPost, "/v1/credits/shelf-fee/charge", bytes.NewReader(raw))
			rec := httptest.NewRecorder()

			h.HandleShelfFeeCharge(rec, req)
			if rec.Code != tt.wantStatus {
				t.Fatalf("expected %d, got %d", tt.wantStatus, rec.Code)
			}
		})
	}
}

func TestHandleImportRewardGrant(t *testing.T) {
	tests := []struct {
		name       string
		body       any
		wantStatus int
	}{
		{
			name:       "missing fields returns 400",
			body:       map[string]any{"userId": ""},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "success returns 200",
			body:       map[string]any{"userId": "user-1", "repositoryId": "repo-1", "amount": 100, "owner": "test", "repo": "test"},
			wantStatus: http.StatusOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &mockCreditsStore{}
			h := NewHandler(store)

			raw, _ := json.Marshal(tt.body)
			req := httptest.NewRequest(http.MethodPost, "/v1/credits/import-reward/grant", bytes.NewReader(raw))
			rec := httptest.NewRecorder()

			h.HandleImportRewardGrant(rec, req)
			if rec.Code != tt.wantStatus {
				t.Fatalf("expected %d, got %d", tt.wantStatus, rec.Code)
			}
		})
	}
}
