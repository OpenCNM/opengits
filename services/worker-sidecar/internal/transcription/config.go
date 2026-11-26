package transcription

type Config struct {
	TranscriptionPollMs      int
	TranscriptionMaxPerCycle int
	TranscriptionConcurrency int
	TranscriptionStaleMs     int
	TranscriptionMaxWallMs   int
	TranscriptionExecutor    string
	ArchiveRoot              string
	SemanticGraphDir         string
	DefaultBranch            string
	ContentDualWrite         bool
	ChunkerMaxTokens         int
	ChunkerOverlap           int
}
