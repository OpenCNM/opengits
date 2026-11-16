package cognitive

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

// OutlineCandidatesRequest represents the payload for POST /v1/outline/candidates.
type OutlineCandidatesRequest struct {
	Owner    string     `json:"owner,omitempty"`
	Repo     string     `json:"repo,omitempty"`
	Sha      string     `json:"sha,omitempty"`
	Nodes    *[]GitNode `json:"nodes,omitempty"`
	Prefix   string     `json:"prefix,omitempty"`
	MaxFiles int        `json:"maxFiles,omitempty"`
}

// OutlineCandidatesResponse represents the response for POST /v1/outline/candidates.
type OutlineCandidatesResponse struct {
	Ok         bool                   `json:"ok"`
	Candidates []CandidateOutlineFile `json:"candidates"`
}

// OutlineRuleFallbackRequest represents the payload for POST /v1/outline/rule-fallback.
type OutlineRuleFallbackRequest struct {
	Owner          string            `json:"owner,omitempty"`
	Repo           string            `json:"repo,omitempty"`
	Sha            string            `json:"sha,omitempty"`
	Nodes          *[]GitNode        `json:"nodes,omitempty"`
	Prefix         string            `json:"prefix,omitempty"`
	TargetLanguage string            `json:"targetLanguage,omitempty"`
	Files          map[string]string `json:"files,omitempty"`
}

// OutlineRuleFallbackResponse represents the response for POST /v1/outline/rule-fallback.
type OutlineRuleFallbackResponse struct {
	Ok       bool             `json:"ok"`
	Chapters []OutlineChapter `json:"chapters"`
}

// OutlineSanitizeRequest represents the payload for POST /v1/outline/sanitize.
type OutlineSanitizeRequest struct {
	Chapters       []OutlineChapter       `json:"chapters"`
	Modules        []DraftModule          `json:"modules,omitempty"`
	Nodes          *[]GitNode             `json:"nodes,omitempty"`
	Owner          string                 `json:"owner,omitempty"`
	Repo           string                 `json:"repo,omitempty"`
	Sha            string                 `json:"sha,omitempty"`
	Prefix         string                 `json:"prefix,omitempty"`
	TargetLanguage string                 `json:"targetLanguage,omitempty"`
	CandidateFiles []CandidateOutlineFile `json:"candidateFiles,omitempty"`
}

// OutlineSanitizeResponse represents the response for POST /v1/outline/sanitize.
type OutlineSanitizeResponse struct {
	Ok                bool             `json:"ok"`
	SanitizedChapters []OutlineChapter `json:"sanitizedChapters"`
	SanitizedModules  []DraftModule    `json:"sanitizedModules"`
	DroppedPaths      []string         `json:"droppedPaths"`
}

// OutlinePrepareSignalsRequest represents the payload for POST /v1/outline/prepare-signals.
type OutlinePrepareSignalsRequest struct {
	Owner    string            `json:"owner,omitempty"`
	Repo     string            `json:"repo,omitempty"`
	Sha      string            `json:"sha,omitempty"`
	Nodes    *[]GitNode        `json:"nodes,omitempty"`
	Prefix   string            `json:"prefix,omitempty"`
	MaxFiles int               `json:"maxFiles,omitempty"`
	Files    map[string]string `json:"files,omitempty"`
}

// OutlinePrepareSignalsResponse represents the response for POST /v1/outline/prepare-signals.
type OutlinePrepareSignalsResponse struct {
	Ok            bool                   `json:"ok"`
	Candidates    []CandidateOutlineFile `json:"candidates"`
	IsFlat        bool                   `json:"isFlat"`
	FlatRepoHints string                 `json:"flatRepoHints"`
	FileCount     int                    `json:"fileCount"`
}

