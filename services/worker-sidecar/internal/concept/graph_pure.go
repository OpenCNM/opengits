package concept

import (
	"sort"
)

const (
	CooccurrenceChunkWeight = 1.0
	CurriculumEdgeWeight    = 0.3
)

// ConceptSeed represents a concept instance within a document chunk.
type ConceptSeed struct {
	ID         string  `json:"id"`
	DocumentID *string `json:"documentId,omitempty"`
	ChunkID    *string `json:"chunkId,omitempty"`
}

// DerivedEdge represents an inferred relationship edge in the concept graph.
type DerivedEdge struct {
	SourceID string         `json:"sourceId"`
	TargetID string         `json:"targetId"`
	Type     string         `json:"type"`
	Weight   float64        `json:"weight"`
	Source   string         `json:"source"`
	Meta     map[string]any `json:"meta,omitempty"`
}

// EdgeRef represents an established edge reference for path/cycle computation.
type EdgeRef struct {
	SourceID string  `json:"sourceId"`
	TargetID string  `json:"targetId"`
	Type     string  `json:"type"`
	Weight   float64 `json:"weight"`
	Source   string  `json:"source,omitempty"`
}

// FilterPrerequisiteResult contains surviving candidate edges and drop count.
type FilterPrerequisiteResult struct {
	Kept    []DerivedEdge `json:"kept"`
	Dropped int           `json:"dropped"`
}

// DeriveCooccurrenceEdges infers bidirectional 'related' edges between concepts co-occurring in the same chunk.
func DeriveCooccurrenceEdges(concepts []ConceptSeed) []DerivedEdge {
	byChunk := make(map[string][]string)
	for _, c := range concepts {
		if c.ChunkID != nil && *c.ChunkID != "" {
			cid := *c.ChunkID
			byChunk[cid] = append(byChunk[cid], c.ID)
		}
	}

	edgesMap := make(map[string]DerivedEdge)
	addPair := func(a, b string, chunkID string) {
		if a == b {
			return
		}
		sourceID, targetID := a, b
		if a > b {
			sourceID, targetID = b, a
		}
		key := sourceID + "|" + targetID + "|related"
		if _, exists := edgesMap[key]; !exists {
			edgesMap[key] = DerivedEdge{
				SourceID: sourceID,
				TargetID: targetID,
				Type:     "related",
				Weight:   CooccurrenceChunkWeight,
				Source:   "cooccurrence",
				Meta:     map[string]any{"chunkId": chunkID},
			}
		}
	}

	for chunkID, list := range byChunk {
		for i := 0; i < len(list); i++ {
			for j := i + 1; j < len(list); j++ {
				addPair(list[i], list[j], chunkID)
			}
		}
	}

	var result []DerivedEdge
	for _, e := range edgesMap {
		result = append(result, e)
	}

	sort.Slice(result, func(i, j int) bool {
		if result[i].SourceID != result[j].SourceID {
			return result[i].SourceID < result[j].SourceID
		}
		return result[i].TargetID < result[j].TargetID
	})

	return result
}

// DeriveCurriculumOrderEdges builds successor edges following linear curriculum order across documents.
func DeriveCurriculumOrderEdges(orderedConceptIds [][]string) []DerivedEdge {
	var edges []DerivedEdge
	for i := 0; i+1 < len(orderedConceptIds); i++ {
		earlier := orderedConceptIds[i]
		later := orderedConceptIds[i+1]
		if len(earlier) == 0 || len(later) == 0 {
			continue
		}

		// Sort earlier to find lexicographically smallest representative
		sortedEarlier := make([]string, len(earlier))
		copy(sortedEarlier, earlier)
		sort.Strings(sortedEarlier)
		representative := sortedEarlier[0]

		for _, tgt := range later {
			if tgt == representative {
				continue
			}
			edges = append(edges, DerivedEdge{
				SourceID: representative,
				TargetID: tgt,
				Type:     "successor",
				Weight:   CurriculumEdgeWeight,
				Source:   "curriculum_order",
				Meta:     map[string]any{"docGap": float64(1)},
			})
		}
	}
	if edges == nil {
		edges = []DerivedEdge{}
	}
	return edges
}

