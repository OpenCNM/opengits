package chapter

import (
	"encoding/json"
	"sort"
	"strings"
)

type rawChapterAsset struct {
	Path string
	Kind string
}

type rawChapter struct {
	Order      float64
	Title      string
	MainPath   string
	AssetPaths []rawChapterAsset
}

func tolerantString(v json.RawMessage, fallback string) string {
	if len(v) == 0 {
		return fallback
	}
	var s string
	if err := json.Unmarshal(v, &s); err != nil {
		return fallback
	}
	return s
}

func tolerantNumber(v json.RawMessage, fallback float64) float64 {
	if len(v) == 0 {
		return fallback
	}
	var f float64
	if err := json.Unmarshal(v, &f); err != nil {
		return fallback
	}
	return f
}

func validAssetKind(kind string) bool {
	switch kind {
	case "exercise", "example", "answer", "resource":
		return true
	}
	return false
}

// Mirrors Zod catch semantics: invalid element resets array to []; invalid scalar falls back to default.
func decodeRawChapters(raw json.RawMessage) (chapters []rawChapter, ok bool) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return nil, false
	}
	chapters = []rawChapter{}
	rawChapters, present := top["chapters"]
	if !present {
		return chapters, true
	}
	var items []json.RawMessage
	if err := json.Unmarshal(rawChapters, &items); err != nil {
		return chapters, true
	}
	for _, item := range items {
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(item, &obj); err != nil {
			return []rawChapter{}, true
		}
		chapter := rawChapter{
			Order:      tolerantNumber(obj["order"], 0),
			Title:      tolerantString(obj["title"], ""),
			MainPath:   tolerantString(obj["mainPath"], ""),
			AssetPaths: []rawChapterAsset{},
		}
		if rawAssets, has := obj["assetPaths"]; has {
			var assetItems []json.RawMessage
			if err := json.Unmarshal(rawAssets, &assetItems); err == nil {
				for _, ai := range assetItems {
					var aobj map[string]json.RawMessage
					if err := json.Unmarshal(ai, &aobj); err != nil {
						chapter.AssetPaths = []rawChapterAsset{}
						break
					}
					kind := tolerantString(aobj["kind"], "resource")
					if !validAssetKind(kind) {
						kind = "resource"
					}
					chapter.AssetPaths = append(chapter.AssetPaths, rawChapterAsset{
						Path: tolerantString(aobj["path"], ""),
						Kind: kind,
					})
				}
			}
		}
		chapters = append(chapters, chapter)
	}
	return chapters, true
}

func ValidateChapterMap(raw json.RawMessage, nodes []ChapterMapNode) []ChapterMapEntry {
	return getDefaultPatterns().ValidateChapterMap(raw, nodes)
}

func (p *ingestPatterns) ValidateChapterMap(raw json.RawMessage, nodes []ChapterMapNode) []ChapterMapEntry {
	pipeline := newChapterMapValidationPipeline(p, nodes)
	return pipeline.Execute(raw)
}

type chapterDraftEntry struct {
	entry   ChapterMapEntry
	sortKey float64
}

type chapterMapValidationPipeline struct {
	patterns  *ingestPatterns
	nodes     []ChapterMapNode
	blobPaths map[string]bool
}

func newChapterMapValidationPipeline(p *ingestPatterns, nodes []ChapterMapNode) *chapterMapValidationPipeline {
	blobPaths := make(map[string]bool, len(nodes))
	for _, n := range nodes {
		if n.Type == "blob" {
			blobPaths[n.Path] = true
		}
	}
	return &chapterMapValidationPipeline{
		patterns:  p,
		nodes:     nodes,
		blobPaths: blobPaths,
	}
}

func (pipe *chapterMapValidationPipeline) Execute(raw json.RawMessage) []ChapterMapEntry {
	parsed, ok := decodeRawChapters(raw)
	if !ok {
		return nil
	}

	entries := pipe.filterAndDeduplicate(parsed)
	if len(entries) < ChapterMapMinChapters {
		return nil
	}

	return pipe.rankAndRenumber(entries)
}

func (pipe *chapterMapValidationPipeline) filterAndDeduplicate(parsed []rawChapter) []chapterDraftEntry {
	seenMains := make(map[string]bool, len(parsed))
	entries := make([]chapterDraftEntry, 0, len(parsed))

	for idx, chapter := range parsed {
		if chapter.MainPath == "" || !pipe.blobPaths[chapter.MainPath] || !pipe.patterns.isDocFilePath(chapter.MainPath) {
			continue
		}
		if seenMains[chapter.MainPath] {
			continue
		}
		seenMains[chapter.MainPath] = true

		assetPaths := pipe.cleanAssetPaths(chapter.MainPath, chapter.AssetPaths)

		sortKey := float64(idx + 1)
		if chapter.Order > 0 {
			sortKey = chapter.Order
		}
		title := strings.TrimSpace(chapter.Title)
		if title == "" {
			title = deriveChapterTitle(chapter.MainPath)
		}

		entries = append(entries, chapterDraftEntry{
			entry: ChapterMapEntry{
				Order:      int(sortKey),
				Title:      title,
				MainPath:   chapter.MainPath,
				AssetPaths: assetPaths,
			},
			sortKey: sortKey,
		})
	}
	return entries
}

func (pipe *chapterMapValidationPipeline) cleanAssetPaths(mainPath string, rawAssets []rawChapterAsset) []ChapterMapAsset {
	seenAssets := make(map[string]bool, len(rawAssets))
	assetPaths := make([]ChapterMapAsset, 0, len(rawAssets))
	for _, asset := range rawAssets {
		if asset.Path == "" || !pipe.blobPaths[asset.Path] || asset.Path == mainPath {
			continue
		}
		if seenAssets[asset.Path] {
			continue
		}
		seenAssets[asset.Path] = true
		assetPaths = append(assetPaths, ChapterMapAsset{Path: asset.Path, Kind: asset.Kind})
	}
	return assetPaths
}

func (pipe *chapterMapValidationPipeline) rankAndRenumber(entries []chapterDraftEntry) []ChapterMapEntry {
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].sortKey != entries[j].sortKey {
			return entries[i].sortKey < entries[j].sortKey
		}
		return naturalCompare(entries[i].entry.MainPath, entries[j].entry.MainPath) < 0
	})
	out := make([]ChapterMapEntry, len(entries))
	for i, d := range entries {
		d.entry.Order = i + 1
		out[i] = d.entry
	}
	return out
}
