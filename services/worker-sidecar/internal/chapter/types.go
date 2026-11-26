package chapter

const (
	ChapterMapCandidateCap = 300
	ChapterMapMinChapters  = 2
	TocMinIntersection     = 3
)

type ChapterMapNode struct {
	Path string `json:"path"`
	Type string `json:"type"`
}

type ChapterMapAsset struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
}

type ChapterMapEntry struct {
	Order      int               `json:"order"`
	Title      string            `json:"title"`
	MainPath   string            `json:"mainPath"`
	AssetPaths []ChapterMapAsset `json:"assetPaths"`
}

type ChapterCandidates struct {
	DocFiles  []string `json:"docFiles"`
	CodeFiles []string `json:"codeFiles"`
}

type OrderSignal struct {
	Type     string   `json:"type"`
	Sequence []string `json:"sequence"`
}

type TextbookRepoProfile struct {
	ChapterCount *int              `json:"chapterCount,omitempty"`
	ChapterMap   []ChapterMapEntry `json:"chapterMap,omitempty"`
}
