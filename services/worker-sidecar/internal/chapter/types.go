package chapter

// ─────────────────────────────────────────────────────────────
// 章节映射领域数据模型与常量契约
// ─────────────────────────────────────────────────────────────

const (
	ChapterMapCandidateCap = 300
	ChapterMapMinChapters  = 2
	TocMinIntersection     = 3
)

// ChapterMapNode 与 GitHubNode 的线上投影（仅 path/type）。
type ChapterMapNode struct {
	Path string `json:"path"`
	Type string `json:"type"`
}

// ChapterMapAsset 与 TS ChapterMapAsset 对齐。
type ChapterMapAsset struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
}

// ChapterMapEntry 与 TS ChapterMapEntry 对齐。
type ChapterMapEntry struct {
	Order      int               `json:"order"`
	Title      string            `json:"title"`
	MainPath   string            `json:"mainPath"`
	AssetPaths []ChapterMapAsset `json:"assetPaths"`
}

// ChapterCandidates 与 TS ChapterCandidates 对齐。
type ChapterCandidates struct {
	DocFiles  []string `json:"docFiles"`
	CodeFiles []string `json:"codeFiles"`
}

// OrderSignal 与 TS OrderSignal 对齐。
type OrderSignal struct {
	Type     string   `json:"type"` // "toc" | "numeric" | "none"
	Sequence []string `json:"sequence"`
}

// TextbookRepoProfile 与 TS 侧 profile 投影对齐（仅消费两个字段）。
type TextbookRepoProfile struct {
	ChapterCount *int              `json:"chapterCount,omitempty"`
	ChapterMap   []ChapterMapEntry `json:"chapterMap,omitempty"`
}
