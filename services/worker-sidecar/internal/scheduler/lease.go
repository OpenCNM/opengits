package scheduler

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"time"
)

var leaseOwner = func() string {
	b := make([]byte, 2)
	if _, err := rand.Read(b); err != nil {
		log.Fatal("[lease] rand read failed:", err)
	}
	return fmt.Sprintf("worker-go-%d-%s", os.Getpid(), hex.EncodeToString(b))
}()

func LeaseOwner() string {
	return leaseOwner
}

// Use CAS table leases rather than pg_advisory_lock; session locks drift on pools and xact locks pin connections for minutes.
func AcquireLeaseWithOwner(ctx context.Context, store TaskStore, key, owner string, ttl time.Duration) bool {
	if owner == "" {
		owner = leaseOwner
	}
	until := time.Now().Add(ttl).UTC()
	n, err := store.LeaseUpdateIfHeldOrExpired(ctx, key, owner, until)
	if err == nil && n == 1 {
		return true
	}
	if err != nil {
		// Fail closed on DB errors by skipping the cycle rather than risking dual execution.
		log.Printf("[lease] acquire (fast path) failed for %s (skip this cycle): %v", key, err)
		return false
	}
	if err := store.LeaseInsert(ctx, key, owner, until); err != nil {
		log.Printf("[lease] acquire failed for %s (skip this cycle): %v", key, err)
		return false
	}
	return true
}

func AcquireLease(ctx context.Context, store TaskStore, key string, ttl time.Duration) bool {
	return AcquireLeaseWithOwner(ctx, store, key, leaseOwner, ttl)
}

func acquireLease(ctx context.Context, store TaskStore, key string, ttl time.Duration) bool {
	return AcquireLease(ctx, store, key, ttl)
}

func LeaseTtlFromInterval(d time.Duration) time.Duration { return d * 2 }

func leaseTtlFromInterval(d time.Duration) time.Duration { return LeaseTtlFromInterval(d) }

func ReleaseLeaseWithOwner(ctx context.Context, store TaskStore, key, owner string) {
	if owner == "" {
		owner = leaseOwner
	}
	_ = store.LeaseDelete(ctx, key, owner)
}

// Release owned leases on shutdown so restarted instances do not stall until TTL expiry.
func ReleaseLease(ctx context.Context, store TaskStore, key string) {
	ReleaseLeaseWithOwner(ctx, store, key, leaseOwner)
}

func releaseLease(ctx context.Context, store TaskStore, key string) {
	ReleaseLease(ctx, store, key)
}
