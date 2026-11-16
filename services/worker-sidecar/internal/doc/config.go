package doc

// Config defines the configuration required by the doc service.
type Config struct {
	DefaultBranch    string
	ContentDualWrite bool
	ChunkerMaxTokens int
	ChunkerOverlap   int
}
