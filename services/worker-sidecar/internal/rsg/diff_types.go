package rsg

import "github.com/opengits/worker-sidecar/internal/diff"

type DiffChapterInput = diff.DiffChapterInput

type GraphDiffRequest = diff.GraphDiffRequest

type SymbolDiffItem = diff.SymbolDiffItem

type FileSemanticCategory = diff.FileSemanticCategory

const (
	FileCategoryAstIdentical    = diff.FileCategoryAstIdentical
	FileCategoryPrivateOnly     = diff.FileCategoryPrivateOnly
	FileCategoryExportedChanged = diff.FileCategoryExportedChanged
	FileCategoryUntouched       = diff.FileCategoryUntouched
	FileCategoryRippleAffected  = diff.FileCategoryRippleAffected
)

type FileSemanticDiff = diff.FileSemanticDiff

type SurgicalAnchor = diff.SurgicalAnchor

type KeepExemption = diff.KeepExemption

type ChapterAction = diff.ChapterAction

const (
	ActionKeep   = diff.ActionKeep
	ActionUpdate = diff.ActionUpdate
)

type ChapterSemanticDecision = diff.ChapterSemanticDecision

type BackboneDrift = diff.BackboneDrift

type GraphDiffStats = diff.GraphDiffStats

type GraphDiffResponse = diff.GraphDiffResponse
