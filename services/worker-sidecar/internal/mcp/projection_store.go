package mcp

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

type RepoStructuralProjection struct {
	RepoID             string
	Owner              string
	Repo               string
	Branch             string
	Edition            string
	Category           string
	TargetVersionLabel string
	GitSha             string
	IsPublic           bool
	McpStatus          string

	StructuralDigest string
	OutlineVersion   int
	DocCount         int

	PreRenderedListResources string
	PreRenderedOutline       string
	PreRenderedCourseMap     string

	DocByPath map[string]DocMeta

	BuiltAt   time.Time
	ExpiresAt time.Time
}

func computeStructuralDigest(outlineVersion int, docs []DocMeta, conceptCount int) string {
	sortedDocs := make([]DocMeta, len(docs))
	copy(sortedDocs, docs)
	sort.Slice(sortedDocs, func(i, j int) bool {
		return sortedDocs[i].Path < sortedDocs[j].Path
	})

	h := md5.New()
	fmt.Fprintf(h, "outlineVersion:%d|docCount:%d|conceptCount:%d|", outlineVersion, len(sortedDocs), conceptCount)
	for _, d := range sortedDocs {
		fmt.Fprintf(h, "%s#%s;", d.Path, d.Title)
	}
	return hex.EncodeToString(h.Sum(nil))
}

const defaultMaxProjections = 128

type ProjectionStore struct {
	mu           sync.RWMutex
	projections  map[string]*RepoStructuralProjection
	repoIDToKeys map[string]map[string]struct{}
	maxEntries   int
}

func newProjectionStore() *ProjectionStore {
	return &ProjectionStore{
		projections:  make(map[string]*RepoStructuralProjection),
		repoIDToKeys: make(map[string]map[string]struct{}),
		maxEntries:   defaultMaxProjections,
	}
}

func NewProjectionStore() *ProjectionStore {
	return newProjectionStore()
}

func projectionKey(owner, repo, edition string) string {
	return strings.ToLower(strings.TrimSpace(owner)) + "/" + strings.ToLower(strings.TrimSpace(repo)) + ":" + strings.TrimSpace(edition)
}

func (ps *ProjectionStore) Get(owner, repo, edition string) (*RepoStructuralProjection, bool) {
	if ps == nil {
		return nil, false
	}
	key := projectionKey(owner, repo, edition)
	ps.mu.RLock()
	proj, ok := ps.projections[key]
	ps.mu.RUnlock()

	if !ok || proj == nil {
		return nil, false
	}
	if !proj.ExpiresAt.IsZero() && time.Now().After(proj.ExpiresAt) {
		ps.mu.Lock()
		if cur, exists := ps.projections[key]; exists && !cur.ExpiresAt.IsZero() && time.Now().After(cur.ExpiresAt) {
			delete(ps.projections, key)
			if cur.RepoID != "" {
				if keys, ok := ps.repoIDToKeys[cur.RepoID]; ok {
					delete(keys, key)
					if len(keys) == 0 {
						delete(ps.repoIDToKeys, cur.RepoID)
					}
				}
			}
		}
		ps.mu.Unlock()
		return nil, false
	}
	return proj, true
}

