package rsg

import "github.com/opengits/worker-sidecar/internal/diff"

// DiffChapterInput represents an input chapter and the files belonging to it.
type DiffChapterInput = diff.DiffChapterInput

// GraphDiffRequest represents the input payload for POST /v1/graph/diff.
type GraphDiffRequest = diff.GraphDiffRequest

// SymbolDiffItem represents changes in an individual symbol.
type SymbolDiffItem = diff.SymbolDiffItem

// FileSemanticCategory classifies the nature of file changes.
type FileSemanticCategory = diff.FileSemanticCategory

const (
	FileCategoryAstIdentical    = diff.FileCategoryAstIdentical
	FileCategoryPrivateOnly     = diff.FileCategoryPrivateOnly
	FileCategoryExportedChanged = diff.FileCategoryExportedChanged
	FileCategoryUntouched       = diff.FileCategoryUntouched
	FileCategoryRippleAffected  = diff.FileCategoryRippleAffected
)

// FileSemanticDiff contains semantic comparison details for a single file.
type FileSemanticDiff = diff.FileSemanticDiff

// SurgicalAnchor locates a specific code symbol change for targeted LLM updating.
type SurgicalAnchor = diff.SurgicalAnchor

// KeepExemption explains why a chapter is exempt from updating.
type KeepExemption = diff.KeepExemption

// ChapterAction is the decision action for a chapter.
type ChapterAction = diff.ChapterAction

const (
	ActionKeep   = diff.ActionKeep
	ActionUpdate = diff.ActionUpdate
)

// ChapterSemanticDecision represents the deterministic verdict for a chapter.
type ChapterSemanticDecision = diff.ChapterSemanticDecision

// BackboneDrift reflects changes in core structural nodes between versions.
type BackboneDrift = diff.BackboneDrift

// GraphDiffStats aggregates summary statistics of the semantic diff.
type GraphDiffStats = diff.GraphDiffStats

// GraphDiffResponse represents the response payload of POST /v1/graph/diff.
type GraphDiffResponse = diff.GraphDiffResponse