// resolveOutlineNodes handles Mode A (Zero-Tree disk read via owner/repo/sha) and Mode B (nodes payload)
// with optional prefix scoping.
func (h *Handler) resolveOutlineNodes(
	w http.ResponseWriter,
	owner, repo, sha string,
	inputNodes *[]GitNode,
	prefix string,
	patterns Patterns,
) ([]GitNode, bool) {
	var nodes []GitNode
	if owner != "" && repo != "" && sha != "" {
		if !httpx.AssertSegments(w,
			httpx.SegmentField{Name: "owner", Value: owner},
			httpx.SegmentField{Name: "repo", Value: repo},
			httpx.SegmentField{Name: "sha", Value: sha},
		) {
			return nil, false
		}
		archiveRoot := h.archiveRoot
		if archiveRoot == "" {
			archiveRoot = "storage/repos"
		}
		diskNodes, ok := archive.TreeFromArchive(archiveRoot, owner, repo, sha)
		if !ok {
			if inputNodes != nil && len(*inputNodes) > 0 {
				nodes = *inputNodes
			} else {
				httpx.Error(w, http.StatusNotFound, "archive not found")
				return nil, false
			}
		} else {
			nodes = diskNodes
		}
	} else if inputNodes != nil {
		nodes = *inputNodes
	} else {
		httpx.Error(w, http.StatusBadRequest, "either (owner, repo, sha) or nodes must be provided")
		return nil, false
	}

	cleanPrefix := strings.Trim(strings.Trim(prefix, " "), "/")
	if cleanPrefix != "" {
		var scoped []GitNode
		for _, n := range nodes {
			isUnderPrefix := n.Path == cleanPrefix || strings.HasPrefix(n.Path, cleanPrefix+"/")
			if isUnderPrefix {
				scoped = append(scoped, n)
				continue
			}
			parts := strings.Split(n.Path, "/")
			fileName := parts[len(parts)-1]
			if patterns != nil && patterns.IsReadme(fileName) && !strings.Contains(n.Path, "/") {
				scoped = append(scoped, n)
			}
		}
		return scoped, true
	}

	return nodes, true
}

// HandleCandidates handles POST /v1/outline/candidates.
func (h *Handler) HandleCandidates(w http.ResponseWriter, r *http.Request) {
	var req OutlineCandidatesRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitLarge) {
		return
	}

	patterns := h.getPatterns()
	if patterns == nil {
		httpx.Error(w, http.StatusInternalServerError, "ingest patterns not loaded")
		return
	}

	nodes, ok := h.resolveOutlineNodes(w, req.Owner, req.Repo, req.Sha, req.Nodes, req.Prefix, patterns)
	if !ok {
		return
	}

	maxFiles := req.MaxFiles
	if maxFiles <= 0 {
		maxFiles = 60
	}

	candidates := SelectCandidateFilesForOutline(nodes, maxFiles, patterns)
	httpx.WriteJSON(w, http.StatusOK, OutlineCandidatesResponse{
		Ok:         true,
		Candidates: candidates,
	})
}

// HandleRuleFallback handles POST /v1/outline/rule-fallback.
func (h *Handler) HandleRuleFallback(w http.ResponseWriter, r *http.Request) {
	var req OutlineRuleFallbackRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitLarge) {
		return
	}

	patterns := h.getPatterns()
	if patterns == nil {
		httpx.Error(w, http.StatusInternalServerError, "ingest patterns not loaded")
		return
	}

	nodes, ok := h.resolveOutlineNodes(w, req.Owner, req.Repo, req.Sha, req.Nodes, req.Prefix, patterns)
	if !ok {
		return
	}

	targetLanguage := req.TargetLanguage
	if targetLanguage == "" {
		targetLanguage = "zh-CN"
	}

	fileReader := resolveFileReader(h.archiveRoot, req.Owner, req.Repo, req.Sha, req.Files)
	var opts []OutlineSignalOptions
	if fileReader != nil {
		opts = append(opts, OutlineSignalOptions{
			FileReader:      fileReader,
			SymbolExtractor: h.getSymbolExtractor(),
		})
	}

	chapters := BuildRuleFallbackOutline(nodes, req.Prefix, targetLanguage, patterns, opts...)
	httpx.WriteJSON(w, http.StatusOK, OutlineRuleFallbackResponse{
		Ok:       true,
		Chapters: chapters,
	})
}

