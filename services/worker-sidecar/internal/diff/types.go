package diff

// ArchiveDiffRequest captures inputs for POST /v1/archive/diff.
type ArchiveDiffRequest struct {
	Owner   string `json:"owner"`
	Repo    string `json:"repo"`
	OldSha  string `json:"oldSha,omitempty"`
	NewSha  string `json:"newSha,omitempty"`
	FromSha string `json:"fromSha,omitempty"`
	ToSha   string `json:"toSha,omitempty"`
}

// DiffHunk represents a unified diff chunk with start and line counts.
type DiffHunk struct {
	OldStart int      `json:"oldStart"`
	OldLines int      `json:"oldLines"`
	NewStart int      `json:"newStart"`
	NewLines int      `json:"newLines"`
	Lines    []string `json:"lines"`
}

// UnifiedDiffResult represents full unified diff output and stats.
// Degraded=true 表示编辑距离超限的整文件删+加兜底（Additions/Deletions
// 非精确统计，语义为"确定有变化"）——下游按"已变更"处理（决策 A），
// 但不得把行数当精确数字展示或计费。
type UnifiedDiffResult struct {
	Unified   string     `json:"unified"`
	Hunks     []DiffHunk `json:"hunks"`
	Additions int        `json:"additions"`
	Deletions int        `json:"deletions"`
	Degraded  bool       `json:"degraded"`
}

// ChapterRename captures an in-place rename mapping.
type ChapterRename struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// ArchiveDiff represents the result of comparing two unpacked archive directories.
type ArchiveDiff struct {
	Added    []string        `json:"added"`
	Modified []string        `json:"modified"`
	Removed  []string        `json:"removed"`
	Renamed  []ChapterRename `json:"renamed"`
}

// UpdateArchiveDiff is an alias for backward compatibility.
type UpdateArchiveDiff = ArchiveDiff

// DiffChapterInput represents an input chapter and the files belonging to it.
type DiffChapterInput struct {
	Path  string   `json:"path"`
	Files []string `json:"files"`
}

// GraphDiffRequest represents the input payload for POST /v1/graph/diff.
type GraphDiffRequest struct {
	Owner         string             `json:"owner"`
	Repo          string             `json:"repo"`
	FromSha       string             `json:"fromSha"`
	ToSha         string             `json:"toSha"`
	ModifiedFiles []string           `json:"modifiedFiles"`
	AddedFiles    []string           `json:"addedFiles"`
	RemovedFiles  []string           `json:"removedFiles"`
	Chapters      []DiffChapterInput `json:"chapters"`
}

// SymbolDiffItem represents changes in an individual symbol.
type SymbolDiffItem struct {
	Name         string `json:"name"`
	Kind         string `json:"kind"`   // "function" | "type"
	Change       string `json:"change"` // "added" | "removed" | "modified" | "ripple"
	Exported     bool   `json:"exported"`
	StartLine    int    `json:"startLine"`
	EndLine      int    `json:"endLine"`
	OldStartLine int    `json:"oldStartLine,omitempty"`
	OldEndLine   int    `json:"oldEndLine,omitempty"`
	DiffSnippet  string `json:"diffSnippet,omitempty"`
}

// FileSemanticCategory classifies the nature of file changes.
type FileSemanticCategory string

const (
	FileCategoryAstIdentical    FileSemanticCategory = "AST_IDENTICAL"
	FileCategoryPrivateOnly     FileSemanticCategory = "PRIVATE_ONLY"
	FileCategoryExportedChanged FileSemanticCategory = "EXPORTED_CHANGED"
	FileCategoryUntouched       FileSemanticCategory = "UNTOUCHED"
	FileCategoryRippleAffected  FileSemanticCategory = "RIPPLE_AFFECTED"
)

// FileSemanticDiff contains semantic comparison details for a single file.
type FileSemanticDiff struct {
	Path        string               `json:"path"`
	Category    FileSemanticCategory `json:"category"`
	SymbolDiffs []SymbolDiffItem     `json:"symbolDiffs"`
	Details     string               `json:"details,omitempty"`
}

// SurgicalAnchor locates a specific code symbol change for targeted LLM updating.
type SurgicalAnchor struct {
	SymbolName  string `json:"symbolName"`
	Kind        string `json:"kind"` // "function" | "type"
	File        string `json:"file"`
	Change      string `json:"change"` // "added" | "removed" | "modified" | "ripple"
	Exported    bool   `json:"exported"`
	Line        int    `json:"line"`
	Reason      string `json:"reason"`
	DiffSnippet string `json:"diffSnippet,omitempty"`
}

// KeepExemption explains why a chapter is exempt from updating.
type KeepExemption struct {
	Reason   string `json:"reason"`
	Evidence string `json:"evidence"`
}

// ChapterAction is the decision action for a chapter.
type ChapterAction string

const (
	ActionKeep   ChapterAction = "keep"
	ActionUpdate ChapterAction = "update"
)

// ChapterSemanticDecision represents the deterministic verdict for a chapter.
type ChapterSemanticDecision struct {
	Path            string           `json:"path"`
	Action          ChapterAction    `json:"action"`
	KeepExemption   *KeepExemption   `json:"keepExemption,omitempty"`
	SurgicalAnchors []SurgicalAnchor `json:"surgicalAnchors,omitempty"`
	IsBreaking      bool             `json:"isBreaking"`
}

// BackboneDrift reflects changes in core structural nodes between versions.
type BackboneDrift struct {
	Index           float64  `json:"index"`
	AddedBackbone   []string `json:"addedBackbone"`
	RemovedBackbone []string `json:"removedBackbone"`
	UnionSize       int      `json:"unionSize"`
}

// GraphDiffStats aggregates summary statistics of the semantic diff.
type GraphDiffStats struct {
	TotalFiles           int `json:"totalFiles"`
	AstIdenticalFiles    int `json:"astIdenticalFiles"`
	PrivateOnlyFiles     int `json:"privateOnlyFiles"`
	ExportedChangedFiles int `json:"exportedChangedFiles"`
	RippleAffectedFiles  int `json:"rippleAffectedFiles"`
	TotalChapters        int `json:"totalChapters"`
	ExemptChapters       int `json:"exemptChapters"`
	UpdateChapters       int `json:"updateChapters"`
}

// RecordCategory increments category statistics for a single file.
func (s *GraphDiffStats) RecordCategory(cat FileSemanticCategory) {
	switch cat {
	case FileCategoryAstIdentical:
		s.AstIdenticalFiles++
	case FileCategoryPrivateOnly:
		s.PrivateOnlyFiles++
	case FileCategoryExportedChanged:
		s.ExportedChangedFiles++
	case FileCategoryRippleAffected:
		s.RippleAffectedFiles++
	}
}

// GraphDiffResponse represents the response payload of POST /v1/graph/diff.
type GraphDiffResponse struct {
	FromSha            string                      `json:"fromSha"`
	ToSha              string                      `json:"toSha"`
	FileDiffs          map[string]FileSemanticDiff `json:"fileDiffs"`
	ChapterDecisions   []ChapterSemanticDecision   `json:"chapterDecisions"`
	GraphDrift         *BackboneDrift              `json:"graphDrift,omitempty"`
	SuggestsNewEdition bool                        `json:"suggestsNewEdition"`
	IsBreaking         bool                        `json:"isBreaking"`
	Stats              GraphDiffStats              `json:"stats"`
}
