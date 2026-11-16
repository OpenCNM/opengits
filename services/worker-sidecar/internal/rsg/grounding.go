package rsg

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
)

// ConceptGroundingRequest represents the query payload for RSG concept grounding.
type ConceptGroundingRequest struct {
	Owner       string                 `json:"owner,omitempty"`
	Repo        string                 `json:"repo,omitempty"`
	Sha         string                 `json:"sha,omitempty"`
	ConceptName string                 `json:"conceptName"`
	ScopeFiles  []string               `json:"scopeFiles,omitempty"`
	Artifact    *SemanticGraphArtifact `json:"artifact,omitempty"`
}

// ConceptGroundingBackboneFile represents a core contract / entry point / backbone file.
type ConceptGroundingBackboneFile struct {
	Path     string  `json:"path"`
	Role     string  `json:"role"`
	PageRank float64 `json:"pageRank"`
}

// ConceptGroundingGoldenSymbol represents an AST-extracted golden symbol in scope.
type ConceptGroundingGoldenSymbol struct {
	Name  string  `json:"name"`
	Kind  string  `json:"kind"`
	File  string  `json:"file"`
	Score float64 `json:"score"`
}

// ConceptGroundingResponse is the JSON payload returned by /v1/graph/concept-grounding.
type ConceptGroundingResponse struct {
	OK            bool                           `json:"ok"`
	Error         string                         `json:"error,omitempty"`
	BackboneFiles []ConceptGroundingBackboneFile `json:"backboneFiles"`
	GoldenSymbols []ConceptGroundingGoldenSymbol `json:"goldenSymbols"`
}

// QueryConceptGrounding evaluates backbone files and golden symbols for a concept against an RSG artifact.
func QueryConceptGrounding(artifact *SemanticGraphArtifact, conceptName string, scopeFiles []string) *ConceptGroundingResponse {
	if artifact == nil {
		return &ConceptGroundingResponse{
			OK:            false,
			Error:         "nil artifact",
			BackboneFiles: make([]ConceptGroundingBackboneFile, 0),
			GoldenSymbols: make([]ConceptGroundingGoldenSymbol, 0),
		}
	}

	scopeSet := make(map[string]bool, len(scopeFiles)*2)
	for _, f := range scopeFiles {
		clean := strings.Trim(strings.TrimSpace(strings.ReplaceAll(f, "\\", "/")), "/")
		if clean != "" {
			scopeSet[clean] = true
			scopeSet[f] = true
		}
	}
	hasScope := len(scopeSet) > 0

	// 1. Filter backbone candidate nodes
	var candidateNodes []SemanticGraphArtifactNode
	for _, node := range artifact.Nodes {
		cleanPath := strings.Trim(strings.TrimSpace(strings.ReplaceAll(node.Path, "\\", "/")), "/")
		if hasScope {
			if scopeSet[node.Path] || scopeSet[cleanPath] {
				candidateNodes = append(candidateNodes, node)
			}
		} else {
			if node.IsBackbone || node.Role == RoleCoreContract || node.Role == RoleEntryPoint {
				candidateNodes = append(candidateNodes, node)
			}
		}
	}

	// Sort by PageRank descending, tie-break by Path ascending
	sort.SliceStable(candidateNodes, func(i, j int) bool {
		if candidateNodes[i].PageRank != candidateNodes[j].PageRank {
			return candidateNodes[i].PageRank > candidateNodes[j].PageRank
		}
		return candidateNodes[i].Path < candidateNodes[j].Path
	})

	limit := 4
	backboneFiles := make([]ConceptGroundingBackboneFile, 0, limit)
	backboneFileSet := make(map[string]bool, limit*2)
	for _, node := range candidateNodes {
		cleanP := strings.Trim(strings.TrimSpace(strings.ReplaceAll(node.Path, "\\", "/")), "/")
		if backboneFileSet[node.Path] || (cleanP != "" && backboneFileSet[cleanP]) {
			continue
		}
		roundedPR := math.Round(node.PageRank*1000) / 1000
		backboneFiles = append(backboneFiles, ConceptGroundingBackboneFile{
			Path:     node.Path,
			Role:     string(node.Role),
			PageRank: roundedPR,
		})
		backboneFileSet[node.Path] = true
		if cleanP != "" {
			backboneFileSet[cleanP] = true
		}
		if len(backboneFiles) >= limit {
			break
		}
	}

	// 2. Filter golden symbols
	goldenSymbols := make([]ConceptGroundingGoldenSymbol, 0)
	seenSymbols := make(map[string]bool)
	normConcept := strings.ToLower(strings.TrimSpace(conceptName))

	for _, sym := range artifact.GoldenSymbols {
		cleanSymFile := strings.Trim(strings.TrimSpace(strings.ReplaceAll(sym.File, "\\", "/")), "/")
		var inScope bool
		if hasScope {
			inScope = scopeSet[sym.File] || (cleanSymFile != "" && scopeSet[cleanSymFile])
		} else {
			inScope = backboneFileSet[sym.File] || (cleanSymFile != "" && backboneFileSet[cleanSymFile])
		}

		var nameMatch bool
		if normConcept != "" {
			normSym := strings.ToLower(strings.TrimSpace(sym.Name))
			nameMatch = strings.Contains(normSym, normConcept) || strings.Contains(normConcept, normSym)
		}

		if inScope || nameMatch {
			dedupFile := sym.File
			if cleanSymFile != "" {
				dedupFile = cleanSymFile
			}
			key := fmt.Sprintf("%s::%s", dedupFile, sym.Name)
			if !seenSymbols[key] {
				seenSymbols[key] = true
				goldenSymbols = append(goldenSymbols, ConceptGroundingGoldenSymbol{
					Name:  sym.Name,
					Kind:  sym.Kind,
					File:  sym.File,
					Score: sym.Score,
				})
				if len(goldenSymbols) >= 6 {
					break
				}
			}
		}
	}

	return &ConceptGroundingResponse{
		OK:            true,
		BackboneFiles: backboneFiles,
		GoldenSymbols: goldenSymbols,
	}
}

