package rsg

import (
	"math"
)

// Accumulate dangling mass and incoming scores in deterministic nodes slice order for bit-identical PageRank output.
func ComputePageRank(
	nodes []string,
	adjacencyMap map[string][]string,
	dampingFactor float64,
	iterations int,
) map[string]float64 {
	n := len(nodes)
	if n == 0 {
		return make(map[string]float64)
	}

	idx := make(map[string]int, n)
	for i, node := range nodes {
		idx[node] = i
	}

	initialScore := 1.0 / float64(n)
	rank := make([]float64, n)
	for i := range rank {
		rank[i] = initialScore
	}

	outDeg := make([]int, n)
	incomingIdx := make([][]int32, n)
	for si, source := range nodes {
		outs := adjacencyMap[source]
		outDeg[si] = len(outs)
		for _, target := range outs {
			if ti, ok := idx[target]; ok {
				incomingIdx[ti] = append(incomingIdx[ti], int32(si))
			}
		}
	}

	var danglingIdx []int32
	for i, node := range nodes {
		if len(adjacencyMap[node]) == 0 {
			danglingIdx = append(danglingIdx, int32(i))
		}
	}

	next := make([]float64, n)
	for iter := 0; iter < iterations; iter++ {
		danglingMass := 0.0
		for _, di := range danglingIdx {
			danglingMass += rank[di]
		}

		for i := 0; i < n; i++ {
			incomingScoreSum := 0.0
			for _, si := range incomingIdx[i] {
				srcOutDegree := outDeg[si]
				if srcOutDegree == 0 {
					srcOutDegree = 1
				}
				incomingScoreSum += rank[si] / float64(srcOutDegree)
			}
			next[i] = (1.0-dampingFactor)/float64(n) + dampingFactor*(incomingScoreSum+danglingMass/float64(n))
		}

		rank, next = next, rank
	}

	out := make(map[string]float64, n)
	for i, node := range nodes {
		out[node] = rank[i]
	}
	return out
}

func QuantileValueFloat64(sortedAscending []float64, quantile float64) float64 {
	n := len(sortedAscending)
	if n == 0 {
		return 0
	}
	index := int(math.Floor(quantile * float64(n-1)))
	if index < 0 {
		index = 0
	}
	if index >= n {
		index = n - 1
	}
	return sortedAscending[index]
}

func QuantileValueInt(sortedAscending []int, quantile float64) int {
	n := len(sortedAscending)
	if n == 0 {
		return 0
	}
	index := int(math.Floor(quantile * float64(n-1)))
	if index < 0 {
		index = 0
	}
	if index >= n {
		index = n - 1
	}
	return sortedAscending[index]
}
