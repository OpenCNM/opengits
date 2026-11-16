package rsg

import (
	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/cognitive"
)

// GitNode represents a file node in git tree or archive.
type GitNode = cluster.GitNode

// GraphNodeRole represents the role of a node in the semantic graph.
type GraphNodeRole = cognitive.GraphNodeRole

const (
	RoleEntryPoint   = cognitive.RoleEntryPoint
	RoleCoreContract = cognitive.RoleCoreContract
	RolePipelineFlow = cognitive.RolePipelineFlow
	RoleLeafUtility  = cognitive.RoleLeafUtility
)

type SymbolEntry = cognitive.SymbolEntry
type SemanticGraphArtifactNode = cognitive.SemanticGraphArtifactNode
type SemanticGraphEdge = cognitive.SemanticGraphEdge
type SoftGraphEdge = cognitive.SoftGraphEdge
type GoldenSymbol = cognitive.GoldenSymbol
type CallEdge = cognitive.CallEdge
type SemanticGraphMeta = cognitive.SemanticGraphMeta
type SemanticGraphArtifact = cognitive.SemanticGraphArtifact

type CognitivePhase = cognitive.CognitivePhase

const (
	PhasePerception = cognitive.PhasePerception
	PhaseEntity     = cognitive.PhaseEntity
	PhasePipeline   = cognitive.PhasePipeline
	PhaseAdapter    = cognitive.PhaseAdapter
)

type PhaseVoteOptions = cognitive.PhaseVoteOptions
type PhaseVoteFile = cognitive.PhaseVoteFile
type ModuleGoldenSymbol = cognitive.ModuleGoldenSymbol
type ModuleCallStep = cognitive.ModuleCallStep
type ModuleCognition = cognitive.ModuleCognition
type ModuleDraftInput = cognitive.ModuleDraftInput
type ProjectedModule = cognitive.ProjectedModule
type SymbolClaim = cognitive.SymbolClaim
type AlignedSymbol = cognitive.AlignedSymbol
type AmbiguousAlignment = cognitive.AmbiguousAlignment
type GroundingVerdict = cognitive.GroundingVerdict
type GroundingReport = cognitive.GroundingReport
type GroundingIndex = cognitive.GroundingIndex
type CandidateOutlineFile = cognitive.CandidateOutlineFile
type OutlineChapter = cognitive.OutlineChapter
type DraftModule = cognitive.DraftModule
type SanitizeOutlineResult = cognitive.SanitizeOutlineResult

func ProjectToCognitiveGradient(artifact *SemanticGraphArtifact, modules []ModuleDraftInput, opts PhaseVoteOptions) []ProjectedModule {
	return cognitive.ProjectToCognitiveGradient(artifact, modules, opts)
}

func ProjectCognitiveGradient(artifact *SemanticGraphArtifact, modules []ModuleDraftInput, opts PhaseVoteOptions) []ProjectedModule {
	return cognitive.ProjectCognitiveGradient(artifact, modules, opts)
}

func BuildCognitiveScaffoldSection(cog ModuleCognition, teachingOrder int) string {
	return cognitive.BuildCognitiveScaffoldSection(cog, teachingOrder)
}

func BuildCognitivePromptScaffold(projectedModules []ProjectedModule) string {
	return cognitive.BuildCognitivePromptScaffold(projectedModules)
}

func DetermineModuleCognitivePhase(files []PhaseVoteFile, opts PhaseVoteOptions) (CognitivePhase, int, string) {
	return cognitive.DetermineModuleCognitivePhase(files, opts)
}

func VerifyFactGrounding(claimedFiles []string, symbolClaims []SymbolClaim, index GroundingIndex) GroundingReport {
	return cognitive.VerifyFactGrounding(claimedFiles, symbolClaims, index)
}

func ExtractClaimedPathsFromMdx(mdxContent string) []string {
	return cognitive.ExtractClaimedPathsFromMdx(mdxContent)
}

