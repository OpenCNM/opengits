package market

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
)

type fakeSweepStore struct {
	released   int64
	failed     int64
	releaseErr error
	failErr    error
	calls      []string
}

func (f *fakeSweepStore) ReleaseExpiredClaims(context.Context) (int64, error) {
	f.calls = append(f.calls, "release")
	return f.released, f.releaseErr
}

func (f *fakeSweepStore) FailTrialsWithoutStaging(context.Context) (int64, error) {
	f.calls = append(f.calls, "fail")
	return f.failed, f.failErr
}

func TestSweepMarketTimeoutsHitsBothSegments(t *testing.T) {
	tests := []struct {
		name                string
		released, failed    int64
		releaseErr, failErr error
	}{
		{name: "both segments have expired jobs", released: 2, failed: 1},
		{name: "no expired jobs"},
		{name: "release failure still runs staging sweep", releaseErr: errors.New("release failed"), failed: 1},
		{name: "staging sweep failure is nonfatal", released: 2, failErr: errors.New("staging sweep failed")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeSweepStore{released: tt.released, failed: tt.failed, releaseErr: tt.releaseErr, failErr: tt.failErr}
			SweepMarketTimeouts(t.Context(), store)
			assert.Equal(t, []string{"release", "fail"}, store.calls)
		})
	}
}