func (ps *ProjectionStore) Set(proj *RepoStructuralProjection) {
	if ps == nil || proj == nil {
		return
	}
	key := projectionKey(proj.Owner, proj.Repo, proj.Edition)
	if proj.BuiltAt.IsZero() {
		proj.BuiltAt = time.Now()
	}
	if proj.ExpiresAt.IsZero() {
		proj.ExpiresAt = time.Now().Add(60 * time.Second)
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	if oldProj, ok := ps.projections[key]; ok && oldProj != nil && oldProj.RepoID != "" && oldProj.RepoID != proj.RepoID {
		if oldKeys, exists := ps.repoIDToKeys[oldProj.RepoID]; exists {
			delete(oldKeys, key)
			if len(oldKeys) == 0 {
				delete(ps.repoIDToKeys, oldProj.RepoID)
			}
		}
	}

	maxCap := ps.maxEntries
	if maxCap <= 0 {
		maxCap = defaultMaxProjections
	}
	if len(ps.projections) >= maxCap {
		now := time.Now()
		var oldestKey string
		var oldestTime time.Time
		for k, p := range ps.projections {
			if !p.ExpiresAt.IsZero() && now.After(p.ExpiresAt) {
				oldestKey = k
				break
			}
			if oldestKey == "" || p.BuiltAt.Before(oldestTime) {
				oldestKey = k
				oldestTime = p.BuiltAt
			}
		}
		if oldestKey != "" {
			if ev, exists := ps.projections[oldestKey]; exists && ev.RepoID != "" {
				if keys, ok := ps.repoIDToKeys[ev.RepoID]; ok {
					delete(keys, oldestKey)
					if len(keys) == 0 {
						delete(ps.repoIDToKeys, ev.RepoID)
					}
				}
			}
			delete(ps.projections, oldestKey)
		}
	}

	ps.projections[key] = proj
	if proj.RepoID != "" {
		keys, ok := ps.repoIDToKeys[proj.RepoID]
		if !ok {
			keys = make(map[string]struct{})
			ps.repoIDToKeys[proj.RepoID] = keys
		}
		keys[key] = struct{}{}
	}
}

func (ps *ProjectionStore) Invalidate(owner, repo string) {
	if ps == nil {
		return
	}
	ownerNorm := strings.ToLower(strings.TrimSpace(owner))
	repoNorm := strings.ToLower(strings.TrimSpace(repo))
	prefix := ownerNorm + "/" + repoNorm + ":"

	ps.mu.Lock()
	defer ps.mu.Unlock()

	for k, p := range ps.projections {
		matches := strings.HasPrefix(k, prefix) || (strings.EqualFold(p.Owner, ownerNorm) && strings.EqualFold(p.Repo, repoNorm))
		if !matches {
			continue
		}
		delete(ps.projections, k)
		if p.RepoID != "" {
			if keys, ok := ps.repoIDToKeys[p.RepoID]; ok {
				delete(keys, k)
				if len(keys) == 0 {
					delete(ps.repoIDToKeys, p.RepoID)
				}
			}
		}
	}
}

func (ps *ProjectionStore) InvalidateByID(repoID string) {
	if ps == nil || repoID == "" {
		return
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()

	if keys, ok := ps.repoIDToKeys[repoID]; ok {
		for k := range keys {
			delete(ps.projections, k)
		}
		delete(ps.repoIDToKeys, repoID)
	}
	for k, p := range ps.projections {
		if p.RepoID == repoID {
			delete(ps.projections, k)
		}
	}
}

func BuildRepoProjection(ctx context.Context, store ReadStore, resolved *ResolvedRepo) (*RepoStructuralProjection, error) {
	if resolved == nil {
		return nil, fmt.Errorf("cannot build projection for nil resolved repo")
	}

	repo := resolved.Repository
	docs := resolved.Documents
	targetVersion := deref(resolved.TargetVersionLabel)
	if targetVersion == "" {
		targetVersion = repo.Branch
	}
	category := repo.Category
	if category == "" {
		category = "General"
	}

	var gitSha string
	outlineVersion := 0
	var taxonomy []taxonomyItem

	if store != nil {
		if _, _, sha, ok := store.GetRepoGitSha(ctx, repo.ID); ok {
			gitSha = sha
		}

		if outlineInfo, err := store.GetActiveOutline(ctx, repo.ID); err == nil && outlineInfo != nil {
			outlineVersion = outlineInfo.Version
			if len(outlineInfo.NavTree) > 0 {
				repo.NavTree = outlineInfo.NavTree
			}
		}

		taxonomy = buildConceptTaxonomy(ctx, store, repo.ID)
	}

	preRenderedListResources := renderListResources(repo, len(docs), targetVersion)
	preRenderedOutline := RenderOutlineFromResolved(repo, docs, taxonomy)
	preRenderedCourseMap := formatCourseMap(repo.RepoProfile, repo.NavTree)

	docByPath := make(map[string]DocMeta, len(docs)*2)
	for _, d := range docs {
		docByPath[d.Path] = d
		docByPath[strings.ToLower(d.Path)] = d
	}

	digest := computeStructuralDigest(outlineVersion, docs, len(taxonomy))

	now := time.Now()
	return &RepoStructuralProjection{
		RepoID:                   repo.ID,
		Owner:                    repo.Owner,
		Repo:                     repo.Repo,
		Branch:                   repo.Branch,
		Edition:                  repo.Edition,
		Category:                 category,
		TargetVersionLabel:       targetVersion,
		GitSha:                   gitSha,
		IsPublic:                 repo.IsPublic,
		McpStatus:                repo.McpStatus,
		StructuralDigest:         digest,
		OutlineVersion:           outlineVersion,
		DocCount:                 len(docs),
		PreRenderedListResources: preRenderedListResources,
		PreRenderedOutline:       preRenderedOutline,
		PreRenderedCourseMap:     preRenderedCourseMap,
		DocByPath:                docByPath,
		BuiltAt:                  now,
		ExpiresAt:                now.Add(60 * time.Second),
	}, nil
}