// HandleSanitize handles POST /v1/outline/sanitize.
func (h *Handler) HandleSanitize(w http.ResponseWriter, r *http.Request) {
	var req OutlineSanitizeRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitLarge) {
		return
	}

	patterns := h.getPatterns()
	if patterns == nil {
		httpx.Error(w, http.StatusInternalServerError, "ingest patterns not loaded")
		return
	}

	nodes, ok := h.resolveOutlineNodes(w, req.Owner, req.Repo, req.Sha, req.Nodes, req.Prefix, patterns)
	if !ok {
		return
	}

	targetLanguage := req.TargetLanguage
	if targetLanguage == "" {
		targetLanguage = "zh-CN"
	}

	candidateFiles := req.CandidateFiles
	if candidateFiles == nil {
		candidateFiles = []CandidateOutlineFile{}
	}

	sanitizeRes := SanitizeAndIntersectOutline(
		req.Chapters,
		nodes,
		req.Prefix,
		targetLanguage,
		candidateFiles,
		patterns,
	)

	sanitizedModules := req.Modules
	if len(sanitizedModules) > 0 {
		sanitizedModules = SanitizeDraftModules(sanitizedModules, nodes, req.Prefix, patterns)
	}

	httpx.WriteJSON(w, http.StatusOK, OutlineSanitizeResponse{
		Ok:                true,
		SanitizedChapters: sanitizeRes.Sanitized,
		SanitizedModules:  sanitizedModules,
		DroppedPaths:      sanitizeRes.DroppedPaths,
	})
}

// HandlePrepareSignals handles POST /v1/outline/prepare-signals.
func (h *Handler) HandlePrepareSignals(w http.ResponseWriter, r *http.Request) {
	var req OutlinePrepareSignalsRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitLarge) {
		return
	}

	patterns := h.getPatterns()
	if patterns == nil {
		httpx.Error(w, http.StatusInternalServerError, "ingest patterns not loaded")
		return
	}

	nodes, ok := h.resolveOutlineNodes(w, req.Owner, req.Repo, req.Sha, req.Nodes, req.Prefix, patterns)
	if !ok {
		return
	}

	maxFiles := req.MaxFiles
	if maxFiles <= 0 {
		maxFiles = 60
	}

	fileReader := resolveFileReader(h.archiveRoot, req.Owner, req.Repo, req.Sha, req.Files)

	opts := OutlineSignalOptions{
		FileReader:      fileReader,
		SymbolExtractor: h.getSymbolExtractor(),
	}

	candidates, isFlat, flatHints, fileCount := PrepareOutlineSignalsWithOptions(nodes, req.Prefix, maxFiles, patterns, opts)

	httpx.WriteJSON(w, http.StatusOK, OutlinePrepareSignalsResponse{
		Ok:            true,
		Candidates:    candidates,
		IsFlat:        isFlat,
		FlatRepoHints: flatHints,
		FileCount:     fileCount,
	})
}

func resolveFileReader(archiveRoot, owner, repo, sha string, inMemoryFiles map[string]string) FileReader {
	if len(inMemoryFiles) > 0 {
		return func(p string) ([]byte, error) {
			cleanP := filepath.ToSlash(filepath.Clean(p))
			if content, ok := inMemoryFiles[cleanP]; ok {
				return []byte(content), nil
			}
			trimmed := strings.TrimPrefix(cleanP, "/")
			if content, ok := inMemoryFiles[trimmed]; ok {
				return []byte(content), nil
			}
			base := filepath.Base(cleanP)
			// 同 basename 多文件时 map 迭代序随机——同请求两次运行结果不同。
			// 收集全部命中后取字典序最小键，恢复确定性（golden 对拍前提）。
			bestKey := ""
			var bestVal string
			for k, v := range inMemoryFiles {
				if filepath.Base(filepath.ToSlash(filepath.Clean(k))) == base {
					if bestKey == "" || k < bestKey {
						bestKey, bestVal = k, v
					}
				}
			}
			if bestKey != "" {
				return []byte(bestVal), nil
			}
			return nil, os.ErrNotExist
		}
	}
	if owner != "" && repo != "" && sha != "" {
		if archiveRoot == "" {
			archiveRoot = "storage/repos"
		}
		archiveDir := filepath.Clean(archive.ArchiveDirFor(archiveRoot, owner, repo, sha))
		if st, err := os.Stat(archiveDir); err == nil && st.IsDir() {
			return func(p string) ([]byte, error) {
				target := filepath.Clean(filepath.Join(archiveDir, filepath.FromSlash(p)))
				if target != archiveDir && !strings.HasPrefix(target, archiveDir+string(filepath.Separator)) {
					return nil, os.ErrPermission
				}
				return os.ReadFile(target)
			}
		}
	}
	return nil
}

// RegisterRoutes registers cognitive, fact-grounding, and outline routes.
// Routes creates a standalone http.Handler with internal token authentication.
// AuthMiddleware authenticates requests using internalToken.
