package ingest

import "os"

type Config struct {
	ArchiveRoot      string
	GitHubAPIBase    string
	GitHubToken      string
	UserAgent        string
	SemanticGraphDir string
}

func LoadConfigFromEnv() Config {
	apiBase := os.Getenv("GITHUB_API_BASE")
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}
	ua := os.Getenv("GITHUB_USER_AGENT")
	if ua == "" {
		ua = "worker-sidecar"
	}
	return Config{
		ArchiveRoot:      os.Getenv("ARCHIVE_ROOT"),
		GitHubAPIBase:    apiBase,
		GitHubToken:      os.Getenv("GITHUB_TOKEN"),
		UserAgent:        ua,
		SemanticGraphDir: os.Getenv("SEMANTIC_GRAPH_DIR"),
	}
}
