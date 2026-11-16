package jobs

import (
	"context"
	"fmt"
	"log"

	"github.com/opengits/worker-sidecar/internal/credits"
)

// VestingReaperStore defines the subset of credits operations needed by the vesting reaper.
type VestingReaperStore interface {
	UnlockDuePendingCredits(ctx context.Context) (*credits.VestingUnlockResult, error)
}

// RunVestingReaperOnce runs a single sweep over matured pending credit grants and unlocks them.
func RunVestingReaperOnce(ctx context.Context, store VestingReaperStore) (*credits.VestingUnlockResult, error) {
	if store == nil {
		return nil, fmt.Errorf("vesting reaper store is nil")
	}

	res, err := store.UnlockDuePendingCredits(ctx)
	if err != nil {
		log.Printf("[vesting-reaper] failed to unlock due pending credits: %v", err)
		return nil, err
	}

	if res != nil && res.UnlockedCount > 0 {
		log.Printf("[vesting-reaper] unlocked %d pending credit grants totaling %d credits", res.UnlockedCount, res.TotalCredits)
	}

	return res, nil
}
