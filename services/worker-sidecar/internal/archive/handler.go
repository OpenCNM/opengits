package archive

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"reflect"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type GitNode = cluster.GitNode

type ArchiveTreeRequest struct {
	Owner string `json:"owner"`
	Repo  string `json:"repo"`
	Sha   string `json:"sha"`
}

type ArchiveTreeResponse struct {
	Ok    bool      `json:"ok"`
	Nodes []GitNode `json:"nodes"`
}

type ScaleDecision struct {
	Scale      string `json:"scale"`
	Confidence string `json:"confidence"`
	Reason     string `json:"reason"`
	TotalFiles int    `json:"totalFiles"`
	MaxDepth   int    `json:"maxDepth"`
}

type FileExclusionVerdict struct {
	IsExcluded    bool   `json:"isExcluded"`
	Category      string `json:"category,omitempty"`
	CategoryLabel string `json:"categoryLabel,omitempty"`
	Reason        string `json:"reason,omitempty"`
}

type DocCodeRatio struct {
	DocFiles       int            `json:"docFiles"`
	CodeFiles      int            `json:"codeFiles"`
	OtherFiles     int            `json:"otherFiles"`
	TotalFiles     int            `json:"totalFiles"`
	Ratio          float64        `json:"ratio"`
	CodeExtensions map[string]int `json:"codeExtensions"`
	DocExtensions  map[string]int `json:"docExtensions"`
	// Track code/doc byte mass alongside file counts to distinguish codebases with docs from doc repos with snippets.
	CodeBytes int64 `json:"codeBytes"`
	DocBytes  int64 `json:"docBytes"`
}

type SniffProfile struct {
	Tier            string       `json:"tier"`
	RepoType        string       `json:"repoType"`
	IngestMode      string       `json:"ingestMode"`
	DocCodeRatio    DocCodeRatio `json:"docCodeRatio"`
	IsTreeTruncated bool         `json:"isTreeTruncated"`
	TextRoot        *string      `json:"textRoot"`
	LabRoots        []string     `json:"labRoots"`
	ChapterCount    int          `json:"chapterCount"`
	GlobalAssets    struct {
		Pdfs []struct {
			Path string `json:"path"`
			Size int64  `json:"size"`
			Lang string `json:"lang,omitempty"`
		} `json:"pdfs"`
		Translations []struct {
			Lang string `json:"lang"`
			Dir  string `json:"dir"`
		} `json:"translations"`
		BuildScripts []string `json:"buildScripts"`
		Misc         []string `json:"misc"`
	} `json:"globalAssets"`
	AnswerFile       *string           `json:"answerFile"`
	HasTranslations  bool              `json:"hasTranslations"`
	TranslationRoots []string          `json:"translationRoots"`
	ExcludeFromNav   []string          `json:"excludeFromNav"`
	SemanticTags     map[string]string `json:"semanticTags"`
}

type ArchiveSniffRequest struct {
	Owner           string     `json:"owner,omitempty"`
	Repo            string     `json:"repo,omitempty"`
	Sha             string     `json:"sha,omitempty"`
	Nodes           *[]GitNode `json:"nodes,omitempty"`
	IsTreeTruncated bool       `json:"isTreeTruncated,omitempty"`
}

type ArchiveSniffResponse struct {
	Ok      bool          `json:"ok"`
	Profile SniffProfile  `json:"profile"`
	Scale   ScaleDecision `json:"scale"`
}

type ArchiveEnsureRequest struct {
	Owner         string   `json:"owner"`
	Repo          string   `json:"repo"`
	Sha           string   `json:"sha"`
	SizeHintBytes int64    `json:"sizeHintBytes,omitempty"`
	Token         string   `json:"token,omitempty"`
	MaxCapBytes   int64    `json:"maxCapBytes,omitempty"`
	PrefixScope   string   `json:"prefixScope,omitempty"`
	Prefix        string   `json:"prefix,omitempty"`
	AllowedFiles  []string `json:"allowedFiles,omitempty"`
}

type ArchiveEnsureResponse struct {
	Dir       *string `json:"dir"`
	FromCache bool    `json:"fromCache"`
}

type RepoSniffer interface {
	SniffRepo(nodes []GitNode, isTreeTruncated bool) SniffProfile
	ComputeRepoScale(nodes []GitNode) ScaleDecision
}

type Handler struct {
	cfg           Config
	ensureService *EnsureService
	assets        AssetStore
	assetClient   *http.Client
	assetSF       singleflight.Group
	getSniffer    func() RepoSniffer
}

func NewHandler(cfg Config, ensureService *EnsureService, assets AssetStore, snifferProvider ...any) *Handler {
	var getSniffer func() RepoSniffer
	if len(snifferProvider) > 0 && snifferProvider[0] != nil {
		sp := snifferProvider[0]
		switch s := sp.(type) {
		case RepoSniffer:
			getSniffer = func() RepoSniffer { return s }
		case func() RepoSniffer:
			getSniffer = s
		default:
			rv := reflect.ValueOf(sp)
			if rv.Kind() == reflect.Func && rv.Type().NumIn() == 0 && rv.Type().NumOut() == 1 {
				getSniffer = func() RepoSniffer {
					res := rv.Call(nil)
					if len(res) > 0 && !res[0].IsNil() {
						if rs, ok := res[0].Interface().(RepoSniffer); ok {
							return rs
						}
					}
					return nil
				}
			}
		}
	}
	return &Handler{
		cfg:           cfg,
		ensureService: ensureService,
		assets:        assets,
		assetClient:   &http.Client{Timeout: 30 * time.Second},
		getSniffer:    getSniffer,
	}
}

