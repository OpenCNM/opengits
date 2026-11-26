package update

import (
	"log"

	"context"
	"fmt"
	"net/url"

	"github.com/opengits/worker-sidecar/internal/platform/client"
)

const (
	AutoUpdateMaxReposPerCycle = 20
	CompareAPIFilesHardCap     = 300
	CompareAPICommitsHardCap   = 250
)

func githubAPIBase(cfg Config) string {
	if cfg.GitHubAPIBase != "" {
		return cfg.GitHubAPIBase
	}
	return "https://api.github.com"
}

func resolveLatestShaHTTP(ctx context.Context, cfg Config, owner, repo, branch string) (string, error) {
	u := fmt.Sprintf("%s/repos/%s/%s/commits/%s", githubAPIBase(cfg),
		url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(branch))
	var out struct {
		Sha string `json:"sha"`
	}
	if err := client.GithubGetJSON(ctx, u, cfg.GitHubToken, cfg.UserAgent, &out); err != nil {
		return "", fmt.Errorf("branch head: %w", err)
	}
	if out.Sha == "" {
		return "", fmt.Errorf("branch head empty sha")
	}
	return out.Sha, nil
}

func fetchCompareDiffHTTP(ctx context.Context, cfg Config, owner, repo, base, head string) (*UpdateArchiveDiff, error) {
	if base == "" || head == "" || base == head {
		return nil, nil
	}
	u := fmt.Sprintf("%s/repos/%s/%s/compare/%s...%s", githubAPIBase(cfg),
		url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(base), url.PathEscape(head))
	var data struct {
		Status       string `json:"status"`
		TotalCommits int    `json:"total_commits"`
		Files        []struct {
			Filename string  `json:"filename"`
			Status   string  `json:"status"`
			Previous *string `json:"previous_filename"`
		} `json:"files"`
	}
	if err := client.GithubGetJSON(ctx, u, cfg.GitHubToken, cfg.UserAgent, &data); err != nil {
		return nil, fmt.Errorf("compare: %w", err)
	}
	// Reject diverged or truncated compare diffs so incremental updates never silently miss files.
	if data.Status == "diverged" {
		return nil, fmt.Errorf("compare diverged（三点 diff ≠ 冻结版真实差异）")
	}
	if len(data.Files) >= CompareAPIFilesHardCap {
		return nil, fmt.Errorf("compare files 触 GitHub 截断上限（%d）", len(data.Files))
	}
	if data.TotalCommits >= CompareAPICommitsHardCap {
		return nil, fmt.Errorf("compare commits 触 GitHub 截断上限（%d）", data.TotalCommits)
	}
	d := &UpdateArchiveDiff{}
	for _, f := range data.Files {
		if f.Filename == "" {
			continue
		}
		// Map renames missing previous_filename to added and unknown statuses to modified so files never drop.
		switch f.Status {
		case "added":
			d.Added = append(d.Added, f.Filename)
		case "removed":
			d.Removed = append(d.Removed, f.Filename)
		case "renamed":
			if f.Previous != nil {
				d.Renamed = append(d.Renamed, ChapterRename{From: *f.Previous, To: f.Filename})
			} else {
				d.Added = append(d.Added, f.Filename)
			}
		default:
			d.Modified = append(d.Modified, f.Filename)
		}
	}
	return d, nil
}

func MarkStaleForRepo(ctx context.Context, cfg Config, store CycleStore, repo StaleRepoRow) error {
	toSha, err := resolveLatestShaHTTP(ctx, cfg, repo.Owner, repo.Repo, repo.Branch)
	if err != nil {
		return fmt.Errorf("resolve latest sha: %w", err)
	}
	if repo.GitSha == toSha {
		return store.ClearUpstreamUpdate(ctx, repo.ID)
	}

	diffBase := repo.GitSha
	if repo.PendingSyncSha != nil && *repo.PendingSyncSha != "" {
		diffBase = *repo.PendingSyncSha
	}
	if diffBase == toSha {
		return SettleIfAllResolved(ctx, store, repo.ID, toSha)
	}

	req := UpdateCandidateRequest{
		Owner:        repo.Owner,
		Repo:         repo.Repo,
		Branch:       repo.Branch,
		FromSha:      diffBase,
		ToSha:        toSha,
		RepositoryID: repo.ID,
	}
	if p, err := store.GetRepoProfile(ctx, repo.ID); err == nil && p != nil {
		req.RepoProfile = p
	}
	candidate, err := BuildUpdateCandidateSet(cfg, req, store)
	if err != nil {
		if d, derr := fetchCompareDiffHTTP(ctx, cfg, repo.Owner, repo.Repo, diffBase, toSha); derr == nil && d != nil {
			req.Diff = d
			candidate, err = BuildUpdateCandidateSet(cfg, req, store)
		}
	}
	if err != nil {
		return fmt.Errorf("candidate set unavailable: %w", err)
	}

	created, structural, err := CreateStaleJobs(ctx, store, repo.ID, diffBase, candidate, toSha)
	if err != nil {
		return err
	}
	// Hold structural changes for manual maintainer plan/apply instead of auto-creating stale jobs.
	if structural {
		return nil
	}
	if created > 0 {
		return nil
	}
	return SettleIfAllResolved(ctx, store, repo.ID, toSha)
}

func CreateStaleJobs(ctx context.Context, store CycleStore, repositoryId, fromSha string, candidate *UpdateCandidateResponse, toSha string) (int, bool, error) {
	for _, c := range candidate.Chapters {
		if c.Change == "structural" {
			return 0, true, nil
		}
	}
	var contentPaths []string
	for _, c := range candidate.Chapters {
		if c.KeepExemption == nil {
			contentPaths = append(contentPaths, c.Path)
		}
	}
	if len(contentPaths) == 0 {
		return 0, false, nil
	}

	docs, err := store.ListProcessedSharedDocs(ctx, repositoryId, contentPaths)
	if err != nil {
		return 0, false, err
	}
	busyIDs, err := store.BusyUpdateJobDocIDs(ctx, repositoryId)
	if err != nil {
		return 0, false, err
	}
	busy := map[string]bool{}
	for _, id := range busyIDs {
		busy[id] = true
	}

	created := 0
	for _, doc := range docs {
		if busy[doc.ID] {
			continue
		}
		if err := store.CreateChapterUpdateJob(ctx, repositoryId, doc.ID, doc.Path, fromSha, toSha); err != nil {
			return created, false, err
		}
		created++
	}
	if created > 0 {
		if err := store.SetPendingSyncSha(ctx, repositoryId, toSha); err != nil {
			return created, false, err
		}
	}
	return created, false, nil
}

func SettleIfAllResolved(ctx context.Context, store CycleStore, repositoryId, toSha string) error {
	n, err := store.CountActiveUpdateJobs(ctx, repositoryId)
	if err != nil || n > 0 {
		return err
	}
	return store.AdvanceSyncBaseline(ctx, repositoryId, toSha)
}

func RunAutoUpdateDeterministicCycle(ctx context.Context, cfg Config, store CycleStore) {
	repos, err := store.ListUpdatableRepos(ctx, AutoUpdateMaxReposPerCycle)
	if err != nil {
		return
	}
	for _, repo := range repos {
		if err := MarkStaleForRepo(ctx, cfg, store, repo); err != nil {
			log.Printf("[auto-update] mark stale failed for %s/%s: %v", repo.Owner, repo.Repo, err)
		}
	}
}
