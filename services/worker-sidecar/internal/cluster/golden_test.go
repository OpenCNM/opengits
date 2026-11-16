package cluster

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ─────────────────────────────────────────────────────────────
// 聚类双实现共享 golden 对拍：夹具由 TS code-cluster-recompute（契约事实源）
// 夹具为冻结手工维护契约（原 TS 生成脚本已于 2026-11 死代码清算退役）。
// 防御「各写各的测试」漂移：两侧都绿 ⇔ 两侧行为一致。
// ─────────────────────────────────────────────────────────────

type paritySnapshot struct {
	TeachingOrder int             `json:"teachingOrder"`
	ChapterNo     int             `json:"chapterNo"`
	Title         string          `json:"title"`
	Summary       string          `json:"summary"`
	Directories   []string        `json:"directories"`
	Granularity   string          `json:"granularity"`
	Files         []string        `json:"files"`
	Cognitive     json.RawMessage `json:"cognitive,omitempty"`
}

type parityRemoved struct {
	TeachingOrder int    `json:"teachingOrder"`
	Title         string `json:"title"`
}

type parityMatched struct {
	Old        paritySnapshot `json:"old"`
	Neu        paritySnapshot `json:"neu"`
	Similarity float64        `json:"similarity"`
}

type parityDiff struct {
	Added   []paritySnapshot `json:"added"`
	Removed []parityRemoved  `json:"removed"`
	Matched []parityMatched  `json:"matched"`
}

func toParitySnapshot(m ModuleSnapshot) paritySnapshot {
	return paritySnapshot{
		TeachingOrder: m.TeachingOrder,
		ChapterNo:     m.ChapterNo,
		Title:         m.Title,
		Summary:       m.Summary,
		Directories:   m.Directories,
		Granularity:   m.Granularity,
		Files:         m.Files,
		Cognitive:     m.Cognitive,
	}
}

func jsonEqual(t *testing.T, got, want any, msg string) {
	t.Helper()
	g, err := json.Marshal(got)
	require.NoError(t, err)
	w, err := json.Marshal(want)
	require.NoError(t, err)
	assert.JSONEq(t, string(w), string(g), "%s\nwant: %s\ngot:  %s", msg, w, g)
}

func findGoldenPath() string {
	candidates := []string{
		"testdata/cluster.golden.json",
		"../../testdata/cluster.golden.json",
		"services/worker-sidecar/testdata/cluster.golden.json",
		"/app/testdata/cluster.golden.json",
		"/src/services/worker-sidecar/testdata/cluster.golden.json",
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "testdata/cluster.golden.json"
}

func TestClusterGoldenParity(t *testing.T) {
	patterns, err := LoadIngestPatterns("")
	require.NoError(t, err)
	require.NotNil(t, patterns)

	goldenPath := findGoldenPath()
	raw, err := os.ReadFile(goldenPath)
	require.NoError(t, err, "cluster.golden.json missing (frozen fixture, hand-maintained)")

	var fixture struct {
		Cases []struct {
			Name        string           `json:"name"`
			OldClusters []ModuleSnapshot `json:"oldClusters"`
			NewTree     []struct {
				Path string `json:"path"`
				Type string `json:"type"`
				Size int64  `json:"size"`
			} `json:"newTree"`
			Expected struct {
				Recomputed  []paritySnapshot `json:"recomputed"`
				ClusterDiff parityDiff       `json:"clusterDiff"`
			} `json:"expected"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Cases)

	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			nodes := make([]GitNode, len(tc.NewTree))
			for i, n := range tc.NewTree {
				nodes[i] = GitNode{Path: n.Path, Type: n.Type, Size: n.Size}
			}

			recomputed := RecomputeModuleSnapshots(tc.OldClusters, nodes, patterns)
			gotSnaps := make([]paritySnapshot, len(recomputed))
			for i, m := range recomputed {
				gotSnaps[i] = toParitySnapshot(m)
			}
			jsonEqual(t, gotSnaps, tc.Expected.Recomputed, "recomputed snapshots")

			diff := DiffCodeClusters(tc.OldClusters, recomputed)
			gotDiff := parityDiff{
				Added:   []paritySnapshot{},
				Removed: make([]parityRemoved, len(diff.Removed)),
				Matched: make([]parityMatched, len(diff.Matched)),
			}
			for _, a := range diff.Added {
				gotDiff.Added = append(gotDiff.Added, toParitySnapshot(a))
			}
			for i, r := range diff.Removed {
				gotDiff.Removed[i] = parityRemoved{TeachingOrder: r.TeachingOrder, Title: r.Title}
			}
			for i, m := range diff.Matched {
				gotDiff.Matched[i] = parityMatched{
					Old:        toParitySnapshot(m.Old),
					Neu:        toParitySnapshot(m.Neu),
					Similarity: m.Similarity,
				}
			}
			jsonEqual(t, gotDiff, tc.Expected.ClusterDiff, "cluster diff")
		})
	}
}