func (h *Handler) HandleTree(w http.ResponseWriter, r *http.Request) {
	var req ArchiveTreeRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.Owner == "" || req.Repo == "" || req.Sha == "" {
		httpx.Error(w, http.StatusBadRequest, "missing required fields (owner, repo, sha)")
		return
	}
	if !httpx.AssertSegments(w,
		httpx.SegmentField{Name: "owner", Value: req.Owner},
		httpx.SegmentField{Name: "repo", Value: req.Repo},
		httpx.SegmentField{Name: "sha", Value: req.Sha},
	) {
		return
	}

	archiveRoot := h.cfg.ArchiveRoot
	if archiveRoot == "" {
		archiveRoot = "storage/repos"
	}

	nodes, ok := TreeFromArchive(archiveRoot, req.Owner, req.Repo, req.Sha)
	if !ok {
		httpx.Error(w, http.StatusNotFound, "archive not found")
		return
	}

	if nodes == nil {
		nodes = []GitNode{}
	}

	httpx.WriteJSON(w, http.StatusOK, ArchiveTreeResponse{
		Ok:    true,
		Nodes: nodes,
	})
}

func (h *Handler) HandleSniff(w http.ResponseWriter, r *http.Request) {
	var req ArchiveSniffRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitLarge) {
		return
	}

	var sniffer RepoSniffer
	if h.getSniffer != nil {
		sniffer = h.getSniffer()
	}
	if sniffer == nil {
		httpx.Error(w, http.StatusInternalServerError, "ingest patterns not loaded")
		return
	}

	var nodes []GitNode
	if req.Owner != "" && req.Repo != "" && req.Sha != "" {
		if !httpx.AssertSegments(w,
			httpx.SegmentField{Name: "owner", Value: req.Owner},
			httpx.SegmentField{Name: "repo", Value: req.Repo},
			httpx.SegmentField{Name: "sha", Value: req.Sha},
		) {
			return
		}
		archiveRoot := h.cfg.ArchiveRoot
		if archiveRoot == "" {
			archiveRoot = "storage/repos"
		}
		diskNodes, ok := TreeFromArchive(archiveRoot, req.Owner, req.Repo, req.Sha)
		if !ok {
			httpx.Error(w, http.StatusNotFound, "archive not found")
			return
		}
		nodes = diskNodes
	} else if req.Nodes != nil {
		nodes = *req.Nodes
	} else {
		httpx.Error(w, http.StatusBadRequest, "either (owner, repo, sha) or nodes must be provided")
		return
	}

	profile := sniffer.SniffRepo(nodes, req.IsTreeTruncated)
	scale := sniffer.ComputeRepoScale(nodes)

	httpx.WriteJSON(w, http.StatusOK, ArchiveSniffResponse{
		Ok:      true,
		Profile: profile,
		Scale:   scale,
	})
}

func (h *Handler) HandleEnsure(w http.ResponseWriter, r *http.Request) {
	var req ArchiveEnsureRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.Owner == "" || req.Repo == "" || req.Sha == "" {
		httpx.Error(w, http.StatusBadRequest, "missing required fields (owner, repo, sha)")
		return
	}

	if err := AssertSafeArchiveSegments(req.Owner, req.Repo, req.Sha); err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}

	if h.ensureService == nil {
		httpx.Error(w, http.StatusInternalServerError, "archive ensure service not initialized")
		return
	}

	timeoutMs := h.cfg.ArchiveDownloadTimeoutMs
	if timeoutMs <= 0 {
		timeoutMs = 60000
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	scope := req.PrefixScope
	if scope == "" {
		scope = req.Prefix
	}
	if len(req.AllowedFiles) > 0 {
		allowedMap := make(map[string]bool, len(req.AllowedFiles))
		for _, f := range req.AllowedFiles {
			allowedMap[f] = true
		}
		ctx = WithAllowedFiles(ctx, allowedMap)
	}
	dir, fromCache, err := h.ensureService.EnsureWithCap(ctx, req.Owner, req.Repo, req.Sha, req.SizeHintBytes, req.Token, req.MaxCapBytes, scope)
	if err != nil {
		status := http.StatusInternalServerError
		if IsInvalidSegments(err) {
			status = http.StatusBadRequest
		}
		httpx.Error(w, status, err.Error())
		return
	}

	resp := ArchiveEnsureResponse{FromCache: fromCache}
	if dir != "" {
		resp.Dir = &dir
	}

	httpx.WriteJSON(w, http.StatusOK, resp)
}

// Return false on .scoped_unpack archives so callers fall back to full-repo tree resolution.
func TreeFromArchive(archiveRoot, owner, repo, sha string) ([]GitNode, bool) {
	if IsScopedArchive(archiveRoot, owner, repo, sha) {
		return nil, false
	}
	var nodes []GitNode
	ok := cluster.WalkArchiveTree(archiveRoot, owner, repo, sha, nil, func(n GitNode) error {
		nodes = append(nodes, n)
		return nil
	})
	if !ok {
		return nil, false
	}
	if nodes == nil {
		nodes = []GitNode{}
	}
	return nodes, true
}

func tokenEquals(provided, expected string) bool {
	if expected == "" {
		return false
	}
	h1 := sha256.Sum256([]byte(provided))
	h2 := sha256.Sum256([]byte(expected))
	return subtle.ConstantTimeCompare(h1[:], h2[:]) == 1
}
