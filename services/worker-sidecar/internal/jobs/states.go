package jobs

type ImportJobStatus string

const (
	StatusQueued    ImportJobStatus = "QUEUED"
	StatusRunning   ImportJobStatus = "RUNNING"
	StatusCompleted ImportJobStatus = "COMPLETED"
	StatusFailed    ImportJobStatus = "FAILED"
)

// Authoritative ImportJob state machine synced with TS IMPORT_JOB_STATUS; all Go UPDATEs stay in internal/jobs.
var importJobTransitions = map[ImportJobStatus]map[ImportJobStatus]bool{
	StatusQueued: {StatusRunning: true},
	StatusRunning: {
		StatusCompleted: true,
		StatusFailed:    true,
	},
	StatusCompleted: {},
	StatusFailed:    {},
}

func CanTransition(from, to ImportJobStatus) bool {
	targets, ok := importJobTransitions[from]
	if !ok {
		return false
	}
	return targets[to]
}

func IsTerminal(s ImportJobStatus) bool {
	targets, ok := importJobTransitions[s]
	return ok && len(targets) == 0
}

func TerminalStates() []ImportJobStatus {
	var out []ImportJobStatus
	for s, targets := range importJobTransitions {
		if len(targets) == 0 {
			out = append(out, s)
		}
	}
	return out
}
