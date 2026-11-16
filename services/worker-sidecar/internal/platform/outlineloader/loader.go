package outlineloader

import (
	"context"
	"errors"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/opengits/worker-sidecar/internal/ingest"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

// OutlineNode represents a single outline leaf pointing to a document.
type OutlineNode struct {
	ID            string  `json:"id"`
	ChapterID     string  `json:"chapterId"`
	Title         string  `json:"title"`
	NodeType      string  `json:"nodeType"`
	HeadingPath   *string `json:"headingPath"`
	DocumentID    *string `json:"documentId"`
	DocPath       *string `json:"docPath"`
	DocStatus     *string `json:"docStatus"`
	TeachingOrder int     `json:"teachingOrder"`
}

// OutlineChapter represents a pedagogical unit (chapter).
type OutlineChapter struct {
	ID            string        `json:"id"`
	PartID        *string       `json:"partId"`
	Title         string        `json:"title"`
	Summary       *string       `json:"summary"`
	ChapterType   string        `json:"chapterType"`
	ModuleName    *string       `json:"moduleName"`
	TeachingOrder int           `json:"teachingOrder"`
	Nodes         []OutlineNode `json:"nodes"`
}

// OutlinePart represents a top-level grouping part.
type OutlinePart struct {
	ID            string           `json:"id"`
	Title         string           `json:"title"`
	Summary       *string          `json:"summary"`
	TeachingOrder int              `json:"teachingOrder"`
	Chapters      []OutlineChapter `json:"chapters"`
}

// ActiveOutlineTree represents the complete active outline tree.
type ActiveOutlineTree struct {
	OutlineID        string           `json:"outlineId"`
	Version          int              `json:"version"`
	Mode             string           `json:"mode"`
	Parts            []OutlinePart    `json:"parts"`
	TopLevelChapters []OutlineChapter `json:"chapters"`
	AllChapters      []OutlineChapter `json:"-"`
}

// NavNode is an alias to ingest.NavNode (the system SSOT navigation node).
type NavNode = ingest.NavNode

// RawNavNode represents a minimal navigation node for MCP JSON serialization.
type RawNavNode struct {
	Type     string       `json:"type"`
	Title    string       `json:"title"`
	Path     string       `json:"path,omitempty"`
	Children []RawNavNode `json:"children,omitempty"`
}

// IsArchitectureOverviewDoc checks if a document is an architecture overview document.
func IsArchitectureOverviewDoc(path string) bool {
	return path == "architecture-overview" || path == "architecture-overview.md" || path == "architecture-overview.mdx"
}

// LoadActiveOutlineTree loads the active outline hierarchy (Part -> Chapter -> Node) using sqlc db.Querier.
func LoadActiveOutlineTree(ctx context.Context, dbtx db.DBTX, repoID string) (*ActiveOutlineTree, error) {
	if dbtx == nil {
		return nil, errors.New("dbtx is nil")
	}
	q := db.New(dbtx)

	outlineRow, err := q.GetActiveOutlineByRepoID(ctx, repoID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}

	partRows, err := q.GetOutlinePartsByOutlineID(ctx, outlineRow.ID)
	if err != nil {
		return nil, err
	}

	chapterRows, err := q.GetOutlineChaptersByOutlineID(ctx, outlineRow.ID)
	if err != nil {
		return nil, err
	}

	chapterIDs := make([]string, 0, len(chapterRows))
	for _, cr := range chapterRows {
		chapterIDs = append(chapterIDs, cr.ID)
	}

	nodesByChapter := make(map[string][]OutlineNode, len(chapterIDs))
	if len(chapterIDs) > 0 {
		nodeRows, err := q.GetOutlineNodesByChapterIDs(ctx, chapterIDs)
		if err != nil {
			return nil, err
		}
		for _, nr := range nodeRows {
			var headingPath *string
			if nr.HeadingPath.Valid {
				s := nr.HeadingPath.String
				headingPath = &s
			}
			var documentID *string
			if nr.DocumentId.Valid {
				s := nr.DocumentId.String
				documentID = &s
			}
			var docPath *string
			if nr.DocPath.Valid {
				s := nr.DocPath.String
				docPath = &s
			}
			var docStatus *string
			if nr.DocStatus.Valid {
				s := string(nr.DocStatus.DocumentStatus)
				docStatus = &s
			}

			nodesByChapter[nr.ChapterId] = append(nodesByChapter[nr.ChapterId], OutlineNode{
				ID:            nr.ID,
				ChapterID:     nr.ChapterId,
				Title:         nr.Title,
				NodeType:      nr.NodeType,
				HeadingPath:   headingPath,
				DocumentID:    documentID,
				DocPath:       docPath,
				DocStatus:     docStatus,
				TeachingOrder: int(nr.TeachingOrder),
			})
		}
	}

	parts := make([]OutlinePart, 0, len(partRows))
	partIndex := make(map[string]int, len(partRows))
	for _, pr := range partRows {
		var summary *string
		if pr.Summary.Valid {
			s := pr.Summary.String
			summary = &s
		}
		partIndex[pr.ID] = len(parts)
		parts = append(parts, OutlinePart{
			ID:            pr.ID,
			Title:         pr.Title,
			Summary:       summary,
			TeachingOrder: int(pr.TeachingOrder),
			Chapters:      []OutlineChapter{},
		})
	}

	allChapters := make([]OutlineChapter, 0, len(chapterRows))
	var topLevelChapters []OutlineChapter
	for _, cr := range chapterRows {
		var partID *string
		if cr.PartId.Valid {
			s := cr.PartId.String
			partID = &s
		}
		var summary *string
		if cr.Summary.Valid {
			s := cr.Summary.String
			summary = &s
		}
		var moduleName *string
		if cr.ModuleName.Valid {
			s := cr.ModuleName.String
			moduleName = &s
		}

		cNodes := nodesByChapter[cr.ID]
		if cNodes == nil {
			cNodes = []OutlineNode{}
		}

		chap := OutlineChapter{
			ID:            cr.ID,
			PartID:        partID,
			Title:         cr.Title,
			Summary:       summary,
			ChapterType:   cr.ChapterType,
			ModuleName:    moduleName,
			TeachingOrder: int(cr.TeachingOrder),
			Nodes:         cNodes,
		}
		allChapters = append(allChapters, chap)

		if partID != nil {
			if idx, ok := partIndex[*partID]; ok {
				parts[idx].Chapters = append(parts[idx].Chapters, chap)
				continue
			}
		}
		topLevelChapters = append(topLevelChapters, chap)
	}

	validParts := make([]OutlinePart, 0, len(parts))
	for _, p := range parts {
		if len(p.Chapters) > 0 {
			validParts = append(validParts, p)
		}
	}

	return &ActiveOutlineTree{
		OutlineID:        outlineRow.ID,
		Version:          int(outlineRow.Version),
		Mode:             outlineRow.Mode,
		Parts:            validParts,
		TopLevelChapters: topLevelChapters,
		AllChapters:      allChapters,
	}, nil
}

// BuildNavTree projects the active outline tree into []*ingest.NavNode.
func (t *ActiveOutlineTree) BuildNavTree(urlBuilder func(docPath string) (name, url string)) []*ingest.NavNode {
	if t == nil {
		return []*ingest.NavNode{}
	}

	type partTracker struct {
		title         string
		teachingOrder int
		firstSubOrder int
		chapters      []*ingest.NavNode
	}

	partMap := make(map[string]*partTracker, len(t.Parts))
	for _, p := range t.Parts {
		partMap[p.ID] = &partTracker{
			title:         p.Title,
			teachingOrder: p.TeachingOrder,
			chapters:      []*ingest.NavNode{},
		}
	}

	type orderedRootItem struct {
		Order    int
		SubOrder int
		Title    string
		Node     *ingest.NavNode
	}
	var orderedItems []orderedRootItem

	for _, c := range t.AllChapters {
		var cNodes []*ingest.NavNode
		for _, n := range c.Nodes {
			if n.DocPath == nil || *n.DocPath == "" {
				continue
			}
			path := *n.DocPath
			if IsArchitectureOverviewDoc(path) {
				continue
			}

			node := &ingest.NavNode{
				Title: n.Title,
				Type:  "file",
				Path:  path,
			}
			if urlBuilder != nil {
				name, u := urlBuilder(path)
				node.Name = name
				node.Url = u
			}
			cNodes = append(cNodes, node)
		}

		if len(cNodes) == 0 {
			continue
		}

		var chNavNode *ingest.NavNode
		if len(cNodes) == 1 && (cNodes[0].Title == c.Title || c.Title == "") {
			chNavNode = cNodes[0]
		} else {
			chNavNode = &ingest.NavNode{
				Title:    c.Title,
				Type:     "directory",
				Children: cNodes,
			}
			if urlBuilder != nil {
				chNavNode.Name = c.Title
			}
		}

		if c.PartID != nil {
			if p, ok := partMap[*c.PartID]; ok {
				if len(p.chapters) == 0 {
					p.firstSubOrder = c.TeachingOrder
				}
				p.chapters = append(p.chapters, chNavNode)
				continue
			}
		}

		orderedItems = append(orderedItems, orderedRootItem{
			Order:    c.TeachingOrder,
			SubOrder: c.TeachingOrder,
			Title:    c.Title,
			Node:     chNavNode,
		})
	}

	for _, p := range t.Parts {
		pt, ok := partMap[p.ID]
		if !ok || len(pt.chapters) == 0 {
			continue
		}

		order := pt.teachingOrder
		if order == 0 {
			order = pt.firstSubOrder
		}

		dirNode := &ingest.NavNode{
			Title:    pt.title,
			Type:     "directory",
			Children: pt.chapters,
		}
		if urlBuilder != nil {
			dirNode.Name = pt.title
		}

		orderedItems = append(orderedItems, orderedRootItem{
			Order:    order,
			SubOrder: pt.firstSubOrder,
			Title:    pt.title,
			Node:     dirNode,
		})
	}

	sort.SliceStable(orderedItems, func(i, j int) bool {
		if orderedItems[i].Order != orderedItems[j].Order {
			return orderedItems[i].Order < orderedItems[j].Order
		}
		if orderedItems[i].SubOrder != orderedItems[j].SubOrder {
			return orderedItems[i].SubOrder < orderedItems[j].SubOrder
		}
		return orderedItems[i].Title < orderedItems[j].Title
	})

	result := make([]*ingest.NavNode, 0, len(orderedItems))
	for _, item := range orderedItems {
		result = append(result, item.Node)
	}

	return result
}

// BuildRawNavTree projects the active outline tree into minimal RawNavNode hierarchy for MCP audit JSON.
func (t *ActiveOutlineTree) BuildRawNavTree() []RawNavNode {
	if t == nil {
		return []RawNavNode{}
	}

	type partTracker struct {
		title         string
		teachingOrder int
		firstSubOrder int
		chapters      []RawNavNode
	}

	partMap := make(map[string]*partTracker, len(t.Parts))
	for _, p := range t.Parts {
		partMap[p.ID] = &partTracker{
			title:         p.Title,
			teachingOrder: p.TeachingOrder,
			chapters:      []RawNavNode{},
		}
	}

	type orderedRootItem struct {
		Order    int
		SubOrder int
		Title    string
		Node     RawNavNode
	}
	var orderedItems []orderedRootItem

	for _, c := range t.AllChapters {
		var cNodes []RawNavNode
		for _, n := range c.Nodes {
			if n.DocPath == nil || *n.DocPath == "" {
				continue
			}
			path := *n.DocPath
			if IsArchitectureOverviewDoc(path) {
				continue
			}

			cNodes = append(cNodes, RawNavNode{
				Title: n.Title,
				Type:  "file",
				Path:  path,
			})
		}

		if len(cNodes) == 0 {
			continue
		}

		var chNavNode RawNavNode
		if len(cNodes) == 1 && (cNodes[0].Title == c.Title || c.Title == "") {
			chNavNode = cNodes[0]
		} else {
			chNavNode = RawNavNode{
				Title:    c.Title,
				Type:     "directory",
				Children: cNodes,
			}
		}

		if c.PartID != nil {
			if p, ok := partMap[*c.PartID]; ok {
				if len(p.chapters) == 0 {
					p.firstSubOrder = c.TeachingOrder
				}
				p.chapters = append(p.chapters, chNavNode)
				continue
			}
		}

		orderedItems = append(orderedItems, orderedRootItem{
			Order:    c.TeachingOrder,
			SubOrder: c.TeachingOrder,
			Title:    c.Title,
			Node:     chNavNode,
		})
	}

	for _, p := range t.Parts {
		pt, ok := partMap[p.ID]
		if !ok || len(pt.chapters) == 0 {
			continue
		}

		order := pt.teachingOrder
		if order == 0 {
			order = pt.firstSubOrder
		}

		dirNode := RawNavNode{
			Title:    pt.title,
			Type:     "directory",
			Children: pt.chapters,
		}

		orderedItems = append(orderedItems, orderedRootItem{
			Order:    order,
			SubOrder: pt.firstSubOrder,
			Title:    pt.title,
			Node:     dirNode,
		})
	}

	sort.SliceStable(orderedItems, func(i, j int) bool {
		if orderedItems[i].Order != orderedItems[j].Order {
			return orderedItems[i].Order < orderedItems[j].Order
		}
		if orderedItems[i].SubOrder != orderedItems[j].SubOrder {
			return orderedItems[i].SubOrder < orderedItems[j].SubOrder
		}
		return orderedItems[i].Title < orderedItems[j].Title
	})

	result := make([]RawNavNode, 0, len(orderedItems))
	for _, item := range orderedItems {
		result = append(result, item.Node)
	}

	return result
}

// NavNodeBaseName extracts a readable basename from a document path.
func NavNodeBaseName(p string) string {
	base := filepath.Base(p)
	ext := filepath.Ext(base)
	return strings.TrimSuffix(base, ext)
}