func FormatGroundingFeedback(report GroundingReport) *string {
	return cognitive.FormatGroundingFeedback(report)
}

func VerifyFileGrounding(claimedFiles []string, index GroundingIndex) GroundingVerdict {
	return cognitive.VerifyFileGrounding(claimedFiles, index)
}

func VerifySymbolGrounding(claims []SymbolClaim, index GroundingIndex) ([]AlignedSymbol, []SymbolClaim, []string) {
	return cognitive.VerifySymbolGrounding(claims, index)
}

func SelectCandidateFilesForOutline(nodes []GitNode, maxFiles int, patterns *ingestPatterns) []CandidateOutlineFile {
	return cognitive.SelectCandidateFilesForOutline(nodes, maxFiles, nil)
}

func BuildRuleFallbackOutline(nodes []GitNode, prefix, targetLanguage string, patterns *ingestPatterns) []OutlineChapter {
	return cognitive.BuildRuleFallbackOutline(nodes, prefix, targetLanguage, nil)
}

func SanitizeAndIntersectOutline(chapters []OutlineChapter, nodes []GitNode, prefix, targetLanguage string, candidateFiles []CandidateOutlineFile, patterns *ingestPatterns) SanitizeOutlineResult {
	return cognitive.SanitizeAndIntersectOutline(chapters, nodes, prefix, targetLanguage, candidateFiles, nil)
}

func SanitizeDraftModules(modules []DraftModule, nodes []GitNode, prefix string, patterns *ingestPatterns) []DraftModule {
	return cognitive.SanitizeDraftModules(modules, nodes, prefix, nil)
}

type OutlineCandidatesRequest = cognitive.OutlineCandidatesRequest
type OutlineCandidatesResponse = cognitive.OutlineCandidatesResponse
type OutlineRuleFallbackRequest = cognitive.OutlineRuleFallbackRequest
type OutlineRuleFallbackResponse = cognitive.OutlineRuleFallbackResponse
type OutlineSanitizeRequest = cognitive.OutlineSanitizeRequest
type OutlineSanitizeResponse = cognitive.OutlineSanitizeResponse
type OutlinePrepareSignalsRequest = cognitive.OutlinePrepareSignalsRequest
type OutlinePrepareSignalsResponse = cognitive.OutlinePrepareSignalsResponse

// SemanticGraphNode represents an in-memory graph node.
type SemanticGraphNode struct {
	Path         string        `json:"path"`
	Language     string        `json:"language"`
	InDegree     int           `json:"inDegree"`
	OutDegree    int           `json:"outDegree"`
	PageRank     float64       `json:"pageRank"`
	Role         GraphNodeRole `json:"role"`
	ImportedBy   []string      `json:"importedBy"`
	Imports      []string      `json:"imports"`
	IsBackbone   bool          `json:"isBackbone"`
	IsEntryPoint bool          `json:"isEntryPoint"`
	Symbols      []SymbolEntry `json:"symbols"`
}

// SourceFileInput represents a source file provided for semantic graph construction.
type SourceFileInput struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Sha     string `json:"sha,omitempty"`
}

// RepositorySemanticGraph is the full in-memory RSG.
type RepositorySemanticGraph struct {
	Nodes             map[string]*SemanticGraphNode
	NodeList          []*SemanticGraphNode
	Edges             []SemanticGraphEdge
	SoftEdges         []SoftGraphEdge
	GoldenSymbols     []GoldenSymbol
	CallEdges         []CallEdge
	EntryPoints       []string
	BackboneNodes     []string
	CoreContractNodes []string
	PipelineNodes     []string
	SymbolsByFile     map[string][]SymbolEntry
	Meta              SemanticGraphMeta
}

// Psr4Alias parsed from composer.json autoload.
type Psr4Alias struct {
	Prefix string `json:"prefix"`
	Dir    string `json:"dir"`
}

// Config holds configuration parameters for the RSG package.
type Config struct {
	ArchiveRoot      string
	SemanticGraphDir string
	InternalToken    string
}
