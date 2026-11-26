package cognitive

import (
	"github.com/opengits/worker-sidecar/internal/cluster"
)

type GitNode = cluster.GitNode

type GraphNodeRole string

const (
	RoleEntryPoint   GraphNodeRole = "entry_point"
	RoleCoreContract GraphNodeRole = "core_contract"
	RolePipelineFlow GraphNodeRole = "pipeline_flow"
	RoleLeafUtility  GraphNodeRole = "leaf_utility"
)

type SymbolEntry struct {
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	Exported  bool   `json:"exported"`
	Golden    bool   `json:"golden,omitempty"`
	Importers int    `json:"importers,omitempty"`
}

type SemanticGraphArtifactNode struct {
	Path         string        `json:"path"`
	Language     string        `json:"language"`
	InDegree     int           `json:"inDegree"`
	OutDegree    int           `json:"outDegree"`
	PageRank     float64       `json:"pageRank"`
	Role         GraphNodeRole `json:"role"`
	IsBackbone   bool          `json:"isBackbone"`
	IsEntryPoint bool          `json:"isEntryPoint"`
}

type SemanticGraphEdge struct {
	Source string `json:"source"`
	Target string `json:"target"`
}

type SoftGraphEdge struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Kind   string `json:"kind"`
}

type GoldenSymbol struct {
	File      string  `json:"file"`
	Name      string  `json:"name"`
	Kind      string  `json:"kind"`
	Score     float64 `json:"score"`
	Importers int     `json:"importers"`
}

type CallEdge struct {
	CallerFile   string `json:"callerFile"`
	CallerSymbol string `json:"callerSymbol"`
	CalleeFile   string `json:"calleeFile"`
	CalleeSymbol string `json:"calleeSymbol"`
	Line         int    `json:"line"`
}

type SemanticGraphMeta struct {
	TotalFiles                  int      `json:"totalFiles"`
	ASTParsedFiles              int      `json:"astParsedFiles"`
	RegistryFallbackFiles       int      `json:"registryFallbackFiles"`
	SkippedFiles                int      `json:"skippedFiles"`
	DroppedTestEdges            int      `json:"droppedTestEdges"`
	UnresolvedImportCount       int      `json:"unresolvedImportCount"`
	SoftEdgeCount               int      `json:"softEdgeCount"`
	AmbiguousSoftReferenceCount int      `json:"ambiguousSoftReferenceCount"`
	UnresolvedCallSiteCount     int      `json:"unresolvedCallSiteCount"`
	GrammarsUsed                []string `json:"grammarsUsed"`
}

type SemanticGraphArtifact struct {
	Version           int                         `json:"version"`
	GeneratedAt       string                      `json:"generatedAt"`
	GitSha            string                      `json:"gitSha"`
	Nodes             []SemanticGraphArtifactNode `json:"nodes"`
	EntryPoints       []string                    `json:"entryPoints"`
	BackboneNodes     []string                    `json:"backboneNodes"`
	CoreContractNodes []string                    `json:"coreContractNodes"`
	PipelineNodes     []string                    `json:"pipelineNodes"`
	SymbolsByFile     map[string][]SymbolEntry    `json:"symbolsByFile"`
	Edges             []SemanticGraphEdge         `json:"edges,omitempty"`
	SoftEdges         []SoftGraphEdge             `json:"softEdges"`
	GoldenSymbols     []GoldenSymbol              `json:"goldenSymbols"`
	CallEdges         []CallEdge                  `json:"callEdges"`
	Meta              SemanticGraphMeta           `json:"meta"`
}

type ChapterFile struct {
	Handle         int      `json:"handle,omitempty"`
	Path           string   `json:"path"`
	Anchor         string   `json:"anchor,omitempty"`
	ShortTitle     string   `json:"shortTitle"`
	CompanionFiles []string `json:"companionFiles,omitempty"`
}

type CognitivePhase string

const (
	PhasePerception CognitivePhase = "phase1_perception"
	PhaseEntity     CognitivePhase = "phase2_entity"
	PhasePipeline   CognitivePhase = "phase3_pipeline"
	PhaseAdapter    CognitivePhase = "phase4_adapter"
)

var PhaseLabels = map[CognitivePhase]string{
	PhasePerception: "[Stage 1: Perception & Entry]",
	PhaseEntity:     "[Stage 2: Core Domain & State]",
	PhasePipeline:   "[Stage 3: Core Business Pipeline]",
	PhaseAdapter:    "[Stage 4: Adapters & Infrastructure]",
}

type PhaseVoteFile struct {
	IsEntryPoint bool          `json:"isEntryPoint"`
	Role         GraphNodeRole `json:"role"`
	PageRank     float64       `json:"pageRank"`
}

type PhaseVoteOptions struct {
	PrimaryEntryMassRatio float64 `json:"primaryEntryMassRatio"`
}

