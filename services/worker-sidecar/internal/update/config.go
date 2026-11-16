package update

import "github.com/opengits/worker-sidecar/internal/market"

// Config defines the configuration required by the update engine.
type Config struct {
	ArchiveRoot         string
	GitHubToken         string
	GitHubAPIBase       string
	UserAgent           string
	AutoUpdateMaxWallMs int
	InternalToken       string
	ContentDualWrite    bool
	ChunkerMaxTokens    int
	ChunkerOverlap      int
}

// MarketConfig projects update Config to market.Config.
func (c Config) MarketConfig() market.Config {
	return market.Config{
		ContentDualWrite: c.ContentDualWrite,
		ChunkerMaxTokens: c.ChunkerMaxTokens,
		ChunkerOverlap:   c.ChunkerOverlap,
	}
}