type scarcityItem struct {
	edge     DerivedEdge
	idx      int
	scarcity int
}

// PrioritizeEdgesForBudget prioritizes curriculum edges unconditionally, then truncates
// cooccurrence edges according to scarcity (sum of endpoints degrees) up to cap.
func PrioritizeEdgesForBudget(curriculumEdges, cooccurrenceEdges []DerivedEdge, cap int) []DerivedEdge {
	if cap <= 0 {
		return []DerivedEdge{}
	}
	remaining := cap - len(curriculumEdges)
	if remaining <= 0 {
		out := make([]DerivedEdge, len(curriculumEdges))
		copy(out, curriculumEdges)
		return out
	}
	if remaining >= len(cooccurrenceEdges) {
		out := make([]DerivedEdge, 0, len(curriculumEdges)+len(cooccurrenceEdges))
		out = append(out, curriculumEdges...)
		out = append(out, cooccurrenceEdges...)
		return out
	}

	degree := make(map[string]int)
	for _, e := range cooccurrenceEdges {
		degree[e.SourceID]++
		degree[e.TargetID]++
	}

	items := make([]scarcityItem, len(cooccurrenceEdges))
	for idx, e := range cooccurrenceEdges {
		items[idx] = scarcityItem{
			edge:     e,
			idx:      idx,
			scarcity: degree[e.SourceID] + degree[e.TargetID],
		}
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].scarcity != items[j].scarcity {
			return items[i].scarcity < items[j].scarcity
		}
		keyI := items[i].edge.SourceID + items[i].edge.TargetID
		keyJ := items[j].edge.SourceID + items[j].edge.TargetID
		if keyI != keyJ {
			return keyI < keyJ
		}
		return items[i].idx < items[j].idx
	})

	out := make([]DerivedEdge, 0, len(curriculumEdges)+remaining)
	out = append(out, curriculumEdges...)
	for i := 0; i < remaining; i++ {
		out = append(out, items[i].edge)
	}
	return out
}

// FilterPrerequisiteCandidates validates candidate edges against existing prerequisite/successor graph,
// rejecting reverse conflicts and transitive cycle-closing candidates.
func FilterPrerequisiteCandidates(candidates []DerivedEdge, established []EdgeRef) FilterPrerequisiteResult {
	forward := make(map[string][]string)
	reversePairs := make(map[string]bool)

	for _, e := range established {
		if e.Type != "prerequisite" && e.Type != "successor" {
			continue
		}
		forward[e.SourceID] = append(forward[e.SourceID], e.TargetID)
		reversePairs[e.SourceID+"|"+e.TargetID] = true
	}

	reaches := func(from, to string) bool {
		if from == to {
			return true
		}
		seen := make(map[string]bool)
		seen[from] = true
		stack := []string{from}

		for len(stack) > 0 {
			cur := stack[len(stack)-1]
			stack = stack[:len(stack)-1]

			for _, next := range forward[cur] {
				if next == to {
					return true
				}
				if !seen[next] {
					seen[next] = true
					stack = append(stack, next)
				}
			}
		}
		return false
	}

	var kept []DerivedEdge
	dropped := 0

	for _, cand := range candidates {
		if cand.Type != "prerequisite" {
			kept = append(kept, cand)
			continue
		}

		// 1) Reverse conflict: target -> source already established
		if reversePairs[cand.TargetID+"|"+cand.SourceID] {
			dropped++
			continue
		}

		// 2) Transitive cycle: target already reaches source
		if reaches(cand.TargetID, cand.SourceID) {
			dropped++
			continue
		}

		kept = append(kept, cand)
		forward[cand.SourceID] = append(forward[cand.SourceID], cand.TargetID)
	}

	if kept == nil {
		kept = []DerivedEdge{}
	}

	return FilterPrerequisiteResult{
		Kept:    kept,
		Dropped: dropped,
	}
}
