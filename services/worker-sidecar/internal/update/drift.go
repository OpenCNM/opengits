package update

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive/pipelineb"
	"github.com/opengits/worker-sidecar/internal/diff"
)

type NodeDriftStatus string

const (
	NodeDriftStable   NodeDriftStatus = "stable"
	NodeDriftModified NodeDriftStatus = "modified"
	NodeDriftBreaking NodeDriftStatus = "breaking"
)

type EdgeDriftStatus string

const (
	EdgeDriftStable EdgeDriftStatus = "stable"
	EdgeDriftRipple EdgeDriftStatus = "ripple"
	EdgeDriftBroken EdgeDriftStatus = "broken"
)

type NodeDriftInfo struct {
	NodeID       string          `json:"nodeId"`
	Path         string          `json:"path"`
	Name         string          `json:"name"`
	Status       NodeDriftStatus `json:"status"`
	Summary      string          `json:"summary"`
	ChangedFiles []string        `json:"changedFiles"`
	RippleFiles  []string        `json:"rippleFiles"`
}

type EdgeDriftInfo struct {
	From   string          `json:"from"`
	To     string          `json:"to"`
	Status EdgeDriftStatus `json:"status"`
	Reason string          `json:"reason,omitempty"`
}

type ArchitectureDrift struct {
	HasDrift        bool            `json:"hasDrift"`
	IsCrossBoundary bool            `json:"isCrossBoundary"`
	Verdict         string          `json:"verdict"`
	AffectedNodes   []NodeDriftInfo `json:"affectedNodes"`
	AffectedEdges   []EdgeDriftInfo `json:"affectedEdges"`
	DriftMermaid    string          `json:"driftMermaid"`
}

func MapFileToMacroNode(filePath string, nodes []pipelineb.MacroTopologyNode) string {
	normalized := filepath.ToSlash(filePath)
	cleanPath := strings.TrimPrefix(normalized, "/")

	var bestNodeID string
	bestPrefixLen := -1

	for _, n := range nodes {
		if n.Path == "." || strings.EqualFold(n.Name, "entrypoint") {
			if !strings.Contains(cleanPath, "/") {
				return n.ID
			}
			continue
		}

		nodeDir := strings.TrimPrefix(filepath.ToSlash(n.Path), "/")
		if nodeDir == "" {
			continue
		}

		if cleanPath == nodeDir || strings.HasPrefix(cleanPath, nodeDir+"/") {
			if len(nodeDir) > bestPrefixLen {
				bestPrefixLen = len(nodeDir)
				bestNodeID = n.ID
			}
		}
	}

	if bestNodeID != "" {
		return bestNodeID
	}

	for _, n := range nodes {
		if strings.Contains(strings.ToLower(n.ID), "utils") || strings.Contains(strings.ToLower(n.ID), "common") {
			return n.ID
		}
	}

	return ""
}

