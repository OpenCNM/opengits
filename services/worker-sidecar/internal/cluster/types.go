package cluster

import "encoding/json"

const ModuleMatchThreshold = 0.4

type GitNode struct {
	Path string `json:"path"`
	Type string `json:"type"`
	Size int64  `json:"size,omitempty"`
}

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

type ClusterMatchedPair struct {
	Old        ModuleSnapshot `json:"old"`
	Neu        ModuleSnapshot `json:"neu"`
	Similarity float64        `json:"similarity"`
}

type ClusterRemovedItem struct {
	TeachingOrder int    `json:"teachingOrder"`
	Title         string `json:"title"`
}

type ClusterDiffResult struct {
	Added   []ModuleSnapshot     `json:"added"`
	Removed []ClusterRemovedItem `json:"removed"`
	Matched []ClusterMatchedPair `json:"matched"`
}

type ClusterRecomputeRequest struct {
	Owner       string           `json:"owner,omitempty"`
	Repo        string           `json:"repo,omitempty"`
	ToSha       string           `json:"toSha,omitempty"`
	ArchiveRoot string           `json:"archiveRoot,omitempty"`
	OldClusters []ModuleSnapshot `json:"oldClusters"`
	NewTree     []GitNode        `json:"newTree,omitempty"`
}

type ClusterRecomputeResponse struct {
	Recomputed  []ModuleSnapshot  `json:"recomputed"`
	ClusterDiff ClusterDiffResult `json:"clusterDiff"`
}

type DraftModuleInput struct {
	Name        string   `json:"name,omitempty"`
	Summary     string   `json:"summary,omitempty"`
	Directories []string `json:"directories,omitempty"`
	Granularity string   `json:"granularity,omitempty"`
}
