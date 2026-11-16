package transcription

// Config 转录执行引擎与调度器专用配置。
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