func ComputeArchitectureDrift(
	topo *pipelineb.MacroTopology,
	diffResult *UpdateArchiveDiff,
	fileDiffs map[string]diff.FileSemanticDiff,
	rippleCallers map[string][]diff.SurgicalAnchor,
) *ArchitectureDrift {
	if topo == nil || len(topo.Nodes) == 0 {
		return nil
	}

	// Memoize MapFileToMacroNode per filePath across the triple loop because topology nodes are invariant.
	memo := make(map[string]string)
	mapFile := func(filePath string) string {
		if v, ok := memo[filePath]; ok {
			return v
		}
		v := MapFileToMacroNode(filePath, topo.Nodes)
		memo[filePath] = v
		return v
	}

	nodeMap := make(map[string]*NodeDriftInfo, len(topo.Nodes))
	for _, n := range topo.Nodes {
		nodeMap[n.ID] = &NodeDriftInfo{
			NodeID:       n.ID,
			Path:         n.Path,
			Name:         n.Name,
			Status:       NodeDriftStable,
			Summary:      "未受本次提交影响",
			ChangedFiles: []string{},
			RippleFiles:  []string{},
		}
	}

	if diffResult != nil {
		allPhysChanged := make([]string, 0, len(diffResult.Modified)+len(diffResult.Added)+len(diffResult.Removed))
		allPhysChanged = append(allPhysChanged, diffResult.Modified...)
		allPhysChanged = append(allPhysChanged, diffResult.Added...)
		allPhysChanged = append(allPhysChanged, diffResult.Removed...)

		for _, f := range allPhysChanged {
			nodeID := mapFile(f)
			if info, ok := nodeMap[nodeID]; ok {
				info.ChangedFiles = append(info.ChangedFiles, f)
			}
		}
	}

	for callerFile := range rippleCallers {
		nodeID := mapFile(callerFile)
		if info, ok := nodeMap[nodeID]; ok {
			alreadyPresent := false
			for _, existing := range info.RippleFiles {
				if existing == callerFile {
					alreadyPresent = true
					break
				}
			}
			if !alreadyPresent {
				info.RippleFiles = append(info.RippleFiles, callerFile)
			}
		}
	}

	removedSet := make(map[string]bool)
	if diffResult != nil {
		for _, f := range diffResult.Removed {
			removedSet[f] = true
		}
	}

	hasBreakingNode := false
	hasModifiedNode := false

	for _, n := range topo.Nodes {
		info := nodeMap[n.ID]
		if len(info.ChangedFiles) == 0 && len(info.RippleFiles) == 0 {
			info.Status = NodeDriftStable
			continue
		}

		isBreaking := false
		var breakingReasons []string

		for _, f := range info.ChangedFiles {
			if removedSet[f] {
				for extCaller, anchors := range rippleCallers {
					extNodeID := mapFile(extCaller)
					if extNodeID != "" && extNodeID != n.ID {
						for _, anchor := range anchors {
							if strings.Contains(anchor.Reason, f) || strings.Contains(anchor.Reason, "已被删除") {
								isBreaking = true
								breakingReasons = append(breakingReasons, fmt.Sprintf("模块核心文件 %s 已删除，导致外部模块 [%s] 调用中断", filepath.Base(f), extNodeID))
								break
							}
						}
					}
					if isBreaking {
						break
					}
				}
			}

			if fd, ok := fileDiffs[f]; ok && fd.Category == diff.FileCategoryExportedChanged {
				for _, sym := range fd.SymbolDiffs {
					if sym.Exported {
						for extCaller, anchors := range rippleCallers {
							extNodeID := mapFile(extCaller)
							if extNodeID != "" && extNodeID != n.ID {
								for _, anchor := range anchors {
									if strings.Contains(anchor.Reason, sym.Name) {
										isBreaking = true
										breakingReasons = append(breakingReasons, fmt.Sprintf("公共接口 %s 发生变更，波及外部模块 [%s]", sym.Name, extNodeID))
										break
									}
								}
							}
							if isBreaking {
								break
							}
						}
					}
					if isBreaking {
						break
					}
				}
			}
		}

		if isBreaking {
			info.Status = NodeDriftBreaking
			info.Summary = strings.Join(breakingReasons, "；")
			hasBreakingNode = true
		} else {
			info.Status = NodeDriftModified
			info.Summary = fmt.Sprintf("内部实现微调（%d 个文件变更），导出契约完好", len(info.ChangedFiles))
			hasModifiedNode = true
		}
	}

	var affectedEdges []EdgeDriftInfo
	hasBrokenEdge := false

	for _, edge := range topo.Edges {
		status := EdgeDriftStable
		reason := ""

		toInfo := nodeMap[edge.To]
		if toInfo != nil && toInfo.Status == NodeDriftBreaking {
			for callerFile, anchors := range rippleCallers {
				if mapFile(callerFile) == edge.From {
					for _, a := range anchors {
						for _, sym := range edge.Symbols {
							if strings.Contains(a.Reason, sym) {
								status = EdgeDriftBroken
								reason = fmt.Sprintf("上游公共接口 %s 发生破坏性变更", sym)
								hasBrokenEdge = true
								break
							}
						}
						if status == EdgeDriftBroken {
							break
						}
					}
				}
				if status == EdgeDriftBroken {
					break
				}
			}

			if status == EdgeDriftStable && len(edge.Symbols) > 0 {
				for _, f := range toInfo.ChangedFiles {
					if fd, ok := fileDiffs[f]; ok {
						for _, sd := range fd.SymbolDiffs {
							for _, sym := range edge.Symbols {
								if sd.Name == sym {
									status = EdgeDriftBroken
									reason = fmt.Sprintf("上游公共接口 %s 签名变更", sym)
									hasBrokenEdge = true
									break
								}
							}
							if status == EdgeDriftBroken {
								break
							}
						}
					}
					if status == EdgeDriftBroken {
						break
					}
				}
			}
		} else if toInfo != nil && len(toInfo.ChangedFiles) > 0 {
			for callerFile := range rippleCallers {
				if mapFile(callerFile) == edge.From {
					status = EdgeDriftRipple
					reason = "下游模块受到上游代码微调波及"
					break
				}
			}
		}

		if status != EdgeDriftStable {
			affectedEdges = append(affectedEdges, EdgeDriftInfo{
				From:   edge.From,
				To:     edge.To,
				Status: status,
				Reason: reason,
			})
		}
	}

	isCrossBoundary := hasBreakingNode || hasBrokenEdge
	hasDrift := isCrossBoundary || hasModifiedNode

	var verdict string
	if isCrossBoundary {
		verdict = "⚠️ 检测到跨子系统契约漂移，核心系统主动脉受到破坏性修改，需重点评审！"
	} else if hasModifiedNode {
		verdict = "子系统内部实现平滑升级，未破坏跨模块契约，系统架构保持稳固。"
	} else {
		verdict = "系统架构与模块拓扑未受影响，保持稳定。"
	}

	affectedNodesList := make([]NodeDriftInfo, 0, len(topo.Nodes))
	for _, n := range topo.Nodes {
		affectedNodesList = append(affectedNodesList, *nodeMap[n.ID])
	}

	drift := &ArchitectureDrift{
		HasDrift:        hasDrift,
		IsCrossBoundary: isCrossBoundary,
		Verdict:         verdict,
		AffectedNodes:   affectedNodesList,
		AffectedEdges:   affectedEdges,
	}

	drift.DriftMermaid = RenderDriftMermaid(topo, drift)

	return drift
}

