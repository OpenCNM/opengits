package rsg

import (
	"sort"
)

func ComputeThresholds(
	allPaths []string,
	reverseAdjacencyMap map[string][]string,
	pageRankMap map[string]float64,
	coreContractQuantile float64,
	backboneQuantile float64,
) (coreContractThreshold int, backboneThreshold float64) {
	var positiveInDegrees []int
	for _, p := range allPaths {
		deg := len(reverseAdjacencyMap[p])
		if deg > 0 {
			positiveInDegrees = append(positiveInDegrees, deg)
		}
	}
	sort.Ints(positiveInDegrees)
	coreContractThreshold = QuantileValueInt(positiveInDegrees, coreContractQuantile)

	sortedRanks := make([]float64, 0, len(pageRankMap))
	for _, score := range pageRankMap {
		sortedRanks = append(sortedRanks, score)
	}
	sort.Float64s(sortedRanks)
	backboneThreshold = QuantileValueFloat64(sortedRanks, backboneQuantile)

	return coreContractThreshold, backboneThreshold
}

func ClassifyNodeRole(
	p string,
	inDegree int,
	outDegree int,
	prScore float64,
	coreContractThreshold int,
	backboneThreshold float64,
	isIsolatedEntry bool,
) (role GraphNodeRole, isEntryPoint bool, isBackbone bool) {
	isEntryPoint = (inDegree == 0 && outDegree > 0) || (inDegree == 0 && outDegree == 0 && isIsolatedEntry)

	if isEntryPoint {
		role = RoleEntryPoint
	} else if inDegree >= coreContractThreshold && inDegree > 0 && outDegree == 0 {
		role = RoleCoreContract
	} else if inDegree > 0 && outDegree > 0 {
		role = RolePipelineFlow
	} else {
		role = RoleLeafUtility
	}

	isBackbone = prScore >= backboneThreshold || isEntryPoint || role == RoleCoreContract
	return role, isEntryPoint, isBackbone
}