// HandleGrounding serves POST /v1/graph/concept-grounding.
func (h *Handler) HandleGrounding(w http.ResponseWriter, r *http.Request) {
	var req ConceptGroundingRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(ConceptGroundingResponse{
			OK:            false,
			Error:         "invalid json body: " + err.Error(),
			BackboneFiles: make([]ConceptGroundingBackboneFile, 0),
			GoldenSymbols: make([]ConceptGroundingGoldenSymbol, 0),
		})
		return
	}

	if req.ConceptName == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(ConceptGroundingResponse{
			OK:            false,
			Error:         "conceptName is required",
			BackboneFiles: make([]ConceptGroundingBackboneFile, 0),
			GoldenSymbols: make([]ConceptGroundingGoldenSymbol, 0),
		})
		return
	}

	var artifact *SemanticGraphArtifact
	if req.Artifact != nil {
		artifact = req.Artifact
	} else {
		if err := AssertSafeSegment(req.Owner); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(ConceptGroundingResponse{
				OK:            false,
				Error:         err.Error(),
				BackboneFiles: make([]ConceptGroundingBackboneFile, 0),
				GoldenSymbols: make([]ConceptGroundingGoldenSymbol, 0),
			})
			return
		}
		if err := AssertSafeSegment(req.Repo); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(ConceptGroundingResponse{
				OK:            false,
				Error:         err.Error(),
				BackboneFiles: make([]ConceptGroundingBackboneFile, 0),
				GoldenSymbols: make([]ConceptGroundingGoldenSymbol, 0),
			})
			return
		}
		if err := AssertSafeSegment(req.Sha); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(ConceptGroundingResponse{
				OK:            false,
				Error:         err.Error(),
				BackboneFiles: make([]ConceptGroundingBackboneFile, 0),
				GoldenSymbols: make([]ConceptGroundingGoldenSymbol, 0),
			})
			return
		}

		graphDir := "storage/graphs"
		if h != nil && h.cfg.SemanticGraphDir != "" {
			graphDir = h.cfg.SemanticGraphDir
		}

		loaded, err := LoadSemanticGraphArtifact(graphDir, req.Owner, req.Repo, req.Sha)
		if err != nil || loaded == nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(ConceptGroundingResponse{
				OK:            false,
				Error:         "semantic graph artifact not found",
				BackboneFiles: make([]ConceptGroundingBackboneFile, 0),
				GoldenSymbols: make([]ConceptGroundingGoldenSymbol, 0),
			})
			return
		}
		artifact = loaded
	}

	res := QueryConceptGrounding(artifact, req.ConceptName, req.ScopeFiles)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(res)
}