func RenderDriftMermaid(topo *pipelineb.MacroTopology, drift *ArchitectureDrift) string {
	if topo == nil || topo.RawMermaid == "" {
		return ""
	}

	var sb strings.Builder
	sb.WriteString(strings.TrimSpace(topo.RawMermaid))
	sb.WriteString("\n\n")

	if drift != nil {
		for _, n := range drift.AffectedNodes {
			switch n.Status {
			case NodeDriftBreaking:
				sb.WriteString(fmt.Sprintf("class %s nodeBreaking;\n", n.NodeID))
			case NodeDriftModified:
				sb.WriteString(fmt.Sprintf("class %s nodeModified;\n", n.NodeID))
			case NodeDriftStable:
				sb.WriteString(fmt.Sprintf("class %s nodeStable;\n", n.NodeID))
			}
		}
	}

	sb.WriteString("\n")
	sb.WriteString("classDef nodeBreaking stroke:var(--color-red-500,#ef4444),stroke-width:2.5px;\n")
	sb.WriteString("classDef nodeModified stroke:var(--color-amber-500,#f59e0b),stroke-width:2px;\n")
	sb.WriteString("classDef nodeStable stroke:var(--color-emerald-500,#10b981),stroke-width:1.5px;\n")

	return sb.String()
}
