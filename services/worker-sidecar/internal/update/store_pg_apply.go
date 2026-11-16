package update

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/ingest"
	"github.com/opengits/worker-sidecar/internal/platform/db"
	"github.com/opengits/worker-sidecar/internal/platform/storeutil"
)

// ApplyUpdatePlanTx executes update plan application atomically within a single database transaction.
func (s *PgxStore) ApplyUpdatePlanTx(ctx context.Context, p ApplyUpdatePlanTxParams) (*ApplyUpdatePlanTxResult, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database connection pool is not configured")
	}

	var (
		owner          string
		repoName       string
		needStructural bool
		result         ApplyUpdatePlanTxResult
	)

	// 前置预提取确定性重命名事实（无状态纯内存推导，无需占用事务周期）
	renameFacts := make([]ChapterRename, 0)
	for _, c := range p.CandidateSet.Chapters {
		if c.Rename != nil {
			renameFacts = append(renameFacts, *c.Rename)
		}
	}

	ownerStr := ""
	if p.DocOwnerID != nil {
		ownerStr = *p.DocOwnerID
	}

	// 对齐 Node $transaction 60s（事务更重：逐章插入+多重命名检查+大纲重写）
	err := storeutil.WithTxTimeout(ctx, s.pool, 60*time.Second, func(tx pgx.Tx) error {
		qtx := s.queries.WithTx(tx)

		// Fetch current repository state
		repoRow, err := qtx.ApplyTxGetRepository(ctx, p.RepositoryID)
		if err != nil {
			if err == pgx.ErrNoRows {
				return fmt.Errorf("repository not found: %s", p.RepositoryID)
			}
			return fmt.Errorf("query repository: %w", err)
		}
		owner = repoRow.Owner
		repoName = repoRow.Repo
		branch := repoRow.Branch
		dbGitSha := repoRow.GitSha
		rawNavTree := repoRow.NavTree
		rawProfile := repoRow.RepoProfile

		// Structural side effects are bound to ownership: only shared canonical updates (docOwnerId=null)
		// advance the baseline if gitSha differs.
		needStructural = (p.DocOwnerID == nil && dbGitSha != p.ToSha) || p.NeedStructural

		var repoProfileMap map[string]any
		if len(rawProfile) > 0 {
			_ = json.Unmarshal(rawProfile, &repoProfileMap)
		}
		if repoProfileMap == nil {
			repoProfileMap = make(map[string]any)
		}

		var oldClusters []ModuleSnapshot
		if clustersRaw, ok := repoProfileMap["codeClusters"]; ok {
			clusterBytes, _ := json.Marshal(clustersRaw)
			_ = json.Unmarshal(clusterBytes, &oldClusters)
		}
		if len(p.OldClusters) > 0 && len(oldClusters) == 0 {
			oldClusters = p.OldClusters
		}

		nextCodeOrder := 1
		for _, c := range oldClusters {
			no := clusterChapterNo(c.ChapterNo, c.TeachingOrder)
			if no >= nextCodeOrder {
				nextCodeOrder = no + 1
			}
		}

		// ── 1. Rename migration (deterministic code takeover) ──
		appliedRenames := make([]ChapterRename, 0, len(renameFacts))
		renamedDocs := 0

		// Topologically sort renames to resolve chains like A->B, B->C
		inDegree := make(map[string]int)
		renameBySrc := make(map[string]ChapterRename)
		for _, r := range renameFacts {
			inDegree[r.From] = 0
			inDegree[r.To] = 0
		}
		for _, r := range renameFacts {
			inDegree[r.To]++
			renameBySrc[r.From] = r
		}

		var queue []string
		for node, deg := range inDegree {
			if deg == 0 {
				if _, ok := renameBySrc[node]; ok {
					queue = append(queue, node)
				}
			}
		}

		var sortedRenames []ChapterRename
		visited := make(map[string]bool)

		for len(queue) > 0 {
			curr := queue[0]
			queue = queue[1:]

			if r, ok := renameBySrc[curr]; ok {
				sortedRenames = append(sortedRenames, r)
				visited[curr] = true
				inDegree[r.To]--
				if inDegree[r.To] == 0 {
					if _, hasNext := renameBySrc[r.To]; hasNext {
						queue = append(queue, r.To)
					}
				}
			}
		}

		var pendingRenames []ChapterRename
		// Reverse sortedRenames so we move destinations first
		for i := len(sortedRenames) - 1; i >= 0; i-- {
			pendingRenames = append(pendingRenames, sortedRenames[i])
		}

		for _, r := range renameFacts {
			if !visited[r.From] {
				log.Printf("[update-applier] rename destination path occupied or circular, skipped: %s -> %s", r.From, r.To)
			}
		}

		for _, r := range pendingRenames {
			_, err := qtx.ApplyTxCheckRenameOccupied(ctx, db.ApplyTxCheckRenameOccupiedParams{
				RepositoryId: p.RepositoryID,
				OwnerUserId:  pgtype.Text{String: ownerStr, Valid: ownerStr != ""},
				Path:         r.To,
			})
			if err == nil {
				log.Printf("[update-applier] destination occupied, skipping: %s -> %s", r.From, r.To)
				continue
			} else if err != pgx.ErrNoRows {
				return fmt.Errorf("check rename occupation (%s -> %s): %w", r.From, r.To, err)
			}

			rowsAffected, err := qtx.ApplyTxExecuteRename(ctx, db.ApplyTxExecuteRenameParams{
				RepositoryId: p.RepositoryID,
				OwnerUserId:  pgtype.Text{String: ownerStr, Valid: ownerStr != ""},
				Path:         r.To,
				Path_2:       r.From,
			})
			if err != nil {
				return fmt.Errorf("execute rename (%s -> %s): %w", r.From, r.To, err)
			}
			if rowsAffected > 0 {
				renamedDocs += int(rowsAffected)
				appliedRenames = append(appliedRenames, r)
			}
		}

		// ── 2. Document operations (scoped by docOwnerId) ──
		type addedNodeInfo struct {
			Node         *NavNode
			FinalPath    string
			PositionPath *string
		}

		var (
			updatedDocs     int
			removedDocs     int
			addedDocs       int
			pendingCodeDocs int
			pendingTextDocs int
			adds            []addedNodeInfo
		)

		updatePaths := make([]string, 0)
		removePaths := make([]string, 0)

		for _, ch := range p.Plan.Chapters {
			switch ch.Action {
			case "update":
				updatePaths = append(updatePaths, ch.Path)
				if isCodeChapterPath(ch.Path) {
					pendingCodeDocs++
				} else {
					pendingTextDocs++
				}
			case "remove":
				removePaths = append(removePaths, ch.Path)
			case "add":
				var built addedNodeInfo
				if isCodeChapterPath(ch.Path) {
					finalPath := codeChapterPath(nextCodeOrder)
					name := fmt.Sprintf("chapter-%d", nextCodeOrder)
					title := ch.Title
					if title == "" {
						title = name
					}
					built = addedNodeInfo{
						Node: &NavNode{
							Name:  name,
							Title: title,
							Type:  "file",
							Path:  finalPath,
							Url:   buildDocUrl(finalPath, owner, repoName), // /docs/:owner/:repo/chapters/%02d 对齐全量 Ingest 规约 (BUG-10)
						},
						FinalPath: finalPath,
					}
					if ch.Position != "" {
						pos := ch.Position
						built.PositionPath = &pos
					}
					nextCodeOrder++
					pendingCodeDocs++
				} else {
					base := navNodeBaseName(ch.Path)
					title := ch.Title
					if title == "" {
						title = base
					}
					built = addedNodeInfo{
						Node: &NavNode{
							Name:  base,
							Title: title,
							Type:  "file",
							Path:  ch.Path,
							Url:   buildDocUrl(ch.Path, owner, repoName),
						},
						FinalPath: ch.Path,
					}
					if ch.Position != "" {
						pos := ch.Position
						built.PositionPath = &pos
					}
					pendingTextDocs++
				}
				adds = append(adds, built)
			}
		}

		if len(updatePaths) > 0 {
			rowsAffected, err := qtx.ApplyTxBatchUpdateDocs(ctx, db.ApplyTxBatchUpdateDocsParams{
				RepositoryId: p.RepositoryID,
				OwnerUserId:  pgtype.Text{String: ownerStr, Valid: ownerStr != ""},
				Paths:        updatePaths,
			})
			if err != nil {
				return fmt.Errorf("batch update documents: %w", err)
			}
			updatedDocs = int(rowsAffected)
		}

		if len(removePaths) > 0 {
			rowsAffected, err := qtx.ApplyTxBatchDeleteDocs(ctx, db.ApplyTxBatchDeleteDocsParams{
				RepositoryId: p.RepositoryID,
				OwnerUserId:  pgtype.Text{String: ownerStr, Valid: ownerStr != ""},
				Paths:        removePaths,
			})
			if err != nil {
				return fmt.Errorf("batch delete documents: %w", err)
			}
			removedDocs = int(rowsAffected)
		}

		if len(adds) > 0 {
			finalPaths := make([]string, len(adds))
			titles := make([]string, len(adds))
			for i, a := range adds {
				finalPaths[i] = a.FinalPath
				titles[i] = a.Node.Title
			}
			rowsAffected, err := qtx.ApplyTxBatchInsertDocs(ctx, db.ApplyTxBatchInsertDocsParams{
				RepositoryId: p.RepositoryID,
				OwnerUserId:  pgtype.Text{String: ownerStr, Valid: ownerStr != ""},
				Paths:        finalPaths,
				Titles:       titles,
			})
			if err != nil {
				return fmt.Errorf("batch insert documents: %w", err)
			}
			addedDocs = int(rowsAffected)
		}

		// ── 3. Structural update & V2 outline activation ──
		navTreePatched := false
		gitShaAdvanced := false

		if needStructural {
			var currentTree []*NavNode
			if len(p.CurrentNavTree) > 0 {
				currentTree = p.CurrentNavTree
			} else {
				var err error
				currentTree, err = s.LoadEffectiveNavTree(ctx, tx, p.RepositoryID, owner, repoName, rawNavTree)
				if err != nil {
					return fmt.Errorf("load current nav tree: %w", err)
				}
			}

			patchAdds := make([]NavTreeAdd, len(adds))
			for i, a := range adds {
				patchAdds[i] = NavTreeAdd{
					Node:         a.Node,
					PositionPath: a.PositionPath,
				}
			}

			patchRenames := make([]NavTreeRename, len(appliedRenames))
			for i, r := range appliedRenames {
				patchRenames[i] = NavTreeRename{
					From:  r.From,
					To:    r.To,
					ToUrl: buildDocUrl(r.To, owner, repoName),
				}
			}

			patch := NavTreePatch{
				Remove: removePaths,
				Add:    patchAdds,
				Rename: patchRenames,
			}

			newTree := PatchNavTree(currentTree, patch)

			newClusters := oldClusters
			clustersChanged := false
			if len(oldClusters) > 0 {
				removeSet := make(map[string]struct{}, len(removePaths))
				for _, rp := range removePaths {
					removeSet[rp] = struct{}{}
				}
				filtered := make([]ModuleSnapshot, 0, len(oldClusters))
				for _, c := range oldClusters {
					cPath := codeChapterPath(clusterChapterNo(c.ChapterNo, c.TeachingOrder))
					if _, removed := removeSet[cPath]; !removed {
						filtered = append(filtered, c)
					} else {
						clustersChanged = true
					}
				}
				newClusters = filtered

				for _, a := range adds {
					if isCodeChapterPath(a.FinalPath) {
						base := filepath.Base(a.FinalPath)
						base = strings.TrimSuffix(base, ".mdx")
						order, _ := strconv.Atoi(base)
						newClusters = append(newClusters, ModuleSnapshot{
							TeachingOrder: order,
							ChapterNo:     order,
							Title:         a.Node.Title,
							Files:         []string{},
							Directories:   []string{},
						})
						clustersChanged = true
					}
				}
			}

			// Zero-Materialization: update gitSha, hasUpstreamUpdate, repoProfile (only if clusters changed), NEVER touch navTree!
			if clustersChanged {
				repoProfileMap["codeClusters"] = newClusters
				updatedProfileJSON, err := json.Marshal(repoProfileMap)
				if err != nil {
					return fmt.Errorf("marshal updated repoProfile: %w", err)
				}
				err = qtx.ApplyTxUpdateRepoProfile(ctx, db.ApplyTxUpdateRepoProfileParams{
					GitSha:      pgtype.Text{String: p.ToSha, Valid: true},
					RepoProfile: updatedProfileJSON,
					ID:          p.RepositoryID,
				})
				if err != nil {
					return fmt.Errorf("update repository gitSha/profile: %w", err)
				}
			} else {
				err = qtx.ApplyTxUpdateRepoGitShaOnly(ctx, db.ApplyTxUpdateRepoGitShaOnlyParams{
					GitSha: pgtype.Text{String: p.ToSha, Valid: true},
					ID:     p.RepositoryID,
				})
				if err != nil {
					return fmt.Errorf("update repository gitSha: %w", err)
				}
			}

			// navTree→大纲派生与落盘复用 ingest 单一事实源内核（1.11：零 LLM 单实现）
			draft := ingest.OutlineFromNavTree(newTree)
			_, err = ingest.StoreOutlineDraftTx(ctx, tx, p.RepositoryID, draft, true)
			if err != nil {
				return fmt.Errorf("store outline draft: %w", err)
			}

			navTreePatched = true
			gitShaAdvanced = true
		}

		// ── 4. Snapshot advance ──
		err = qtx.ApplyTxUpsertImportRecord(ctx, db.ApplyTxUpsertImportRecordParams{
			UserId:       p.UserID,
			RepositoryId: p.RepositoryID,
			Owner:        owner,
			Repo:         repoName,
			Branch:       branch,
			Sha:          p.ToSha,
		})
		if err != nil {
			return fmt.Errorf("register import snapshot: %w", err)
		}

		// ── 5. Audit log ──
		if p.RunID != nil && *p.RunID != "" {
			statsJSON, _ := json.Marshal(map[string]any{
				"docsToUpdate":   updatedDocs,
				"docsToRemove":   removedDocs,
				"docsToAdd":      addedDocs,
				"docsToRename":   renamedDocs,
				"coercedActions": p.CoercedCount,
				"navTreePatched": navTreePatched,
				"gitShaAdvanced": gitShaAdvanced,
			})
			rowsAffected, err := qtx.ApplyTxUpdateImportRunStats(ctx, db.ApplyTxUpdateImportRunStatsParams{
				Stats: statsJSON,
				ID:    *p.RunID,
			})
			if err != nil {
				return fmt.Errorf("update import update run status: %w", err)
			}
			if rowsAffected == 0 {
				return fmt.Errorf("import update run not found: %s", *p.RunID)
			}
		}

		result = ApplyUpdatePlanTxResult{
			UpdatedDocs:     updatedDocs,
			RemovedDocs:     removedDocs,
			AddedDocs:       addedDocs,
			RenamedDocs:     renamedDocs,
			CoercedActions:  p.CoercedCount,
			NavTreePatched:  navTreePatched,
			GitShaAdvanced:  gitShaAdvanced,
			PendingCodeDocs: pendingCodeDocs,
			PendingTextDocs: pendingTextDocs,
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	// ── MCP 双轨制内存只读投影联动 ──
	if needStructural {
		if s.projStore != nil {
			s.projStore.Invalidate(owner, repoName)
			s.projStore.InvalidateByID(p.RepositoryID)
		} else {
			go notifyMcpProjectionInvalidate(p.RepositoryID, owner, repoName)
		}
	}

	return &result, nil
}

func notifyMcpProjectionInvalidate(repoID, owner, repo string) {
	addr := os.Getenv("MCP_SIDECAR_ADDR")
	if addr == "" {
		addr = os.Getenv("MCP_SIDECAR_URL")
	}
	if addr == "" {
		addr = "http://mcp-go:8080"
	}
	if !strings.HasPrefix(addr, "http://") && !strings.HasPrefix(addr, "https://") {
		addr = "http://" + addr
	}
	targetURL := strings.TrimRight(addr, "/") + "/v1/projection/invalidate"

	payload, err := json.Marshal(map[string]string{
		"repositoryId": repoID,
		"owner":        owner,
		"repo":         repo,
	})
	if err != nil {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(payload))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if token := os.Getenv("INTERNAL_API_TOKEN"); token != "" {
		req.Header.Set("x-internal-token", token)
	}

	client := &http.Client{Timeout: 500 * time.Millisecond}
	resp, err := client.Do(req)
	if err == nil && resp != nil {
		_ = resp.Body.Close()
	}
}
