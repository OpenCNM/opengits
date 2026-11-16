package update

import (
	"log"

	"context"
	"fmt"
	"net/url"

	"github.com/opengits/worker-sidecar/internal/platform/client"
)

// ─────────────────────────────────────────────────────────────
// auto-update 确定性周期 Go 单实现（D组端点6c：/api/internal/scheduler/
// auto-update-once 收窄）。原「Go 时钟 → Node 全周期端点 → markStale 又
// HTTP 回折 Go 候选集」的三段 ping-pong 收敛为进程内闭环：
//
//   租约 → 超时清扫（market_sweep）→ 过期标记（归档 diff 优先 →
//   GitHub compare 兜底 → BuildUpdateCandidateSet 进程内直调 →
//   createStaleJobs）→ 基线推进（活跃清零结算）
//
// 留在窄化端点上的仅剩两类 Node 锚定语义：TRIAL 投票结算（swapIn 资金
// 事务）与维护者兜底转录（BYOK 引擎）——与 llm/generate 同域裁定保留。
// ─────────────────────────────────────────────────────────────

const (
	AutoUpdateMaxReposPerCycle = 20
	CompareAPIFilesHardCap     = 300
	CompareAPICommitsHardCap   = 250
)

// githubAPIBase GITHUB_ENDPOINTS.api 同源（cfg 缺省回落官方端点）。
func githubAPIBase(cfg Config) string {
	if cfg.GitHubAPIBase != "" {
		return cfg.GitHubAPIBase
	}
	return "https://api.github.com"
}

// resolveLatestShaHTTP 分支头解析（对齐 fetchBranchHead 无 ETag 形态）。
func resolveLatestShaHTTP(ctx context.Context, cfg Config, owner, repo, branch string) (string, error) {
	u := fmt.Sprintf("%s/repos/%s/%s/commits/%s", githubAPIBase(cfg),
		url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(branch))
	var out struct {
		Sha string `json:"sha"`
	}
	// 共享 GitHub 客户端：限流退避重试 + 空仓语义（对齐 fetcher 重试面）
	if err := client.GithubGetJSON(ctx, u, cfg.GitHubToken, cfg.UserAgent, &out); err != nil {
		return "", fmt.Errorf("branch head: %w", err)
	}
	if out.Sha == "" {
		return "", fmt.Errorf("branch head empty sha")
	}
	return out.Sha, nil
}

// fetchCompareDiffHTTP GitHub compare 兜底 diff（对齐 fetchCompareDiff：
// 300 文件/250 提交/diverged 截断护栏——触线即拒用宁慢勿漏；
// 状态映射含 default→modified 与 renamed-无 previous→added，对齐
// github-api.ts:165-189——未知状态/copied 不再从 diff 中静默蒸发）。
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
		switch f.Status {
		case "added":
			d.Added = append(d.Added, f.Filename)
		case "removed":
			d.Removed = append(d.Removed, f.Filename)
		case "renamed":
			if f.Previous != nil {
				d.Renamed = append(d.Renamed, ChapterRename{From: *f.Previous, To: f.Filename})
			} else {
				// rename 记录缺 previous_filename → 按 added 处理（绝不静默丢弃）
				d.Added = append(d.Added, f.Filename)
			}
		default:
			// modified/changed/copied/未知状态一律按 modified（对齐 Node default 分支）
			d.Modified = append(d.Modified, f.Filename)
		}
	}
	return d, nil
}

// MarkStaleForRepo 单仓过期标记（对齐 auto-update.ts markStaleForRepo：
// sha 未变清红点 / diffBase 去重 / 候选集 + 建单 / 结构变更留人工 / 空单推进基线）。
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

	// 候选集：进程内直调（归档 diff 优先；缺失回落 GitHub compare 兜底）
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
	if structural {
		return nil // 结构变更留维护者手动 plan→apply（红点保留）
	}
	if created > 0 {
		return nil
	}
	return SettleIfAllResolved(ctx, store, repo.ID, toSha)
}

// CreateStaleJobs 建单（对齐 update-market/jobs.ts createStaleJobs：
// structural 拦截 / keepExemption 物理拦截 / 活跃任务去重 / pendingSyncSha 记账）。
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

// SettleIfAllResolved 活跃清零结算：推进 gitSha、清红点与同步目标。
func SettleIfAllResolved(ctx context.Context, store CycleStore, repositoryId, toSha string) error {
	n, err := store.CountActiveUpdateJobs(ctx, repositoryId)
	if err != nil || n > 0 {
		return err
	}
	return store.AdvanceSyncBaseline(ctx, repositoryId, toSha)
}

// RunAutoUpdateDeterministicCycle 确定性周期主体（引擎缝之外的全部段落）。
func RunAutoUpdateDeterministicCycle(ctx context.Context, cfg Config, store CycleStore) {
	repos, err := store.ListUpdatableRepos(ctx, AutoUpdateMaxReposPerCycle)
	if err != nil {
		return
	}
	for _, repo := range repos {
		// 单仓失败不阻断本轮（对齐 Node try/catch 逐仓吞错），但必须留痕：
		// GitHub 限流/DB 错误整窗静默失败时，红点永不消化且无任何可观测信号
		if err := MarkStaleForRepo(ctx, cfg, store, repo); err != nil {
			log.Printf("[auto-update] mark stale failed for %s/%s: %v", repo.Owner, repo.Repo, err)
		}
	}
}
