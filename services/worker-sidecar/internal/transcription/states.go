package transcription

type TranscriptionJobStatus string

const (
	TStatusQueued  TranscriptionJobStatus = "QUEUED"
	TStatusRunning TranscriptionJobStatus = "RUNNING"
	TStatusDone    TranscriptionJobStatus = "DONE"
	TStatusFailed  TranscriptionJobStatus = "FAILED"
)

var transcriptionTransitions = map[TranscriptionJobStatus]map[TranscriptionJobStatus]bool{
	TStatusQueued: {TStatusRunning: true},
	TStatusRunning: {
		TStatusDone:   true,
		TStatusQueued: true,
		TStatusFailed: true,
	},
	TStatusDone:   {TStatusQueued: true},
	TStatusFailed: {TStatusQueued: true},
}

// Unlike ImportJob, DONE and FAILED retain reopen edges to QUEUED for fingerprint-based re-transcription.
func CanTranscribeTransition(from, to TranscriptionJobStatus) bool {
	targets, ok := transcriptionTransitions[from]
	if !ok {
		return false
	}
	return targets[to]
}

func IsTranscriptionSettled(s TranscriptionJobStatus) bool {
	_, ok := transcriptionTransitions[s]
	return ok && s != TStatusQueued && s != TStatusRunning
}
