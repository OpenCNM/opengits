package diff

type ArchiveDiffRequest struct {
	Owner   string `json:"owner"`
	Repo    string `json:"repo"`
	OldSha  string `json:"oldSha,omitempty"`
	NewSha  string `json:"newSha,omitempty"`
	FromSha string `json:"fromSha,omitempty"`
	ToSha   string `json:"toSha,omitempty"`
}

type DiffHunk struct {
	OldStart int      `json:"oldStart"`
	OldLines int      `json:"oldLines"`
	NewStart int      `json:"newStart"`
	NewLines int      `json:"newLines"`
	Lines    []string `json:"lines"`
}

type UnifiedDiffResult struct {
	Unified   string     `json:"unified"`
	Hunks     []DiffHunk `json:"hunks"`
	Additions int        `json:"additions"`
	Deletions int        `json:"deletions"`
	Degraded  bool       `json:"degraded"`
}

type ChapterRename struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type ArchiveDiff struct {
	Added    []string        `json:"added"`
	Modified []string        `json:"modified"`
	Removed  []string        `json:"removed"`
	Renamed  []ChapterRename `json:"renamed"`
}

type UpdateArchiveDiff = ArchiveDiff

type DiffChapterInput struct {
	Path  string   `json:"path"`
	Files []string `json:"files"`
}

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

type SymbolDiffItem struct {
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	Change       string `json:"change"`
	Exported     bool   `json:"exported"`
	StartLine    int    `json:"startLine"`
	EndLine      int    `json:"endLine"`
	OldStartLine int    `json:"oldStartLine,omitempty"`
	OldEndLine   int    `json:"oldEndLine,omitempty"`
	DiffSnippet  string `json:"diffSnippet,omitempty"`
}

type FileSemanticCategory string

const (
	FileCategoryAstIdentical    FileSemanticCategory = "AST_IDENTICAL"
	FileCategoryPrivateOnly     FileSemanticCategory = "PRIVATE_ONLY"
	FileCategoryExportedChanged FileSemanticCategory = "EXPORTED_CHANGED"
	FileCategoryUntouched       FileSemanticCategory = "UNTOUCHED"
	FileCategoryRippleAffected  FileSemanticCategory = "RIPPLE_AFFECTED"
)

type FileSemanticDiff struct {
	Path        string               `json:"path"`
	Category    FileSemanticCategory `json:"category"`
	SymbolDiffs []SymbolDiffItem     `json:"symbolDiffs"`
	Details     string               `json:"details,omitempty"`
}

type SurgicalAnchor struct {
	SymbolName  string `json:"symbolName"`
	Kind        string `json:"kind"`
	File        string `json:"file"`
	Change      string `json:"change"`
	Exported    bool   `json:"exported"`
	Line        int    `json:"line"`
	Reason      string `json:"reason"`
	DiffSnippet string `json:"diffSnippet,omitempty"`
}

type KeepExemption struct {
	Reason   string `json:"reason"`
	Evidence string `json:"evidence"`
}

type ChapterAction string

const (
	ActionKeep   ChapterAction = "keep"
	ActionUpdate ChapterAction = "update"
)

type ChapterSemanticDecision struct {
	Path            string           `json:"path"`
	Action          ChapterAction    `json:"action"`
	KeepExemption   *KeepExemption   `json:"keepExemption,omitempty"`
	SurgicalAnchors []SurgicalAnchor `json:"surgicalAnchors,omitempty"`
	IsBreaking      bool             `json:"isBreaking"`
}

type BackboneDrift struct {
	Index           float64  `json:"index"`
	AddedBackbone   []string `json:"addedBackbone"`
	RemovedBackbone []string `json:"removedBackbone"`
	UnionSize       int      `json:"unionSize"`
}

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
