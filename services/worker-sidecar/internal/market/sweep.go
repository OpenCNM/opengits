package market

import (
	"context"
	"log"
)

type Sweeper interface {
	ReleaseExpiredClaims(ctx context.Context) (int64, error)
	FailTrialsWithoutStaging(ctx context.Context) (int64, error)
}

// Idempotent CAS sweeps align with resolveTimeouts before worker dispatch.
func SweepMarketTimeouts(ctx context.Context, s Sweeper) {
	if n, err := s.ReleaseExpiredClaims(ctx); err == nil && n > 0 {
		log.Printf("[auto-update] go sweep: released %d expired claims", n)
	}
	if n, err := s.FailTrialsWithoutStaging(ctx); err == nil && n > 0 {
		log.Printf("[auto-update] go sweep: terminalized %d bad TRIAL jobs", n)
	}
}