type ModuleGoldenSymbol struct {
	Name string `json:"name"`
	File string `json:"file"`
	Kind string `json:"kind"`
}

type ModuleCallStep struct {
	Caller     string `json:"caller"`
	Callee     string `json:"callee"`
	CalleeFile string `json:"calleeFile,omitempty"`
}

type ModuleCognition struct {
	Phase             CognitivePhase       `json:"phase"`
	PhaseOrder        int                  `json:"phaseOrder"`
	Rationale         string               `json:"rationale"`
	UpstreamModules   []string             `json:"upstreamModules"`
	DownstreamModules []string             `json:"downstreamModules"`
	GoldenSymbols     []ModuleGoldenSymbol `json:"goldenSymbols,omitempty"`
	CallFlow          []ModuleCallStep     `json:"callFlow,omitempty"`
}

type ModuleDraftInput struct {
	Name        string   `json:"name"`
	Summary     string   `json:"summary"`
	Directories []string `json:"directories"`
	DraftIndex  *int     `json:"draftIndex,omitempty"`
}

type ProjectedModule struct {
	Name               string               `json:"name"`
	Summary            string               `json:"summary"`
	Phase              CognitivePhase       `json:"phase"`
	PhaseOrder         int                  `json:"phaseOrder"`
	TeachingOrder      int                  `json:"teachingOrder"`
	Directories        []string             `json:"directories"`
	PrimaryFiles       []string             `json:"primaryFiles"`
	BackboneCount      int                  `json:"backboneCount"`
	EntryPointCount    int                  `json:"entryPointCount"`
	AveragePageRank    float64              `json:"averagePageRank"`
	CognitiveRationale string               `json:"cognitiveRationale"`
	UpstreamModules    []string             `json:"upstreamModules"`
	DownstreamModules  []string             `json:"downstreamModules"`
	DraftIndex         *int                 `json:"draftIndex,omitempty"`
	GoldenSymbols      []ModuleGoldenSymbol `json:"goldenSymbols"`
	CallFlow           []ModuleCallStep     `json:"callFlow"`
}

type SymbolClaim struct {
	File   string `json:"file"`
	Symbol string `json:"symbol"`
	Line   *int   `json:"line,omitempty"`
}

type AlignedSymbol struct {
	File         string `json:"file"`
	Symbol       string `json:"symbol"`
	Line         *int   `json:"line,omitempty"`
	ResolvedFile string `json:"resolvedFile"`
}

type AmbiguousAlignment struct {
	Claimed    string `json:"claimed"`
	ResolvedTo string `json:"resolvedTo"`
}

type GroundingVerdict struct {
	Valid               bool     `json:"valid"`
	GroundedFiles       []string `json:"groundedFiles"`
	HallucinatedFiles   []string `json:"hallucinatedFiles"`
	AdjustedSourceFiles []string `json:"adjustedSourceFiles"`
	Warnings            []string `json:"warnings"`
}

type GroundingReport struct {
	GroundingVerdict
	AmbiguousAlignments []AmbiguousAlignment `json:"ambiguousAlignments"`
	GroundedSymbols     []AlignedSymbol      `json:"groundedSymbols"`
	HallucinatedSymbols []SymbolClaim        `json:"hallucinatedSymbols"`
}

type GroundingIndex struct {
	Paths         []string                 `json:"paths"`
	SymbolsByFile map[string][]SymbolEntry `json:"symbolsByFile"`
}

type CandidateOutlineFile struct {
	Handle int    `json:"handle,omitempty"`
	Path   string `json:"path"`
	Anchor string `json:"anchor,omitempty"`
	Kind   string `json:"kind,omitempty"`
	Detail string `json:"detail,omitempty"`
	IsDoc  bool   `json:"isDoc"`
	Role   string `json:"role,omitempty"`
	Weight int    `json:"weight"`
}

type SymbolExtractor interface {
	ExtractSymbols(content string, filePath string) []SymbolEntry
}

type SymbolExtractorFunc func(content string, filePath string) []SymbolEntry

func (f SymbolExtractorFunc) ExtractSymbols(content string, filePath string) []SymbolEntry {
	return f(content, filePath)
}

type FileReader func(path string) ([]byte, error)

type OutlineSignalOptions struct {
	FileReader      FileReader
	SymbolExtractor SymbolExtractor
}

type OutlineChapter struct {
	Name      string        `json:"name"`
	Summary   string        `json:"summary"`
	Files     []ChapterFile `json:"files"`
	PartTitle string        `json:"partTitle,omitempty"`
}

type DraftModule struct {
	Name        string   `json:"name"`
	Summary     string   `json:"summary"`
	Directories []string `json:"directories"`
	Granularity string   `json:"granularity,omitempty"`
}

type SanitizeOutlineResult struct {
	Sanitized    []OutlineChapter `json:"sanitized"`
	DroppedPaths []string         `json:"droppedPaths"`
}
