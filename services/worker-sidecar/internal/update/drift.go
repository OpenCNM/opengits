package update

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive/pipelineb"
	"github.com/opengits/worker-sidecar/internal/diff"
)

// NodeDriftStatus 节点架构漂移状态。
type NodeDriftStatus string

const (
	NodeDriftStable   NodeDriftStatus = "stable"   // 未受任何影响 (稳定绿色)
	NodeDriftModified NodeDriftStatus = "modified" // 内部私有实现微调，契约完好 (平滑黄色)
	NodeDriftBreaking NodeDriftStatus = "breaking" // 跨模块导出契约断裂或受波及 (高危红色)
)

// EdgeDriftStatus 依赖边架构漂移状态。
type EdgeDriftStatus string

const (
	EdgeDriftStable EdgeDriftStatus = "stable" // 连线稳定
	EdgeDriftRipple EdgeDriftStatus = "ripple" // 下游受到波及
	EdgeDriftBroken EdgeDriftStatus = "broken" // 契约断裂受损
)

// NodeDriftInfo 单个架构节点的漂移详情。
type NodeDriftInfo struct {
	NodeID       string          `json:"nodeId"`
	Path         string          `json:"path"`
	Name         string          `json:"name"`
	Status       NodeDriftStatus `json:"status"`
	Summary      string          `json:"summary"`
	ChangedFiles []string        `json:"changedFiles"`
	RippleFiles  []string        `json:"rippleFiles"`
}

// EdgeDriftInfo 单条架构连线的漂移详情。
type EdgeDriftInfo struct {
	From   string          `json:"from"`
	To     string          `json:"to"`
	Status EdgeDriftStatus `json:"status"`
	Reason string          `json:"reason,omitempty"`
}

// ArchitectureDrift 架构漂移宏观事实模型。
type ArchitectureDrift struct {
	HasDrift        bool            `json:"hasDrift"`
	IsCrossBoundary bool            `json:"isCrossBoundary"` // 是否伤及跨子系统主动脉
	Verdict         string          `json:"verdict"`          // 高层判定结论文案
	AffectedNodes   []NodeDriftInfo `json:"affectedNodes"`
	AffectedEdges   []EdgeDriftInfo `json:"affectedEdges"`
	DriftMermaid    string          `json:"driftMermaid"` // 确定性红黄绿全景图
}

// MapFileToMacroNode 将代码物理文件映射至所属的 MacroTopologyNode ID。
// 规则：
// 1. 优先匹配 Entrypoint 根目录节点（若文件位于根目录无下级子目录）；
// 2. 匹配最长目录前缀（例如 pkg/api 优于 pkg）；
// 3. 兜底回落至 common_utils 或空字符串。
func MapFileToMacroNode(filePath string, nodes []pipelineb.MacroTopologyNode) string {
	normalized := filepath.ToSlash(filePath)
	cleanPath := strings.TrimPrefix(normalized, "/")

	var bestNodeID string
	bestPrefixLen := -1

	for _, n := range nodes {
		// Entrypoint 根节点判定
		if n.Path == "." || strings.EqualFold(n.Name, "entrypoint") {
			if !strings.Contains(cleanPath, "/") {
				return n.ID
			}
			continue
		}

		// 目录前缀匹配
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

	// 兜底找 common_utils
	for _, n := range nodes {
		if strings.Contains(strings.ToLower(n.ID), "utils") || strings.Contains(strings.ToLower(n.ID), "common") {
			return n.ID
		}
	}

	return ""
}

// ComputeArchitectureDrift 纯函数：将物理 diff、AST 逐文件分类与调用波及结果，投影到 C4 宏观拓扑。
func ComputeArchitectureDrift(
	topo *pipelineb.MacroTopology,
	diffResult *UpdateArchiveDiff,
	fileDiffs map[string]diff.FileSemanticDiff,
	rippleCallers map[string][]diff.SurgicalAnchor,
) *ArchitectureDrift {
	if topo == nil || len(topo.Nodes) == 0 {
		return nil
	}

	// MapFileToMacroNode 是 (filePath, nodes) 纯函数且 nodes 调用期内不变
	// ——三重循环内无 memo 反复 O(nodes) 线性前缀匹配，按 filePath 记忆化。
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

	// 1. 归集物理变更文件至节点
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

	// 2. 归集波及调用文件至节点
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

	// 3. 逐节点定性：判定是否穿透子系统边界 (Cross-Boundary Breaking)
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

		// 检查删除文件是否有外部节点调用
		for _, f := range info.ChangedFiles {
			if removedSet[f] {
				// 遍历 rippleCallers 检查是否有其他节点的 caller 依赖此文件
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

			// 检查导出符号变动是否被外部节点调用
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

	// 4. 依赖边定性
	var affectedEdges []EdgeDriftInfo
	hasBrokenEdge := false

	for _, edge := range topo.Edges {
		status := EdgeDriftStable
		reason := ""

		toInfo := nodeMap[edge.To]
		if toInfo != nil && toInfo.Status == NodeDriftBreaking {
			// 检查 from 节点内部是否有 caller 调了 to 节点的变动符号
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
				// 兜底检查 edge.Symbols 是否有命中 to 节点变动符号
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
			// 虽非 breaking，但如果有 ripple 涉及此连线
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

	// 5. 组装高阶判定
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

	// 6. 确定性渲染红黄绿 Mermaid
	drift.DriftMermaid = RenderDriftMermaid(topo, drift)

	return drift
}

// RenderDriftMermaid 纯函数：向 Mermaid 代码中注入红黄绿 class 与连线样式。
func RenderDriftMermaid(topo *pipelineb.MacroTopology, drift *ArchitectureDrift) string {
	if topo == nil || topo.RawMermaid == "" {
		return ""
	}

	var sb strings.Builder
	sb.WriteString(strings.TrimSpace(topo.RawMermaid))
	sb.WriteString("\n\n")

	// 注入节点 class 标记
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

	// 注入主题安全类定义 (使用 CSS 变量与主题颜色)
	sb.WriteString("\n")
	sb.WriteString("classDef nodeBreaking stroke:var(--color-red-500,#ef4444),stroke-width:2.5px;\n")
	sb.WriteString("classDef nodeModified stroke:var(--color-amber-500,#f59e0b),stroke-width:2px;\n")
	sb.WriteString("classDef nodeStable stroke:var(--color-emerald-500,#10b981),stroke-width:1.5px;\n")

	return sb.String()
}
