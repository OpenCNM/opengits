package market

type ChapterUpdateJobStatus string

const (
	MarketStatusPending   ChapterUpdateJobStatus = "PENDING"
	MarketStatusClaimed   ChapterUpdateJobStatus = "CLAIMED"
	MarketStatusTrial     ChapterUpdateJobStatus = "TRIAL"
	MarketStatusSwapped   ChapterUpdateJobStatus = "SWAPPED"
	MarketStatusRejected  ChapterUpdateJobStatus = "REJECTED"
	MarketStatusFailed    ChapterUpdateJobStatus = "FAILED"
	MarketStatusCancelled ChapterUpdateJobStatus = "CANCELLED"
)

// Authoritative ChapterUpdateJob state machine synced with TS CHAPTER_UPDATE_JOB_STATUS.
var chapterUpdateJobTransitions = map[ChapterUpdateJobStatus]map[ChapterUpdateJobStatus]bool{
	MarketStatusPending: {MarketStatusClaimed: true},
	MarketStatusClaimed: {
		MarketStatusPending: true,
		MarketStatusSwapped: true,
		MarketStatusFailed:  true,
	},
	MarketStatusTrial: {
		MarketStatusSwapped:  true,
		MarketStatusRejected: true,
		MarketStatusFailed:   true,
	},
	MarketStatusSwapped:   {},
	MarketStatusRejected:  {},
	MarketStatusFailed:    {},
	MarketStatusCancelled: {},
}

func CanTransition(from, to ChapterUpdateJobStatus) bool {
	targets, ok := chapterUpdateJobTransitions[from]
	if !ok {
		return false
	}
	return targets[to]
}

func IsTerminal(s ChapterUpdateJobStatus) bool {
	targets, ok := chapterUpdateJobTransitions[s]
	return ok && len(targets) == 0
}

const ReleaseExpiredClaimsSQL = `
	UPDATE "ChapterUpdateJob"
	SET status = 'PENDING', "claimedBy" = NULL, "claimedUntil" = NULL, "frozenCredits" = 0, "updatedAt" = now()
	WHERE status = 'CLAIMED' AND "claimedUntil" < now()`

const FailTrialsWithoutStagingSQL = `
	UPDATE "ChapterUpdateJob"
	SET status = 'FAILED', "errorMessage" = '试读超时且暂存内容缺失', "updatedAt" = now()
	WHERE status = 'TRIAL' AND "voteDeadline" < now() AND "stagedContentId" IS NULL`
