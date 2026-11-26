package chapter

import (
	"fmt"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

type SkeletonOptions struct {
	MaxCallSteps    int
	IncludeExternal bool
}

func BuildModuleArchitectureMermaidSkeleton(title string, cog *cognitive.ModuleCognition, goldenSymbols []cognitive.ModuleGoldenSymbol, opts SkeletonOptions) string {
	maxSteps := opts.MaxCallSteps
	if maxSteps <= 0 {
		maxSteps = 6
	}

	cleanTitle := strings.ReplaceAll(title, `"`, "''")
	cleanTitle = strings.TrimSpace(cleanTitle)
	if cleanTitle == "" {
		cleanTitle = "Module Architecture"
	}

	var b strings.Builder
	b.WriteString("```mermaid\nflowchart TD\n")

	nodeIdMap := make(map[string]string)
	nextId := 1
	getNodeId := func(sym string) string {
		if existing, ok := nodeIdMap[sym]; ok {
			return existing
		}
		newId := fmt.Sprintf("fn%d", nextId)
		nextId++
		nodeIdMap[sym] = newId
		return newId
	}

	subgraphId := "ChapterMod"
	b.WriteString(fmt.Sprintf("  subgraph %s[\"%s\"]\n", subgraphId, cleanTitle))

	var firstNodeId string
	var lastNodeId string
	hasInternalNodes := false

	if cog != nil && len(cog.CallFlow) > 0 {
		stepsCount := 0
		for _, step := range cog.CallFlow {
			caller := strings.TrimSpace(step.Caller)
			callee := strings.TrimSpace(step.Callee)
			if caller == "" || callee == "" {
				continue
			}
			callerId := getNodeId(caller)
			calleeId := getNodeId(callee)

			callerLabel := strings.ReplaceAll(caller, `"`, "''")
			calleeLabel := strings.ReplaceAll(callee, `"`, "''")

			b.WriteString(fmt.Sprintf("    %s[\"%s()\"]\n", callerId, callerLabel))
			if step.CalleeFile != "" {
				b.WriteString(fmt.Sprintf("    %s[\"%s()<br/>%s\"]\n", calleeId, calleeLabel, strings.ReplaceAll(step.CalleeFile, `"`, "''")))
			} else {
				b.WriteString(fmt.Sprintf("    %s[\"%s()\"]\n", calleeId, calleeLabel))
			}
			b.WriteString(fmt.Sprintf("    %s --> %s\n", callerId, calleeId))

			if firstNodeId == "" {
				firstNodeId = callerId
			}
			lastNodeId = calleeId
			hasInternalNodes = true

			stepsCount++
			if stepsCount >= maxSteps {
				break
			}
		}
	}

	if !hasInternalNodes {
		symbols := goldenSymbols
		if len(symbols) == 0 && cog != nil {
			symbols = cog.GoldenSymbols
		}
		if len(symbols) > 0 {
			symCount := 0
			var prevId string
			for _, sym := range symbols {
				name := strings.TrimSpace(sym.Name)
				if name == "" {
					continue
				}
				symId := getNodeId(name)
				kindStr := ""
				if sym.Kind != "" {
					kindStr = fmt.Sprintf(" (%s)", sym.Kind)
				}
				label := strings.ReplaceAll(name+kindStr, `"`, "''")
				b.WriteString(fmt.Sprintf("    %s[\"%s\"]\n", symId, label))

				if firstNodeId == "" {
					firstNodeId = symId
				}
				if prevId != "" {
					b.WriteString(fmt.Sprintf("    %s -.-> %s\n", prevId, symId))
				}
				prevId = symId
				lastNodeId = symId
				hasInternalNodes = true

				symCount++
				if symCount >= 4 {
					break
				}
			}
		}
	}

	if !hasInternalNodes {
		// Returns empty string when neither internal AST nodes nor external boundaries exist instead of faking a node.
		if !opts.IncludeExternal || cog == nil || (len(cog.UpstreamModules) == 0 && len(cog.DownstreamModules) == 0) {
			return ""
		}
		singleId := getNodeId(cleanTitle)
		b.WriteString(fmt.Sprintf("    %s[\"%s Core\"]\n", singleId, cleanTitle))
		firstNodeId = singleId
		lastNodeId = singleId
	}

	b.WriteString("  end\n")

	if opts.IncludeExternal && cog != nil {
		upCount := 0
		for _, up := range cog.UpstreamModules {
			upName := strings.TrimSpace(up)
			if upName == "" {
				continue
			}
			upId := fmt.Sprintf("up%d", upCount+1)
			cleanUp := strings.ReplaceAll(upName, `"`, "''")
			b.WriteString(fmt.Sprintf("  %s([\"Prerequisite: %s\"]) --> %s\n", upId, cleanUp, firstNodeId))
			upCount++
			if upCount >= 2 {
				break
			}
		}

		downCount := 0
		for _, down := range cog.DownstreamModules {
			downName := strings.TrimSpace(down)
			if downName == "" {
				continue
			}
			downId := fmt.Sprintf("down%d", downCount+1)
			cleanDown := strings.ReplaceAll(downName, `"`, "''")
			b.WriteString(fmt.Sprintf("  %s --> %s([\"Dependent: %s\"])\n", lastNodeId, downId, cleanDown))
			downCount++
			if downCount >= 2 {
				break
			}
		}
	}

	b.WriteString("```")
	return b.String()
}

var skeletonLabelRe = mdpat.SkeletonLabelRe

// Skips subgraph containers and fallback Core nodes so only real AST entities enter grounding checks.
func ExtractSymbolsFromSkeleton(skeleton string) []string {
	lines := strings.Split(skeleton, "\n")
	var symbols []string
	seen := make(map[string]bool)

	for _, line := range lines {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "subgraph ") {
			continue
		}
		if strings.HasSuffix(trim, ` Core"]`) || strings.HasSuffix(trim, ` Core"])`) {
			continue
		}

		matches := skeletonLabelRe.FindAllStringSubmatch(trim, -1)
		for _, m := range matches {
			raw := m[1]
			if raw == "" {
				raw = m[2]
			}
			raw = strings.TrimSpace(raw)
			if idx := strings.Index(raw, "<br/>"); idx >= 0 {
				raw = raw[:idx]
			}
			raw = strings.TrimSuffix(raw, "()")
			if idx := strings.Index(raw, " ("); idx >= 0 {
				raw = raw[:idx]
			}
			raw = strings.TrimPrefix(raw, "Prerequisite: ")
			raw = strings.TrimPrefix(raw, "Dependent: ")
			clean := strings.TrimSpace(raw)
			if len(clean) >= 2 && !isReservedMermaidLabel(clean) && !seen[clean] {
				seen[clean] = true
				symbols = append(symbols, clean)
			}
		}
	}
	return symbols
}

func isReservedMermaidLabel(s string) bool {
	lower := strings.ToLower(s)
	return lower == "flowchart" || lower == "td" || lower == "lr" ||
		lower == "subgraph" || lower == "end" || lower == "graph" ||
		lower == "empty" || lower == "module architecture"
}
