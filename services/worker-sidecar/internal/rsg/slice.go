package rsg

import (
	"fmt"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

type TopologySliceRequest struct {
	Owner  string `json:"owner"`
	Repo   string `json:"repo"`
	Sha    string `json:"sha"`
	Path   string `json:"path"`
	Symbol string `json:"symbol,omitempty"`
	Line   int    `json:"line,omitempty"`
}

type TopologySliceResponse struct {
	Found        bool          `json:"found"`
	FilePath     string        `json:"filePath"`
	TargetSymbol *SymbolEntry  `json:"targetSymbol,omitempty"`
	Role         string        `json:"role,omitempty"`
	PageRank     float64       `json:"pageRank,omitempty"`
	Callers      []CallEdge    `json:"callers"`
	Callees      []CallEdge    `json:"callees"`
	PeerSymbols  []SymbolEntry `json:"peerSymbols"`
	TopologyText string        `json:"topologyText"`
}

const (
	maxSliceCallers     = 6
	maxSliceCallees     = 6
	maxSlicePeerSymbols = 8
	maxSliceTextTokens  = 300
)

func ExtractTopologySlice(artifact *SemanticGraphArtifact, req TopologySliceRequest) *TopologySliceResponse {
	if artifact == nil {
		return &TopologySliceResponse{
			Found:        false,
			FilePath:     req.Path,
			Callers:      []CallEdge{},
			Callees:      []CallEdge{},
			PeerSymbols:  []SymbolEntry{},
			TopologyText: "",
		}
	}

	cleanPath := strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(req.Path), "./"), "/")

	var (
		nodeRole     string
		nodePageRank float64
		matchedPath  string
	)

	for _, n := range artifact.Nodes {
		if n.Path == cleanPath || strings.HasSuffix(n.Path, "/"+cleanPath) || strings.HasSuffix(cleanPath, "/"+n.Path) {
			matchedPath = n.Path
			nodeRole = string(n.Role)
			nodePageRank = n.PageRank
			break
		}
	}

	if matchedPath == "" {
		matchedPath = cleanPath
	}

	fileSymbols := artifact.SymbolsByFile[matchedPath]
	if len(fileSymbols) == 0 {
		for p, syms := range artifact.SymbolsByFile {
			if strings.HasSuffix(p, "/"+cleanPath) || strings.HasSuffix(cleanPath, "/"+p) {
				matchedPath = p
				fileSymbols = syms
				break
			}
		}
	}

	var targetSym *SymbolEntry
	reqSymbol := strings.TrimSpace(req.Symbol)

	if reqSymbol != "" {
		for i := range fileSymbols {
			if fileSymbols[i].Name == reqSymbol {
				targetSym = &fileSymbols[i]
				break
			}
		}
		if targetSym == nil {
			for i := range fileSymbols {
				if strings.EqualFold(fileSymbols[i].Name, reqSymbol) {
					targetSym = &fileSymbols[i]
					break
				}
			}
		}
	}

	if targetSym == nil && req.Line > 0 {
		var bestCandidate *SymbolEntry
		minSpan := int(^uint(0) >> 1)
		for i := range fileSymbols {
			s := &fileSymbols[i]
			if s.StartLine <= req.Line && (s.EndLine >= req.Line || s.EndLine == 0) {
				span := s.EndLine - s.StartLine
				if span >= 0 && span < minSpan {
					minSpan = span
					bestCandidate = s
				}
			}
		}
		targetSym = bestCandidate
	}

	if targetSym == nil && len(fileSymbols) > 0 {
		for i := range fileSymbols {
			if fileSymbols[i].Exported && (fileSymbols[i].Kind == "function" || fileSymbols[i].Kind == "method") {
				targetSym = &fileSymbols[i]
				break
			}
		}
		if targetSym == nil {
			for i := range fileSymbols {
				if fileSymbols[i].Exported {
					targetSym = &fileSymbols[i]
					break
				}
			}
		}
		if targetSym == nil && len(fileSymbols) > 0 {
			targetSym = &fileSymbols[0]
		}
	}

	callers := make([]CallEdge, 0)
	callees := make([]CallEdge, 0)
	seenCallerKey := make(map[string]bool)
	seenCalleeKey := make(map[string]bool)

	for _, edge := range artifact.CallEdges {
		edgeCalleePathMatch := edge.CalleeFile == matchedPath || strings.HasSuffix(edge.CalleeFile, "/"+matchedPath)
		edgeCallerPathMatch := edge.CallerFile == matchedPath || strings.HasSuffix(edge.CallerFile, "/"+matchedPath)

		if targetSym != nil {

			if edgeCalleePathMatch && edge.CalleeSymbol == targetSym.Name {
				key := fmt.Sprintf("%s:%s:%d", edge.CallerFile, edge.CallerSymbol, edge.Line)
				if !seenCallerKey[key] {
					seenCallerKey[key] = true
					callers = append(callers, edge)
				}
			}

			if edgeCallerPathMatch && edge.CallerSymbol == targetSym.Name {
				key := fmt.Sprintf("%s:%s:%d", edge.CalleeFile, edge.CalleeSymbol, edge.Line)
				if !seenCalleeKey[key] {
					seenCalleeKey[key] = true
					callees = append(callees, edge)
				}
			}
		} else {

			if edgeCalleePathMatch {
				key := fmt.Sprintf("%s:%s:%d", edge.CallerFile, edge.CallerSymbol, edge.Line)
				if !seenCallerKey[key] {
					seenCallerKey[key] = true
					callers = append(callers, edge)
				}
			}
			if edgeCallerPathMatch {
				key := fmt.Sprintf("%s:%s:%d", edge.CalleeFile, edge.CalleeSymbol, edge.Line)
				if !seenCalleeKey[key] {
					seenCalleeKey[key] = true
					callees = append(callees, edge)
				}
			}
		}
	}

	sort.Slice(callers, func(i, j int) bool {
		if callers[i].CallerFile != callers[j].CallerFile {
			return callers[i].CallerFile < callers[j].CallerFile
		}
		return callers[i].Line < callers[j].Line
	})
	if len(callers) > maxSliceCallers {
		callers = callers[:maxSliceCallers]
	}

	sort.Slice(callees, func(i, j int) bool {
		if callees[i].CalleeFile != callees[j].CalleeFile {
			return callees[i].CalleeFile < callees[j].CalleeFile
		}
		return callees[i].Line < callees[j].Line
	})
	if len(callees) > maxSliceCallees {
		callees = callees[:maxSliceCallees]
	}

	peerSymbols := make([]SymbolEntry, 0)
	for _, s := range fileSymbols {
		if targetSym != nil && s.Name == targetSym.Name {
			continue
		}
		if s.Exported {
			peerSymbols = append(peerSymbols, s)
			if len(peerSymbols) >= maxSlicePeerSymbols {
				break
			}
		}
	}

	var sb strings.Builder
	symHeader := matchedPath
	if targetSym != nil {
		symHeader = fmt.Sprintf("%s#%s", matchedPath, targetSym.Name)
	}

	fmt.Fprintf(&sb, "[Physical Code Topology: %s]\n", symHeader)
	roleLabel := nodeRole
	if roleLabel == "" {
		roleLabel = "source_file"
	}
	fmt.Fprintf(&sb, "- File: %s | Role: %s (PageRank: %.2f)\n", matchedPath, roleLabel, nodePageRank)

	if targetSym != nil {
		lineInfo := ""
		if targetSym.StartLine > 0 {
			if targetSym.EndLine > targetSym.StartLine {
				lineInfo = fmt.Sprintf(" at line %d-%d", targetSym.StartLine, targetSym.EndLine)
			} else {
				lineInfo = fmt.Sprintf(" at line %d", targetSym.StartLine)
			}
		}
		exportStatus := "internal"
		if targetSym.Exported {
			exportStatus = "exported"
		}
		fmt.Fprintf(&sb, "- Symbol: %s %s%s [%s]\n", targetSym.Kind, targetSym.Name, lineInfo, exportStatus)
	}

	sb.WriteString("- Upstream Callers (Who calls this):\n")
	if len(callers) == 0 {
		sb.WriteString("  * (None or Top-level export)\n")
	} else {
		for _, c := range callers {
			sym := c.CallerSymbol
			if sym == "" {
				sym = "(file-scope)"
			}
			fmt.Fprintf(&sb, "  * %s:%d in %s\n", c.CallerFile, c.Line, sym)
		}
	}

	sb.WriteString("- Downstream Dependencies (What this calls):\n")
	if len(callees) == 0 {
		sb.WriteString("  * (None or Leaf primitive)\n")
	} else {
		for _, c := range callees {
			sym := c.CalleeSymbol
			if sym == "" {
				sym = "(file-scope)"
			}
			fmt.Fprintf(&sb, "  * %s -> %s at line %d\n", c.CalleeFile, sym, c.Line)
		}
	}

	if len(peerSymbols) > 0 {
		sb.WriteString("- Related Exported Symbols:\n")
		for _, ps := range peerSymbols {
			fmt.Fprintf(&sb, "  * %s (%s)\n", ps.Name, ps.Kind)
		}
	}

	rawText := sb.String()
	tokens := mdpat.EstimateTokens(rawText)
	if tokens > maxSliceTextTokens {
		lines := strings.Split(rawText, "\n")
		var trimmedSb strings.Builder
		for _, l := range lines {
			if mdpat.EstimateTokens(trimmedSb.String()+"\n"+l) > maxSliceTextTokens-10 {
				trimmedSb.WriteString("  * ... (truncated to budget)\n")
				break
			}
			trimmedSb.WriteString(l)
			trimmedSb.WriteByte('\n')
		}
		rawText = trimmedSb.String()
	}

	found := targetSym != nil || len(fileSymbols) > 0 || len(callers) > 0 || len(callees) > 0

	return &TopologySliceResponse{
		Found:        found,
		FilePath:     matchedPath,
		TargetSymbol: targetSym,
		Role:         nodeRole,
		PageRank:     nodePageRank,
		Callers:      callers,
		Callees:      callees,
		PeerSymbols:  peerSymbols,
		TopologyText: rawText,
	}
}
