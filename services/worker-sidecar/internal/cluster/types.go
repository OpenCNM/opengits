package cluster

import "encoding/json"

// ModuleMatchThreshold is the Jaccard similarity threshold below which modules are considered distinct.
const ModuleMatchThreshold = 0.4

// GitNode represents a node in a git tree or archive.
type GitNode struct {
	Path string `json:"path"`
	Type string `json:"type"` // "tree" | "blob"
	Size int64  `json:"size,omitempty"`
}

// ModuleSnapshot represents a teaching code module snapshot, congruent with TypeScript ModuleSnapshot.
type ModuleSnapshot struct {
	TeachingOrder int             `json:"teachingOrder"`
	ChapterNo     int             `json:"chapterNo,omitempty"`
	Title         string          `json:"title"`
	Summary       string          `json:"summary"`
	Directories   []string        `json:"directories"`
	Granularity   string          `json:"granularity,omitempty"`
	Files         []string        `json:"files"`
	PartTitle     string          `json:"partTitle,omitempty"`
	Cognitive     json.RawMessage `json:"cognitive,omitempty"`
}

// ClusterMatchedPair represents a matched pair of old and new module snapshots.
type ClusterMatchedPair struct {
	Old        ModuleSnapshot `json:"old"`
	Neu        ModuleSnapshot `json:"neu"`
	Similarity float64        `json:"similarity"`
}

// ClusterRemovedItem represents metadata for a removed module.
type ClusterRemovedItem struct {
	TeachingOrder int    `json:"teachingOrder"`
	Title         string `json:"title"`
}

// ClusterDiffResult contains added, removed, and matched cluster diff items.
type ClusterDiffResult struct {
	Added   []ModuleSnapshot     `json:"added"`
	Removed []ClusterRemovedItem `json:"removed"`
	Matched []ClusterMatchedPair `json:"matched"`
}

// ClusterRecomputeRequest input payload for /v1/clusters/recompute.
type ClusterRecomputeRequest struct {
	Owner       string           `json:"owner,omitempty"`
	Repo        string           `json:"repo,omitempty"`
	ToSha       string           `json:"toSha,omitempty"`
	ArchiveRoot string           `json:"archiveRoot,omitempty"`
	OldClusters []ModuleSnapshot `json:"oldClusters"`
	NewTree     []GitNode        `json:"newTree,omitempty"`
}

// ClusterRecomputeResponse output payload for /v1/clusters/recompute.
type ClusterRecomputeResponse struct {
	Recomputed  []ModuleSnapshot  `json:"recomputed"`
	ClusterDiff ClusterDiffResult `json:"clusterDiff"`
}

// DraftModuleInput represents raw module inputs from outline drafting.
type DraftModuleInput struct {
	Name        string   `json:"name,omitempty"`
	Summary     string   `json:"summary,omitempty"`
	Directories []string `json:"directories,omitempty"`
	Granularity string   `json:"granularity,omitempty"`
}
